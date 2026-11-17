import type {
  AbiEvent,
  Address,
  GetLogsReturnType,
  Hash,
  Hex,
  HttpTransport,
  PublicClient,
} from 'viem';
import type { infer as zodInfer } from 'zod';
import type { CONFIG_SCHEMA, SUPPORTED_CHAINS } from './constants';

type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

export type TraceAction = {
  callType?: string;
  from?: Hex;
  to?: Hex;
  gas?: Hex;
  input?: Hex;
  value?: Hex;
};

export type TraceResult = {
  type: string;
  error?: string;
  subtraces: number;
  traceAddress: number[];
  action: TraceAction;
  result?: {
    gasUsed?: Hex;
    output?: Hex;
  };
  blockHash: Hex;
  blockNumber: number;
  transactionHash: Hex;
  transactionPosition: number;
};

export type TraceableRpcSchema = [
  {
    Method: 'trace_transaction';
    Parameters: [transactionHash: Hex];
    ReturnType: TraceResult[];
  },
];

export type FilecoinCid = {
  '/': string;
};

export type FilecoinFinalizedTipset = {
  Cids: FilecoinCid[];
  Blocks: unknown[];
  Height: number;
};

export type FilecoinRpcSchema = [
  {
    Method: 'Filecoin.ChainGetFinalizedTipSet';
    Parameters: [];
    ReturnType: FilecoinFinalizedTipset;
  },
  {
    Method: 'Filecoin.EthGetMessageCidByTransactionHash';
    Parameters: [transactionHash: Hash];
    ReturnType: FilecoinCid;
  },
  {
    Method: 'Filecoin.StateReplay';
    Parameters: [tipsets: FilecoinCid[], messageCid: FilecoinCid];
    ReturnType: unknown;
  },
];

export type FilecoinActions = {
  filecoin: {
    chainGetFinalizedTipSet: () => Promise<FilecoinFinalizedTipset>;
  };
};

export type FilecoinPublicClient = PublicClient<
  HttpTransport,
  SupportedChain,
  undefined,
  TraceableRpcSchema | FilecoinRpcSchema
> &
  FilecoinActions;

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
