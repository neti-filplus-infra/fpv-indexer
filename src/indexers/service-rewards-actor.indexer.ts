import ServiceRewardsActorABI from '@/abis/service-rewards-actor.abi';
import { type TransactionContext } from '@/db/db';
import { ServiceRewardsActorParameterType } from '@/db/enums';
import { ARCHIVE_NODE_CLIENT, RECENT_NODE_CLIENT } from '@/lib/constants';
import { maxBigInt, numericToBigInt } from '@/lib/utils';
import { FilfoxApiService } from '@/services/filfox-api.service';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BigNumber } from 'bignumber.js';
import { uniq } from 'es-toolkit';
import { AbiEvent, Address, getAbiItem } from 'viem';
import type {
  ConfigShape,
  ERC20Metadata,
  FilecoinPublicClient,
  LogForEvents,
} from '../lib/types';
import { AbstractIndexer, type GetLogsParameters } from './abstract.indexer';

type EventType = (typeof events)[number];
type Logs = LogForEvents<EventType>[];
type OrchestratorRemovedLog = LogForEvents<typeof orchestratorRemovedEvent>;
type BindingDeclaredLog = LogForEvents<typeof bindingDeclaredEvent>;
type BindingReassignedLog = LogForEvents<typeof bindingReassignedEvent>;
type BindingCanceledLog = LogForEvents<typeof bindingCanceledEvent>;
type AdmittedListsUpdatedLog = LogForEvents<typeof admittedListUpdatedEvent>;
type PricingParamsUpdatedLog = LogForEvents<typeof pricingParamsUpdatedEvent>;

const orchestratorRemovedEvent = getAbiItem({
  abi: ServiceRewardsActorABI,
  name: 'OrchestratorRemoved',
});

const bindingDeclaredEvent = getAbiItem({
  abi: ServiceRewardsActorABI,
  name: 'BindingDeclared',
});

const bindingReassignedEvent = getAbiItem({
  abi: ServiceRewardsActorABI,
  name: 'BindingReassigned',
});

const bindingCanceledEvent = getAbiItem({
  abi: ServiceRewardsActorABI,
  name: 'BindingCanceled',
});

const admittedListUpdatedEvent = getAbiItem({
  abi: ServiceRewardsActorABI,
  name: 'AdmittedListsUpdated',
});

const pricingParamsUpdatedEvent = getAbiItem({
  abi: ServiceRewardsActorABI,
  name: 'PricingParamsUpdated',
});

const events = [
  getAbiItem({ abi: ServiceRewardsActorABI, name: 'OrchestratorAdmitted' }),
  orchestratorRemovedEvent,
  getAbiItem({
    abi: ServiceRewardsActorABI,
    name: 'OrchestratorWalletReplaced',
  }),
  bindingDeclaredEvent,
  bindingReassignedEvent,
  bindingCanceledEvent,
  getAbiItem({ abi: ServiceRewardsActorABI, name: 'BindingCanceled' }),
  admittedListUpdatedEvent,
  pricingParamsUpdatedEvent,
  getAbiItem({ abi: ServiceRewardsActorABI, name: 'VolumePosted' }),
  getAbiItem({ abi: ServiceRewardsActorABI, name: 'VolumeCorrected' }),
  getAbiItem({ abi: ServiceRewardsActorABI, name: 'SharesSubmitted' }),
] as const satisfies AbiEvent[];

@Injectable()
export class ServiceRewardsActorIndexer extends AbstractIndexer<EventType> {
  constructor(
    protected readonly configService: ConfigService<ConfigShape, true>,
    @Inject(RECENT_NODE_CLIENT)
    protected readonly recentNodeClient: FilecoinPublicClient,
    @Inject(ARCHIVE_NODE_CLIENT)
    protected readonly archiveNodeClient: FilecoinPublicClient,
    private readonly filfoxApiService: FilfoxApiService,
  ) {
    super(configService, recentNodeClient, archiveNodeClient);
  }

