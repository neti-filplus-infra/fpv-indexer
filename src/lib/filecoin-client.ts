import { FactoryProvider, Inject } from '@nestjs/common';
import {
  Chain,
  createPublicClient,
  extractChain,
  Hash,
  Hex,
  http,
  HttpTransport,
  PublicClient,
  rpcSchema,
} from 'viem';
import { ConfigShape } from './types';
import { ConfigService } from '@nestjs/config';
import { filecoin, filecoinCalibration } from 'viem/chains';
import { RpcMetricsContext } from '@/services/rpc-metrics-context.service';

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];
export type SupportedChainId = SupportedChain['id'];

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

export const RECENT_NODE_CLIENT = 'RECENT_NODE_CLIENT';
export const ARCHIVE_NODE_CLIENT = 'ARCHIVE_NODE_CLIENT';

export const SUPPORTED_CHAINS = [
  filecoin,
  filecoinCalibration,
] as const satisfies Chain[];

export const InjectRecentNodeClient = () => Inject(RECENT_NODE_CLIENT);
export const InjectArchiveNodeClient = () => Inject(ARCHIVE_NODE_CLIENT);

const filecoinRpcSchema = rpcSchema<TraceableRpcSchema | FilecoinRpcSchema>();

export const recentNodeClientProvider: FactoryProvider<FilecoinPublicClient> = {
  provide: RECENT_NODE_CLIENT,
  useFactory: (
    configService: ConfigService<ConfigShape, true>,
    rpcMetricsContext: RpcMetricsContext,
  ) => {
    return createClientForChain({
      chainId: configService.get('CHAIN_ID'),
      rpcUrl: configService.get('RECENT_RPC_URL'),
      authToken: configService.get('RECENT_RPC_AUTH_TOKEN'),
      rpcMetricsContext,
    });
  },
  inject: [ConfigService, RpcMetricsContext],
};

export const archiveNodeClientProvider: FactoryProvider<FilecoinPublicClient> =
  {
    provide: ARCHIVE_NODE_CLIENT,
    useFactory: (
      configService: ConfigService<ConfigShape, true>,
      rpcMetricsContext: RpcMetricsContext,
    ) => {
      return createClientForChain({
        chainId: configService.get('CHAIN_ID'),
        rpcUrl: configService.get('ARCHIVE_RPC_URL'),
        authToken: configService.get('ARCHIVE_RPC_AUTH_TOKEN'),
        rpcMetricsContext,
      });
    },
    inject: [ConfigService, RpcMetricsContext],
  };

function isJsonRpcEntry(value: unknown): value is { method?: unknown } {
  return typeof value === 'object' && value !== null && 'method' in value;
}

function createClientForChain({
  chainId,
  rpcUrl,
  authToken,
  rpcMetricsContext,
}: {
  chainId: SupportedChain['id'];
  rpcUrl?: string | null;
  authToken?: string | null;
  rpcMetricsContext: RpcMetricsContext;
}): FilecoinPublicClient {
  const chain = extractChain({ chains: SUPPORTED_CHAINS, id: chainId });

  const transport = http(rpcUrl ?? undefined, {
    fetchFn: async (input, init) => {
      const metrics = rpcMetricsContext.current();
      const request = new Request(input, init);

      let methods: string[] = [];

      try {
        const bodyText = await request.clone().text();
        const payload: unknown = JSON.parse(bodyText);
        const entries = Array.isArray(payload) ? payload : [payload];

        methods = entries.flatMap((entry) => {
          return isJsonRpcEntry(entry) && typeof entry.method === 'string'
            ? [entry.method]
            : [];
        });
      } catch {
        // Not readable JSON-RPC body, leave methods empty
      }

      const startTime = performance.now();

      try {
        return await fetch(request);
      } finally {
        // if metrics are being collected and some methods were called measure times
        if (metrics && methods.length > 0) {
          const requestDurationMs = performance.now() - startTime;
          const duratioPerCallMs = requestDurationMs / methods.length;
          metrics.totalCallsCount += methods.length;
          metrics.totalCallsDurationMs += requestDurationMs;
          metrics.averageCallDurationMs =
            metrics.totalCallsDurationMs / metrics.totalCallsCount;

          for (const method of methods) {
            const methodMetrics = (metrics.rpcCallsByMethod[method] ??= {
              count: 0,
              totalDurationMs: 0,
              averageDurationMs: 0,
            });

            methodMetrics.count++;
            methodMetrics.totalDurationMs += duratioPerCallMs;
            methodMetrics.averageDurationMs =
              methodMetrics.totalDurationMs / methodMetrics.count;
          }
        }
      }
    },
    fetchOptions:
      typeof authToken === 'string' && authToken !== ''
        ? {
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          }
        : undefined,
    timeout: 60_000,
  });

  const client = createPublicClient({
    chain,
    transport,
    rpcSchema: filecoinRpcSchema,
  }).extend((client) => ({
    filecoin: {
      chainGetFinalizedTipSet() {
        return client.request({
          method: 'Filecoin.ChainGetFinalizedTipSet',
          params: [],
        });
      },
    },
  }));

  return client;
}
