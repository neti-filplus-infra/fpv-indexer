import { AppController } from '@/controllers/app.controller';
import { QuartersController } from '@/controllers/quarters.controller';
import { AuctionableTokenIndexer } from '@/indexers/auctionable-token.indexer';
import { FilecoinPayV1Indexer } from '@/indexers/filecoin-pay-v1.indexer';
import {
  ARCHIVE_NODE_CLIENT,
  packageSemver,
  RECENT_NODE_CLIENT,
} from '@/lib/constants';
import type { ConfigShape, FilecoinPublicClient } from '@/lib/types';
import { createClientForChain, validateConfig } from '@/lib/utils';
import { IndexerOrchestratorService } from '@/services/indexer-orchestrator.service';
import { QuartersService } from '@/services/quarters.service';
import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module, type FactoryProvider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createObserveModule } from '@nestjs/observe';
import { ScheduleModule } from '@nestjs/schedule';
import { filecoin } from 'viem/chains';
import { GateController } from './controllers/gate.controller';
import { ServiceOrchestratorsController } from './controllers/service-orchestrators.controller';
import { VolumeController } from './controllers/volume.controller';
import { ServiceRewardsActorIndexer } from './indexers/service-rewards-actor.indexer';
import { StreamWeightActorIndexer } from './indexers/stream-weight-actor.indexer';
import { BlockNumberService } from './services/block-number-service';
import { ConfigSeedService } from './services/config-seed.service';
import { ERC20TokenInfoService } from './services/erc-20-token-info.service';
import { FilfoxApiService } from './services/filfox-api.service';
import { GateCheckService } from './services/gate-check.service';
import { ServiceOrchestratorService } from './services/service-orchestrator.service';
import { VolumeCalculationService } from './services/volume-calculation.service';
import { PaymentsService } from './services/payments.service';
import { PaymentsController } from './controllers/payments.controller';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

const observeAppKey = process.env.OBSERVE_APP_KEY ?? null;
const observeAppSecret = process.env.OBSERVE_APP_SECRET ?? null;

const recentNodeClientProvider: FactoryProvider<FilecoinPublicClient> = {
  provide: RECENT_NODE_CLIENT,
  useFactory: (configService: ConfigService<ConfigShape, true>) => {
    return createClientForChain({
      chainId: configService.get('CHAIN_ID') ?? filecoin.id,
      rpcUrl: configService.get('RECENT_RPC_URL'),
      authToken: configService.get('RECENT_RPC_AUTH_TOKEN'),
    });
  },
  inject: [ConfigService],
};

const archiveNodeClientProvider: FactoryProvider<FilecoinPublicClient> = {
  provide: ARCHIVE_NODE_CLIENT,
  useFactory: (configService: ConfigService<ConfigShape, true>) => {
    return createClientForChain({
      chainId: configService.get('CHAIN_ID') ?? filecoin.id,
      rpcUrl: configService.get('ARCHIVE_RPC_URL'),
      authToken: configService.get('ARCHIVE_RPC_AUTH_TOKEN'),
    });
  },
  inject: [ConfigService],
};

@Module({
  imports: [
    ConfigModule.forRoot({
      validate: validateConfig,
    }),
    ScheduleModule.forRoot(),
    CacheModule.register(),
    HttpModule,

    ...(observeAppKey !== null && observeAppSecret !== null
      ? [
          ObserveModule.forRoot({
            appKey: observeAppKey,
            appSecret: observeAppSecret,
            serviceId: 'fpv-indexer',
            serviceVersion: packageSemver
              ? packageSemver.toString()
              : undefined,
          }),
        ]
      : []),
  ],
  controllers: [
    AppController,
    QuartersController,
    ServiceOrchestratorsController,
    VolumeController,
    GateController,
    PaymentsController,
  ],
  providers: [
    recentNodeClientProvider,
    archiveNodeClientProvider,
    ERC20TokenInfoService,
    FilfoxApiService,
    ConfigSeedService,
    BlockNumberService,
    IndexerOrchestratorService,
    ServiceRewardsActorIndexer,
    StreamWeightActorIndexer,
    FilecoinPayV1Indexer,
    AuctionableTokenIndexer,
    QuartersService,
    VolumeCalculationService,
    ServiceOrchestratorService,
    GateCheckService,
    PaymentsService,
  ],
})
export class AppModule {}
