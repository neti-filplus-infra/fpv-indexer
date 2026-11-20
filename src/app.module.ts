import { AppController } from '@/controllers/app.controller';
import { QuartersController } from '@/controllers/quarters.controller';
import { AuctionableTokenIndexer } from '@/indexers/auctionable-token.indexer';
import { FilecoinPayV1Indexer } from '@/indexers/filecoin-pay-v1.indexer';
import { packageSemver } from '@/lib/constants';
import { validateConfig } from '@/lib/utils';
import { IndexerOrchestratorService } from '@/services/indexer-orchestrator.service';
import { QuartersService } from '@/services/quarters.service';
import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { createObserveModule } from '@nestjs/observe';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { GateController } from './controllers/gate.controller';
import { PaymentsController } from './controllers/payments.controller';
import { ServiceOrchestratorsController } from './controllers/service-orchestrators.controller';
import { VolumeController } from './controllers/volume.controller';
import { ServiceRewardsActorIndexer } from './indexers/service-rewards-actor.indexer';
import { StreamWeightActorIndexer } from './indexers/stream-weight-actor.indexer';
import {
  archiveNodeClientProvider,
  recentNodeClientProvider,
} from './lib/filecoin-client';
import { BlockNumberService } from './services/block-number-service';
import { ConfigSeedService } from './services/config-seed.service';
import { ERC20TokenInfoService } from './services/erc-20-token-info.service';
import { FilfoxApiService } from './services/filfox-api.service';
import { GateCheckService } from './services/gate-check.service';
import { IndexerRunner } from './services/indexer-runner.service';
import { PaymentsService } from './services/payments.service';
import { RpcMetricsContext } from './services/rpc-metrics-context.service';
import { ServiceOrchestratorService } from './services/service-orchestrator.service';
import { VolumeCalculationService } from './services/volume-calculation.service';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

const observeAppKey = process.env.OBSERVE_APP_KEY ?? null;
const observeAppSecret = process.env.OBSERVE_APP_SECRET ?? null;

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'test' ? 'silent' : 'debug',
      },
    }),
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
    RpcMetricsContext,
    recentNodeClientProvider,
    archiveNodeClientProvider,
    ERC20TokenInfoService,
    FilfoxApiService,
    ConfigSeedService,
    BlockNumberService,
    IndexerRunner,
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
