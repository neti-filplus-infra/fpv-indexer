import { db } from '@/db/db';
import {
  applyPagination,
  applySorting,
  selectQueryToCountQuery,
} from '@/db/utils';
import { PaginatedPaymentsList, PaymentsQuery } from '@/lib/schemas';
import { ConfigShape } from '@/lib/types';
import { divideBigInt, numericToBigInt } from '@/lib/utils';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uniq } from 'es-toolkit';
import { sql } from 'kysely';
import { zeroAddress } from 'viem';
import { ERC20TokenInfoService } from './erc-20-token-info.service';
import { QuartersService } from './quarters.service';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly configService: ConfigService<ConfigShape, true>,
    private readonly erc20Service: ERC20TokenInfoService,
    private readonly quartersService: QuartersService,
  ) {}

  public async getPaymentsPaginated({
    serviceOrchestrator,
    fromEpoch,
    toEpoch,
    countsTowardsVolume,
    sort,
    page,
    limit = 100,
  }: PaymentsQuery): Promise<PaginatedPaymentsList> {
    type Payment = PaginatedPaymentsList['data'][number];
    type PricingPeriod = NonNullable<Payment['pricingPeriod']>;

    const activationEpoch = this.configService.get('ACTIVATION_EPOCH', {
      infer: true,
    });

    const basePaymentsQuery = db
      .selectFrom('filecoin_pay_payment as p')
      .innerJoin('filecoin_pay_rail as r', (join) => {
        return join
          .onRef('p.rail_id', '=', 'r.rail_id')
          .onRef(
            'p.filecoin_pay_contract_address',
            '=',
            'r.filecoin_pay_contract_address',
          );
      })
      .leftJoin('service_pair as sp', (jb) => {
        return jb
          .onRef('r.payer', '=', 'sp.payer')
          .onRef('r.operator', '=', 'sp.operator')
          .on((eb) => {
            return eb.or([
              eb('p.settled_at_epoch', '>', eb.ref('sp.from_epoch')),
              eb.and([
                eb('p.settled_at_epoch', '=', eb.ref('sp.from_epoch')),
                eb('p.log_index', '>=', eb.ref('sp.from_log_index')),
              ]),
            ]);
          })
          .on((eb) => {
            return eb.or([
              eb('sp.to_epoch', 'is', null),
              eb('p.settled_at_epoch', '<', eb.ref('sp.to_epoch')),
              eb.and([
                eb('p.settled_at_epoch', '=', eb.ref('sp.to_epoch')),
                eb('p.log_index', '<=', eb.ref('sp.to_log_index')),
              ]),
            ]);
          });
      })
      .select((eb) => {
        const whitelistedFilecoinPayContractsSubquery = eb
          .selectFrom('filecoin_pay_contract as fpc')
          .select('contract_address')
          .whereRef(
            'p.filecoin_pay_contract_address',
            '=',
            'fpc.contract_address',
          )
          .where((eb) => {
            return eb.or([
              eb('fpc.admittance_epoch', '<', eb.ref('p.settled_at_epoch')),
              eb.and([
                eb('fpc.admittance_epoch', '=', eb.ref('p.settled_at_epoch')),
                eb('fpc.admittance_log_index', '<=', eb.ref('p.log_index')),
              ]),
            ]);
          })
          .where((eb) => {
            return eb.or([
              eb('fpc.removal_epoch', 'is', null),
              eb('p.settled_at_epoch', '<', eb.ref('fpc.removal_epoch')),
              eb.and([
                eb('p.settled_at_epoch', '=', eb.ref('fpc.removal_epoch')),
                eb('p.log_index', '<=', eb.ref('fpc.removal_log_index')),
              ]),
            ]);
          });

        const whitelistedTokensSubquery = eb
          .selectFrom('whitelisted_token as t')
          .select('token_address')
          .whereRef('r.token', '=', 't.token_address')
          .where((eb) => {
            return eb.or([
              eb('t.admittance_epoch', '<', eb.ref('p.settled_at_epoch')),
              eb.and([
                eb('t.admittance_epoch', '=', eb.ref('p.settled_at_epoch')),
                eb('t.admittance_log_index', '<=', eb.ref('p.log_index')),
              ]),
            ]);
          })
          .where((eb) => {
            return eb.or([
              eb('t.removal_epoch', 'is', null),
              eb('p.settled_at_epoch', '<', eb.ref('t.removal_epoch')),
              eb.and([
                eb('p.settled_at_epoch', '=', eb.ref('t.removal_epoch')),
                eb('p.log_index', '<=', eb.ref('t.removal_log_index')),
              ]),
            ]);
          });

        return [
          'p.id',
          'p.filecoin_pay_contract_address',
          'p.settled_at_epoch',
          'p.log_index',
          'p.tx_hash',
          'r.rail_id',
          'r.payer',
          'r.payee',
          'r.operator',
          'r.token',
          'p.total_amount',
          'p.net_payee_amount',
          'p.network_fee',
          'p.operator_commission',
          'sp.service_orchestrator_id',
          eb
            .exists(whitelistedFilecoinPayContractsSubquery)
            .as('filecoin_pay_contract_whitelisted'),
          eb
            .or([
              eb('r.token', '=', zeroAddress),
              eb.exists(whitelistedTokensSubquery),
            ])
            .as('token_whitelisted'),
        ];
      })
      .as('payments');

    let baseResultsQuery = db.selectFrom(basePaymentsQuery);

    if (serviceOrchestrator) {
      baseResultsQuery = baseResultsQuery.where(
        'service_orchestrator_id',
        '=',
        serviceOrchestrator.toLowerCase(),
      );
    }

    if (fromEpoch !== undefined) {
      baseResultsQuery = baseResultsQuery.where(
        'settled_at_epoch',
        '>=',
        fromEpoch.toString(),
      );
    }

    if (toEpoch !== undefined) {
      baseResultsQuery = baseResultsQuery.where(
        'settled_at_epoch',
        '<=',
        toEpoch.toString(),
      );
    }

    if (typeof countsTowardsVolume === 'boolean') {
      baseResultsQuery = baseResultsQuery.where((eb) => {
        const predicate = eb.and([
          eb('service_orchestrator_id', 'is not', null),
          eb('filecoin_pay_contract_whitelisted', '=', true),
          eb('token_whitelisted', '=', true),
        ]);

        return countsTowardsVolume ? predicate : eb.not(predicate);
      });
    }

    const enrichedQuery = baseResultsQuery
      .leftJoinLateral(
        (eb) => {
          return eb
            .selectFrom('qualified_price_periods_mv as qp')
            .select((eb) => {
              const previousPeriodEpoch = sql<
                string | null
              >`LAG(epoch) OVER (ORDER BY epoch, log_index)`;
              const previousPeriodLogIndex = sql<
                string | null
              >`LAG(log_index) OVER (ORDER BY epoch, log_index)`;

              return [
                eb.fn
                  .coalesce(previousPeriodEpoch, eb.val(activationEpoch))
                  .as('start_epoch'),
                eb.fn
                  .coalesce(eb(previousPeriodLogIndex, '+', '1'), eb.val(0))
                  .as('start_log_index'),
                'epoch as end_epoch',
                'log_index as end_log_index',
                'qp.lot_atto_usd',
                'qp.claim_atto_fil',
                eb('lot_atto_usd', '/', eb.ref('claim_atto_fil')).as(
                  'implied_rate',
                ),
              ];
            })
            .where((eb) => {
              return eb.or([
                eb('qp.epoch', '>', eb.ref('payments.settled_at_epoch')),
                eb.and([
                  eb('qp.epoch', '=', eb.ref('payments.settled_at_epoch')),
                  eb('qp.log_index', '>', eb.ref('payments.log_index')),
                ]),
              ]);
            })
            .orderBy('qp.epoch', 'asc')
            .orderBy('qp.log_index', 'asc')
            .limit(1)
            .as('pp');
        },
        (jb) => {
          return jb.on('payments.token', '=', zeroAddress);
        },
      )
      .selectAll('payments')
      .select([
        'pp.start_epoch as pricing_period_start_epoch',
        'pp.start_log_index as pricing_period_start_log_index',
        'pp.end_epoch as pricing_period_end_epoch',
        'pp.end_log_index as pricing_period_end_log_index',
        'pp.lot_atto_usd as pricing_period_lot_atto_usd',
        'pp.claim_atto_fil as pricing_period_claim_atto_fil',
        'pp.implied_rate as pricing_period_implied_rate',
      ]);

    const resultsQuery = applySorting(
      applyPagination(enrichedQuery, { page, limit }),
      {
        sort,
        fieldMap: {
          epoch: 'settled_at_epoch',
        },
      },
    );

    const [quarters, results, countResult] = await Promise.all([
      this.quartersService.getQuarters(),
      resultsQuery.execute(),
      selectQueryToCountQuery(baseResultsQuery).executeTakeFirstOrThrow(),
    ]);

    const totalCount = numericToBigInt(countResult.count);
    const limitBigInt = BigInt(limit);
    const pagesCount =
      totalCount / limitBigInt + (totalCount % limitBigInt === 0n ? 0n : 1n);
    const uniqueTokens = uniq(results.map((result) => result.token));

    const [decimalsPairs, symbolPairs] = await Promise.all([
      Promise.all(
        uniqueTokens.map(async (token) => {
          const decimals = await this.erc20Service.getTokenDecimals(token);
          return [token, decimals] as const;
        }),
      ),
      Promise.all(
        uniqueTokens.map(async (token) => {
          const symbol = await this.erc20Service.getTokenSymbol(token);
          return [token, symbol] as const;
        }),
      ),
    ]);

    const decimalsMap = new Map(decimalsPairs);
    const symbolMap = new Map(symbolPairs);

    const payments = results.map((result) => {
      const tokenDecimals = decimalsMap.get(result.token);
      const tokenSymbol = symbolMap.get(result.token);

      if (tokenDecimals === undefined || tokenSymbol === undefined) {
        throw new InternalServerErrorException(
          `Token "${result.token}" details not found`,
        );
      }

      const pricingPeriod =
        result.pricing_period_start_epoch !== null &&
        result.pricing_period_start_log_index !== null &&
        result.pricing_period_end_epoch !== null &&
        result.pricing_period_end_log_index !== null &&
        result.pricing_period_lot_atto_usd !== null &&
        result.pricing_period_claim_atto_fil !== null &&
        result.pricing_period_implied_rate !== null
          ? ({
              startEpoch: numericToBigInt(result.pricing_period_start_epoch),
              startLogIndex: parseInt(
                result.pricing_period_start_log_index.toString(),
                10,
              ),
              endEpoch: numericToBigInt(result.pricing_period_end_epoch),
              endLogIndex: parseInt(
                result.pricing_period_end_log_index.toString(),
                10,
              ),
              lotAttoUsd: numericToBigInt(result.pricing_period_lot_atto_usd),
              lotUsd: divideBigInt(
                numericToBigInt(result.pricing_period_lot_atto_usd),
                10n ** 18n,
                2,
              ),
              claimAttoFil: numericToBigInt(
                result.pricing_period_claim_atto_fil,
              ),
              claimFil: divideBigInt(
                numericToBigInt(result.pricing_period_claim_atto_fil),
                10n ** 18n,
                18,
              ),
              impliedRate: parseFloat(result.pricing_period_implied_rate),
            } satisfies PricingPeriod)
          : null;

      const tokenBase = 10n ** BigInt(tokenDecimals);
      const epoch = numericToBigInt(result.settled_at_epoch);
      const totalAmountBaseUnits = numericToBigInt(result.total_amount);
      const netPayeeAmountBaseUnits = numericToBigInt(result.net_payee_amount);
      const networkFeeBaseUnits = numericToBigInt(result.network_fee);
      const operatorComissionBaseUnits = numericToBigInt(
        result.operator_commission,
      );

      const quarter = quarters.find((quarter) => {
        return epoch >= quarter.startEpoch && epoch <= quarter.endEpoch;
      });

      return {
        filecoinPayContract: result.filecoin_pay_contract_address,
        epoch,
        logIndex: result.log_index,
        transactionHash: result.tx_hash,
        railId: numericToBigInt(result.rail_id),
        payer: result.payer,
        payee: result.payee,
        operator: result.operator,
        tokenAddress: result.token,
        tokenDecimals,
        tokenSymbol,
        totalAmountBaseUnits,
        totalAmount: divideBigInt(
          totalAmountBaseUnits,
          tokenBase,
          tokenDecimals,
        ),
        netPayeeAmountBaseUnits,
        netPayeeAmount: divideBigInt(
          netPayeeAmountBaseUnits,
          tokenBase,
          tokenDecimals,
        ),
        networkFeeBaseUnits,
        networkFee: divideBigInt(networkFeeBaseUnits, tokenBase, tokenDecimals),
        operatorComissionBaseUnits,
        operatorComission: divideBigInt(
          operatorComissionBaseUnits,
          tokenBase,
          tokenDecimals,
        ),
        serviceOrchestrator: result.service_orchestrator_id,
        filecoinPayContractWhitelisted: Boolean(
          result.filecoin_pay_contract_whitelisted,
        ),
        tokenWhitelisted: Boolean(result.token_whitelisted),
        quarter: quarter ?? null,
        pricingPeriod,
      } satisfies Payment;
    });

    return {
      data: payments,
      pagination: {
        page,
        pagesCount,
        totalCount,
      },
    };
  }
}
