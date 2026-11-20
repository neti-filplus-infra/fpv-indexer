import { TransactionContext } from '@/db/db';
import type { AbiEvent, Address, GetLogsReturnType } from 'viem';
import type { infer as zodInfer } from 'zod';
import type { CONFIG_SCHEMA } from './constants';
import { FilecoinPublicClient } from './filecoin-client';

export type ConfigShape = zodInfer<typeof CONFIG_SCHEMA>;

export interface IndexerRunParameters {
  contractAddress: Address;
  minBlockNumber: bigint;
  maxBlockNumber: bigint | null;
}

export interface IndexerBatchParameters {
  client: FilecoinPublicClient;
  contractAddress: Address;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface Indexer<Changes = unknown> {
  readonly name: string;
  getChanges(parameters: IndexerBatchParameters): Promise<Changes> | Changes;
  updateDb(tx: TransactionContext, changes: Changes): Promise<void>;
}

export interface RpcMetrics {
  totalCallsCount: number;
  totalCallsDurationMs: number;
  averageCallDurationMs: number;
  rpcCallsByMethod: Record<
    string,
    {
      count: number;
      totalDurationMs: number;
      averageDurationMs: number;
    }
  >;
}

export type LogForEvents<EventType extends AbiEvent> = GetLogsReturnType<
  undefined,
  EventType[],
  true,
  bigint,
  bigint
>[number];

export interface ERC20Metadata {
  decimals: number;
  symbol: string;
}
