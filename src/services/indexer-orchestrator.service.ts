import { db } from '@/db/db';
import { IndexerStatusDto } from '@/dto/indexer-status.dto';
import { AuctionableTokenIndexer } from '@/indexers/auctionable-token.indexer';
import { FilecoinPayV1Indexer } from '@/indexers/filecoin-pay-v1.indexer';
import { ServiceRewardsActorIndexer } from '@/indexers/service-rewards-actor.indexer';
import { packageMajorVersion, packageSemver } from '@/lib/constants';
import { ConfigShape } from '@/lib/types';
import { minBigInt, numericToBigInt } from '@/lib/utils';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { Address, isAddress, isAddressEqual, zeroAddress } from 'viem';
import { ERC20TokenInfoService } from './erc-20-token-info.service';
import { FilfoxApiService } from './filfox-api.service';

@Injectable()
export class IndexerOrchestratorService implements OnApplicationBootstrap {
  public static CRON_JOB_NAME: string = 'indexer_orchestrator_cron_job';
  public static RETRY_TIMEOUT_SECONDS: number = 60;
  public static RETRY_TIMEOUT_NAME: string =
    'indexer_orchestrator_retry_timeout';

  private isRunning: boolean = false;
  private logger = new Logger(IndexerOrchestratorService.name);

  constructor(
    private readonly configService: ConfigService<ConfigShape, true>,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly filfoxApiService: FilfoxApiService,
    private readonly erc20Service: ERC20TokenInfoService,
    private readonly serviceRewardsActorIndxer: ServiceRewardsActorIndexer,
    private readonly filecoinPayV1Indexer: FilecoinPayV1Indexer,
    private readonly auctionableTokenIndexer: AuctionableTokenIndexer,
  ) {}

  public async onApplicationBootstrap() {
    await this.cleanupIfNeeded();

    const configuredCronExpression = this.configService.get(
      'INTERVAL_CRON_EXPRESSION',
      { infer: true },
    );
    const cronJob = new CronJob(
      configuredCronExpression ?? CronExpression.EVERY_HOUR,
      () => {
        void this.index();
      },
    );

    this.schedulerRegistry.addCronJob(
      IndexerOrchestratorService.CRON_JOB_NAME,
      cronJob,
    );

    cronJob.start();
    void this.index();
  }

  private async index() {
    if (this.isRunning) {
      this.logger.log('Indexing already in progress, skipping execution');
      return;
    }

    if (
      this.schedulerRegistry.doesExist(
        'timeout',
        IndexerOrchestratorService.RETRY_TIMEOUT_NAME,
      )
    ) {
      this.logger.log('Clearing retry timeout.');
      this.schedulerRegistry.deleteTimeout(
        IndexerOrchestratorService.RETRY_TIMEOUT_NAME,
      );
    }

    this.logger.log('Starting indexing');

    try {
      this.isRunning = true;
      await this.execute();
    } catch (error) {
      this.logger.error(error);
      this.logger.log(
        `Error occured during indexing. Retrying in ${IndexerOrchestratorService.RETRY_TIMEOUT_SECONDS} seconds.`,
      );

      const timeout = setTimeout(
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        this.index.bind(this),
        IndexerOrchestratorService.RETRY_TIMEOUT_SECONDS * 1000,
      );
      this.schedulerRegistry.addTimeout(
        IndexerOrchestratorService.RETRY_TIMEOUT_NAME,
        timeout,
      );
    } finally {
      this.isRunning = false;
    }
  }

  public async execute() {
    const sraAddress = this.configService.get('SERVICE_REWARDS_ACTOR_ADDRESS', {
      infer: true,
    });

    const sraStartBlock =
      await this.filfoxApiService.getContractDeploymentEpoch(sraAddress);

    await this.serviceRewardsActorIndxer.run({
      contractAddress: sraAddress.toLowerCase() as Address,
      minBlockNumber: sraStartBlock,
      maxBlockNumber: null,
    });

    const filecoinPayContracts = await db
      .selectFrom('filecoin_pay_contract')
      .select((eb) => [
        'contract_address',
        eb.fn.max('removal_epoch').as('max_block_number'),
      ])
      .distinctOn('contract_address')
      .groupBy(['contract_address', 'removal_epoch'])
      .orderBy('contract_address')
      .orderBy('removal_epoch', (ob) => ob.desc().nullsFirst())
      .execute();

    const filecoinPayIndexerRuns = filecoinPayContracts.map(
      async (contract) => {
        const contractAddress = contract.contract_address.toLowerCase();

        if (isAddress(contractAddress)) {
          const minBlockNumber =
            await this.filfoxApiService.getContractDeploymentEpoch(
              contractAddress,
            );

          await this.filecoinPayV1Indexer.run({
            contractAddress,
            minBlockNumber,
            maxBlockNumber:
              contract.max_block_number !== null
                ? BigInt(contract.max_block_number)
                : null,
          });
        } else {
          this.logger.warn(
            `Invalid Filecoin Pay Contract address "${contractAddress} found in database."`,
          );
        }
      },
    );

    await Promise.all(filecoinPayIndexerRuns);

    const auctionableTokens = await db
      .selectFrom('filecoin_pay_rail as r')
      .select('token')
      .where('r.token', '<>', zeroAddress)
      .groupBy('token')
      .execute();

    const auctionableTokenIndexerRuns = auctionableTokens.map(async (token) => {
      const tokenAddress = token.token.toLowerCase();

      if (!isAddress(tokenAddress)) {
        this.logger.warn(
          `Rail with invalid token address "${tokenAddress}" found in database. Token won't be indexed.`,
        );

        return;
      }

      let isERC20 = false;

      try {
        await this.filfoxApiService.getERC20Metadata(tokenAddress);
        isERC20 = true;
      } catch {
        isERC20 = await this.erc20Service.isValidERC20(tokenAddress);
      }

      if (!isERC20) {
        this.logger.warn(
          `Token "${tokenAddress}" found in database does not point to a valid ERC20 contract and won't be indexer.`,
        );

        return;
      }

      const minBlockNumber =
        await this.filfoxApiService.getContractDeploymentEpoch(tokenAddress);

      await this.auctionableTokenIndexer.run({
        contractAddress: tokenAddress,
        minBlockNumber,
        maxBlockNumber: null,
      });
    });

    await Promise.all(auctionableTokenIndexerRuns);
  }

