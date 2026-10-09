import { db } from '@/db/db';
import { ServiceRewardsActorParameterType } from '@/db/enums';
import { epochToQuarterNumber } from '@/db/utils';
import {
  OrchestratorQuarterlyVolumeParameters,
  OrchestratorQuarterlyVolumePosting,
  Quarter,
  QuarterNumberFilter,
  QuarterParameters,
} from '@/lib/schemas';
import type { ConfigShape } from '@/lib/types';
import { divideBigInt, numericToBigInt } from '@/lib/utils';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BigNumber } from 'bignumber.js';
import { head, last, range } from 'es-toolkit';
import { Address } from 'viem';
import { BlockNumberService } from './block-number-service';

@Injectable()
export class QuartersService {
  constructor(
    private readonly configService: ConfigService<ConfigShape, true>,
    private readonly blockNumberService: BlockNumberService,
  ) {}

  public async getQuarterByIndex(quarterNum: number): Promise<Quarter> {
    if (quarterNum < 1) {
      throw new TypeError('Quarter index cannot be lower than 1.');
    }

    if (!Number.isInteger(quarterNum)) {
      throw new TypeError('Quarter index must be a integer.');
    }

    const activationEpoch = this.configService.get('ACTIVATION_EPOCH', {
      infer: true,
    });
    const epochsPerQuarter = this.configService.get('EPOCHS_PER_QUARTER', {
      infer: true,
    });
    const blockNumber = await this.blockNumberService.getBlockNumber();

    const startEpoch =
      activationEpoch + epochsPerQuarter * BigInt(quarterNum - 1);
    const endEpoch = startEpoch + epochsPerQuarter - 1n;

    return {
      q: quarterNum,
      startEpoch,
      endEpoch,
      completed: blockNumber > endEpoch,
    };
  }

  public async getQuarters(): Promise<Quarter[]> {
    const currentBlockNumber = await this.blockNumberService.getBlockNumber();
    const activationEpoch = this.configService.get('ACTIVATION_EPOCH', {
      infer: true,
    });
    const epochsPerQuarter = this.configService.get('EPOCHS_PER_QUARTER', {
      infer: true,
    });

    if (currentBlockNumber < activationEpoch) {
      throw new Error(
        `Activation epoch "${activationEpoch}" is in the future (current block number is "${currentBlockNumber}").`,
      );
    }

    const quartersCount = Math.max(
      1,
      Number((currentBlockNumber - activationEpoch) / epochsPerQuarter + 1n),
    );

    const results = await Promise.all(
      range(quartersCount).map((q) => {
        return this.getQuarterByIndex(q + 1);
      }),
    );

    return results;
  }

  public async getCurrentQuarterNum(): Promise<number | null> {
    const currentBlockNumber = await this.blockNumberService.getBlockNumber();
    const activationEpoch = this.configService.get('ACTIVATION_EPOCH', {
      infer: true,
    });
    const epochsPerQuarter = this.configService.get('EPOCHS_PER_QUARTER', {
      infer: true,
    });

    if (currentBlockNumber < activationEpoch) {
      return null;
    }

    return Number(
      (currentBlockNumber - activationEpoch) / epochsPerQuarter + 1n,
    );
  }

