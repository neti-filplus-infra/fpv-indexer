/* eslint-disable @typescript-eslint/no-unsafe-argument */
import FilecoinPayV1ABI from '@/abis/filecoin-pay-v1.abi';
import { db } from '@/db/db';
import { ERC20Metadata } from '@/lib/types';
import { ConfigSeedService } from '@/services/config-seed.service';
import { IndexerOrchestratorService } from '@/services/indexer-orchestrator.service';
import { QuartersService } from '@/services/quarters.service';
import {
  INestApplication,
  StandardSchemaSerializerInterceptor,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { BigNumber } from 'bignumber.js';
import { range } from 'es-toolkit';
import { sql } from 'kysely';
import request from 'supertest';
import {
  Address,
  encodeFunctionData,
  Hash,
  isAddressEqual,
  TransactionNotFoundError,
  zeroAddress,
} from 'viem';
import { AppModule } from '../src/app.module';
import { ARCHIVE_NODE_CLIENT, RECENT_NODE_CLIENT } from '../src/lib/constants';
import '../src/polyfill';
import { ERC20TokenInfoService } from '../src/services/erc-20-token-info.service';
import { FilfoxApiService } from '../src/services/filfox-api.service';

type TestLog = {
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionIndex?: number;
  transactionHash: Hash;
};

type TestTransaction = {
  hash: Hash;
  input: Hash;
  value: bigint;
};

interface LogInputs {
  address: Address;
  blockNumber: bigint;
  txHash?: Hash;
  logIndex?: number;
  transactionIndex?: number;
}

const serviceRewardsActorValue = process.env['SERVICE_REWARDS_ACTOR_ADDRESS'];
if (!serviceRewardsActorValue) {
  throw new Error('SERVICE_REWARDS_ACTOR_ADDRESS is required for e2e tests.');
}
const serviceRewardsActor = serviceRewardsActorValue as Address;
const filecoinPayContractA =
  '0x000000000000000000000000000000000000020a' as const satisfies Address;
const filecoinPayContractB =
  '0x000000000000000000000000000000000000020b' as const satisfies Address;
const orchestratorA =
  '0x000000000000000000000000000000000000040a' as const satisfies Address;
const orchestratorB =
  '0x000000000000000000000000000000000000040b' as const satisfies Address;
const orchestratorC =
  '0x000000000000000000000000000000000000040c' as const satisfies Address;
const operatorA =
  '0x000000000000000000000000000000000000050a' as const satisfies Address;
const operatorB =
  '0x000000000000000000000000000000000000050b' as const satisfies Address;
const operatorC =
  '0x000000000000000000000000000000000000050c' as const satisfies Address;
const payerA =
  '0x000000000000000000000000000000000000060a' as const satisfies Address;
const payerB =
  '0x000000000000000000000000000000000000060b' as const satisfies Address;

class TestFilecoinClient {
  private logs: TestLog[] = [];
  private transactionsMap: Map<Hash, TestTransaction> = new Map();
  private currentBlockNumber: bigint = 0n;

  public resetWithLogs(logs: TestLog[], transactions: TestTransaction[] = []) {
    if (logs.some((log) => log.blockNumber === 0n)) {
      throw new TypeError('Test logs must start after block number 0.');
    }

    this.currentBlockNumber = 0n;
    this.replaceLogs(logs, transactions);
  }

  public replaceLogs(logs: TestLog[], transactions: TestTransaction[] = []) {
    this.logs = logs;
    this.transactionsMap = new Map(transactions.map((t) => [t.hash, t]));
  }

  public forwardTo(
    blockNumberOrFn: ((currentBlockNumber: bigint) => bigint) | bigint,
  ) {
    const blockNumber =
      typeof blockNumberOrFn === 'bigint'
        ? blockNumberOrFn
        : blockNumberOrFn(this.currentBlockNumber);

    if (blockNumber <= this.currentBlockNumber) {
      throw new Error('Must forward to a future block');
    }

    this.currentBlockNumber = blockNumber;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async getLogs({
    address,
    fromBlock,
    toBlock,
  }: {
    address?: Address;
    fromBlock?: bigint;
    toBlock?: bigint;
  }) {
    return this.logs
      .filter((log) => {
        return (
          (!address || log.address.toLowerCase() === address.toLowerCase()) &&
          (fromBlock === undefined || log.blockNumber >= fromBlock) &&
          (toBlock === undefined || log.blockNumber <= toBlock)
        );
      })
      .map((log) => ({
        ...log,
        transactionIndex: log.transactionIndex ?? 0,
      }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async getBlockNumber() {
    return this.currentBlockNumber;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async getTransaction({ hash }: { hash: Hash }) {
    const transaction = this.transactionsMap.get(hash);

    if (!transaction) {
      throw new TransactionNotFoundError({ hash });
    }

    return transaction;
  }
}

class TestToken {
  constructor(
    public readonly address: Address,
    public readonly symbol: string,
    public readonly decimals: number,
  ) {}

  public formatNumericValue(numericValue: number | bigint | string): bigint {
    const result = BigNumber(numericValue)
      .times(BigNumber(10).pow(this.decimals))
      .toBigInt();

    if (!result) {
      throw new TypeError(
        `Invalid numeric value "${numericValue}" for token ${this.symbol}`,
      );
    }

    return result;
  }
}

const filToken = new TestToken(zeroAddress, 'FIL', 18);
const usdfcToken = new TestToken(
  '0x80B98d3aa09ffff255c3ba4A241111Ff1262F045',
  'USDFC',
  18,
);
const axlUsdcToken = new TestToken(
  '0xEB466342C4d449BC9f53A865D5Cb90586f405215',
  'axlUSDC',
  6,
);

class TestERC20Service {
  private tokensMap: Map<string, TestToken>;

  constructor() {
    this.tokensMap = new Map(
      [filToken, usdfcToken, axlUsdcToken].map((t) => [
        t.address.toLowerCase(),
        t,
      ]),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async getTokenDecimals(address: string) {
    return this.getToken(address).decimals;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async getTokenSymbol(address: string) {
    return this.getToken(address).symbol;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async isValidERC20(address: string) {
    const token = this.tokensMap.get(address);

    return !!token && !isAddressEqual(token.address, zeroAddress);
  }

  private getToken(address: string): TestToken {
    const token = this.tokensMap.get(address);

    if (!token) {
      throw new TypeError(`Token "${address}" not found.`);
    }

    return token;
  }
}

class TestFilfoxApiService {
  // eslint-disable-next-line @typescript-eslint/require-await
  public async getContractDeploymentEpoch() {
    return 0n;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async getERC20Metadata(tokenAddress: string): Promise<ERC20Metadata> {
    switch (tokenAddress.toLowerCase()) {
      case usdfcToken.address.toLowerCase():
        return { decimals: usdfcToken.decimals, symbol: usdfcToken.symbol };
      case axlUsdcToken.address.toLowerCase():
        return { decimals: axlUsdcToken.decimals, symbol: axlUsdcToken.symbol };
      default:
        throw new Error(`No metadata for token ${tokenAddress}`);
    }
  }
}

describe('FIP-0118 adherence test', () => {
  let testFilecoinClient: TestFilecoinClient;
  let app: INestApplication;

  beforeAll(async () => {
    await resetDatabase();

    testFilecoinClient = new TestFilecoinClient();

    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RECENT_NODE_CLIENT)
      .useValue(testFilecoinClient)
      .overrideProvider(ARCHIVE_NODE_CLIENT)
      .useValue(testFilecoinClient)
      .overrideProvider(FilfoxApiService)
      .useValue(new TestFilfoxApiService())
      .overrideProvider(ERC20TokenInfoService)
      .useValue(new TestERC20Service())
      .compile();

    app = module.createNestApplication();
    app.useGlobalInterceptors(
      new StandardSchemaSerializerInterceptor(app.get(Reflector)),
    );
    app.useGlobalPipes(new StandardSchemaValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db.destroy();
  });

  beforeEach(async () => {
    await resetDatabase();
    await app.get(ConfigSeedService).onApplicationBootstrap();
    testFilecoinClient.resetWithLogs([]);
  });

  // Tests:
  // - ERC20 normalization
  // - totalSettledAmount is used for settlements calculation
  it('ERC20 decimals are normalized to atto-USD', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    testFilecoinClient.resetWithLogs([
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address, axlUsdcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        railId: 2n,
        logIndex: 5,
        token: axlUsdcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // settlments in Q1
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue('1.5'),
        totalNetPayeeAmount: usdfcToken.formatNumericValue('1.4'),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue('0.1'),
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 1,
        railId: 2n,
        totalSettledAmount: axlUsdcToken.formatNumericValue('1.5'),
        totalNetPayeeAmount: axlUsdcToken.formatNumericValue('1.4'),
        operatorCommission: 0n,
        networkFee: axlUsdcToken.formatNumericValue('0.1'),
      }),
    ]);

    testFilecoinClient.forwardTo(q1.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const expectedStablecoinVolume = filToken
      .formatNumericValue('3')
      .toString();

    expect(response.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolume,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolume,
    });
  });

  // Tests:
  // -  Total amount (net + commision + fee) for one time payments is used for
  //    volume calculations
  it('Gross total is used for one time payments', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    testFilecoinClient.resetWithLogs([
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // one time payment in Q1
      railOneTimePaymentProcessedLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        railId: 1n,
        netPayeeAmount: usdfcToken.formatNumericValue('1.3'),
        operatorCommission: usdfcToken.formatNumericValue('0.1'),
        networkFee: usdfcToken.formatNumericValue('0.1'),
      }),
    ]);

    testFilecoinClient.forwardTo(q1.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const expectedStablecoinVolume = filToken
      .formatNumericValue('1.5')
      .toString();

    expect(response.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolume,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolume,
    });
  });

  // Tests:
  // - Settlement at quarter startEpoch is included in quarter volume
  // - Settlement at quarter endEpoch is included in quarter volume
  // - Settlement at quarter startEpoch - 1 and quarter endEpoch + 1 are
  //   excluded from quarter volume
  it('Settlement quarter boundaries are respected', async () => {
    const q2 = await app.get(QuartersService).getQuarterByIndex(2);

    testFilecoinClient.resetWithLogs([
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // settlments in Q1
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.startEpoch - 1n,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue('100'),
        totalNetPayeeAmount: usdfcToken.formatNumericValue('99'),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue('1'),
      }),

      // settlments in Q2
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.startEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue('1.5'),
        totalNetPayeeAmount: usdfcToken.formatNumericValue('1.4'),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue('0.1'),
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.endEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue('1.5'),
        totalNetPayeeAmount: usdfcToken.formatNumericValue('1.4'),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue('0.1'),
      }),

      // settlments in Q3
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.endEpoch + 1n,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue('200'),
        totalNetPayeeAmount: usdfcToken.formatNumericValue('198'),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue('2'),
      }),
    ]);

    testFilecoinClient.forwardTo(q2.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const response = await request(app.getHttpServer())
      .get(`/volume/2/${orchestratorA}`)
      .expect(200);

    const expectedStablecoinVolume = filToken
      .formatNumericValue('3')
      .toString();

    expect(response.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolume,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolume,
    });
  });

  // Tests
  // - Same (payer, operator) across several rails must aggregate
  // - Same payer with different operators must remain separate
  // - Same operator with different payers must remain separate
  it('Settlements across multiple rails are aggregated', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    testFilecoinClient.resetWithLogs([
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        railId: 2n,
        logIndex: 5,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        railId: 3n,
        logIndex: 6,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorB,
        validator: zeroAddress,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        railId: 4n,
        logIndex: 7,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerB,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // payments in Q1
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue('1.5'),
        totalNetPayeeAmount: usdfcToken.formatNumericValue('1.4'),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue('0.1'),
      }),
      railOneTimePaymentProcessedLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 1,
        railId: 2n,
        netPayeeAmount: usdfcToken.formatNumericValue('1.4'),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue('0.1'),
      }),

      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 2,
        railId: 3n,
        totalSettledAmount: usdfcToken.formatNumericValue('150'),
        totalNetPayeeAmount: usdfcToken.formatNumericValue('140'),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue('10'),
      }),
      railOneTimePaymentProcessedLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 3,
        railId: 4n,
        netPayeeAmount: usdfcToken.formatNumericValue('140'),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue('10'),
      }),
    ]);

    testFilecoinClient.forwardTo(q1.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const expectedStablecoinVolume = filToken
      .formatNumericValue('3')
      .toString();

    expect(response.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolume,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolume,
    });
  });

  // Tests:
  // - Exclude non-admitted stablecoins from volume
  // - Exclude non-admitted Filecoin Pay contracts from volume
  // - Verify admission/removal applies only from the next quarter boundary
  it('Admitted lists are respected', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);
    const q2 = await app.get(QuartersService).getQuarterByIndex(2);

    testFilecoinClient.resetWithLogs([
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      railCreatedLog({
        address: filecoinPayContractB,
        blockNumber: 1n,
        railId: 2n,
        logIndex: 5,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 6,
        railId: 3n,
        token: axlUsdcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      railCreatedLog({
        address: filecoinPayContractB,
        blockNumber: 1n,
        railId: 4n,
        logIndex: 7,
        token: axlUsdcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // settlements in Q1
      // USDFC settlement on contract A (should count)
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(1n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      // USDFC settlement on contract B (should NOT count)
      railSettledLog({
        address: filecoinPayContractB,
        blockNumber: q1.startEpoch,
        logIndex: 1,
        railId: 2n,
        totalSettledAmount: usdfcToken.formatNumericValue(10n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(10n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      // axlUSDC settlement on contract A (should NOT count)
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 2,
        railId: 3n,
        totalSettledAmount: axlUsdcToken.formatNumericValue(100n),
        totalNetPayeeAmount: axlUsdcToken.formatNumericValue(100n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      // axlUSDC settlement on contract B (should NOT count)
      railSettledLog({
        address: filecoinPayContractB,
        blockNumber: q1.startEpoch,
        logIndex: 3,
        railId: 4n,
        totalSettledAmount: axlUsdcToken.formatNumericValue(1000n),
        totalNetPayeeAmount: axlUsdcToken.formatNumericValue(1000n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),

      // admitted lists switch during Q1 (should apply from Q2)
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: q1.endEpoch,
        logIndex: 0,
        filecoinPayContracts: [filecoinPayContractB],
        stablecoins: [axlUsdcToken.address],
      }),

      // settlements in Q2
      // USDFC settlement on contract A (should NOT count)
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.startEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(1000n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1000n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      // USDFC settlement on contract B (should NOT count)
      railSettledLog({
        address: filecoinPayContractB,
        blockNumber: q2.startEpoch,
        logIndex: 1,
        railId: 2n,
        totalSettledAmount: usdfcToken.formatNumericValue(100n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(100n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      // axlUSDC settlement on contract A (should NOT count)
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.startEpoch,
        logIndex: 2,
        railId: 3n,
        totalSettledAmount: axlUsdcToken.formatNumericValue(10n),
        totalNetPayeeAmount: axlUsdcToken.formatNumericValue(10n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      // axlUSDC settlement on contract B (should count)
      railSettledLog({
        address: filecoinPayContractB,
        blockNumber: q2.startEpoch,
        logIndex: 3,
        railId: 4n,
        totalSettledAmount: axlUsdcToken.formatNumericValue(1n),
        totalNetPayeeAmount: axlUsdcToken.formatNumericValue(1n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
    ]);

    testFilecoinClient.forwardTo(q2.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const responseQ1 = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const responseQ2 = await request(app.getHttpServer())
      .get(`/volume/2/${orchestratorA}`)
      .expect(200);

    const expectedStablecoinVolume = filToken
      .formatNumericValue('1')
      .toString();

    expect(responseQ1.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolume,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolume,
    });

    expect(responseQ2.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolume,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolume,
    });
  });

  // Tests:
  // - settlements made on unbound pairs do not count towards quarterly volume
  it('Excludes unbound settlements and one time payments', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    testFilecoinClient.resetWithLogs([
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorB,
        wallet: orchestratorB,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 4,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerB,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 5,
        orchestrator: orchestratorB,
        operator: operatorB,
        payer: payerA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 6,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        railId: 2n,
        logIndex: 7,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerB,
        operator: operatorB,
        validator: zeroAddress,
      }),

      // Q1 payments
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(100n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(100n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      railOneTimePaymentProcessedLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 1,
        railId: 2n,
        netPayeeAmount: usdfcToken.formatNumericValue(100n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
    ]);

    testFilecoinClient.forwardTo(q1.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const responseA = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const responseB = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorB}`)
      .expect(200);

    const expectedStablecoinVolume = '0';

    expect(responseA.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolume,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolume,
    });

    expect(responseB.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolume,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolume,
    });
  });

  // Tests:
  // - previously unbound settlements count towards quarterly volume of an
  //   orchestrator if registration happens after settlement but before
  //   registration cutoff
  it('Back-covers unbound volume after mid-quarter registration', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);
    const q2 = await app.get(QuartersService).getQuarterByIndex(2);

    testFilecoinClient.resetWithLogs([
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 3,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Q1 events

      // Rail settlement in Q1 (should NOT count if pair registered in Q2)
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(1000n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1000n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),

      // Q2 events

      // Settlement in Q2 (should count even if pair is registered after
      // settlement, but before REGISTRATION_CUTOFF)
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.startEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(1n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),

      // Binding after some settlements using that pair in Q2 were made
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q2.startEpoch + 1n,
        logIndex: 0,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerA,
      }),

      // Settlement after binding, the default case
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.startEpoch + 2n,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(1n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
    ]);

    testFilecoinClient.forwardTo(q2.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const responseQ1 = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const responseQ2 = await request(app.getHttpServer())
      .get(`/volume/2/${orchestratorA}`)
      .expect(200);

    const expectedStablecoinVolumeQ2 = filToken
      .formatNumericValue(2n)
      .toString();

    expect(responseQ1.body).toMatchObject({
      stablecoinVolumeAttoUsd: '0',
      filVolumeAttoUsd: '0',
      volumeAttoUsd: '0',
    });

    expect(responseQ2.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolumeQ2,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolumeQ2,
    });
  });

  // Tests:
  // - settlements bound after REGISTRATION_CUTTOFF are properly excluded from
  //   volume of quarter registration was made in
  // - they are properly included in next quarter
  it('Excludes volume if registration was made in REGISTRATION_CUTOFF period', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);
    const q2 = await app.get(QuartersService).getQuarterByIndex(2);

    testFilecoinClient.resetWithLogs([
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 3,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 2n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerB,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Q1 events

      // Rail 1 settlement in Q1 (should count if pair registered before cutoff)
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(1n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),

      // Rail 2 settlement in Q1 (should NOT count if pair registered after
      // cutoff)
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 1,
        railId: 2n,
        totalSettledAmount: usdfcToken.formatNumericValue(1000n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1000n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),

      // Registration of rail 1 pair before cutoff
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 4n,
        logIndex: 0,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerA,
      }),

      // Registration of rail 2 pair after cutoff
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 5n,
        logIndex: 0,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerB,
      }),

      // Q2 events

      // Rail 2 settlement in Q2 (should now count)
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.startEpoch,
        logIndex: 0,
        railId: 2n,
        totalSettledAmount: usdfcToken.formatNumericValue(1n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
    ]);

    testFilecoinClient.forwardTo(q2.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const responseQ1 = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const responseQ2 = await request(app.getHttpServer())
      .get(`/volume/2/${orchestratorA}`)
      .expect(200);

    const expectedStablecoinVolume = filToken.formatNumericValue(1n).toString();

    expect(responseQ1.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolume,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolume,
    });

    expect(responseQ2.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolume,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolume,
    });
  });

  // Tests:
  // - orchestrator bindings are released on orchestrator removal
  // - another orchestrator can bind released pairs
  // - same epoch settlement/release/binding is ordered correctly
  it('Attributes volume properly after orchestrator removal', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    testFilecoinClient.resetWithLogs([
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorB,
        wallet: orchestratorB,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 5,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerA,
      }),

      // Settlement before A removal, should count towards A
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(1n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),

      // A gets removed same epoch, binding should be released
      orchestratorRemovedLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 1,
        orchestrator: orchestratorA,
      }),
      // Same epoch released settlement
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 2,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(10n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(10n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),

      // B bind released pair, previous settlement now counts towards B's volume
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 2n,
        logIndex: 0,
        orchestrator: orchestratorB,
        operator: operatorA,
        payer: payerA,
      }),

      // Another settlement when B already binds the pair
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 3n,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(100n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(100n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
    ]);

    testFilecoinClient.forwardTo(q1.endEpoch + 1n);
    await app.get(IndexerOrchestratorService).execute();

    const responseA = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const responseB = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorB}`)
      .expect(200);

    expect(responseA.body).toMatchObject({
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(1n).toString(),
      filVolumeAttoUsd: '0',
      volumeAttoUsd: usdfcToken.formatNumericValue(1n).toString(),
    });

    expect(responseB.body).toMatchObject({
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(110n).toString(),
      filVolumeAttoUsd: '0',
      volumeAttoUsd: usdfcToken.formatNumericValue(110n).toString(),
    });
  });

  // Tests:
  // - orchestrator bindings are released on reassigment
  // - volume is correctly inherited if a flag is set
  // - another orchestrator can bind released pairs
  // - same epoch settlement/reassignment is ordered correctly
  it('Attributes volume properly after binding reassignment', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);
    const q2 = await app.get(QuartersService).getQuarterByIndex(2);

    const commonRailOptions = {
      address: filecoinPayContractA,
      token: usdfcToken.address,
      payee: zeroAddress,
      validator: zeroAddress,
    } as const;

    const rail1 = {
      railId: 1n,
      payer: payerA,
      operator: operatorA,
    } as const;

    const rail2 = {
      railId: 2n,
      payer: payerA,
      operator: operatorB,
    };

    const rail3 = {
      railId: 3n,
      payer: payerA,
      operator: operatorC,
    } as const;

    const rail4 = {
      railId: 4n,
      payer: payerB,
      operator: operatorA,
    };

    const rail5 = {
      railId: 5n,
      payer: payerB,
      operator: operatorB,
    };

    const railCreationLogs = [rail1, rail2, rail3, rail4, rail5].map(
      (rail, index) => {
        return railCreatedLog({
          ...commonRailOptions,
          ...rail,
          blockNumber: 2n,
          logIndex: index,
        });
      },
    );

    testFilecoinClient.resetWithLogs([
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorB,
        wallet: orchestratorB,
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 4,
        orchestrator: orchestratorC,
        wallet: orchestratorC,
      }),
      ...railCreationLogs,

      // Case 1: Bound to A -> settlement 1 -> reassignment to B without inherit
      // -> settlement 2, all in one epoch. Default non malicient reassignment.
      // Settlment 1 should count towards A's Q1 volume and settlment 2 towards
      // B's Q1 volume.
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        orchestrator: orchestratorA,
        operator: rail1.operator,
        payer: rail1.payer,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 1,
        railId: rail1.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(1),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      bindingReassignedLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch,
        logIndex: 2,
        orchestrator: orchestratorB,
        operator: rail1.operator,
        payer: rail1.payer,
        inherit: false,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 3,
        railId: rail1.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(2),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(2),
        operatorCommission: 0n,
        networkFee: 0n,
      }),

      // Case 2: Bound to A -> settlement 1 -> reassignment to B with inherit
      // -> settlement 2, all in one epoch. Default malicient reassignment.
      // Both settlment 1 and settlment 2 should count towards B's Q1 volume.
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 0,
        orchestrator: orchestratorA,
        operator: rail2.operator,
        payer: rail2.payer,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 1,
        railId: rail2.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(10),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(10),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      bindingReassignedLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 2,
        orchestrator: orchestratorB,
        operator: rail2.operator,
        payer: rail2.payer,
        inherit: true,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 3,
        railId: rail2.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(20),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(20),
        operatorCommission: 0n,
        networkFee: 0n,
      }),

      // Case 3: Bound to A in Q1 -> settlement 1 in Q2 -> reassigned to B with
      // inherit -> settlement 2. Special pair held longer case. Settlment 1
      // should count towards A's Q2 volume and settlment 2 towards B's Q2
      // volume.
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 2n,
        logIndex: 0,
        orchestrator: orchestratorA,
        operator: rail3.operator,
        payer: rail3.payer,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.startEpoch + 2n,
        logIndex: 1,
        railId: rail3.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(100),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(100),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      bindingReassignedLog({
        address: serviceRewardsActor,
        blockNumber: q2.startEpoch + 2n,
        logIndex: 2,
        orchestrator: orchestratorB,
        operator: rail3.operator,
        payer: rail3.payer,
        inherit: true,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.startEpoch + 2n,
        logIndex: 3,
        railId: rail3.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(200),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(200),
        operatorCommission: 0n,
        networkFee: 0n,
      }),

      // Case 4: Bound to C -> settlement 1 -> released -> bound to A ->
      // settlement 2 -> reassigned to B with inherit -> settlement 3 all in one
      // epoch. Maleficient reassignment honoring previous bindings.
      // Settlement 1 should count towards C's volume, settlments 2 and 3
      // towards B's volume, A gets nothing.
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 3n,
        logIndex: 0,
        orchestrator: orchestratorC,
        operator: rail4.operator,
        payer: rail4.payer,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 3n,
        logIndex: 1,
        railId: rail4.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(3000),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(3000),
        networkFee: 0n,
        operatorCommission: 0n,
      }),
      bindingCanceledLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 3n,
        logIndex: 2,
        payer: rail4.payer,
        operator: rail4.operator,
        orchestrator: orchestratorC,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 3n,
        logIndex: 3,
        orchestrator: orchestratorA,
        operator: rail4.operator,
        payer: rail4.payer,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 3n,
        logIndex: 4,
        railId: rail4.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(1000),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1000),
        networkFee: 0n,
        operatorCommission: 0n,
      }),
      bindingReassignedLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 3n,
        logIndex: 5,
        orchestrator: orchestratorB,
        operator: rail4.operator,
        payer: rail4.payer,
        inherit: true,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 3n,
        logIndex: 6,
        railId: rail4.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(2000),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(2000),
        networkFee: 0n,
        operatorCommission: 0n,
      }),

      // Case 5: Settlement 1 in Q1 -> bound to A during Q1 cutoff -> reassigned
      // to B during Q1 cutoff with inherit -> settlement 2 in Q2. No one should
      // get settlement 1 and settlement 2 should count towards B's Q2 volume.
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.endEpoch,
        logIndex: 0,
        railId: rail5.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(10000),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(10000),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.endEpoch,
        logIndex: 1,
        orchestrator: orchestratorA,
        operator: rail5.operator,
        payer: rail5.payer,
      }),
      bindingReassignedLog({
        address: serviceRewardsActor,
        blockNumber: q1.endEpoch,
        logIndex: 2,
        orchestrator: orchestratorB,
        operator: rail5.operator,
        payer: rail5.payer,
        inherit: true,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q2.startEpoch + 4n,
        logIndex: 0,
        railId: rail5.railId,
        totalSettledAmount: usdfcToken.formatNumericValue(20000),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(20000),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
    ]);

    testFilecoinClient.forwardTo(q2.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const responseQ1A = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);
    const responseQ1B = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorB}`)
      .expect(200);
    const responseQ1C = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorC}`)
      .expect(200);
    const responseQ2A = await request(app.getHttpServer())
      .get(`/volume/2/${orchestratorA}`)
      .expect(200);
    const responseQ2B = await request(app.getHttpServer())
      .get(`/volume/2/${orchestratorB}`)
      .expect(200);

    expect(responseQ1A.body).toMatchObject({
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(1).toString(),
      volumeAttoUsd: usdfcToken.formatNumericValue(1).toString(),
    });
    expect(responseQ1B.body).toMatchObject({
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(3032).toString(),
      volumeAttoUsd: usdfcToken.formatNumericValue(3032).toString(),
    });
    expect(responseQ1C.body).toMatchObject({
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(3000).toString(),
      volumeAttoUsd: usdfcToken.formatNumericValue(3000).toString(),
    });
    expect(responseQ2A.body).toMatchObject({
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(100).toString(),
      volumeAttoUsd: usdfcToken.formatNumericValue(100).toString(),
    });
    expect(responseQ2B.body).toMatchObject({
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(20200).toString(),
      volumeAttoUsd: usdfcToken.formatNumericValue(20200).toString(),
    });
  });

  // Tests:
  // - orchestrator bindings are released on cancellation
  // - another orchestrator can bind released pairs
  // - same epoch settlement/cancellation is ordered correctly
  it('Attributes volume properly after binding cancellation', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    testFilecoinClient.resetWithLogs([
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 0n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorB,
        wallet: orchestratorB,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerA,
      }),

      // Settlement before cancellation attributed to A
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(1n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      bindingCanceledLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 1,
        orchestrator: orchestratorA,
        operator: operatorA,
        payer: payerA,
      }),
      // Unbound settlement
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 2,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(10n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(10n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      // B binds released pair
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 3,
        orchestrator: orchestratorB,
        operator: operatorA,
        payer: payerA,
      }),
      // Settlement bound to B
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 4,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(100n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(100n),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
    ]);

    testFilecoinClient.forwardTo(q1.endEpoch + 1n);
    await app.get(IndexerOrchestratorService).execute();

    const responseA = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const responseB = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorB}`)
      .expect(200);

    expect(responseA.body).toMatchObject({
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(1n).toString(),
      volumeAttoUsd: usdfcToken.formatNumericValue(1n).toString(),
    });

    expect(responseB.body).toMatchObject({
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(110n).toString(),
      volumeAttoUsd: usdfcToken.formatNumericValue(110n).toString(),
    });
  });

  // Tests:
  // - settlement and print on same epoch must be ordered by log index
  // - print before settlement does not price it
  // - first qualifying print strictly after settlement must price it even if
  //   there are multiple prints in the same epoch
  it('Matches prints strictly after settlement', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    const transfers = range(0, 8).map((index) => {
      return transferLog({
        address: usdfcToken.address,
        blockNumber: index >= 5 ? q1.startEpoch + 1n : q1.startEpoch,
        logIndex: index >= 5 ? 2 * (index % 5) : index,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(10 + index),
      });
    });

    const transactions = transfers.map((transfer) => {
      return burnForFeesTransaction({
        hash: transfer.transactionHash,
        recipient: transfer.args.to,
        requested: transfer.args.value,
        token: transfer.address,
        value: filToken.formatNumericValue(1n),
      });
    });

    const logs = [
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: filToken.formatNumericValue('0.5'),
        minLotAlphaDen: 1n,
        minLotAlphaNum: 400n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        payer: payerA,
        operator: operatorA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: filToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Rail to seed auctionable tokens indexing
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 5,
        railId: 2n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Q1 events
      ...transfers,

      // Settlement after 1st price period but before second price period
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 1,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(10n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(9n),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue(1n),
      }),

      // Settlement after last price period (should not be counted)
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 5,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(1000n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(900n),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue(100n),
      }),
    ];

    testFilecoinClient.resetWithLogs(logs, transactions);
    testFilecoinClient.forwardTo(q1.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const expectedFilVolume = filToken.formatNumericValue(160n).toString();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pricingPeriods = response.body.pricingPeriods as unknown[];

    expect(response.body).toMatchObject({
      stablecoinVolumeAttoUsd: '0',
      filVolumeAttoUsd: expectedFilVolume,
      volumeAttoUsd: expectedFilVolume,
    });

    expect(pricingPeriods.length).toBe(3);
    expect(pricingPeriods[0]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(15n).toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: '0',
      volumeAttoUsd: '0',
    });
    expect(pricingPeriods[1]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(16n).toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: filToken.formatNumericValue(10n).toString(),
      volumeAttoUsd: expectedFilVolume,
    });
    expect(pricingPeriods[2]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(17n).toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: '0',
      volumeAttoUsd: '0',
    });
  });

  // Tests:
  // - FIL settlement after last qualifying print in a quarter should be priced
  //   by first qualyifing print in subsequent quarters
  // - no settlement should be counted twice
  it('Pending FIL volume rolls forward', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);
    const q2 = await app.get(QuartersService).getQuarterByIndex(2);

    const seedTransfers = range(0, 5).map((index) => {
      return transferLog({
        address: usdfcToken.address,
        blockNumber: q1.startEpoch,
        logIndex: index,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(10 + index),
      });
    });

    const q1TransferLog = transferLog({
      address: usdfcToken.address,
      blockNumber: q1.startEpoch + 1n,
      logIndex: 0,
      from: filecoinPayContractA,
      to: payerA,
      value: usdfcToken.formatNumericValue(15n),
    });

    const q2TransferLog = transferLog({
      address: usdfcToken.address,
      blockNumber: q2.startEpoch + 1n,
      logIndex: 0,
      from: filecoinPayContractA,
      to: payerA,
      value: usdfcToken.formatNumericValue(16n),
    });

    const transactions = [...seedTransfers, q1TransferLog, q2TransferLog].map(
      (transfer) => {
        return burnForFeesTransaction({
          hash: transfer.transactionHash,
          recipient: transfer.args.to,
          requested: transfer.args.value,
          token: transfer.address,
          value: filToken.formatNumericValue(1n),
        });
      },
    );

    const logs = [
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: filToken.formatNumericValue('0.5'),
        minLotAlphaDen: 1n,
        minLotAlphaNum: 400n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        payer: payerA,
        operator: operatorA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: filToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Rail to seed auctionable tokens indexing
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 5,
        railId: 2n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Q1 events
      ...seedTransfers,
      q1TransferLog,

      // Settlement after last Q1 price period should be counted in Q2
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 2n,
        logIndex: 1,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(10n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(9n),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue(1n),
      }),

      // Q2 events
      q2TransferLog,
    ];

    testFilecoinClient.resetWithLogs(logs, transactions);
    testFilecoinClient.forwardTo(q2.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const responseQ1 = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const responseQ2 = await request(app.getHttpServer())
      .get(`/volume/2/${orchestratorA}`)
      .expect(200);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pricingPeriodsQ1 = responseQ1.body.pricingPeriods as unknown[];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pricingPeriodsQ2 = responseQ2.body.pricingPeriods as unknown[];

    expect(responseQ1.body).toMatchObject({
      stablecoinVolumeAttoUsd: '0',
      filVolumeAttoUsd: '0',
      volumeAttoUsd: '0',
    });

    expect(responseQ2.body).toMatchObject({
      stablecoinVolumeAttoUsd: '0',
      filVolumeAttoUsd: filToken.formatNumericValue(160n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(160n).toString(),
    });

    expect(pricingPeriodsQ1.length).toBe(1);
    expect(pricingPeriodsQ1[0]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(15n).toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: '0',
      volumeAttoUsd: '0',
    });

    expect(pricingPeriodsQ2.length).toBe(1);
    expect(pricingPeriodsQ2[0]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(16n).toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: filToken.formatNumericValue(10n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(160n).toString(),
    });
  });

  // Tests:
  // - Seed prints do not price volume
  // - First qualifying print after seed prices all pending volume
  it('Seed prints do not price volume', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    const transfers = range(0, 6).map((index) => {
      return transferLog({
        address: usdfcToken.address,
        blockNumber: q1.startEpoch + 1n + BigInt(index),
        logIndex: 0,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(10 + index),
      });
    });

    const transactions = transfers.map((transfer) => {
      return burnForFeesTransaction({
        hash: transfer.transactionHash,
        recipient: transfer.args.to,
        requested: transfer.args.value,
        token: transfer.address,
        value: filToken.formatNumericValue(1n),
      });
    });

    const logs = [
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: filToken.formatNumericValue('0.5'),
        minLotAlphaDen: 1n,
        minLotAlphaNum: 400n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        payer: payerA,
        operator: operatorA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: filToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Rail to seed auctionable tokens indexing
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 5,
        railId: 2n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Settlement before seed prints that should not be priced by them
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(10n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(9n),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue(1n),
      }),

      ...transfers,
    ];

    testFilecoinClient.resetWithLogs(logs, transactions);
    testFilecoinClient.forwardTo(q1.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pricingPeriods = response.body.pricingPeriods as unknown[];

    expect(response.body).toMatchObject({
      stablecoinVolumeAttoUsd: '0',
      filVolumeAttoUsd: filToken.formatNumericValue(150n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(150n).toString(),
    });

    expect(pricingPeriods.length).toBe(1);
    expect(pricingPeriods[0]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(15n).toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: filToken.formatNumericValue(10n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(150n).toString(),
    });
  });

  // Tests:
  // - Seed auctions median is properly calculated using ordering by comparsion
  //   to avoid division, not arithmetic mean.
  it('Calculates seed median properly', async () => {
    const priceBandBps = 0n;
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    const seedTransfers = range(0, 5).map((index) => {
      return transferLog({
        address: usdfcToken.address,
        blockNumber: q1.startEpoch,
        logIndex: index,
        from: filecoinPayContractA,
        to: payerA,

        // Ratios 1, 2, 3, 4, 100. Artifically high ratio on last print.
        // Arithemtic mean is 22 but median by comparsion is 3 (middle item).
        value:
          index === 4
            ? usdfcToken.formatNumericValue(100n)
            : usdfcToken.formatNumericValue(index + 1),
      });
    });

    const nonQualifyingTransfer = transferLog({
      address: usdfcToken.address,
      // After settlement on block start + 1
      blockNumber: q1.startEpoch + 2n,
      logIndex: 0,
      from: filecoinPayContractA,
      to: payerA,
      // Value of 22 would pass decimal median price band but should fail here
      // with price band of 0% (exact median)
      value: usdfcToken.formatNumericValue(22n),
    });

    const qualifyingTransfer = transferLog({
      address: usdfcToken.address,
      // After settlement on block start + 1
      blockNumber: q1.startEpoch + 2n,
      logIndex: 1,
      from: filecoinPayContractA,
      to: payerA,
      // Value of 3 would fail decimal median price band but should pass here
      // with price band of 0% (exact median)
      value: usdfcToken.formatNumericValue(3n),
    });

    const transactions = [
      ...seedTransfers,
      nonQualifyingTransfer,
      qualifyingTransfer,
    ].map((transfer) => {
      return burnForFeesTransaction({
        hash: transfer.transactionHash,
        recipient: transfer.args.to,
        requested: transfer.args.value,
        token: transfer.address,
        value: filToken.formatNumericValue(1n),
      });
    });

    const logs = [
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 400n,
        priceBand: priceBandBps,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        payer: payerA,
        operator: operatorA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: filToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Rail to seed auctionable tokens indexing
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 5,
        railId: 2n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Q1 events
      ...seedTransfers,

      // Settlement before price band checked prints
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch + 1n,
        logIndex: 0,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(10n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(9n),
        operatorCommission: 0n,
        networkFee: usdfcToken.formatNumericValue(1n),
      }),

      nonQualifyingTransfer,
      qualifyingTransfer,
    ];

    testFilecoinClient.resetWithLogs(logs, transactions);
    testFilecoinClient.forwardTo(q1.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pricingPeriods = response.body.pricingPeriods as unknown[];

    expect(response.body).toMatchObject({
      stablecoinVolumeAttoUsd: '0',
      filVolumeAttoUsd: filToken.formatNumericValue(30n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(30n).toString(),
    });

    expect(pricingPeriods.length).toBe(1);
    expect(pricingPeriods[0]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(3n).toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: filToken.formatNumericValue(10n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(30n).toString(),
    });
  });

  // Test:
  // - seed auctions in Q1 don't qualify if below min lot floor
  // - seed auctions in subsequent quarters don't qualify if they don't clear
  //   min lot calculated from previous quarter state and pricing params
  // - post seed auctions follow same rules
  it('Properly calculates min lot floor and qualifies price prints based on it', async () => {
    const minLotFloor = filToken.formatNumericValue('1.5');
    const minLotAlphaNum = 1n;
    const minLotAlphaDen = 10n;
    const priceBandBps = 0n;
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);
    const q2 = await app.get(QuartersService).getQuarterByIndex(2);

    const transferLogs = [
      // Q1

      // All 3 clear min lot floor
      transferLog({
        address: usdfcToken.address,
        // After settlement on Q1 start
        blockNumber: q1.startEpoch + 1n,
        logIndex: 0,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(6n),
      }),
      transferLog({
        address: usdfcToken.address,
        // After settlement on Q1 start
        blockNumber: q1.startEpoch + 1n,
        logIndex: 1,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(8n),
      }),
      transferLog({
        address: usdfcToken.address,
        // After settlement on Q1 start
        blockNumber: q1.startEpoch + 1n,
        logIndex: 2,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(4n),
      }),

      // Below min lot floor, no min lot yet for Q1
      transferLog({
        address: usdfcToken.address,
        // After settlement on Q1 start
        blockNumber: q1.startEpoch + 1n,
        logIndex: 3,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(1n),
      }),

      // Q2. We still don't have 5 seed auctions. Min lot now calculated based
      // on Q1 volume and params, should be 10USD (300 * (1 / 10) / 3)

      // Below new min lot
      transferLog({
        address: usdfcToken.address,
        blockNumber: q2.startEpoch,
        logIndex: 0,
        from: filecoinPayContractA,
        to: payerA,
        // Below 10USD
        value: usdfcToken.formatNumericValue(9n),
      }),

      // Both clear new min lot
      transferLog({
        address: usdfcToken.address,
        blockNumber: q2.startEpoch,
        logIndex: 1,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(10n),
      }),
      transferLog({
        address: usdfcToken.address,
        blockNumber: q2.startEpoch,
        logIndex: 2,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(12n),
      }),

      // First qualifying print after seed, median should be 8.
      // Check by using same price with 0% price band.
      transferLog({
        address: usdfcToken.address,
        blockNumber: q2.startEpoch + 1n,
        logIndex: 0,
        from: filecoinPayContractA,
        to: payerA,
        // Exact seed median
        value: usdfcToken.formatNumericValue(8n),
      }),
    ];

    const transactions = transferLogs.map((transfer) => {
      return burnForFeesTransaction({
        hash: transfer.transactionHash,
        recipient: transfer.args.to,
        requested: transfer.args.value,
        token: transfer.address,
        value: filToken.formatNumericValue(1n),
      });
    });

    const logs = [
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor,
        minLotAlphaDen,
        minLotAlphaNum,
        priceBand: priceBandBps,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        payer: payerA,
        operator: operatorA,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: filToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 5,
        railId: 2n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Settlements before prints, 300USD for Q1 volume and 10FIL to test
      // pricing in Q2
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        railId: 2n,
        totalSettledAmount: usdfcToken.formatNumericValue(300n),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(240n),
        networkFee: usdfcToken.formatNumericValue(60n),
        operatorCommission: 0n,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 1,
        railId: 1n,
        totalSettledAmount: filToken.formatNumericValue(10n),
        totalNetPayeeAmount: filToken.formatNumericValue(9n),
        networkFee: filToken.formatNumericValue(1n),
        operatorCommission: 0n,
      }),

      ...transferLogs,

      sharesSubmittedLog({
        address: serviceRewardsActor,
        blockNumber: q2.startEpoch + 2n,
        logIndex: 0,
        q: 1n,
        totalUsd: filToken.formatNumericValue(300n),
      }),
    ];

    testFilecoinClient.resetWithLogs(logs, transactions);
    testFilecoinClient.forwardTo(q2.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const responseQ1 = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const responseQ2 = await request(app.getHttpServer())
      .get(`/volume/2/${orchestratorA}`)
      .expect(200);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pricingPeriodsQ1 = responseQ1.body.pricingPeriods as unknown[];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pricingPeriodsQ2 = responseQ2.body.pricingPeriods as unknown[];

    expect(responseQ1.body).toMatchObject({
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(300n).toString(),
      filVolumeAttoUsd: '0',
      volumeAttoUsd: usdfcToken.formatNumericValue(300n).toString(),
    });

    expect(pricingPeriodsQ1.length).toBe(0);

    expect(responseQ2.body).toMatchObject({
      stablecoinVolumeAttoUsd: '0',
      filVolumeAttoUsd: filToken.formatNumericValue(80n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(80n).toString(),
    });

    expect(pricingPeriodsQ2.length).toBe(1);
    expect(pricingPeriodsQ2[0]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(8n).toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: filToken.formatNumericValue(10n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(80n).toString(),
    });
  });

  // Test:
  // - auction with lot/claim below price band lower threshold does not qualify
  // - auction with lot/claim above price band upper threshold does not qualify
  // - auction with lot/claim between (inclusive) both thresholds qualify
  it('Respects price-band boundaries when qualifying prints', async () => {
    const priceBandBps = 3000n; // 30%
    const initialLotUsd = 10n;
    const upperPriceBand = usdfcToken.formatNumericValue(13);
    const lowerPriceBand = usdfcToken.formatNumericValue(7);
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    const usdfcRailLog = railCreatedLog({
      address: filecoinPayContractA,
      blockNumber: 1n,
      logIndex: 4,
      railId: 1n,
      token: filToken.address,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    const seedAuctions = range(0, 5).map((index) => {
      return transferLog({
        address: usdfcToken.address,
        blockNumber: q1.startEpoch,
        logIndex: index,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(initialLotUsd),
      });
    });

    const beforeUpperPriceBandSettlement = railSettledLog({
      address: filecoinPayContractA,
      blockNumber: q1.startEpoch + 1n,
      logIndex: 0,
      railId: usdfcRailLog.args.railId,
      totalSettledAmount: usdfcToken.formatNumericValue(100n),
      totalNetPayeeAmount: usdfcToken.formatNumericValue(90n),
      operatorCommission: 0n,
      networkFee: usdfcToken.formatNumericValue(10n),
    });

    const aboveUpperPriceBandAuction = transferLog({
      address: usdfcToken.address,
      blockNumber: beforeUpperPriceBandSettlement.blockNumber + 1n,
      logIndex: 0,
      from: filecoinPayContractA,
      to: payerA,
      value: upperPriceBand + 1n,
    });

    const upperPriceBandAuction = transferLog({
      address: usdfcToken.address,
      blockNumber: aboveUpperPriceBandAuction.blockNumber,
      logIndex: aboveUpperPriceBandAuction.logIndex + 1,
      from: filecoinPayContractA,
      to: payerA,
      value: upperPriceBand,
    });

    const resetAuction = transferLog({
      address: usdfcToken.address,
      blockNumber: upperPriceBandAuction.blockNumber,
      logIndex: upperPriceBandAuction.logIndex + 1,
      from: filecoinPayContractA,
      to: payerA,
      value: usdfcToken.formatNumericValue(initialLotUsd),
    });

    const beforeLowerPriceBandSettlement = railSettledLog({
      address: filecoinPayContractA,
      blockNumber: resetAuction.blockNumber + 1n,
      logIndex: 0,
      railId: usdfcRailLog.args.railId,
      totalSettledAmount: usdfcToken.formatNumericValue(1000n),
      totalNetPayeeAmount: usdfcToken.formatNumericValue(900n),
      operatorCommission: 0n,
      networkFee: usdfcToken.formatNumericValue(100n),
    });

    const belowLowerPriceBandAuction = transferLog({
      address: usdfcToken.address,
      blockNumber: beforeLowerPriceBandSettlement.blockNumber + 1n,
      logIndex: 0,
      from: filecoinPayContractA,
      to: payerA,
      value: lowerPriceBand - 1n,
    });

    const lowerPriceBandAuction = transferLog({
      address: usdfcToken.address,
      blockNumber: beforeLowerPriceBandSettlement.blockNumber + 1n,
      logIndex: 0,
      from: filecoinPayContractA,
      to: payerA,
      value: lowerPriceBand,
    });

    const logs = [
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 400n,
        priceBand: priceBandBps,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        payer: payerA,
        operator: operatorA,
      }),
      usdfcRailLog,

      // Rail to seed auctionable tokens indexing
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 5,
        railId: 2n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // Q1 events
      ...seedAuctions,
      beforeUpperPriceBandSettlement,
      aboveUpperPriceBandAuction,
      upperPriceBandAuction,
      resetAuction,
      beforeLowerPriceBandSettlement,
      belowLowerPriceBandAuction,
      lowerPriceBandAuction,
    ];

    const transactions = [
      ...seedAuctions,
      aboveUpperPriceBandAuction,
      upperPriceBandAuction,
      resetAuction,
      belowLowerPriceBandAuction,
      lowerPriceBandAuction,
    ].map((transfer) => {
      return burnForFeesTransaction({
        hash: transfer.transactionHash,
        recipient: transfer.args.to,
        requested: transfer.args.value,
        token: transfer.address,
        value: filToken.formatNumericValue(1n),
      });
    });

    testFilecoinClient.resetWithLogs(logs, transactions);
    testFilecoinClient.forwardTo(q1.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pricingPeriods = response.body.pricingPeriods as unknown[];

    expect(response.body).toMatchObject({
      stablecoinVolumeAttoUsd: '0',
      filVolumeAttoUsd: filToken.formatNumericValue(8300n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(8300n).toString(),
    });

    expect(pricingPeriods.length).toBe(3);

    expect(pricingPeriods[0]).toMatchObject({
      lotAttoUsd: upperPriceBand.toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: filToken.formatNumericValue(100n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(1300n).toString(),
    });

    expect(pricingPeriods[1]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(initialLotUsd).toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: '0',
      volumeAttoUsd: '0',
    });

    expect(pricingPeriods[2]).toMatchObject({
      lotAttoUsd: lowerPriceBand.toString(),
      claimAttoFil: filToken.formatNumericValue(1n).toString(),
      volumeAttoFil: filToken.formatNumericValue(1000n).toString(),
      volumeAttoUsd: filToken.formatNumericValue(7000n).toString(),
    });
  });

  // Tests:
  // - seed auction on not admitted FP contract does not qualify
  // - seed auction using not admitted token does not qualify
  // - same rules apply after seeding
  it('Filters prints with non admitted contracts or tokens', async () => {
    const indexerOrchestrator = app.get(IndexerOrchestratorService);
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);
    const auctionClaim = filToken.formatNumericValue(1n);

    testFilecoinClient.resetWithLogs([
      // bootstrap
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 400n,
        priceBand: 10000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA, filecoinPayContractB],
        stablecoins: [usdfcToken.address, axlUsdcToken.address],
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 2,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),

      // USDFC rail
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 4,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // axlUSDC rail
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 5,
        railId: 2n,
        token: axlUsdcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // FIL rail
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 6,
        railId: 3n,
        token: filToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),
    ]);

    testFilecoinClient.forwardTo(q1.startEpoch - 1n);

    // need to index multiple times with fresh set of logs because test
    // implementation does not support advanced filtering eg. by indexed args
    await indexerOrchestrator.execute();

    // Not admitted contract seed case
    const notAdmittedContractSeedAuction = transferLog({
      address: usdfcToken.address,
      blockNumber: q1.startEpoch,
      logIndex: 0,
      from: filecoinPayContractB,
      to: payerA,
      value: usdfcToken.formatNumericValue(21n),
    });

    const notAdmittedContractSeedAuctionTx = burnForFeesTransaction({
      hash: notAdmittedContractSeedAuction.transactionHash,
      requested: notAdmittedContractSeedAuction.args.value,
      token: notAdmittedContractSeedAuction.address,
      value: auctionClaim,
    });

    testFilecoinClient.replaceLogs(
      [notAdmittedContractSeedAuction],
      [notAdmittedContractSeedAuctionTx],
    );

    testFilecoinClient.forwardTo((b) => b + 2n);

    await indexerOrchestrator.execute();

    // Not admitted token seed case
    const notAdmittedTokenSeedAuction = transferLog({
      address: axlUsdcToken.address,
      blockNumber: notAdmittedContractSeedAuction.blockNumber + 1n,
      logIndex: 0,
      from: filecoinPayContractA,
      to: payerA,
      value: axlUsdcToken.formatNumericValue(22n),
    });

    const notAdmittedTokenSeedAuctionTx = burnForFeesTransaction({
      hash: notAdmittedTokenSeedAuction.transactionHash,
      requested: notAdmittedTokenSeedAuction.args.value,
      token: notAdmittedTokenSeedAuction.address,
      value: auctionClaim,
    });

    testFilecoinClient.replaceLogs(
      [notAdmittedTokenSeedAuction],
      [notAdmittedTokenSeedAuctionTx],
    );

    testFilecoinClient.forwardTo((b) => b + 1n);

    await indexerOrchestrator.execute();

    // Default seed
    const seedAuctions = range(0, 5).map((index) => {
      return transferLog({
        address: usdfcToken.address,
        blockNumber: notAdmittedTokenSeedAuction.blockNumber + 1n,
        logIndex: index,
        from: filecoinPayContractA,
        to: payerA,
        value: usdfcToken.formatNumericValue(10n * BigInt(index + 1)),
      });
    });

    const seedTransactions = seedAuctions.map((log) => {
      return burnForFeesTransaction({
        hash: log.transactionHash,
        requested: log.args.value,
        token: log.address,
        value: auctionClaim,
      });
    });

    testFilecoinClient.replaceLogs(seedAuctions, seedTransactions);
    testFilecoinClient.forwardTo((b) => b + 1n);

    await indexerOrchestrator.execute();

    // Not admitted contract case
    const notAdmittedContractAuction = transferLog({
      address: usdfcToken.address,
      blockNumber: notAdmittedTokenSeedAuction.blockNumber + 2n,
      logIndex: 0,
      from: filecoinPayContractB,
      to: payerA,
      value: usdfcToken.formatNumericValue(61n),
    });

    const notAdmittedContractAuctionTx = burnForFeesTransaction({
      hash: notAdmittedContractAuction.transactionHash,
      requested: notAdmittedContractAuction.args.value,
      token: notAdmittedContractAuction.address,
      value: auctionClaim,
    });

    testFilecoinClient.replaceLogs(
      [notAdmittedContractAuction],
      [notAdmittedContractAuctionTx],
    );

    testFilecoinClient.forwardTo((b) => b + 1n);

    await indexerOrchestrator.execute();

    // Not admitted token case
    const notAdmittedTokenAuction = transferLog({
      address: axlUsdcToken.address,
      blockNumber: notAdmittedContractAuction.blockNumber + 1n,
      logIndex: 0,
      from: filecoinPayContractA,
      to: payerA,
      value: axlUsdcToken.formatNumericValue(62n),
    });

    const notAdmittedTokenAuctionTx = burnForFeesTransaction({
      hash: notAdmittedTokenAuction.transactionHash,
      requested: notAdmittedTokenAuction.args.value,
      token: notAdmittedTokenAuction.address,
      value: auctionClaim,
    });

    testFilecoinClient.replaceLogs(
      [notAdmittedTokenAuction],
      [notAdmittedTokenAuctionTx],
    );

    testFilecoinClient.forwardTo((b) => b + 1n);

    await indexerOrchestrator.execute();

    // Qualifying auction
    const qualifyingAuction = transferLog({
      address: usdfcToken.address,
      blockNumber: notAdmittedTokenAuction.blockNumber + 2n,
      logIndex: 0,
      from: filecoinPayContractA,
      to: payerA,
      value: usdfcToken.formatNumericValue(31n),
    });

    const qualifyingAuctionTx = burnForFeesTransaction({
      hash: qualifyingAuction.transactionHash,
      requested: qualifyingAuction.args.value,
      token: qualifyingAuction.address,
      value: auctionClaim,
    });

    testFilecoinClient.replaceLogs([qualifyingAuction], [qualifyingAuctionTx]);
    testFilecoinClient.forwardTo(q1.endEpoch + 1n);

    await indexerOrchestrator.execute();

    // Validation
    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pricingPeriods = response.body.pricingPeriods as unknown[];

    expect(pricingPeriods.length).toBe(1);

    expect(pricingPeriods[0]).toMatchObject({
      lotAttoUsd: usdfcToken.formatNumericValue(31n).toString(),
      claimAttoFil: auctionClaim.toString(),
    });
  });

  // Tests:
  // - quarterly volume postings are collected
  // - corrections are respected
  it('Collects orchestrators quarterly volume', async () => {
    const indexerOrchestrator = app.get(IndexerOrchestratorService);
    const q2 = await app.get(QuartersService).getQuarterByIndex(2);

    testFilecoinClient.resetWithLogs([
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 3,
        orchestrator: orchestratorB,
        wallet: orchestratorB,
      }),

      volumeLog({
        address: serviceRewardsActor,
        blockNumber: q2.startEpoch,
        logIndex: 0,
        orchestrator: orchestratorA,
        volume: filToken.formatNumericValue(1),
        q: 1n,
        isCorrection: false,
      }),
      volumeLog({
        address: serviceRewardsActor,
        blockNumber: q2.startEpoch,
        logIndex: 1,
        orchestrator: orchestratorB,
        volume: filToken.formatNumericValue(10),
        q: 1n,
        isCorrection: false,
      }),
      volumeLog({
        address: serviceRewardsActor,
        blockNumber: q2.startEpoch,
        logIndex: 2,
        orchestrator: orchestratorA,
        volume: 0n,
        q: 1n,
        isCorrection: true,
      }),
    ]);

    testFilecoinClient.forwardTo(q2.endEpoch + 1n);
    await indexerOrchestrator.execute();

    // Validation
    const responseA = await request(app.getHttpServer())
      .get(`/quarters/1/postings/${orchestratorA}`)
      .expect(200);

    const responseB = await request(app.getHttpServer())
      .get(`/quarters/1/postings/${orchestratorB}`)
      .expect(200);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const postingsA = responseA.body.postings as unknown[];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const postingsB = responseB.body.postings as unknown[];

    expect(responseA.body).toMatchObject({
      serviceOrchestrator: orchestratorA.toLowerCase(),
      quarterNum: 1,
      volumeAttoUsd: null,
      corrected: true,
      postingEpoch: null,
      postingTxHash: null,
    });

    expect(postingsA.length).toBe(2);

    expect(responseB.body).toMatchObject({
      serviceOrchestrator: orchestratorB.toLowerCase(),
      quarterNum: 1,
      volumeAttoUsd: filToken.formatNumericValue(10).toString(),
      corrected: false,
      postingEpoch: q2.startEpoch.toString(),
    });

    expect(postingsB.length).toBe(1);
  });

  // Tests:
  // - service orchestrators can be admitted again with same address after removal
  // - pairs remain unbound after re-admission without explicit binding
  it('Allows orchestrator re-admission', async () => {
    const indexerOrchestrator = app.get(IndexerOrchestratorService);
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    testFilecoinClient.resetWithLogs([
      pricingParamsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 0,
        minLotFloor: 0n,
        minLotAlphaDen: 1n,
        minLotAlphaNum: 400n,
        priceBand: 30_000n,
        registrationCutoff: 5n,
      }),
      admittedListsUpdatedLog({
        address: serviceRewardsActor,
        blockNumber: 1n,
        logIndex: 1,
        filecoinPayContracts: [filecoinPayContractA],
        stablecoins: [usdfcToken.address],
      }),
      railCreatedLog({
        address: filecoinPayContractA,
        blockNumber: 1n,
        logIndex: 2,
        railId: 1n,
        token: usdfcToken.address,
        payee: zeroAddress,
        payer: payerA,
        operator: operatorA,
        validator: zeroAddress,
      }),

      // q1
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch,
        logIndex: 0,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
      bindingDeclaredLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch,
        logIndex: 1,
        orchestrator: orchestratorA,
        payer: payerA,
        operator: operatorA,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 2,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(1),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(1),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      orchestratorRemovedLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch,
        logIndex: 3,
        orchestrator: orchestratorA,
      }),
      railSettledLog({
        address: filecoinPayContractA,
        blockNumber: q1.startEpoch,
        logIndex: 4,
        railId: 1n,
        totalSettledAmount: usdfcToken.formatNumericValue(10),
        totalNetPayeeAmount: usdfcToken.formatNumericValue(10),
        operatorCommission: 0n,
        networkFee: 0n,
      }),
      orchestratorAdmittedLog({
        address: serviceRewardsActor,
        blockNumber: q1.startEpoch,
        logIndex: 5,
        orchestrator: orchestratorA,
        wallet: orchestratorA,
      }),
    ]);

    testFilecoinClient.forwardTo(q1.endEpoch + 1n);
    await indexerOrchestrator.execute();

    // Validation
    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    expect(response.body).toMatchObject({
      volumeAttoUsd: usdfcToken.formatNumericValue(1).toString(),
    });
  });

  async function resetDatabase() {
    const query = sql`
      TRUNCATE TABLE
        filecoin_pay_payment, filecoin_pay_fee_auction, filecoin_pay_rail,
        service_pair, service_orchestrator_admission, service_orchestrator, 
        whitelisted_token, filecoin_pay_contract, 
        service_rewards_actor_parameter, quarter_bound_volume, 
        application_config, indexer_state, service_orchestrator_quarterly_volume
      CASCADE;

      REFRESH MATERIALIZED VIEW CONCURRENTLY qualified_price_periods_mv;
    `;

    await query.execute(db);
  }
});

let txNumber = 0;

function nextTxHash(): Hash {
  txNumber = txNumber + 1;
  return `0x${txNumber.toString(16).padStart(64, '0')}`;
}

function orchestratorAdmittedLog({
  orchestrator,
  wallet,
  txHash,
  ...logInputs
}: LogInputs & {
  orchestrator: Address;
  wallet: Address;
}) {
  return {
    eventName: 'OrchestratorAdmitted',
    args: { orch: orchestrator, wallet },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function orchestratorRemovedLog({
  orchestrator,
  txHash,
  ...logInputs
}: LogInputs & { orchestrator: Address }) {
  return {
    eventName: 'OrchestratorRemoved',
    args: { orch: orchestrator },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function bindingReassignedLog({
  payer,
  operator,
  orchestrator,
  inherit,
  txHash,
  ...logInputs
}: LogInputs & {
  payer: Address;
  operator: Address;
  orchestrator: Address;
  inherit: boolean;
}) {
  return {
    eventName: 'BindingReassigned',
    args: { payer, operator, orchestrator, inherit },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function bindingCanceledLog({
  payer,
  operator,
  orchestrator,
  txHash,
  ...logInputs
}: LogInputs & {
  payer: Address;
  operator: Address;
  orchestrator: Address;
}) {
  return {
    eventName: 'BindingCanceled',
    args: { payer, operator, orchestrator },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function admittedListsUpdatedLog({
  filecoinPayContracts,
  stablecoins,
  txHash,
  ...logInputs
}: LogInputs & {
  filecoinPayContracts: Address[];
  stablecoins: Address[];
}) {
  return {
    eventName: 'AdmittedListsUpdated',
    args: { filecoinPayContracts, stablecoins },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function pricingParamsUpdatedLog({
  minLotFloor,
  minLotAlphaNum,
  minLotAlphaDen,
  priceBand,
  registrationCutoff,
  txHash,
  ...logInputs
}: LogInputs & {
  minLotFloor: bigint;
  minLotAlphaNum: bigint;
  minLotAlphaDen: bigint;
  priceBand: bigint;
  registrationCutoff: bigint;
}) {
  return {
    eventName: 'PricingParamsUpdated',
    args: {
      minLotFloor,
      minLotAlphaNum,
      minLotAlphaDen,
      priceBand,
      registrationCutoff,
    },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function bindingDeclaredLog({
  payer,
  operator,
  orchestrator,
  txHash,
  ...logInputs
}: LogInputs & {
  payer: Address;
  operator: Address;
  orchestrator: Address;
}) {
  return {
    eventName: 'BindingDeclared',
    args: { payer, operator, orchestrator },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function railCreatedLog({
  payee,
  payer,
  operator,
  railId,
  token,
  validator,
  txHash,
  ...logInputs
}: LogInputs & {
  payee: Address;
  payer: Address;
  operator: Address;
  railId: bigint;
  token: Address;
  validator: Address;
}) {
  return {
    eventName: 'RailCreated',
    args: {
      railId,
      payer,
      payee,
      operator,
      validator,
      token,
    },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function railSettledLog({
  networkFee,
  operatorCommission,
  railId,
  totalNetPayeeAmount,
  totalSettledAmount,
  txHash,
  ...logInputs
}: LogInputs & {
  networkFee: bigint;
  operatorCommission: bigint;
  railId: bigint;
  totalNetPayeeAmount: bigint;
  totalSettledAmount: bigint;
}) {
  return {
    eventName: 'RailSettled',
    args: {
      networkFee,
      operatorCommission,
      railId,
      settledUpTo: logInputs.blockNumber,
      totalNetPayeeAmount,
      totalSettledAmount,
    },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function railOneTimePaymentProcessedLog({
  netPayeeAmount,
  networkFee,
  operatorCommission,
  railId,
  txHash,
  ...logInputs
}: LogInputs & {
  netPayeeAmount: bigint;
  networkFee: bigint;
  operatorCommission: bigint;
  railId: bigint;
}) {
  return {
    eventName: 'RailOneTimePaymentProcessed',
    args: {
      railId,
      netPayeeAmount,
      networkFee,
      operatorCommission,
    },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function transferLog({
  from,
  to,
  value,
  txHash,
  ...logInputs
}: LogInputs & {
  from: Address;
  to: Address;
  value: bigint;
}) {
  return {
    eventName: 'Transfer',
    args: {
      from,
      to,
      value,
    },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function volumeLog({
  orchestrator,
  q,
  volume,
  isCorrection,
  txHash,
  ...logInputs
}: LogInputs & {
  orchestrator: Address;
  q: bigint;
  volume: bigint;
  isCorrection: boolean;
}) {
  return {
    eventName: isCorrection ? 'VolumeCorrected' : 'VolumePosted',
    args: {
      orchestrator,
      q,
      volume,
    },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function sharesSubmittedLog({
  q,
  recipientCount,
  totalUsd,
  txHash,
  ...logInputs
}: LogInputs & {
  q: bigint;
  recipientCount?: bigint;
  totalUsd: bigint;
}) {
  return {
    eventName: 'SharesSubmitted',
    args: {
      q,
      recipientCount: recipientCount ?? 1n,
      totalUsd,
    },
    logIndex: 0,
    transactionHash: txHash ?? nextTxHash(),
    ...logInputs,
  };
}

function burnForFeesTransaction({
  hash,
  recipient,
  requested,
  token,
  value,
}: {
  hash: Hash;
  recipient?: Address;
  requested: bigint;
  token: Address;
  value: bigint;
}): TestTransaction {
  return {
    hash,
    value,
    input: encodeFunctionData({
      abi: FilecoinPayV1ABI,
      functionName: 'burnForFees',
      args: [token, recipient ?? zeroAddress, requested],
    }),
  };
}
