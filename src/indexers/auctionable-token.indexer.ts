import { db, type TransactionContext } from '@/db/db';
import type { DB } from '@/db/types';
import type { TraceResult } from '@/lib/types';
import { numericToBigInt } from '@/lib/utils';
import { Injectable } from '@nestjs/common';
import { groupBy, mapValues, uniq } from 'es-toolkit';
import type { InsertObject } from 'kysely';
import {
  type Address,
  decodeFunctionData,
  type DecodeFunctionDataReturnType,
  getAbiItem,
  type Hex,
  isAddress,
  isAddressEqual,
} from 'viem';
import ERC20ABI from '../abis/erc-20.abi';
import FilecoinPayV1ABI from '../abis/filecoin-pay-v1.abi';
import { AbstractIndexer, type GetChangesParameters } from './abstract.indexer';

type IndexedTraceResult = TraceResult & {
  callIndex: number;
};

type DecodableTraceResult = IndexedTraceResult & {
  action: TraceResult['action'] & {
    to: Address;
    input: Hex;
  };
};

type DecodedFilecoinPayV1TraceResult = DecodableTraceResult & {
  data: DecodeFunctionDataReturnType<typeof FilecoinPayV1ABI>;
};
type AuctionData = InsertObject<DB, 'filecoin_pay_fee_auction'>;
type Changes = {
  newAuctions: AuctionData[];
  paymentsCallIndices: Record<string, number[]>;
};

const transferEvent = getAbiItem({ abi: ERC20ABI, name: 'Transfer' });

@Injectable()
export class AuctionableTokenIndexer extends AbstractIndexer<Changes> {
  public getName(): string {
    return AuctionableTokenIndexer.name;
  }

  protected async getChanges({
    client,
    contractAddress,
    fromBlock,
    toBlock,
  }: GetChangesParameters) {
    const filecoinPayContractRows = await db
      .selectFrom('filecoin_pay_contract')
      .select('contract_address')
      .execute();

    const filecoinPayAddresses = filecoinPayContractRows
      .map((row) => row.contract_address)
      .filter((maybeAddress) => isAddress(maybeAddress));

    // Fetch ERC20 transfers from Filecoin Pay
    const logs = await client.getLogs({
      address: contractAddress,
      event: transferEvent,
      args: {
        from: filecoinPayAddresses,
      },
      fromBlock,
      toBlock,
      strict: true,
    });

    // Get traces for all unique txs retpresenting transfer out of Filecoin Pay
    const uniqueTransactions = uniq(logs.map((log) => log.transactionHash));
    const traces = await Promise.all(
      uniqueTransactions.map((transactionHash) => {
        return client.request({
          method: 'trace_transaction',
          params: [transactionHash],
        });
      }),
    );

    // Filter out traces realted to Filecoin Pay contract
    const filecoinPayTraces = traces.flatMap((transactionTraces) => {
      return transactionTraces
        .map((trace, callIndex) => {
          return {
            ...trace,
            callIndex,
          } satisfies IndexedTraceResult;
        })
        .filter((trace, _, indexedTraces) => {
          return !this.traceOrAncestorFailed(trace, indexedTraces);
        })
        .filter((trace): trace is DecodableTraceResult => {
          if (!this.isDecodableTraceResult(trace)) return false;

          // In some real edge case we might possible miss an auction here if
          // a Filecoin Pay contract is whitelisted after the burn but it
          // should be fine as long as the rule saying that newly whitelisted
          // Filecoun Pay contracts count starting from next quarter.
          return filecoinPayAddresses.some((whitelistedAddress) =>
            isAddressEqual(trace.action.to, whitelistedAddress),
          );
        })
        .map((trace) => {
          const data = decodeFunctionData({
            abi: FilecoinPayV1ABI,
            data: trace.action.input,
          });

          return {
            ...trace,
            data,
          } satisfies DecodedFilecoinPayV1TraceResult;
        });
    });

    // Map traces to auction data
    const newAuctions = filecoinPayTraces.reduce<AuctionData[]>(
      (auctions, trace) => {
        if (trace.data.functionName !== 'burnForFees') return auctions;

        const auction = {
          filecoin_pay_contract_address: trace.action.to,
          tx_hash: trace.transactionHash.toLowerCase(),
          tx_position: trace.transactionPosition,
          call_index: trace.callIndex,
          token_address: trace.data.args[0].toLowerCase(),
          // This is the amount REQUESTED by the caller not the actual amount
          // transferred to the receipient. In case of regular ERC20 tokens
          // that do not modify amount on transfers it should represent actual
          // amount transferred.
          amount_requested: trace.data.args[2].toString(),
          fil_burned: trace.action.value
            ? numericToBigInt(trace.action.value).toString()
            : '0',
          auctioned_at_epoch: trace.blockNumber.toString(),
        } satisfies AuctionData;

        return [...auctions, auction];
      },
      [],
    );

    // Since we are already fetching transaction traces here we update payments
    // call indices so that same transaction payments and auctions can be
    // properly ordered. This this is enforce that auction only prices the
    // payments strictly after it.
    const paymentsTracesGrouped = groupBy(
      filecoinPayTraces.filter((trace) => {
        // Those are two function on Filecoin Pay contract that can create
        // either a settlement or one time payment.
        return (
          trace.data.functionName === 'settleRail' ||
          trace.data.functionName === 'settleTerminatedRailWithoutValidation'
        );
      }),
      (trace) => {
        return trace.transactionHash.toLowerCase();
      },
    );

    const paymentsCallIndices = mapValues(paymentsTracesGrouped, (traces) => {
      // It's important they are sorted in order of occurence within a tx.
      return traces.map((trace) => trace.callIndex).sort((a, b) => a - b);
    });

    return {
      newAuctions,
      paymentsCallIndices,
    };
  }

