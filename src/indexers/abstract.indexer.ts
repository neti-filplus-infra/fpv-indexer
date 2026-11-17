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
} from '@/lib/types';
import { maxBigInt, numericToBigInt } from '@/lib/utils';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Address } from 'viem';

export interface GetChangesParameters {
  archiveClient: FilecoinPublicClient;
  client: FilecoinPublicClient;
  contractAddress: Address;
  fromBlock: bigint;
  recentClient: FilecoinPublicClient;
  toBlock: bigint;
}

@Injectable()
export abstract class AbstractIndexer<C = unknown> {
  public abstract getName(): string;
  protected abstract getChanges(
    parameters: GetChangesParameters,
  ): Promise<C> | C;
  protected abstract updateDb(
    txContext: TransactionContext,
    changes: C,
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
      `Fetching changes in block range [${fromBlock.toString()}-${toBlock.toString()}] using ${shouldUseArchiveNode ? '"Archive Node"' : '"Recent Node"'}`,
    );

    const changes = await this.getChanges({
      archiveClient: this.archiveNodeClient,
      recentClient: this.recentNodeClient,
      client: selectedNode,
      contractAddress,
      fromBlock,
      toBlock,
    });

    await db.transaction().execute(async (tx) => {
      await this.updateDb(tx, changes);

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

    const keepRunning = maxToBlock !== toBlock;

    logger.log(
      `Indexed changes up to block ${toBlock.toString()}. ${keepRunning ? 'Scheduling another run.' : 'Indexer up to date.'}.`,
    );

    // keep indexing if we havent synced up
    if (keepRunning) {
      await this.run(parameters);
    }
  }
}
