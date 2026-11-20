import { db } from '@/db/db';
import { packageMajorVersion } from '@/lib/constants';
import {
  InjectArchiveNodeClient,
  InjectRecentNodeClient,
  type FilecoinPublicClient,
} from '@/lib/filecoin-client';
import {
  IndexerBatchResultContext,
  StructuredLogger,
} from '@/lib/observability';
import type { ConfigShape, Indexer, IndexerRunParameters } from '@/lib/types';
import { maxBigInt, numericToBigInt } from '@/lib/utils';
import { RpcMetricsContext } from '@/services/rpc-metrics-context.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TimeoutError } from 'viem';

@Injectable()
export class IndexerRunner {
  constructor(
    private readonly configService: ConfigService<ConfigShape, true>,
    private readonly rpcMetricsContext: RpcMetricsContext,
    @InjectRecentNodeClient()
    private readonly recentNodeClient: FilecoinPublicClient,
    @InjectArchiveNodeClient()
    private readonly archiveNodeClient: FilecoinPublicClient,
  ) {}

  public async run(
    indexer: Indexer,
    parameters: IndexerRunParameters,
  ): Promise<void> {
    let keepRunning: boolean;

    do {
      keepRunning = await this.runBatchWithTimeoutRetries(
        indexer,
        parameters,
        0,
      );
    } while (keepRunning);
  }

  private async runBatchWithTimeoutRetries(
    indexer: Indexer,
    parameters: IndexerRunParameters,
    timeoutCount: number,
  ): Promise<boolean> {
    const maxTimeouts = 10;
    const logger = this.createIndexerLogger(indexer, parameters);

    try {
      const result = await this.runBatchWithMetrics(
        indexer,
        parameters,
        timeoutCount,
      );

      return result;
    } catch (error) {
      if (!(error instanceof TimeoutError)) throw error;

      const nextTimeoutCount = timeoutCount + 1;

      if (timeoutCount >= maxTimeouts) {
        logger.warn(
          {
            event: 'indexer.batch.rpc_timeout_retries_limit_reached',
            maxTimeouts,
          },
          'Timeout retry limit reached. Immediate retry will not trigger.',
        );

        throw error;
      }

      logger.debug(
        {
          event: 'indexer.batch.rpc_timeout_retry',
          timeoutsCount: nextTimeoutCount,
          maxTimeouts,
        },
        `Retrying immediately with lower batch size due to RPC call timeout.`,
      );

      const result = await this.runBatchWithTimeoutRetries(
        indexer,
        parameters,
        nextTimeoutCount,
      );

      return result;
    }
  }

