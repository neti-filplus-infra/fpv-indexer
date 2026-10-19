import { db, TransactionContext } from '@/db/db';
import {
  ARCHIVE_NODE_CLIENT,
  packageMajorVersion,
  RECENT_NODE_CLIENT,
} from '@/lib/constants';
import type {
  ConfigShape,
  FilecoinPublicClient,
  IndexerRunParameters,
  LogForEvents,
} from '@/lib/types';
import { compareNullableNumber, maxBigInt, numericToBigInt } from '@/lib/utils';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AbiEvent, Address, Log } from 'viem';

export interface GetLogsParameters {
  client: FilecoinPublicClient;
  contractAddress: Address;
  fromBlock: bigint;
  toBlock: bigint;
}

@Injectable()
export abstract class AbstractIndexer<EventType extends AbiEvent> {
  public abstract getName(): string;
  protected abstract getLogs(
    parameters: GetLogsParameters,
  ): Promise<LogForEvents<EventType>[]>;
  protected abstract updateDb(
    txContext: TransactionContext,
    logs: LogForEvents<EventType>[],
  ): Promise<void>;
  protected logger: Logger;

  constructor(
    protected readonly configService: ConfigService<ConfigShape, true>,
    @Inject(RECENT_NODE_CLIENT)
    protected readonly recentNodeClient: FilecoinPublicClient,
    @Inject(ARCHIVE_NODE_CLIENT)
    protected readonly archiveNodeClient: FilecoinPublicClient,
  ) {
    this.logger = new Logger(`${this.getName()}`);
  }

  public async run(parameters: IndexerRunParameters) {
    const { contractAddress, minBlockNumber, maxBlockNumber } = parameters;
    this.logger = new Logger(`${this.getName()}:${contractAddress}`);
    const logger = this.logger;

    const lastRun = await db
      .selectFrom('indexer_state')
      .selectAll()
      .where('contract_address', '=', contractAddress)
      .orderBy('last_run_date', 'desc')
      .executeTakeFirst();

    if (
      maxBlockNumber !== null &&
      !!lastRun &&
      numericToBigInt(lastRun.end_block) >= maxBlockNumber
    ) {
      logger.log('Nothing to index.');
      return;
    }
    const fromBlock = !lastRun
      ? minBlockNumber
      : numericToBigInt(lastRun.end_block) + 1n;
    const archiveThreshold = this.configService.get('ARCHIVE_RPC_THRESHOLD', {
      infer: true,
    });
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

    if (fromBlock > maxToBlock) {
      logger.log('Nothing to index.');
      return;
    }

    const blockDifference = maxToBlock - fromBlock;
    const batchBlockSize = this.configService.get(
      shouldUseArchiveNode
        ? 'ARCHIVE_NODE_BATCH_BLOCK_SIZE'
        : 'RECENT_NODE_BATCH_BLOCK_SIZE',
      {
        infer: true,
      },
    );
    const toBlock =
      blockDifference >= batchBlockSize
        ? fromBlock + batchBlockSize - 1n
        : maxToBlock;

    if (toBlock > finalizedHeight) {
      logger.warn(
        `Due to indexer configuration blocks up to epoch ${toBlock} will be indexed but finalized epoch is ${finalizedHeight}. This may result in invalid data after chain reorganization.`,
      );
    }

    logger.log(
      `Fetching logs in block range [${fromBlock.toString()}-${toBlock.toString()}] using ${shouldUseArchiveNode ? '"Archive Node"' : '"Recent Node"'}`,
    );

    const logs = await this.getLogs({
      client: selectedNode,
      contractAddress,
      fromBlock,
      toBlock,
    });
    const logsSorted = this.sortLogs(logs);

    await db.transaction().execute(async (tx) => {
      await this.updateDb(tx, logsSorted);

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

    const logsCount = logs.length;
    const keepRunning = maxToBlock !== toBlock;

    logger.log(
      keepRunning
        ? `Indexed ${logsCount} logs up to block ${toBlock.toString()}. Scheduling another run.`
        : `Finished indexing ${logsCount} logs.`,
    );

    // keep indexing if we havent synced up
    if (keepRunning) {
      await this.run(parameters);
    }
  }

  private sortLogs<T extends Log>(logs: T[]): T[] {
    return [...logs].sort((a, b) => {
      const blockOrder = compareNullableNumber(
        a.blockNumber,
        b.blockNumber,
        'asc',
      );
      if (blockOrder !== 0) return blockOrder;

      const transactionOrder = compareNullableNumber(
        a.transactionIndex,
        b.transactionIndex,
        'asc',
      );
      if (transactionOrder !== 0) return transactionOrder;

      return compareNullableNumber(a.logIndex, b.logIndex, 'asc');
    });
  }
}