  public getName(): string {
    return ServiceRewardsActorIndexer.name;
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
    type MaybeMetadataPair = [Address, ERC20Metadata] | null;

    const admittedTokens = logs
      .filter((log) => log.eventName === 'AdmittedListsUpdated')
      .flatMap((log) =>
        log.args.stablecoins.map((token) => token.toLowerCase() as Address),
      );
    const uniqueAdmittedTokens = uniq(admittedTokens);
    const maybeTokensMetadataPairs = await Promise.all(
      uniqueAdmittedTokens.map<Promise<MaybeMetadataPair>>(
        async (tokenAddress) => {
          try {
            const metadata =
              await this.filfoxApiService.getERC20Metadata(tokenAddress);
            return [tokenAddress, metadata];
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);

            this.logger.warn(
              `Skipping admitted token ${tokenAddress}: ${reason}`,
            );

            return null;
          }
        },
      ),
    );

    const tokensMap = new Map(
      maybeTokensMetadataPairs.filter(
        (maybePair): maybePair is [Address, ERC20Metadata] => {
          return maybePair !== null;
        },
      ),
    );

    for (const log of logs) {
      switch (log.eventName) {
        case 'OrchestratorAdmitted':
          await tx
            .insertInto('service_orchestrator')
            .values({
              id: log.args.orch.toLowerCase(),
              wallet: log.args.wallet.toLowerCase(),
              registration_epoch: log.blockNumber.toString(),
              registration_tx_hash: log.transactionHash.toLowerCase(),
            })
            .executeTakeFirst();

          break;

        case 'OrchestratorRemoved':
          await this.removeOrchestrator(tx, log);
          break;

        case 'OrchestratorWalletReplaced':
          await tx
            .updateTable('service_orchestrator')
            .set({
              wallet: log.args.newWallet.toLowerCase(),
            })
            .where('id', '=', log.args.oldOrch.toLowerCase())
            .executeTakeFirst();

          break;

        case 'BindingDeclared':
          await this.createBinding(tx, log);
          break;

        case 'BindingReassigned':
          await this.reassignBinding(tx, log);
          break;

        case 'BindingCanceled':
          await this.cancelBinding(tx, log);
          break;

        case 'AdmittedListsUpdated':
          await this.updatedAdmittedLists(tx, log, tokensMap);
          break;

        case 'PricingParamsUpdated':
          await this.updatePricingParams(tx, log);
          break;

        case 'VolumePosted':
        case 'VolumeCorrected':
          await tx
            .insertInto('service_orchestrator_quarterly_volume')
            .values({
              service_orchestrator_id: log.args.orchestrator.toLowerCase(),
              quarter_num: Number(log.args.q),
              volume_atto_usd: log.args.volume.toString(),
              is_correction: log.eventName === 'VolumeCorrected',
              posting_epoch: log.blockNumber.toString(),
              posting_log_index: log.logIndex,
              posting_tx_hash: log.transactionHash.toString(),
            })
            .executeTakeFirst();

          break;

        case 'SharesSubmitted':
          await tx
            .insertInto('quarter_bound_volume')
            .values({
              quarter_num: Number(log.args.q),
              volume_atto_usd: log.args.totalUsd.toString(),
              epoch: log.blockNumber.toString(),
              tx_hash: log.transactionHash.toLowerCase(),
            })
            .executeTakeFirst();

          break;
      }
    }
  }

  private async removeOrchestrator(
    tx: TransactionContext,
    log: OrchestratorRemovedLog,
  ) {
    const epoch = log.blockNumber.toString();
    const logIndex = log.logIndex;
    const serviceOrchestrator = log.args.orch.toLowerCase();
    const txHash = log.transactionHash.toLowerCase();

    // mark orchestrator as removed
    await tx
      .updateTable('service_orchestrator')
      .set({
        removed: true,
        removal_epoch: epoch,
        removal_tx_hash: txHash,
      })
      .where('id', '=', serviceOrchestrator)
      .executeTakeFirst();

    // delete binding of removed orchestrator which binding period didn't start
    await tx
      .deleteFrom('service_pair')
      .where('service_orchestrator_id', '=', serviceOrchestrator)
      .where('to_epoch', 'is', null)
      .where((eb) => {
        return eb.or([
          eb('from_epoch', '>', epoch),
          eb.and([
            eb('from_epoch', '=', epoch),
            eb('from_log_index', '>', logIndex),
          ]),
        ]);
      })
      .executeTakeFirst();

    // release other bindings of removed orchestrator
    await tx
      .updateTable('service_pair')
      .where('service_orchestrator_id', '=', log.args.orch.toLowerCase())
      .where('to_epoch', 'is', null)
      .set({
        to_epoch: log.blockNumber.toString(),
        to_log_index: logIndex,
        unbinding_epoch: log.blockNumber.toString(),
        unbinding_tx_hash: txHash,
      })
      .execute();
  }

  private async createBinding(tx: TransactionContext, log: BindingDeclaredLog) {
    const pairTupleString = `(operator: ${log.args.operator}, payer: ${log.args.payer})`;
    const activationEpoch = this.configService.get('ACTIVATION_EPOCH', {
      infer: true,
    });
    const epochsPerQuarter = this.configService.get('EPOCHS_PER_QUARTER', {
      infer: true,
    });

    const logQuarter = this.getQuarterForEpoch(log.blockNumber);

    const activeBindingsCount = await tx
      .selectFrom('service_pair')
      .where('operator', '=', log.args.operator.toLowerCase())
      .where('payer', '=', log.args.payer.toLowerCase())
      .where('to_epoch', 'is', null)
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirstOrThrow();

    if (BigInt(activeBindingsCount.count) > 0n) {
      throw new TypeError(
        `Cannot bind pair ${pairTupleString}. Pair is already bound to another orchestrator.`,
      );
    }

    const previousBinding = await tx
      .selectFrom('service_pair')
      .where('operator', '=', log.args.operator.toLowerCase())
      .where('payer', '=', log.args.payer.toLowerCase())
      .where('to_epoch', 'is not', null)
      .select(['to_epoch', 'to_log_index'])
      .orderBy('to_epoch', 'desc')
      .orderBy('to_log_index', (ob) => ob.desc().nullsLast())
      .executeTakeFirst();
    const previousReleaseEpoch =
      previousBinding && previousBinding.to_epoch !== null
        ? numericToBigInt(previousBinding.to_epoch)
        : null;
    const previousReleaseLogIndex =
      previousBinding && previousBinding.to_log_index !== null
        ? previousBinding.to_log_index
        : null;

    const wasReleasedInFutureEpoch =
      previousReleaseEpoch !== null && previousReleaseEpoch > log.blockNumber;
    const wasReleasedInFutureLogIndex =
      previousReleaseEpoch !== null &&
      previousReleaseLogIndex !== null &&
      previousReleaseEpoch === log.blockNumber &&
      previousReleaseLogIndex >= log.logIndex;

    if (wasReleasedInFutureEpoch || wasReleasedInFutureLogIndex) {
      throw new TypeError(
        `Trying to bind pair ${pairTupleString} at epoch ${log.blockNumber}, log index ${log.logIndex} when it was released on epoch ${previousReleaseEpoch}, log index ${previousReleaseLogIndex}.`,
      );
    }

    const quarterStartEpoch =
      activationEpoch + epochsPerQuarter * (maxBigInt(logQuarter, 1n) - 1n);
    const quarterEndEpoch = quarterStartEpoch + epochsPerQuarter - 1n;
    let cutoffStartEpoch = quarterEndEpoch + 1n;

    // check registration cutoff only from Q1 onwards
    if (logQuarter >= 1n) {
      const registrationCutoff = await tx
        .selectFrom('service_rewards_actor_parameter')
        .select('parameter_value')
        .where(
          'parameter_type',
          '=',
          ServiceRewardsActorParameterType.REGISTRATION_CUTOFF_EPOCHS,
        )
        .where('update_epoch', '<', quarterStartEpoch.toString())
        .orderBy('update_epoch', 'desc')
        .orderBy('update_log_index', 'desc')
        .executeTakeFirst();

      const noRegistrationCutoffError = new TypeError(
        `Cannot bind pair ${pairTupleString} at epoch ${log.blockNumber} - no "REGISTRATION_CUTOFF" parameter found for quarter Q${logQuarter}.`,
      );

      if (!registrationCutoff) {
        throw noRegistrationCutoffError;
      }

      const registrationCutoffEpochs = BigNumber(
        registrationCutoff.parameter_value,
      ).toBigInt();

      if (registrationCutoffEpochs === null) {
        throw noRegistrationCutoffError;
      }

      if (registrationCutoffEpochs > epochsPerQuarter) {
        throw new TypeError(
          `"REGISTRATION_CUTOFF" param for quarter Q${logQuarter} has value ${registrationCutoffEpochs} which is more than defined ${epochsPerQuarter} epochs per quarter.`,
        );
      }

      cutoffStartEpoch = quarterEndEpoch - registrationCutoffEpochs + 1n;
    }

    const [fromEpoch, fromLogIndex] = (() => {
      // registration falls into registration cutoff, binding applies from the
      // next quarter
      if (log.blockNumber >= cutoffStartEpoch) {
        return [quarterEndEpoch + 1n, 0];
      }

      // no previous releases or released in previous quarter, binding applies
      // from the beggining of the quarter
      if (
        previousReleaseEpoch === null ||
        this.getQuarterForEpoch(previousReleaseEpoch) !== logQuarter
      ) {
        return [quarterStartEpoch, 0];
      }

      return [
        previousReleaseEpoch,
        previousReleaseLogIndex !== null ? previousReleaseLogIndex + 1 : 0,
      ];
    })();

    await tx
      .insertInto('service_pair')
      .values({
        service_orchestrator_id: log.args.orchestrator.toLowerCase(),
        payer: log.args.payer.toLowerCase(),
        operator: log.args.operator.toLowerCase(),
        from_epoch: fromEpoch.toString(),
        from_log_index: fromLogIndex,
        binding_epoch: log.blockNumber.toString(),
        binding_tx_hash: log.transactionHash.toLowerCase(),
      })
      .executeTakeFirst();
  }

  private async reassignBinding(
    tx: TransactionContext,
    log: BindingReassignedLog,
  ) {
    const activationEpoch = this.configService.get('ACTIVATION_EPOCH', {
      infer: true,
    });
    const epochsPerQuarter = this.configService.get('EPOCHS_PER_QUARTER', {
      infer: true,
    });

    const logQuarter = this.getQuarterForEpoch(log.blockNumber);
    const quarterStartEpoch =
      activationEpoch + epochsPerQuarter * (maxBigInt(logQuarter, 1n) - 1n);

    // inherited pairs start from quarter start otherwise from the epoch and
    // next log index they were reassigned at
    const fromEpoch = log.args.inherit ? quarterStartEpoch : log.blockNumber;
    const fromLogIndex = log.args.inherit ? 0 : log.logIndex + 1;
    const unboundToEpoch = log.args.inherit ? fromEpoch - 1n : log.blockNumber;
    const unboundToLogIndex = log.args.inherit
      ? // since to_log_index was designed to be inclusive we need to create an
        // unreachable max log number, here limit of the underlying DB field
        2147483647
      : log.logIndex;

    // if binding got reassigned before it could start delete it to prevent
    // primary key constraint violations
    await tx
      .deleteFrom('service_pair')
      .where('payer', '=', log.args.payer.toLowerCase())
      .where('operator', '=', log.args.operator.toLowerCase())
      .where('to_epoch', 'is', null)
      .where((eb) => {
        return eb.or([
          eb('from_epoch', '>', unboundToEpoch.toString()),
          eb.and([
            eb('from_epoch', '=', unboundToEpoch.toString()),
            eb('from_log_index', '>', unboundToLogIndex),
          ]),
        ]);
      })
      .executeTakeFirst();

    // unbind active pairs
    await tx
      .updateTable('service_pair')
      .set({
        to_epoch: unboundToEpoch.toString(),
        to_log_index: unboundToLogIndex,
        unbinding_epoch: log.blockNumber.toString(),
        unbinding_tx_hash: log.transactionHash.toLowerCase(),
      })
      .where('operator', '=', log.args.operator.toLowerCase())
      .where('payer', '=', log.args.payer.toLowerCase())
      .where('to_epoch', 'is', null)
      .execute();

    // bind to new orchestrator
    await tx
      .insertInto('service_pair')
      .values({
        service_orchestrator_id: log.args.orchestrator.toLowerCase(),
        payer: log.args.payer.toLowerCase(),
        operator: log.args.operator.toLowerCase(),
        from_epoch: fromEpoch.toString(),
        from_log_index: fromLogIndex,
        binding_epoch: log.blockNumber.toString(),
        binding_tx_hash: log.transactionHash.toLowerCase(),
      })
      .executeTakeFirst();
  }

  private async cancelBinding(tx: TransactionContext, log: BindingCanceledLog) {
    const epoch = log.blockNumber.toString();
    const logIndex = log.logIndex;
    const orchestrator = log.args.orchestrator.toLowerCase();
    const payer = log.args.payer.toLowerCase();
    const operator = log.args.operator.toLowerCase();

    // if binding got canceled before it binding period - remove it entirely...
    await tx
      .deleteFrom('service_pair')
      .where('operator', '=', operator)
      .where('payer', '=', payer)
      .where('service_orchestrator_id', '=', orchestrator)
      .where('to_epoch', 'is', null)
      .where((eb) => {
        return eb.or([
          eb('from_epoch', '>', epoch),
          eb.and([
            eb('from_epoch', '=', epoch),
            eb('from_log_index', '>', logIndex),
          ]),
        ]);
      })
      .executeTakeFirst();

    // ...otherwise unbind it
    await tx
      .updateTable('service_pair')
      .set({
        to_epoch: epoch,
        to_log_index: logIndex,
        unbinding_epoch: epoch,
        unbinding_tx_hash: log.transactionHash.toLowerCase(),
      })
      .where('operator', '=', operator)
      .where('payer', '=', payer)
      .where('service_orchestrator_id', '=', orchestrator)
      .where('to_epoch', 'is', null)
      .execute();
  }

  private async updatedAdmittedLists(
    tx: TransactionContext,
    log: AdmittedListsUpdatedLog,
    tokensMap: Map<Address, ERC20Metadata>,
  ) {
    const whitelistedContracts = await tx
      .selectFrom('filecoin_pay_contract')
      .select('contract_address')
      .where('removal_epoch', 'is', null)
      .execute();
    const whitelistedContractsAddresses = whitelistedContracts.map((i) =>
      i.contract_address.toLowerCase(),
    );

    const whitelistedTokens = await tx
      .selectFrom('whitelisted_token')
      .select('token_address')
      .where('removal_epoch', 'is', null)
      .execute();
    const whitelistedTokensAddresses = whitelistedTokens.map((i) =>
      i.token_address.toLowerCase(),
    );

    const admittedContracts = log.args.filecoinPayContracts.map((c) =>
      c.toLowerCase(),
    );
    const addedContracts = admittedContracts.filter(
      (c) => !whitelistedContractsAddresses.includes(c),
    );
    const removedContracts = whitelistedContractsAddresses.filter(
      (c) => !admittedContracts.includes(c),
    );

    const admittedTokens = log.args.stablecoins.map((t) => t.toLowerCase());
    const addedTokens = admittedTokens.filter(
      (t) => !whitelistedTokensAddresses.includes(t),
    );
    const removedTokens = whitelistedTokensAddresses.filter(
      (t) => !admittedTokens.includes(t),
    );

    if (removedContracts.length > 0) {
      await tx
        .updateTable('filecoin_pay_contract')
        .set({
          removal_epoch: log.blockNumber.toString(),
          removal_log_index: log.logIndex,
          removal_tx_hash: log.transactionHash.toLowerCase(),
        })
        .where('contract_address', 'in', removedContracts)
        .where('removal_epoch', 'is', null)
        .execute();
    }

    if (removedTokens.length > 0) {
      await tx
        .updateTable('whitelisted_token')
        .set({
          removal_epoch: log.blockNumber.toString(),
          removal_log_index: log.logIndex,
          removal_tx_hash: log.transactionHash.toLowerCase(),
        })
        .where('token_address', 'in', removedTokens)
        .where('removal_epoch', 'is', null)
        .execute();
    }

    if (addedContracts.length > 0) {
      await tx
        .insertInto('filecoin_pay_contract')
        .values(
          addedContracts.map((contractAddress) => {
            return {
              contract_address: contractAddress,
              admittance_epoch: log.blockNumber.toString(),
              admittance_log_index: log.logIndex,
              admittance_tx_hash: log.transactionHash.toLowerCase(),
            };
          }),
        )
        .execute();
    }

    for (const tokenAddress of addedTokens) {
      const metadata = tokensMap.get(tokenAddress as Address);

      if (!metadata) {
        // silently skip tokens for which metadata was not found, warning is
        // already logged previously when fetching token metadata
        continue;
      }

      await tx
        .insertInto('whitelisted_token')
        .values({
          token_address: tokenAddress,
          token_decimals: metadata.decimals,
          token_symbol: metadata.symbol,
          admittance_epoch: log.blockNumber.toString(),
          admittance_log_index: log.logIndex,
          admittance_tx_hash: log.transactionHash.toLowerCase(),
        })
        .executeTakeFirst();
    }
  }

  private async updatePricingParams(
    tx: TransactionContext,
    log: PricingParamsUpdatedLog,
  ) {
    const pairs: [
      paramType: ServiceRewardsActorParameterType,
      paramValue: string,
    ][] = [
      [
        ServiceRewardsActorParameterType.MIN_LOT_FLOOR,
        log.args.minLotFloor.toString(),
      ],
      [
        ServiceRewardsActorParameterType.MIN_LOT_ALPHA_NUMERATOR,
        log.args.minLotAlphaNum.toString(),
      ],
      [
        ServiceRewardsActorParameterType.MIN_LOT_ALPHA_DENOMINATOR,
        log.args.minLotAlphaDen.toString(),
      ],
      [
        ServiceRewardsActorParameterType.PRICE_BAND_BPS,
        log.args.priceBand.toString(),
      ],
      [
        ServiceRewardsActorParameterType.REGISTRATION_CUTOFF_EPOCHS,
        log.args.registrationCutoff.toString(),
      ],
    ];

    await tx
      .insertInto('service_rewards_actor_parameter')
      .values(
        pairs.map(([parameterType, parameterValue]) => {
          return {
            parameter_type: parameterType,
            parameter_value: parameterValue,
            update_epoch: log.blockNumber.toString(),
            update_log_index: log.logIndex,
            update_tx_hash: log.transactionHash.toLowerCase(),
          };
        }),
      )
      .execute();
  }

  private getQuarterForEpoch(epoch: bigint): bigint {
    const activationEpoch = this.configService.get('ACTIVATION_EPOCH', {
      infer: true,
    });

    if (epoch < activationEpoch) {
      return 0n;
    }

    const epochsPerQuarter = this.configService.get('EPOCHS_PER_QUARTER', {
      infer: true,
    });

    return (epoch - activationEpoch) / epochsPerQuarter + 1n;
  }
}