  private async runBatchWithMetrics(
    indexer: Indexer,
    parameters: IndexerRunParameters,
    timeoutCount: number,
  ): Promise<boolean> {
    const logger = this.createIndexerLogger(indexer, parameters);
    const rpcMetrics = this.rpcMetricsContext.empty();
    const startTime = performance.now();
    let error: unknown;
    const range: {
      fromEpoch?: bigint;
      toEpoch?: bigint;
    } = {};
    let changesReadDurationMs: number | undefined = undefined;
    let changesWriteDurationMs: number | undefined = undefined;
    let keepRunning = false;

    try {
      keepRunning = await this.rpcMetricsContext.run(rpcMetrics, async () => {
        const { contractAddress, minBlockNumber, maxBlockNumber } = parameters;

        const lastRun = await db
          .selectFrom('indexer_state')
          .selectAll()
          .where('contract_address', '=', contractAddress)
          .orderBy('last_run_date', 'desc')
          .executeTakeFirst();

        const fromBlock = !lastRun
          ? minBlockNumber
          : numericToBigInt(lastRun.end_block) + 1n;

        range.fromEpoch = fromBlock;

        const archiveThreshold = this.configService.get(
          'ARCHIVE_RPC_THRESHOLD',
          {
            infer: true,
          },
        );

        if (
          maxBlockNumber !== null &&
          !!lastRun &&
          numericToBigInt(lastRun.end_block) >= maxBlockNumber
        ) {
          logger.debug(
            {
              event: 'indexer.batch.end_reached',
              maxToEpoch: maxBlockNumber.toString(),
              indexedUpToEpoch: lastRun.end_block,
            },
            'Nothing to index',
          );

          return false;
        }

        const recentHead = await this.recentNodeClient.getBlockNumber();
        const shouldUseArchiveNode = recentHead - fromBlock > archiveThreshold;
        const selectedNode = shouldUseArchiveNode
          ? this.archiveNodeClient
          : this.recentNodeClient;

        const finalizedHeightMaxDifference = this.configService.get(
          'FINALIZED_HEIGHT_MAX_DIFFERENCE',
          { infer: true },
        );
        const [currentHeight, finalizedHeight] = await Promise.all([
          selectedNode.getBlockNumber(),
          selectedNode.filecoin
            .chainGetFinalizedTipSet()
            .then((r) => numericToBigInt(r.Height)),
        ]);

        const maxToBlock =
          typeof finalizedHeightMaxDifference === 'bigint'
            ? maxBigInt(
                finalizedHeight,
                currentHeight - finalizedHeightMaxDifference,
              )
            : finalizedHeight;
        const blockDifference = maxToBlock - fromBlock;
        const initialBatchBlockSize = this.configService.get(
          shouldUseArchiveNode
            ? 'ARCHIVE_NODE_BATCH_BLOCK_SIZE'
            : 'RECENT_NODE_BATCH_BLOCK_SIZE',
          {
            infer: true,
          },
        );
        const batchBlockSize = maxBigInt(
          1n,
          initialBatchBlockSize / BigInt(timeoutCount + 1),
        );

        const toBlock =
          blockDifference >= batchBlockSize
            ? fromBlock + batchBlockSize - 1n
            : maxToBlock;

        range.toEpoch = toBlock;

        if (fromBlock > maxToBlock) {
          logger.debug(
            {
              event: 'indexer.batch.end_reached',
              maxToEpoch: maxBlockNumber?.toString(),
              indexedUpToEpoch: lastRun?.end_block,
            },
            'Nothing to index',
          );

          return false;
        }

        if (toBlock > finalizedHeight) {
          logger.warn(
            {
              event: 'indexer.batch.finality_ignored',
              batchEndEpoch: toBlock.toString(),
              finalizedHeight: finalizedHeight.toString(),
              finalizedHeightMaxDifference:
                finalizedHeightMaxDifference?.toString(),
            },
            'Possible invalid data warning due to finality config.',
          );
        }

        logger.debug(
          {
            event: 'indexer.batch.fetching_changes',
            batchStartEpoch: fromBlock.toString(),
            batchEndEpoch: toBlock.toString(),
            nodeType: shouldUseArchiveNode ? 'archive' : 'recent',
          },
          'Fetching changes',
        );

        const readStart = performance.now();
        const changes = await indexer.getChanges({
          client: selectedNode,
          contractAddress,
          fromBlock,
          toBlock,
        });
        changesReadDurationMs = performance.now() - readStart;

        const writeStart = performance.now();
        await db.transaction().execute(async (tx) => {
          await indexer.updateDb(tx, changes);

          await tx
            .insertInto('indexer_state')
            .values({
              contract_address: contractAddress.toLowerCase(),
              version: packageMajorVersion,
              last_run_date: new Date(),
              end_block: toBlock.toString(),
            })
            .onConflict((oc) => {
              return oc.column('contract_address').doUpdateSet({
                version: packageMajorVersion,
                last_run_date: new Date(),
                end_block: toBlock.toString(),
              });
            })
            .executeTakeFirst();
        });
        changesWriteDurationMs = performance.now() - writeStart;

        return maxToBlock !== toBlock;
      });

      return keepRunning;
    } catch (caught) {
      error = caught;
      throw caught;
    } finally {
      const context = {
        event: 'indexer.batch.result',
        indexer: indexer.name,
        contractAddress: parameters.contractAddress,
        batchStartEpoch: range.fromEpoch?.toString(),
        batchEndEpoch: range.toEpoch?.toString(),
        error: !!error,
        timeoutCount,
        keepRunning,
        totalDurationMs: performance.now() - startTime,
        changesReadDurationMs,
        changesWriteDurationMs,
        rpcCalls: rpcMetrics.totalCallsCount,
        rpcTotalDurationMs: rpcMetrics.totalCallsDurationMs,
        rpcCallAverageDurationMs: rpcMetrics.averageCallDurationMs,
        rpcByMethod: rpcMetrics.rpcCallsByMethod,
      } satisfies IndexerBatchResultContext;

      if (error) {
        logger.error(context, 'Indexer batch attempt failed');
      } else {
        logger.log(context, 'Indexer batch completed');
      }
    }
  }

  private createIndexerLogger(
    indexer: Indexer,
    parameters: IndexerRunParameters,
  ): StructuredLogger {
    return new StructuredLogger(
      `${indexer.name}:${parameters.contractAddress.toLowerCase()}`,
    );
  }
}