  public async getStatus(): Promise<IndexerStatusDto> {
    const [savedContractsStates, filecoinPayContracts, auctionableTokens] =
      await Promise.all([
        db
          .selectFrom('indexer_state')
          .selectAll()
          .where('version', '=', packageMajorVersion)
          .execute(),
        db
          .selectFrom('filecoin_pay_contract')
          .select((eb) => [
            'contract_address',
            eb.fn.max('removal_epoch').as('max_block_number'),
          ])
          .distinctOn('contract_address')
          .groupBy(['contract_address', 'removal_epoch'])
          .orderBy('contract_address')
          .orderBy('removal_epoch', (ob) => ob.desc().nullsFirst())
          .execute(),
        db
          .selectFrom('filecoin_pay_rail as r')
          .select('token as token_address')
          .where('r.token', '<>', zeroAddress)
          .groupBy('token')
          .execute(),
      ]);

    const indexedAddresses = [
      this.configService
        .get('SERVICE_REWARDS_ACTOR_ADDRESS', { infer: true })
        .toLowerCase(),
      ...filecoinPayContracts.map((contract) => contract.contract_address),
      ...auctionableTokens.map((token) => token.token_address),
    ];

    const contractsStates: IndexerStatusDto['contracts'] = [];

    for (const indexedAddress of indexedAddresses) {
      const savedState = savedContractsStates.find(
        (state) => state.contract_address === indexedAddress,
      );

      const indexedUpTo = savedState
        ? BigInt(savedState.end_block)
        : (await this.filfoxApiService.getContractDeploymentEpoch(
            indexedAddress as Address,
          )) - 1n;

      contractsStates.push({
        address: indexedAddress,
        indexedUpTo,
      });
    }

    return {
      version: packageSemver ? packageSemver.toString() : 'N/A',
      isRunning: this.isRunning,
      indexedUpTo: minBigInt(
        ...(contractsStates
          .filter((state) => {
            const isRemovedAndSyncedFilecoinPayAddress =
              filecoinPayContracts.find((filecoinPayContract) => {
                return (
                  isAddress(state.address) &&
                  isAddress(filecoinPayContract.contract_address) &&
                  isAddressEqual(
                    state.address,
                    filecoinPayContract.contract_address,
                  ) &&
                  filecoinPayContract.max_block_number !== null &&
                  state.indexedUpTo >=
                    numericToBigInt(filecoinPayContract.max_block_number)
                );
              });

            return !isRemovedAndSyncedFilecoinPayAddress;
          })
          .map((i) => i.indexedUpTo) as [bigint, ...bigint[]]),
      ),
      contracts: contractsStates,
    };
  }

  private async cleanupIfNeeded() {
    const invalidRun = await db
      .selectFrom('indexer_state')
      .select('contract_address')
      .where('version', '<>', packageMajorVersion)
      .executeTakeFirst();

    if (invalidRun) {
      this.logger.log('Major version changed. Performing necessary cleanup.');

      await db.transaction().execute(async (tx) => {
        await tx.deleteFrom('filecoin_pay_fee_auction').executeTakeFirst();
        await tx.deleteFrom('filecoin_pay_payment').executeTakeFirst();
        await tx.deleteFrom('filecoin_pay_rail').executeTakeFirst();
        await tx.deleteFrom('filecoin_pay_contract').executeTakeFirst();
        await tx.deleteFrom('service_pair').executeTakeFirst();
        await tx.deleteFrom('service_orchestrator').executeTakeFirst();
        await tx.deleteFrom('whitelisted_token').executeTakeFirst();
        await tx.deleteFrom('indexer_state').executeTakeFirst();
      });

      this.logger.log('Cleanup completed.');
    }
  }
}