  public async getQuarterParameters({
    quarterNumber,
  }: QuarterNumberFilter): Promise<QuarterParameters> {
    const quarterNumInt = quarterNumber.toNumber();
    const activationEpoch = this.configService.get('ACTIVATION_EPOCH', {
      infer: true,
    });
    const epochsPerQuarter = this.configService.get('EPOCHS_PER_QUARTER', {
      infer: true,
    });
    const previousQuarterBoundVolumeResult = await db
      .selectFrom('quarter_bound_volume')
      .select('volume_atto_usd')
      .where('quarter_num', '=', quarterNumInt - 1)
      .executeTakeFirst();
    const previousQuarterBoundVolumeAttoUsd = previousQuarterBoundVolumeResult
      ? numericToBigInt(previousQuarterBoundVolumeResult.volume_atto_usd)
      : 0n;
    const previousQuarterBoundVolumeUsd = divideBigInt(
      previousQuarterBoundVolumeAttoUsd,
      10n ** 18n,
      2,
    );

    const previousQuarterPricePeriodsCountResult = await db
      .selectFrom('qualified_price_periods_mv')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('quarter_num', '=', quarterNumInt - 1)
      .executeTakeFirst();
    const previousQuarterPricePeriodsCount =
      previousQuarterPricePeriodsCountResult
        ? parseInt(previousQuarterPricePeriodsCountResult.count.toString(), 10)
        : 0;

    // Parameters
    const quarterParameters = await db
      .with('parameters_by_quarter', (eb) => {
        return eb.selectFrom('service_rewards_actor_parameter').select((eb) => {
          return [
            'parameter_type',
            'parameter_value',
            'update_epoch',
            'update_log_index',
            eb
              .case()
              .when('update_epoch', '<', activationEpoch.toString())
              .then(0)
              .else(
                epochToQuarterNumber({
                  epoch: eb.ref('update_epoch'),
                  activationEpoch: eb.val(activationEpoch),
                  epochsPerQuarter: eb.val(epochsPerQuarter),
                }),
              )
              .end()
              .as('quarter_num'),
          ];
        });
      })
      .selectFrom('parameters_by_quarter')
      .distinctOn('parameter_type')
      .select(['parameter_type', 'parameter_value'])
      .where('quarter_num', '<', quarterNumInt)
      .orderBy('parameter_type')
      .orderBy('quarter_num', 'desc')
      .orderBy('update_epoch', 'desc')
      .orderBy('update_log_index', 'desc')
      .execute();

    // Whitelisted tokens
    const quarterTokens = await db
      .with('tokens_by_quarter', (eb) => {
        return eb.selectFrom('whitelisted_token').select((eb) => {
          return [
            'token_address',
            'admittance_epoch',
            'admittance_log_index',
            eb
              .case()
              .when('admittance_epoch', '<', activationEpoch.toString())
              .then(0)
              .else(
                epochToQuarterNumber({
                  epoch: eb.ref('admittance_epoch'),
                  activationEpoch: eb.val(activationEpoch),
                  epochsPerQuarter: eb.val(epochsPerQuarter),
                }),
              )
              .end()
              .as('admittance_quarter_num'),
            eb
              .case()
              .when('removal_epoch', 'is', null)
              .then(null)
              .when('removal_epoch', '<', activationEpoch.toString())
              .then(0)
              .else(
                epochToQuarterNumber({
                  epoch: eb.ref('removal_epoch'),
                  activationEpoch: eb.val(activationEpoch),
                  epochsPerQuarter: eb.val(epochsPerQuarter),
                }),
              )
              .end()
              .as('removal_quarter_num'),
          ];
        });
      })
      .selectFrom('tokens_by_quarter')
      .distinctOn('token_address')
      .select(['token_address'])
      .where((eb) => {
        return eb.and([
          eb('admittance_quarter_num', '<', quarterNumInt),
          eb.or([
            eb('removal_quarter_num', 'is', null),
            eb('removal_quarter_num', '>=', quarterNumInt),
          ]),
        ]);
      })
      .orderBy('token_address')
      .orderBy('admittance_quarter_num', 'desc')
      .orderBy('admittance_epoch', 'desc')
      .orderBy('admittance_log_index', 'desc')
      .execute();

    // Whitelisted tokens
    const quarterFilecoinPayContracts = await db
      .with('contracts_by_quarter', (eb) => {
        return eb.selectFrom('filecoin_pay_contract').select((eb) => {
          return [
            'contract_address',
            'admittance_epoch',
            'admittance_log_index',
            eb
              .case()
              .when('admittance_epoch', '<', activationEpoch.toString())
              .then(0)
              .else(
                epochToQuarterNumber({
                  epoch: eb.ref('admittance_epoch'),
                  activationEpoch: eb.val(activationEpoch),
                  epochsPerQuarter: eb.val(epochsPerQuarter),
                }),
              )
              .end()
              .as('admittance_quarter_num'),
            eb
              .case()
              .when('removal_epoch', 'is', null)
              .then(null)
              .when('removal_epoch', '<', activationEpoch.toString())
              .then(0)
              .else(
                epochToQuarterNumber({
                  epoch: eb.ref('removal_epoch'),
                  activationEpoch: eb.val(activationEpoch),
                  epochsPerQuarter: eb.val(epochsPerQuarter),
                }),
              )
              .end()
              .as('removal_quarter_num'),
          ];
        });
      })
      .selectFrom('contracts_by_quarter')
      .distinctOn('contract_address')
      .select(['contract_address'])
      .where((eb) => {
        return eb.and([
          eb('admittance_quarter_num', '<', quarterNumInt),
          eb.or([
            eb('removal_quarter_num', 'is', null),
            eb('removal_quarter_num', '>=', quarterNumInt),
          ]),
        ]);
      })
      .orderBy('contract_address')
      .orderBy('admittance_quarter_num', 'desc')
      .orderBy('admittance_epoch', 'desc')
      .orderBy('admittance_log_index', 'desc')
      .execute();

    // PRICE_BAND
    const priceBandBpsParameter = quarterParameters.find(
      (p) =>
        p.parameter_type === ServiceRewardsActorParameterType.PRICE_BAND_BPS,
    );

    if (priceBandBpsParameter === undefined) {
      throw this.createMissingParameterError(
        quarterNumInt,
        ServiceRewardsActorParameterType.PRICE_BAND_BPS,
      );
    }

    const priceBandBps = BigNumber(
      priceBandBpsParameter.parameter_value,
    ).toBigInt();

    if (priceBandBps === null) {
      throw this.createInvalidParameterError(
        quarterNumInt,
        ServiceRewardsActorParameterType.PRICE_BAND_BPS,
      );
    }

    const priceBand = divideBigInt(priceBandBps, 10000n, 6);

    // MIN_LOT_FLOOR
    const minLotFloorParameter = quarterParameters.find(
      (p) =>
        p.parameter_type === ServiceRewardsActorParameterType.MIN_LOT_FLOOR,
    );

    if (minLotFloorParameter === undefined) {
      throw this.createMissingParameterError(
        quarterNumInt,
        ServiceRewardsActorParameterType.MIN_LOT_FLOOR,
      );
    }

    const minLotFloorAttoUsd = BigNumber(
      minLotFloorParameter.parameter_value,
    ).toBigInt();

    if (minLotFloorAttoUsd === null) {
      throw this.createMissingParameterError(
        quarterNumInt,
        ServiceRewardsActorParameterType.MIN_LOT_FLOOR,
      );
    }

    const minLotFloorUsd = divideBigInt(minLotFloorAttoUsd, 10n ** 18n, 2);

    // MIN_LOT_ALPHA numerator
    const minLotAlphaNumeratorParameter = quarterParameters.find(
      (p) =>
        p.parameter_type ===
        ServiceRewardsActorParameterType.MIN_LOT_ALPHA_NUMERATOR,
    );

    if (minLotAlphaNumeratorParameter === undefined) {
      throw this.createMissingParameterError(
        quarterNumInt,
        ServiceRewardsActorParameterType.MIN_LOT_ALPHA_NUMERATOR,
      );
    }

    const minLotAlphaNumerator = BigNumber(
      minLotAlphaNumeratorParameter.parameter_value,
    ).toBigInt();

    if (minLotAlphaNumerator === null) {
      throw this.createMissingParameterError(
        quarterNumInt,
        ServiceRewardsActorParameterType.MIN_LOT_ALPHA_NUMERATOR,
      );
    }

    // MIN_LOT_ALPHA denominator
    const minLotAlphaDenominatorParameter = quarterParameters.find(
      (p) =>
        p.parameter_type ===
        ServiceRewardsActorParameterType.MIN_LOT_ALPHA_DENOMINATOR,
    );

    if (minLotAlphaDenominatorParameter === undefined) {
      throw this.createMissingParameterError(
        quarterNumInt,
        ServiceRewardsActorParameterType.MIN_LOT_ALPHA_DENOMINATOR,
      );
    }

    const minLotAlphaDenominator = BigNumber(
      minLotAlphaDenominatorParameter.parameter_value,
    ).toBigInt();

    if (minLotAlphaDenominator === null) {
      throw this.createMissingParameterError(
        quarterNumInt,
        ServiceRewardsActorParameterType.MIN_LOT_ALPHA_DENOMINATOR,
      );
    }

    // MIN_LOT
    const unboundMinLotAttoUsd =
      minLotAlphaDenominator !== 0n && previousQuarterPricePeriodsCount !== 0
        ? (minLotAlphaNumerator * previousQuarterBoundVolumeAttoUsd) /
          (minLotAlphaDenominator * BigInt(previousQuarterPricePeriodsCount))
        : 0n;
    const minLotAttoUsd =
      unboundMinLotAttoUsd >= minLotFloorAttoUsd
        ? unboundMinLotAttoUsd
        : minLotFloorAttoUsd;
    const minLotUsd = divideBigInt(minLotAttoUsd, 10n ** 18n, 2);

    return {
      previousQuarterBoundVolumeAttoUsd,
      previousQuarterBoundVolumeUsd,
      previousQuarterPricePeriodsCount,
      minLotFloorAttoUsd,
      minLotFloorUsd,
      minLotAlphaNumerator,
      minLotAlphaDenominator,
      minLotAlpha:
        minLotAlphaDenominator === 0n
          ? 0
          : divideBigInt(minLotAlphaNumerator, minLotAlphaDenominator, 18),
      minLotAttoUsd,
      minLotUsd,
      priceBandBps,
      priceBand,
      admittedStablecoins: quarterTokens.map((t) => t.token_address as Address),
      admittedFilecoinPayContractAddresses: quarterFilecoinPayContracts.map(
        (c) => c.contract_address as Address,
      ),
    };
  }

