import FilecoinPayV1ABI from '@/abis/filecoin-pay-v1.abi';
import type { TransactionContext } from '@/db/db';
import type { DB } from '@/db/types';
import type {
  Indexer,
  IndexerBatchParameters,
  LogForEvents,
} from '@/lib/types';
import { sortLogs } from '@/lib/utils';
import { Injectable } from '@nestjs/common';
import { chunk } from 'es-toolkit';
import type { InsertObject } from 'kysely';
import { getAbiItem, type AbiEvent } from 'viem';

type EventType = (typeof events)[number];
type Logs = LogForEvents<EventType>[];

const events = [
  getAbiItem({ abi: FilecoinPayV1ABI, name: 'RailCreated' }),
  getAbiItem({ abi: FilecoinPayV1ABI, name: 'RailOneTimePaymentProcessed' }),
  getAbiItem({ abi: FilecoinPayV1ABI, name: 'RailSettled' }),
] as const satisfies AbiEvent[];

@Injectable()
export class FilecoinPayV1Indexer implements Indexer<Logs> {
  public name = FilecoinPayV1Indexer.name;

  public async getChanges({
    client,
    contractAddress,
    fromBlock,
    toBlock,
  }: IndexerBatchParameters): Promise<Logs> {
    const logs = await client.getLogs({
      address: contractAddress,
      events,
      fromBlock,
      toBlock,
      strict: true,
    });

    return sortLogs(logs);
  }

  public async updateDb(tx: TransactionContext, logs: Logs): Promise<void> {
    const rails = this.getRailsInputs(logs);

    if (rails.length > 0) {
      for (const part of chunk(rails, 1000)) {
        await tx.insertInto('filecoin_pay_rail').values(part).execute();
      }
    }

    const payments = this.getPaymentsInputs(logs);

    if (payments.length > 0) {
      for (const part of chunk(payments, 1000)) {
        await tx.insertInto('filecoin_pay_payment').values(part).execute();
      }
    }
  }

  private getRailsInputs(
    logs: LogForEvents<EventType>[],
  ): InsertObject<DB, 'filecoin_pay_rail'>[] {
    return logs
      .filter((log) => log.eventName === 'RailCreated')
      .map((log) => {
        return {
          filecoin_pay_contract_address: log.address.toLowerCase(),
          tx_hash: log.transactionHash.toLowerCase(),
          log_index: log.logIndex,
          rail_id: log.args.railId.toString(),
          payer: log.args.payer.toLowerCase(),
          payee: log.args.payee.toLowerCase(),
          operator: log.args.operator.toLowerCase(),
          validator: log.args.validator.toLowerCase(),
          token: log.args.token.toLowerCase(),
        };
      });
  }

  private getPaymentsInputs(
    logs: LogForEvents<EventType>[],
  ): InsertObject<DB, 'filecoin_pay_payment'>[] {
    return logs
      .filter((log) => {
        return (
          log.eventName === 'RailOneTimePaymentProcessed' ||
          log.eventName === 'RailSettled'
        );
      })
      .map((log) => {
        const totalAmount =
          log.eventName === 'RailSettled'
            ? log.args.totalSettledAmount
            : log.args.netPayeeAmount +
              log.args.networkFee +
              log.args.operatorCommission;
        const netPayeeAmount =
          log.eventName === 'RailSettled'
            ? log.args.totalNetPayeeAmount
            : log.args.netPayeeAmount;

        return {
          filecoin_pay_contract_address: log.address.toLowerCase(),
          tx_hash: log.transactionHash.toLowerCase(),
          tx_position: log.transactionIndex,
          log_index: log.logIndex,
          rail_id: log.args.railId.toString(),
          total_amount: totalAmount.toString(),
          net_payee_amount: netPayeeAmount.toString(),
          operator_commission: log.args.operatorCommission.toString(),
          network_fee: log.args.networkFee.toString(),
          settled_at_epoch: log.blockNumber.toString(),
          one_time: log.eventName === 'RailOneTimePaymentProcessed',
        };
      });
  }
}
