import StreamWeightActorABI from '@/abis/stream-weight-actor.abi';
import { type TransactionContext } from '@/db/db';
import { Injectable } from '@nestjs/common';
import { AbiEvent, getAbiItem } from 'viem';
import type { LogForEvents } from '../lib/types';
import { AbstractIndexer, type GetLogsParameters } from './abstract.indexer';

type EventType = (typeof events)[number];
type Logs = LogForEvents<EventType>[];

const events = [
  getAbiItem({ abi: StreamWeightActorABI, name: 'GateParamsSet' }),
  getAbiItem({ abi: StreamWeightActorABI, name: 'QuarterlyGateCheckResult' }),
] as const satisfies AbiEvent[];

@Injectable()
export class StreamWeightActorIndexer extends AbstractIndexer<EventType> {
  public getName(): string {
    return StreamWeightActorIndexer.name;
  }

  protected async getLogs({
    client,
    contractAddress,
    fromBlock,
    toBlock,
  }: GetLogsParameters): Promise<Logs> {
    return client.getLogs({
      address: contractAddress,
      events,
      fromBlock,
      toBlock,
      strict: true,
    });
  }

  protected async updateDb(tx: TransactionContext, logs: Logs): Promise<void> {
    const gateParamsLogs = logs.filter(
      (log) => log.eventName === 'GateParamsSet',
    );
    const quarterlyGateCheckResultLogs = logs.filter(
      (log) => log.eventName === 'QuarterlyGateCheckResult',
    );

    if (gateParamsLogs.length > 0) {
      await tx
        .insertInto('stream_weight_actor_parameters')
        .values(
          gateParamsLogs.map((log) => {
            return {
              epoch: log.blockNumber.toString(),
              log_index: log.logIndex,
              tx_hash: log.transactionHash.toLowerCase(),
              base_atto_usd: log.args.params.target.base.toString(),
              step_ratio: log.args.params.target.stepRatio.toString(),
              steps: log.args.params.steps.toString(),
            };
          }),
        )
        .execute();
    }

    if (quarterlyGateCheckResultLogs.length > 0) {
      await tx
        .insertInto('quarterly_gate_check')
        .values(
          quarterlyGateCheckResultLogs.map((log) => {
            return {
              epoch: log.blockNumber.toString(),
              log_index: log.logIndex,
              tx_hash: log.transactionHash.toLowerCase(),
              quarter: log.args.quarter.toString(),
              passed: log.args.passed,
              steps_after: log.args.steps.toString(),
              steps_before: (
                log.args.steps - (log.args.passed ? 1n : 0n)
              ).toString(),
            };
          }),
        )
        .execute();
    }
  }
}