  protected async updateDb(
    tx: TransactionContext,
    changes: Changes,
  ): Promise<void> {
    for (const [transactionHash, callIndices] of Object.entries(
      changes.paymentsCallIndices,
    )) {
      const payments = await tx
        .selectFrom('filecoin_pay_payment')
        .select('id')
        .where('tx_hash', '=', transactionHash.toLowerCase())
        .orderBy('log_index')
        .execute();

      // The number of call indices withing a transaction trace must much the
      // number of payments recorded in that transaction. Otherwise we can't
      // reliably assign call index to a payment.
      if (payments.length !== callIndices.length) {
        throw new Error(
          `Trying to update indices of ${callIndices.length} payments in transaction "${transactionHash}" but ${payments.length} were found.`,
        );
      }

      for (const [index, payment] of payments.entries()) {
        const callIndex = callIndices[index];

        await tx
          .updateTable('filecoin_pay_payment')
          .set({
            call_index: callIndex,
          })
          .where('id', '=', payment.id)
          .executeTakeFirst();
      }
    }

    // Since now multiple triggers can read traces from same transaction, there
    // can be a possibility that duplicates of auctions can be inserted into DB.
    // This is solved by a unique constrain plus skipping on conflict here.
    if (changes.newAuctions.length > 0) {
      await tx
        .insertInto('filecoin_pay_fee_auction')
        .values(changes.newAuctions)
        .onConflict((oc) => {
          return oc
            .columns([
              'filecoin_pay_contract_address',
              'auctioned_at_epoch',
              'tx_position',
              'call_index',
            ])
            .doNothing();
        })
        .executeTakeFirst();
    }
  }

  private isDecodableTraceResult(
    traceResult: IndexedTraceResult,
  ): traceResult is DecodableTraceResult {
    return (
      !!traceResult.action.to &&
      isAddress(traceResult.action.to) &&
      !!traceResult.action.to
    );
  }

  private traceOrAncestorFailed(
    trace: TraceResult,
    traces: TraceResult[],
  ): boolean {
    return traces.some((candidate) => {
      if (!candidate.error) return false;

      const path = candidate.traceAddress;

      return (
        path.length <= trace.traceAddress.length &&
        path.every((frame, index) => frame === trace.traceAddress[index])
      );
    });
  }
}