  public async getServiceOrchestratorsQuarterlyVolumePostings({
    serviceOrchestrator,
    quarterNumber,
  }: OrchestratorQuarterlyVolumeParameters): Promise<OrchestratorQuarterlyVolumePosting> {
    type Posting = OrchestratorQuarterlyVolumePosting['postings'][number];

    const quarterNumInt = quarterNumber.toNumber();
    const [blockNumber, quarter] = await Promise.all([
      this.blockNumberService.getBlockNumber(),
      this.getQuarterByIndex(quarterNumInt),
    ]);
    const postPeriod = this.configService.get('POST_PERIOD', { infer: true });
    const postingWindowClosed = blockNumber > quarter.endEpoch + postPeriod;

    const results = await db
      .selectFrom('service_orchestrator as o')
      .leftJoin(
        'service_orchestrator_quarterly_volume as v',
        'o.id',
        'v.service_orchestrator_id',
      )
      .select([
        'o.id as service_orchestrator_id',
        'v.volume_atto_usd',
        'v.is_correction',
        'v.posting_epoch',
        'v.posting_tx_hash',
      ])
      .where('quarter_num', '=', quarterNumInt)
      .where('o.id', '=', serviceOrchestrator.toLowerCase())
      .orderBy('posting_epoch', 'desc')
      .orderBy('posting_log_index', 'desc')
      .execute();

    const postings = results.reduce<Posting[]>((results, result) => {
      if (
        result.volume_atto_usd === null ||
        result.is_correction === null ||
        result.posting_epoch === null ||
        result.posting_tx_hash === null
      ) {
        return results;
      }

      const nextPosting: Posting = {
        serviceOrchestrator,
        volumeAttoUsd: numericToBigInt(result.volume_atto_usd),
        correction: result.is_correction,
        postingEpoch: numericToBigInt(result.posting_epoch),
        postingTxHash: result.posting_tx_hash,
      };

      return [...results, nextPosting];
    }, []);

    const firstPosting = last(postings);
    const lastPosting = head(postings);
    const corrected = postings.some((posting) => posting.correction);
    const missed = firstPosting
      ? firstPosting.postingEpoch > quarter.endEpoch + postPeriod
      : postingWindowClosed;

    return {
      serviceOrchestrator,
      quarterNum: quarterNumInt,
      volumeAttoUsd:
        !lastPosting || lastPosting.volumeAttoUsd === 0n
          ? null
          : lastPosting.volumeAttoUsd,
      corrected,
      missed,
      postingEpoch:
        !lastPosting || lastPosting.volumeAttoUsd === 0n
          ? null
          : lastPosting.postingEpoch,
      postingTxHash:
        !lastPosting || lastPosting.volumeAttoUsd === 0n
          ? null
          : lastPosting.postingTxHash,
      postings,
    } satisfies OrchestratorQuarterlyVolumePosting;
  }

  private createMissingParameterError(
    quarterNum: number,
    parameterType: ServiceRewardsActorParameterType,
  ): Error {
    return new TypeError(
      `Parameter "${parameterType}" is not configured for quarter Q${quarterNum}`,
    );
  }

  private createInvalidParameterError(
    quarterNum: number,
    parameterType: ServiceRewardsActorParameterType,
  ): Error {
    return new TypeError(
      `Parameter "${parameterType}" for quarter Q${quarterNum} has invalid value.`,
    );
  }
}
