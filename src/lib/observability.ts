import type { RpcMetrics } from '@/lib/types';
import { Logger } from '@nestjs/common';

export interface UnknownLogContext {
  event: 'unknown';
  [key: string]: unknown;
}

export interface IndexerInvalidFilecoinPayContractStoredContext {
  event: 'indexer.invalid_filecoin_pay_contract_stored';
  contractAddress: string;
}

export interface IndexerInvalidTokenStoredContext {
  event: 'indexer.invalid_token_stored';
  tokenAddress: string;
  reason: 'invalid_address' | 'not_erc20';
}

export interface IndexerBatchEndReachedContext {
  event: 'indexer.batch.end_reached';
  maxToEpoch?: string;
  indexedUpToEpoch?: string;
}

export interface IndexerBatchFetchingChangesContext {
  event: 'indexer.batch.fetching_changes';
  batchStartEpoch: string;
  batchEndEpoch: string;
  nodeType: 'archive' | 'recent';
}

export interface IndexerBatchFinalityIgnoredContext {
  event: 'indexer.batch.finality_ignored';
  batchEndEpoch: string;
  finalizedHeight: string;
  finalizedHeightMaxDifference?: string;
}

export interface IndexerBatchResultContext {
  event: 'indexer.batch.result';
  indexer: string;
  contractAddress: string;
  batchStartEpoch?: string;
  batchEndEpoch?: string;
  error: boolean;
  timeoutCount: number;
  keepRunning: boolean;
  totalDurationMs: number;
  changesReadDurationMs?: number;
  changesWriteDurationMs?: number;
  rpcCalls: number;
  rpcTotalDurationMs: number;
  rpcCallAverageDurationMs: number;
  rpcByMethod: RpcMetrics['rpcCallsByMethod'];
}

export interface IndexerBatchRpcTimeoutRetriesLimitReachedContext {
  event: 'indexer.batch.rpc_timeout_retries_limit_reached';
  maxTimeouts: number;
}

export interface IndexerBatchRpcTimeoutRetryContext {
  event: 'indexer.batch.rpc_timeout_retry';
  maxTimeouts: number;
  timeoutsCount: number;
}

export interface IndexerRunErrorContext {
  event: 'indexer.run.error';
  error: unknown;
  errorMessage: string;
  retryTimeoutMs: number;
}

export interface IndexerRunSkippedContext {
  event: 'indexer.run.skipped';
}

export type LogContext =
  | UnknownLogContext
  | IndexerInvalidFilecoinPayContractStoredContext
  | IndexerInvalidTokenStoredContext
  | IndexerBatchEndReachedContext
  | IndexerBatchFetchingChangesContext
  | IndexerBatchFinalityIgnoredContext
  | IndexerBatchResultContext
  | IndexerBatchRpcTimeoutRetriesLimitReachedContext
  | IndexerBatchRpcTimeoutRetryContext
  | IndexerRunErrorContext
  | IndexerRunSkippedContext;

export class StructuredLogger extends Logger {
  override verbose(message: string, ...optionalParams: unknown[]): void;
  override verbose(
    context: LogContext,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  override verbose(arg: string | LogContext, ...args: unknown[]): void {
    super.verbose(arg, ...args);
  }

  override debug(message: string, ...optionalParams: unknown[]): void;
  override debug(
    context: LogContext,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  override debug(arg: string | LogContext, ...args: unknown[]): void {
    super.debug(arg, ...args);
  }

  override log(message: string, ...optionalParams: unknown[]): void;
  override log(
    context: LogContext,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  override log(arg: string | LogContext, ...args: unknown[]): void {
    super.log(arg, ...args);
  }

  override warn(message: string, ...optionalParams: unknown[]): void;
  override warn(
    context: LogContext,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  override warn(arg: string | LogContext, ...args: unknown[]): void {
    super.warn(arg, ...args);
  }

  override error(message: string, ...optionalParams: unknown[]): void;
  override error(
    context: LogContext,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  override error(arg: string | LogContext, ...args: unknown[]): void {
    super.error(arg, ...args);
  }

  override fatal(message: string, ...optionalParams: unknown[]): void;
  override fatal(
    context: LogContext,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  override fatal(arg: string | LogContext, ...args: unknown[]): void {
    super.fatal(arg, ...args);
  }
}
