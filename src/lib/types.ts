import {
  type AbiEvent,
  type Address,
  type GetLogsReturnType,
  type HttpTransport,
  type PublicClient,
} from 'viem';
import type { infer as zodInfer } from 'zod';
import type { CONFIG_SCHEMA, SUPPORTED_CHAINS } from './constants';

type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

export type FilecoinPublicClient = PublicClient<
  HttpTransport,
  SupportedChain,
  undefined
>;

export type ConfigShape = zodInfer<typeof CONFIG_SCHEMA>;

export interface FilecoinPayIndexParameters {
  contractAddress: Address;
  minBlockNumber: bigint;
  maxBlockNumber: bigint | null;
}

export interface IndexerRunParameters {
  contractAddress: Address;
  minBlockNumber: bigint;
  maxBlockNumber: bigint | null;
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
