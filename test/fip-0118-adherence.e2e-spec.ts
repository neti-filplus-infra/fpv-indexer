/* eslint-disable @typescript-eslint/no-unsafe-argument */
import FilecoinPayV1ABI from '@/abis/filecoin-pay-v1.abi';
import { db } from '@/db/db';
import { ERC20Metadata, FilecoinActions, TraceResult } from '@/lib/types';
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
  isHex,
  toHex,
  TransactionNotFoundError,
  zeroAddress,
} from 'viem';
import { AppModule } from '../src/app.module';
import { ARCHIVE_NODE_CLIENT, RECENT_NODE_CLIENT } from '../src/lib/constants';
import '../src/polyfill';
import { ERC20TokenInfoService } from '../src/services/erc-20-token-info.service';
import { FilfoxApiService } from '../src/services/filfox-api.service';

type TestLogInput = {
  address?: Address;
  eventName: string;
  args: Record<string, unknown>;
};

type TestLog = Omit<TestLogInput, 'address'> & {
  address: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionIndex: number;
  transactionHash: Hash;
};

type TestTransactionInput = {
  from?: Address;
  hash?: Hash;
  input?: Hash;
  logs?: TestLogInput[];
  to?: Address;
  trace?: TraceResult[];
  value?: bigint;
};

type TestTransaction = {
  blockNumber: number;
  hash: Hash;
  from: Address;
  index: number;
  input: Hash;
  logs: TestLog[];
  to: Address;
  trace: TraceResult[];
  value: bigint;
};

type TestBlockInput = {
  blockNumber: number;
  transactions: TestTransactionInput[];
};

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
  public filecoin: FilecoinActions['filecoin'];
  private transactionsMap: Map<Hash, TestTransaction> = new Map();
  private currentBlockNumber: bigint = 0n;

  constructor() {
    const getBlockNumber = this.getBlockNumber.bind(this);

    this.filecoin = {
      async chainGetFinalizedTipSet() {
        const blockNumber = await getBlockNumber();
        return Promise.resolve({
          Cids: [],
          Blocks: [],
          Height: Number(blockNumber),
        });
      },
    };
  }

  public reset(blocks: TestBlockInput[] = []) {
    this.currentBlockNumber = 0n;

    blocks.forEach((block, index) => {
      if (block.blockNumber < 1n) {
        throw new Error(
          `Blocks need to start from block number 1 - "${block.blockNumber}" given.`,
        );
      }

      const firstIndex = blocks.findIndex(
        (candidate) => candidate.blockNumber === block.blockNumber,
      );

      if (firstIndex !== index) {
        throw new Error(`Duplicate block number "${block.blockNumber}" found.`);
      }
    });

    const transactions: TestTransaction[] = blocks
      .toSorted((a, b) => a.blockNumber - b.blockNumber)
      .flatMap(({ blockNumber, transactions: transactionsInputs }) => {
        let logIndex = 0;

        return transactionsInputs.map((txInput, transactionIndex) => {
          const {
            from = zeroAddress,
            hash = nextTxHash(),
            input = '0x0',
            to = zeroAddress,
            value = 0n,
          } = txInput;
          const logs: TestLog[] = txInput.logs
            ? txInput.logs.map((logInput) => {
                return {
                  ...logInput,
                  address: logInput.address ?? to,
                  blockNumber: BigInt(blockNumber),
                  logIndex: logIndex++,
                  transactionIndex,
                  transactionHash: hash,
                } satisfies TestLog;
              })
            : [];

          return {
            blockNumber,
            from,
            hash,
            index: transactionIndex,
            input,
            logs,
            to,
            value,
            trace: txInput.trace ?? [
              {
                blockNumber: blockNumber,
                transactionHash: hash,
                transactionPosition: transactionIndex,
                action: {
                  callType: 'call',
                  from,
                  to,
                  gas: '0x0',
                  input,
                  value: `0x${value.toString(16)}`,
                },
                type: 'call',
                subtraces: 0,
                traceAddress: [],
                blockHash: '0x0',
                result: {
                  gasUsed: '0x0',
                  output: '0x0',
                },
              },
            ],
          } satisfies TestTransaction;
        });
      });

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
    const logs = Array.from(this.transactionsMap.values())
      .filter((tx) => {
        const txBlockNumber = BigInt(tx.blockNumber);

        return (
          (fromBlock === undefined || txBlockNumber >= fromBlock) &&
          (toBlock === undefined || txBlockNumber <= toBlock)
        );
      })
      .flatMap((tx) => {
        return tx.logs.filter((log) => {
          return (
            address === undefined ||
            log.address.toLowerCase() === address.toLowerCase()
          );
        });
      });

    return logs;
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

  // eslint-disable-next-line @typescript-eslint/require-await
  public async request({
    method,
    params,
  }: {
    method: string;
    params: unknown[];
  }) {
    switch (method) {
      case 'trace_transaction':
        return this.prepareTxTrace(params[0]);
      default:
        throw new Error(
          `Request method "${method}" not implemented on TestFilecoinClient`,
        );
    }
  }

  private prepareTxTrace(hash: unknown): TraceResult[] {
    if (typeof hash !== 'string' || !isHex(hash)) {
      throw new Error('Invalid tx hash');
    }

    const tx = this.transactionsMap.get(hash);

    if (!tx) {
      throw new Error(`Tx "${hash}" not found`);
    }

    return tx.trace;
  }
}

class TestToken {
  constructor(
    public readonly address: Address,
    public readonly symbol: string,
    public readonly decimals: number,
  ) {}

  public formatNumericValue(numericValue: number | bigint | string): bigint {
    const bn = BigNumber(numericValue);

    if (bn.eq(0)) {
      return 0n;
    }

    const result = bn.times(BigNumber(10).pow(this.decimals)).toBigInt();

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

let txNumber = 0;

function nextTxHash(): Hash {
  txNumber = txNumber + 1;
  return `0x${txNumber.toString(16).padStart(64, '0')}`;
}

function block(
  blockNumber: bigint | number,
  transactions: TestTransactionInput[],
): TestBlockInput {
  return {
    blockNumber: Number(blockNumber),
    transactions,
  };
}

function rail({
  filecoinPayContract,
  payee,
  payer,
  operator,
  railId,
  token,
  validator,
}: {
  filecoinPayContract: Address;
  payee: Address;
  payer: Address;
  operator: Address;
  railId: bigint;
  token: TestToken;
  validator: Address;
}) {
  function railCreatedTx() {
    return {
      to: filecoinPayContract,
      logs: [
        {
          eventName: 'RailCreated',
          args: {
            railId,
            payer,
            payee,
            operator,
            validator,
            token: token.address,
          },
        },
      ],
    };
  }

  function railSettledTx({
    networkFee = 0n,
    operatorCommission = 0n,
    settledUpTo,
    totalNetPayeeAmount = 0n,
  }: {
    networkFee?: number | bigint | string;
    operatorCommission?: number | bigint | string;
    settledUpTo: bigint;
    totalNetPayeeAmount?: number | bigint | string;
  }) {
    const networkFeeFormatted = token.formatNumericValue(networkFee);
    const operatorCommissionFormatted =
      token.formatNumericValue(operatorCommission);
    const totalNetPayeeAmountFormatted =
      token.formatNumericValue(totalNetPayeeAmount);

    return {
      to: filecoinPayContract,
      logs: [
        {
          eventName: 'RailSettled',
          args: {
            networkFee: networkFeeFormatted,
            operatorCommission: operatorCommissionFormatted,
            railId,
            settledUpTo,
            totalNetPayeeAmount: totalNetPayeeAmountFormatted,
            totalSettledAmount:
              networkFeeFormatted +
              operatorCommissionFormatted +
              totalNetPayeeAmountFormatted,
          },
        },
      ],
    };
  }

  function railOneTimePaymentProcessedTx({
    netPayeeAmount = 0n,
    networkFee = 0n,
    operatorCommission = 0n,
  }: {
    netPayeeAmount?: number | bigint | string;
    networkFee?: number | bigint | string;
    operatorCommission?: number | bigint | string;
  }) {
    const netPayeeAmountFormatted = token.formatNumericValue(netPayeeAmount);
    const networkFeeFormatted = token.formatNumericValue(networkFee);
    const operatorCommissionFormatted =
      token.formatNumericValue(operatorCommission);

    return {
      to: filecoinPayContract,
      logs: [
        {
          eventName: 'RailOneTimePaymentProcessed',
          args: {
            railId,
            netPayeeAmount: netPayeeAmountFormatted,
            networkFee: networkFeeFormatted,
            operatorCommission: operatorCommissionFormatted,
          },
        },
      ],
    };
  }

  return {
    filecoinPayContract,
    payee,
    payer,
    operator,
    railId,
    token,
    validator,
    railCreatedTx,
    railSettledTx,
    railOneTimePaymentProcessedTx,
  };
}

function orchestratorAdmittedTx({
  orchestrator,
  wallet,
}: {
  orchestrator: Address;
  wallet: Address;
}): TestTransactionInput {
  return {
    to: serviceRewardsActor,
    logs: [
      {
        eventName: 'OrchestratorAdmitted',
        args: { orch: orchestrator, wallet },
      },
    ],
  };
}

function orchestratorRemovedTx({
  orchestrator,
}: {
  orchestrator: Address;
}): TestTransactionInput {
  return {
    to: serviceRewardsActor,
    logs: [
      {
        eventName: 'OrchestratorRemoved',
        args: { orch: orchestrator },
      },
    ],
  };
}

function bindingReassignedTx({
  payer,
  operator,
  orchestrator,
  inherit,
}: {
  payer: Address;
  operator: Address;
  orchestrator: Address;
  inherit: boolean;
}): TestTransactionInput {
  return {
    to: serviceRewardsActor,
    logs: [
      {
        eventName: 'BindingReassigned',
        args: { payer, operator, orchestrator, inherit },
      },
    ],
  };
}

function bindingCanceledTx({
  payer,
  operator,
  orchestrator,
}: {
  payer: Address;
  operator: Address;
  orchestrator: Address;
}): TestTransactionInput {
  return {
    to: serviceRewardsActor,
    logs: [
      {
        eventName: 'BindingCanceled',
        args: { payer, operator, orchestrator },
      },
    ],
  };
}

function admittedListsUpdatedTx({
  filecoinPayContracts,
  stablecoins,
}: {
  filecoinPayContracts: Address[];
  stablecoins: Address[];
}): TestTransactionInput {
  return {
    to: serviceRewardsActor,
    logs: [
      {
        eventName: 'AdmittedListsUpdated',
        args: { filecoinPayContracts, stablecoins },
      },
    ],
  };
}

function pricingParamsUpdatedTx({
  minLotFloor,
  minLotAlphaNum,
  minLotAlphaDen,
  priceBand,
  registrationCutoff,
}: {
  minLotFloor: bigint;
  minLotAlphaNum: bigint;
  minLotAlphaDen: bigint;
  priceBand: bigint;
  registrationCutoff: bigint;
}): TestTransactionInput {
  return {
    to: serviceRewardsActor,
    logs: [
      {
        eventName: 'PricingParamsUpdated',
        args: {
          minLotFloor,
          minLotAlphaNum,
          minLotAlphaDen,
          priceBand,
          registrationCutoff,
        },
      },
    ],
  };
}

function bindingDeclaredTx({
  payer,
  operator,
  orchestrator,
}: {
  payer: Address;
  operator: Address;
  orchestrator: Address;
}): TestTransactionInput {
  return {
    to: serviceRewardsActor,
    logs: [
      { eventName: 'BindingDeclared', args: { payer, operator, orchestrator } },
    ],
  };
}

function volumePostedTx({
  orchestrator,
  q,
  volume,
}: {
  orchestrator: Address;
  q: bigint;
  volume: bigint;
}) {
  return {
    to: serviceRewardsActor,
    logs: [
      {
        eventName: 'VolumePosted',
        args: {
          orchestrator,
          q,
          volume,
        },
      },
    ],
  };
}

function volumeCorrectedTx({
  orchestrator,
  q,
  volume,
}: {
  orchestrator: Address;
  q: bigint;
  volume: bigint;
}) {
  return {
    to: serviceRewardsActor,
    logs: [
      {
        eventName: 'VolumeCorrected',
        args: {
          orchestrator,
          q,
          volume,
        },
      },
    ],
  };
}

function sharesSubmittedTx({
  q,
  recipientCount,
  totalUsd,
}: {
  q: bigint;
  recipientCount?: bigint;
  totalUsd: bigint;
}): TestTransactionInput {
  return {
    to: serviceRewardsActor,
    logs: [
      {
        eventName: 'SharesSubmitted',
        args: {
          q,
          recipientCount: recipientCount ?? 1n,
          totalUsd,
        },
      },
    ],
  };
}

function burnForFeesTx({
  filecoinPayContract,
  recipient,
  requested,
  token,
  value,
}: {
  filecoinPayContract: Address;
  recipient: Address;
  requested: bigint;
  token: Address;
  value: bigint;
}): TestTransactionInput {
  return {
    to: filecoinPayContract,
    value,
    input: encodeFunctionData({
      abi: FilecoinPayV1ABI,
      functionName: 'burnForFees',
      args: [token, recipient, requested],
    }),
    logs: [
      {
        address: token,
        eventName: 'Transfer',
        args: { from: filecoinPayContract, to: recipient, value: requested },
      },
    ],
  };
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
    testFilecoinClient.reset();
  });

  // Tests:
  // - ERC20 normalization
  // - totalSettledAmount is used for settlements calculation
  it('ERC20 decimals are normalized to atto-USD', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);
    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    const railTwo = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 2n,
      token: axlUsdcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address, axlUsdcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerA,
        }),
        railOne.railCreatedTx(),
        railTwo.railCreatedTx(),
      ]),

      // settlments in Q1
      block(q1.startEpoch, [
        railOne.railSettledTx({
          totalNetPayeeAmount: 1.4,
          networkFee: 0.1,
          settledUpTo: q1.startEpoch,
        }),
        railTwo.railSettledTx({
          totalNetPayeeAmount: 1.4,
          networkFee: 0.1,
          settledUpTo: q1.startEpoch,
        }),
      ]),
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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerA,
        }),
        railOne.railCreatedTx(),
      ]),

      // one time payment in Q1
      block(q1.startEpoch, [
        railOne.railOneTimePaymentProcessedTx({
          netPayeeAmount: 1.3,
          operatorCommission: 0.1,
          networkFee: 0.1,
        }),
      ]),
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
    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerA,
        }),
        railOne.railCreatedTx(),
      ]),

      // settlments in Q1
      block(q2.startEpoch - 1n, [
        railOne.railSettledTx({
          totalNetPayeeAmount: 99,
          networkFee: 1,
          settledUpTo: q2.startEpoch - 1n,
        }),
      ]),

      // settlments in Q2
      block(q2.startEpoch, [
        railOne.railSettledTx({
          settledUpTo: q2.startEpoch,
          totalNetPayeeAmount: 1.4,
          networkFee: 0.1,
        }),
      ]),

      block(q2.endEpoch, [
        railOne.railSettledTx({
          settledUpTo: q2.endEpoch,
          totalNetPayeeAmount: 1.4,
          networkFee: 0.1,
        }),
      ]),

      // settlments in Q3
      block(q2.endEpoch + 1n, [
        railOne.railSettledTx({
          settledUpTo: q2.endEpoch + 1n,
          totalNetPayeeAmount: 198,
          networkFee: 2,
        }),
      ]),
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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });
    const railTwo = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 2n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });
    const railThree = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 3n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorB,
      validator: zeroAddress,
    });
    const railFour = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 4n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerB,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerA,
        }),
        railOne.railCreatedTx(),
        railTwo.railCreatedTx(),
        railThree.railCreatedTx(),
        railFour.railCreatedTx(),
      ]),

      // payments in Q1
      block(q1.startEpoch, [
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 1.4,
          networkFee: 0.1,
        }),
        railTwo.railOneTimePaymentProcessedTx({
          netPayeeAmount: 1.4,
          networkFee: 0.1,
        }),
        railThree.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 140,
          networkFee: 10,
        }),
        railFour.railOneTimePaymentProcessedTx({
          netPayeeAmount: 140,
          networkFee: 10,
        }),
      ]),
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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });
    const railTwo = rail({
      filecoinPayContract: filecoinPayContractB,
      railId: 2n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });
    const railThree = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 3n,
      token: axlUsdcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });
    const railFour = rail({
      filecoinPayContract: filecoinPayContractB,
      railId: 4n,
      token: axlUsdcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerA,
        }),
        railOne.railCreatedTx(),
        railTwo.railCreatedTx(),
        railThree.railCreatedTx(),
        railFour.railCreatedTx(),
      ]),

      // settlements in Q1

      block(q1.startEpoch, [
        // USDFC settlement on contract A (should count)
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 1,
        }),
        // USDFC settlement on contract B (should NOT count)
        railTwo.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 10,
        }),
        // axlUSDC settlement on contract A (should NOT count)
        railThree.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 100,
        }),
        // axlUSDC settlement on contract B (should NOT count)
        railFour.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 1000,
        }),
      ]),

      // admitted lists switch during Q1 (should apply from Q2)
      block(q1.startEpoch + 1n, [
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractB],
          stablecoins: [axlUsdcToken.address],
        }),
      ]),

      block(q1.startEpoch + 2n, [
        // USDFC settlement on contract A (should still count)
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 1,
        }),
        // USDFC settlement on contract B (should still NOT count)
        railTwo.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 10,
        }),
        // axlUSDC settlement on contract A (should still NOT count)
        railThree.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 100,
        }),
        // axlUSDC settlement on contract B (should still NOT count)
        railFour.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 1000,
        }),
      ]),

      // settlements in Q2
      block(q2.startEpoch, [
        // USDFC settlement on contract A (should NOT count)
        railOne.railSettledTx({
          settledUpTo: q2.startEpoch,
          totalNetPayeeAmount: 1000,
        }),
        // USDFC settlement on contract B (should NOT count)
        railTwo.railSettledTx({
          settledUpTo: q2.startEpoch,
          totalNetPayeeAmount: 100,
        }),
        // axlUSDC settlement on contract A (should NOT count)
        railThree.railSettledTx({
          settledUpTo: q2.startEpoch,
          totalNetPayeeAmount: 10,
        }),
        // axlUSDC settlement on contract B (should count)
        railFour.railSettledTx({
          settledUpTo: q2.startEpoch,
          totalNetPayeeAmount: 1,
        }),
      ]),
    ]);

    testFilecoinClient.forwardTo(q2.endEpoch + 1n);

    await app.get(IndexerOrchestratorService).execute();

    const responseQ1 = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    const responseQ2 = await request(app.getHttpServer())
      .get(`/volume/2/${orchestratorA}`)
      .expect(200);

    const expectedStablecoinVolumeQ1 = filToken
      .formatNumericValue('2')
      .toString();

    const expectedStablecoinVolumeQ2 = filToken
      .formatNumericValue('1')
      .toString();

    expect(responseQ1.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolumeQ1,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolumeQ1,
    });

    expect(responseQ2.body).toMatchObject({
      stablecoinVolumeAttoUsd: expectedStablecoinVolumeQ2,
      filVolumeAttoUsd: '0',
      volumeAttoUsd: expectedStablecoinVolumeQ2,
    });
  });

  // Tests:
  // - settlements made on unbound pairs do not count towards quarterly volume
  it('Excludes unbound settlements and one time payments', async () => {
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });
    const railTwo = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 2n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerB,
      operator: operatorB,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorB,
          wallet: orchestratorB,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerB,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorB,
          operator: operatorB,
          payer: payerA,
        }),
        railOne.railCreatedTx(),
        railTwo.railCreatedTx(),
      ]),

      // Q1 payments
      block(q1.startEpoch, [
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 100,
        }),
        railTwo.railOneTimePaymentProcessedTx({
          netPayeeAmount: 1000,
        }),
      ]),
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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        railOne.railCreatedTx(),
      ]),

      // Q1 events

      // Rail settlement in Q1 (should NOT count if pair registered in Q2)
      block(q1.startEpoch, [
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 1000,
        }),
      ]),

      // Q2 events

      // Settlement in Q2 (should count even if pair is registered after
      // settlement, but before REGISTRATION_CUTOFF)
      block(q2.startEpoch, [
        railOne.railSettledTx({
          settledUpTo: q2.startEpoch,
          totalNetPayeeAmount: 1,
        }),
      ]),

      // Binding after some settlements using that pair in Q2 were made
      block(q2.startEpoch + 1n, [
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerA,
        }),
      ]),

      // Settlement after binding, the default case
      block(q2.startEpoch + 2n, [
        railOne.railSettledTx({
          settledUpTo: q2.startEpoch + 2n,
          totalNetPayeeAmount: 1,
        }),
      ]),
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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });
    const railTwo = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 2n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerB,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        railOne.railCreatedTx(),
        railTwo.railCreatedTx(),
      ]),

      // Q1 events
      block(q1.startEpoch, [
        // Rail 1 settlement in Q1 (should count if pair registered before cutoff)
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 1,
        }),
        // Rail 2 settlement in Q1 (should NOT count if pair registered after
        // cutoff)
        railTwo.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 1000,
        }),
      ]),

      block(q1.startEpoch + 4n, [
        // Registration of rail 1 pair before cutoff
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerA,
        }),
      ]),

      block(q1.startEpoch + 5n, [
        // Registration of rail 2 pair after cutoff
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerB,
        }),
      ]),

      // Q2 events

      // Rail 2 settlement in Q2 (should now count)
      block(q2.startEpoch, [
        railTwo.railSettledTx({
          settledUpTo: q2.startEpoch,
          totalNetPayeeAmount: 1,
        }),
      ]),
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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorB,
          wallet: orchestratorB,
        }),
        railOne.railCreatedTx(),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerA,
        }),
      ]),

      block(q1.startEpoch + 1n, [
        // Settlement before A removal, should count towards A
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 1,
        }),
        // A gets removed same epoch, binding should be released
        orchestratorRemovedTx({ orchestrator: orchestratorA }),
        // Same epoch released settlement
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 10,
        }),
        // B bind released pair, previous settlement now counts towards B's volume
        bindingDeclaredTx({
          orchestrator: orchestratorB,
          operator: operatorA,
          payer: payerA,
        }),
      ]),

      block(q1.startEpoch + 3n, [
        // Another settlement when B already binds the pair
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch + 3n,
          totalNetPayeeAmount: 100,
        }),
      ]),
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
      stablecoinVolumeAttoUsd: usdfcToken.formatNumericValue(0n).toString(),
      filVolumeAttoUsd: '0',
      volumeAttoUsd: usdfcToken.formatNumericValue(0n).toString(),
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
      filecoinPayContract: filecoinPayContractA,
      token: usdfcToken,
      payee: zeroAddress,
      validator: zeroAddress,
    } as const;

    const [railOne, railTwo, railThree, railFour, railFive] = [
      {
        payer: payerA,
        operator: operatorA,
      },
      {
        payer: payerA,
        operator: operatorB,
      },
      {
        payer: payerA,
        operator: operatorC,
      },
      {
        payer: payerB,
        operator: operatorA,
      },
      {
        payer: payerB,
        operator: operatorB,
      },
    ].map((railInput, index) => {
      return rail({
        ...commonRailOptions,
        ...railInput,
        railId: BigInt(index + 1),
      });
    });

    testFilecoinClient.reset([
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorB,
          wallet: orchestratorB,
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorC,
          wallet: orchestratorC,
        }),
        ...[railOne, railTwo, railThree, railFour, railFive].map((r) =>
          r.railCreatedTx(),
        ),
      ]),

      // Case 1: Bound to A -> settlement 1 -> reassignment to B without inherit
      // -> settlement 2, all in one epoch. Default non malicient reassignment.
      // Settlment 1 should count towards A's Q1 volume and settlment 2 towards
      // B's Q1 volume.
      block(q1.startEpoch, [
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: railOne.operator,
          payer: railOne.payer,
        }),
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 1,
        }),
        bindingReassignedTx({
          orchestrator: orchestratorB,
          operator: railOne.operator,
          payer: railOne.payer,
          inherit: false,
        }),
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 2,
        }),
      ]),

      // Case 2: Bound to A -> settlement 1 -> reassignment to B with inherit
      // -> settlement 2, all in one epoch. Default malicient reassignment.
      // Both settlment 1 and settlment 2 should count towards B's Q1 volume.
      block(q1.startEpoch + 1n, [
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: railTwo.operator,
          payer: railTwo.payer,
        }),
        railTwo.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 10,
        }),
        bindingReassignedTx({
          orchestrator: orchestratorB,
          operator: railTwo.operator,
          payer: railTwo.payer,
          inherit: true,
        }),
        railTwo.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 20,
        }),
      ]),

      // Case 3: Bound to A in Q1 -> settlement 1 in Q2 -> reassigned to B with
      // inherit -> settlement 2. Special pair held longer case. Settlment 1
      // should count towards A's Q2 volume and settlment 2 towards B's Q2
      // volume.
      block(q1.startEpoch + 2n, [
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: railThree.operator,
          payer: railThree.payer,
        }),
      ]),
      block(q2.startEpoch + 2n, [
        railThree.railSettledTx({
          settledUpTo: q2.startEpoch + 2n,
          totalNetPayeeAmount: 100,
        }),
        bindingReassignedTx({
          orchestrator: orchestratorB,
          operator: railThree.operator,
          payer: railThree.payer,
          inherit: true,
        }),
        railThree.railSettledTx({
          settledUpTo: q2.startEpoch + 2n,
          totalNetPayeeAmount: 200,
        }),
      ]),

      // Case 4: Bound to C -> settlement 1 -> released -> bound to A ->
      // settlement 2 -> reassigned to B with inherit -> settlement 3 all in one
      // epoch. Maleficient reassignment honoring previous bindings.
      // Settlement 1 should count towards C's volume, settlments 2 and 3
      // towards B's volume, A gets nothing.
      block(q1.startEpoch + 3n, [
        bindingDeclaredTx({
          orchestrator: orchestratorC,
          operator: railFour.operator,
          payer: railFour.payer,
        }),
        railFour.railSettledTx({
          settledUpTo: q1.startEpoch + 3n,
          totalNetPayeeAmount: 3000,
        }),
        bindingCanceledTx({
          payer: railFour.payer,
          operator: railFour.operator,
          orchestrator: orchestratorC,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: railFour.operator,
          payer: railFour.payer,
        }),
        railFour.railSettledTx({
          settledUpTo: q1.startEpoch + 3n,
          totalNetPayeeAmount: 1000,
        }),
        bindingReassignedTx({
          orchestrator: orchestratorB,
          operator: railFour.operator,
          payer: railFour.payer,
          inherit: true,
        }),
        railFour.railSettledTx({
          settledUpTo: q1.startEpoch + 3n,
          totalNetPayeeAmount: 2000,
        }),
      ]),

      // Case 5: Settlement 1 in Q1 -> bound to A during Q1 cutoff -> reassigned
      // to B during Q1 cutoff with inherit -> settlement 2 in Q2. No one should
      // get settlement 1 and settlement 2 should count towards B's Q2 volume.
      block(q1.endEpoch, [
        railFive.railSettledTx({
          settledUpTo: q1.endEpoch,
          totalNetPayeeAmount: 10000,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: railFive.operator,
          payer: railFive.payer,
        }),
        bindingReassignedTx({
          orchestrator: orchestratorB,
          operator: railFive.operator,
          payer: railFive.payer,
          inherit: true,
        }),
      ]),
      block(q2.startEpoch + 4n, [
        railFive.railSettledTx({
          settledUpTo: q2.startEpoch + 4n,
          totalNetPayeeAmount: 20000,
        }),
      ]),
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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 0n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorB,
          wallet: orchestratorB,
        }),
        railOne.railCreatedTx(),
      ]),

      block(q1.startEpoch, [
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerA,
        }),
      ]),

      // Settlement before cancellation attributed to A
      block(q1.startEpoch + 1n, [
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 1,
        }),
        bindingCanceledTx({
          orchestrator: orchestratorA,
          operator: operatorA,
          payer: payerA,
        }),
        // Unbound settlement
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 10,
        }),
        // B binds released pair
        bindingDeclaredTx({
          orchestrator: orchestratorB,
          operator: operatorA,
          payer: payerA,
        }),
        // Settlement bound to B
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 100,
        }),
      ]),
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

    const seeds = range(0, 5).map((index) => {
      return burnForFeesTx({
        filecoinPayContract: filecoinPayContractA,
        recipient: payerA,
        requested: usdfcToken.formatNumericValue(10 + index),
        token: usdfcToken.address,
        value: filToken.formatNumericValue(1),
      });
    });

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: filToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: filToken.formatNumericValue('0.5'),
          minLotAlphaDen: 1n,
          minLotAlphaNum: 400n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          payer: payerA,
          operator: operatorA,
        }),
        railOne.railCreatedTx(),

        // Rail to seed auctionable tokens indexing
        rail({
          filecoinPayContract: filecoinPayContractA,
          railId: 2n,
          token: usdfcToken,
          payee: zeroAddress,
          payer: payerA,
          operator: operatorA,
          validator: zeroAddress,
        }).railCreatedTx(),
      ]),

      // Q1 events
      block(q1.startEpoch, seeds),
      block(q1.startEpoch + 1n, [
        burnForFeesTx({
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: usdfcToken.formatNumericValue(15),
          token: usdfcToken.address,
          value: filToken.formatNumericValue(1),
        }),
        // Settlement after 2nd price period but before last price period
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 10,
        }),
        burnForFeesTx({
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: usdfcToken.formatNumericValue(16),
          token: usdfcToken.address,
          value: filToken.formatNumericValue(1),
        }),
        burnForFeesTx({
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: usdfcToken.formatNumericValue(17),
          token: usdfcToken.address,
          value: filToken.formatNumericValue(1),
        }),

        // Settlement after last price period (should not be counted)
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 1000,
        }),
      ]),
    ]);

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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: filToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: filToken.formatNumericValue('0.5'),
          minLotAlphaDen: 1n,
          minLotAlphaNum: 400n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          payer: payerA,
          operator: operatorA,
        }),
        railOne.railCreatedTx(),

        // Rail to seed auctionable tokens indexing
        rail({
          filecoinPayContract: filecoinPayContractA,
          railId: 2n,
          token: usdfcToken,
          payee: zeroAddress,
          payer: payerA,
          operator: operatorA,
          validator: zeroAddress,
        }).railCreatedTx(),
      ]),

      // Q1 events
      // seed
      block(
        q1.startEpoch,
        range(0, 5).map((index) => {
          return burnForFeesTx({
            token: usdfcToken.address,
            filecoinPayContract: filecoinPayContractA,
            recipient: payerA,
            requested: usdfcToken.formatNumericValue(10 + index),
            value: filToken.formatNumericValue(1n),
          });
        }),
      ),

      block(q1.startEpoch + 1n, [
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: usdfcToken.formatNumericValue(15),
          value: filToken.formatNumericValue(1n),
        }),
      ]),

      block(q1.startEpoch + 2n, [
        // Settlement after last Q1 price period should be counted in Q2
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch + 2n,
          totalNetPayeeAmount: 10,
        }),
      ]),

      // Q2 events
      block(q2.startEpoch + 1n, [
        sharesSubmittedTx({
          q: 1n,
          totalUsd: 0n,
        }),
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: usdfcToken.formatNumericValue(16),
          value: filToken.formatNumericValue(1n),
        }),
      ]),
    ]);

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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: filToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: filToken.formatNumericValue('0.5'),
          minLotAlphaDen: 1n,
          minLotAlphaNum: 400n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          payer: payerA,
          operator: operatorA,
        }),
        railOne.railCreatedTx(),

        // Rail to seed auctionable tokens indexing
        rail({
          filecoinPayContract: filecoinPayContractA,
          railId: 2n,
          token: usdfcToken,
          payee: zeroAddress,
          payer: payerA,
          operator: operatorA,
          validator: zeroAddress,
        }).railCreatedTx(),
      ]),

      // Settlement before seed prints that should not be priced by them
      block(q1.startEpoch, [
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 10,
        }),
      ]),

      ...range(0, 6).map((index) => {
        return block(q1.startEpoch + 1n + BigInt(index), [
          burnForFeesTx({
            filecoinPayContract: filecoinPayContractA,
            token: usdfcToken.address,
            recipient: payerA,
            requested: usdfcToken.formatNumericValue(10 + index),
            value: filToken.formatNumericValue(1),
          }),
        ]);
      }),
    ]);

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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: filToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    const auctionBaseValue = filToken.formatNumericValue(1);
    const seedAuctions = range(0, 5).map((index) => {
      return burnForFeesTx({
        filecoinPayContract: filecoinPayContractA,
        token: usdfcToken.address,
        recipient: payerA,
        value: auctionBaseValue,

        // Ratios 1, 2, 3, 4, 100. Artifically high ratio on last print.
        // Arithemtic mean is 22 but median by comparsion is 3 (middle item).
        requested:
          index === 4
            ? usdfcToken.formatNumericValue(100n)
            : usdfcToken.formatNumericValue(index + 1),
      });
    });

    const nonQualifyingAuction = burnForFeesTx({
      filecoinPayContract: filecoinPayContractA,
      token: usdfcToken.address,
      recipient: payerA,
      value: auctionBaseValue,
      // Value of 22 would pass decimal median price band but should fail here
      // with price band of 0% (exact median)
      requested: usdfcToken.formatNumericValue(22n),
    });

    const qualifyingAuction = burnForFeesTx({
      filecoinPayContract: filecoinPayContractA,
      token: usdfcToken.address,
      recipient: payerA,
      value: auctionBaseValue,
      // Value of 3 would fail decimal median price band but should pass here
      // with price band of 0% (exact median)
      requested: usdfcToken.formatNumericValue(3n),
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 400n,
          priceBand: priceBandBps,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          payer: payerA,
          operator: operatorA,
        }),
        railOne.railCreatedTx(),

        // Rail to seed auctionable tokens indexing
        rail({
          filecoinPayContract: filecoinPayContractA,
          railId: 2n,
          token: usdfcToken,
          payee: zeroAddress,
          payer: payerA,
          operator: operatorA,
          validator: zeroAddress,
        }).railCreatedTx(),
      ]),

      // Q1 events
      block(q1.startEpoch, seedAuctions),

      // Settlement before price band checked prints
      block(q1.startEpoch + 1n, [
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 10,
        }),
      ]),

      block(q1.startEpoch + 2n, [nonQualifyingAuction, qualifyingAuction]),
    ]);

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

    const auctionBaseValue = filToken.formatNumericValue(1n);

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: filToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    const railTwo = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 2n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor,
          minLotAlphaDen,
          minLotAlphaNum,
          priceBand: priceBandBps,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          payer: payerA,
          operator: operatorA,
        }),
        railOne.railCreatedTx(),
        railTwo.railCreatedTx(),
      ]),

      // Q1
      block(q1.startEpoch, [
        // Settlements before prints, 300USD for Q1 volume and 10FIL to test
        // pricing in Q2
        railTwo.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 300,
        }),
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 10,
        }),
      ]),

      block(q1.startEpoch + 1n, [
        // All 3 clear min lot floor
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          value: auctionBaseValue,
          requested: usdfcToken.formatNumericValue(6n),
        }),
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          value: auctionBaseValue,
          requested: usdfcToken.formatNumericValue(8n),
        }),
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          value: auctionBaseValue,
          requested: usdfcToken.formatNumericValue(4n),
        }),

        // Below min lot floor, no min lot yet for Q1
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          value: auctionBaseValue,
          requested: usdfcToken.formatNumericValue(1n),
        }),
      ]),

      // Q2. We still don't have 5 seed auctions. Min lot now calculated based
      // on Q1 volume and params, should be 10USD (300 * (1 / 10) / 3)

      block(q2.startEpoch, [
        // Below new min lot
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          value: auctionBaseValue,
          // Below 10USD
          requested: usdfcToken.formatNumericValue(9n),
        }),

        // Both clear new min lot
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          value: auctionBaseValue,
          requested: usdfcToken.formatNumericValue(10n),
        }),
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          value: auctionBaseValue,
          requested: usdfcToken.formatNumericValue(12n),
        }),
      ]),

      block(q2.startEpoch + 1n, [
        // First qualifying print after seed, median should be 8.
        // Check by using same price with 0% price band.
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          value: auctionBaseValue,
          // Exact seed median
          requested: usdfcToken.formatNumericValue(8n),
        }),
      ]),

      block(q2.startEpoch + 2n, [
        sharesSubmittedTx({
          q: 1n,
          totalUsd: filToken.formatNumericValue(300n),
        }),
      ]),
    ]);

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
    const auctionBaseValue = filToken.formatNumericValue(1n);

    const usdfcRail = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: filToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 400n,
          priceBand: priceBandBps,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          payer: payerA,
          operator: operatorA,
        }),
        usdfcRail.railCreatedTx(),

        // Rail to seed auctionable tokens indexing
        rail({
          filecoinPayContract: filecoinPayContractA,
          railId: 2n,
          token: usdfcToken,
          payee: zeroAddress,
          payer: payerA,
          operator: operatorA,
          validator: zeroAddress,
        }).railCreatedTx(),
      ]),

      // Q1 events
      block(
        q1.startEpoch,
        range(0, 5).map(() => {
          return burnForFeesTx({
            token: usdfcToken.address,
            filecoinPayContract: filecoinPayContractA,
            recipient: payerA,
            requested: usdfcToken.formatNumericValue(initialLotUsd),
            value: auctionBaseValue,
          });
        }),
      ),

      // Before upper price band settlement
      block(q1.startEpoch + 1n, [
        usdfcRail.railSettledTx({
          settledUpTo: q1.startEpoch + 1n,
          totalNetPayeeAmount: 100,
        }),
      ]),

      block(q1.startEpoch + 2n, [
        // Above upper price band auction
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: upperPriceBand + 1n,
          value: auctionBaseValue,
        }),

        // Upper price band auction
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: upperPriceBand,
          value: auctionBaseValue,
        }),

        // Reset auction
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: usdfcToken.formatNumericValue(initialLotUsd),
          value: auctionBaseValue,
        }),
      ]),

      block(q1.startEpoch + 3n, [
        // Before lower price band settlement
        usdfcRail.railSettledTx({
          settledUpTo: q1.startEpoch + 3n,
          totalNetPayeeAmount: 1000,
        }),
      ]),

      block(q1.startEpoch + 4n, [
        // Below lower price band auction
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: lowerPriceBand - 1n,
          value: auctionBaseValue,
        }),

        // Lower price band auction
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: lowerPriceBand,
          value: auctionBaseValue,
        }),
      ]),
    ]);

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

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 400n,
          priceBand: 10000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA, filecoinPayContractB],
          stablecoins: [usdfcToken.address, axlUsdcToken.address],
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),

        // USDFC rail
        rail({
          filecoinPayContract: filecoinPayContractA,
          railId: 1n,
          token: usdfcToken,
          payee: zeroAddress,
          payer: payerA,
          operator: operatorA,
          validator: zeroAddress,
        }).railCreatedTx(),

        // axlUSDC rail
        rail({
          filecoinPayContract: filecoinPayContractA,
          railId: 2n,
          token: axlUsdcToken,
          payee: zeroAddress,
          payer: payerA,
          operator: operatorA,
          validator: zeroAddress,
        }).railCreatedTx(),

        // FIL rail
        rail({
          filecoinPayContract: filecoinPayContractA,
          railId: 3n,
          token: filToken,
          payee: zeroAddress,
          payer: payerA,
          operator: operatorA,
          validator: zeroAddress,
        }).railCreatedTx(),
      ]),

      // Not admitted contract seed case
      block(q1.startEpoch, [
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractB,
          recipient: payerA,
          requested: usdfcToken.formatNumericValue(21n),
          value: auctionClaim,
        }),
      ]),

      // Not admitted token seed case
      block(q1.startEpoch + 1n, [
        burnForFeesTx({
          token: axlUsdcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: axlUsdcToken.formatNumericValue(22n),
          value: auctionClaim,
        }),
      ]),

      // Default seed
      block(
        q1.startEpoch + 2n,
        range(0, 5).map((index) => {
          return burnForFeesTx({
            token: usdfcToken.address,
            filecoinPayContract: filecoinPayContractA,
            recipient: payerA,
            requested: usdfcToken.formatNumericValue(10n * BigInt(index + 1)),
            value: auctionClaim,
          });
        }),
      ),

      // Not admitted contract case
      block(q1.startEpoch + 3n, [
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractB,
          recipient: payerA,
          requested: usdfcToken.formatNumericValue(61n),
          value: auctionClaim,
        }),
      ]),

      // Not admitted token case
      block(q1.startEpoch + 4n, [
        burnForFeesTx({
          token: axlUsdcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: axlUsdcToken.formatNumericValue(62n),
          value: auctionClaim,
        }),
      ]),

      // Qualifying auction
      block(q1.startEpoch + 5n, [
        burnForFeesTx({
          token: usdfcToken.address,
          filecoinPayContract: filecoinPayContractA,
          recipient: payerA,
          requested: usdfcToken.formatNumericValue(31n),
          value: auctionClaim,
        }),
      ]),
    ]);

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

    testFilecoinClient.reset([
      block(1, [
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorB,
          wallet: orchestratorB,
        }),
      ]),

      block(q2.startEpoch, [
        volumePostedTx({
          orchestrator: orchestratorA,
          volume: filToken.formatNumericValue(1),
          q: 1n,
        }),
        volumePostedTx({
          orchestrator: orchestratorB,
          volume: filToken.formatNumericValue(10),
          q: 1n,
        }),
        volumeCorrectedTx({
          orchestrator: orchestratorA,
          volume: 0n,
          q: 1n,
        }),
      ]),
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

    const railOne = rail({
      filecoinPayContract: filecoinPayContractA,
      railId: 1n,
      token: usdfcToken,
      payee: zeroAddress,
      payer: payerA,
      operator: operatorA,
      validator: zeroAddress,
    });

    testFilecoinClient.reset([
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 400n,
          priceBand: 30_000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        railOne.railCreatedTx(),
      ]),

      // q1
      block(q1.startEpoch, [
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          payer: payerA,
          operator: operatorA,
        }),
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 1,
        }),
        orchestratorRemovedTx({
          orchestrator: orchestratorA,
        }),
        railOne.railSettledTx({
          settledUpTo: q1.startEpoch,
          totalNetPayeeAmount: 10,
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        bindingDeclaredTx({
          orchestrator: orchestratorA,
          payer: payerA,
          operator: operatorA,
        }),
      ]),
    ]);

    testFilecoinClient.forwardTo(q1.endEpoch + 1n);
    await indexerOrchestrator.execute();

    // Validation
    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    expect(response.body).toMatchObject({
      volumeAttoUsd: usdfcToken.formatNumericValue(10).toString(),
    });
  });

  it('Indexes auctions triggered via multicall/multisig', async () => {
    const indexerOrchestrator = app.get(IndexerOrchestratorService);
    const q1 = await app.get(QuartersService).getQuarterByIndex(1);
    const auctionBaseValue = filToken.formatNumericValue(1);

    const traceBlockNumber = Number(q1.startEpoch + 1n);
    const multiTxHash = nextTxHash();
    const callerAddress: Address = '0x000000000000000000000000000000000000a001';
    const safeAddress: Address = '0x000000000000000000000000000000000000a002';
    const multicallAddress: Address =
      '0x000000000000000000000000000000000000a003';
    const requestedAmount1 = usdfcToken.formatNumericValue(11);
    const requestedAmount2 = usdfcToken.formatNumericValue(12);

    testFilecoinClient.reset([
      // bootstrap
      block(1, [
        pricingParamsUpdatedTx({
          minLotFloor: 0n,
          minLotAlphaDen: 1n,
          minLotAlphaNum: 400n,
          priceBand: 30_000n,
          registrationCutoff: 5n,
        }),
        admittedListsUpdatedTx({
          filecoinPayContracts: [filecoinPayContractA],
          stablecoins: [usdfcToken.address],
        }),
        orchestratorAdmittedTx({
          orchestrator: orchestratorA,
          wallet: orchestratorA,
        }),
        rail({
          filecoinPayContract: filecoinPayContractA,
          railId: 1n,
          token: usdfcToken,
          payee: zeroAddress,
          payer: payerA,
          operator: operatorA,
          validator: zeroAddress,
        }).railCreatedTx(),
      ]),

      // seed auctions
      block(
        q1.startEpoch,
        range(0, 5).map(() => {
          return burnForFeesTx({
            token: usdfcToken.address,
            filecoinPayContract: filecoinPayContractA,
            recipient: payerA,
            requested: usdfcToken.formatNumericValue(10),
            value: auctionBaseValue,
          });
        }),
      ),

      // transaction simulating call to a multisig calling a multicall contract
      block(traceBlockNumber, [
        {
          hash: multiTxHash,
          to: safeAddress,

          // trace multisig -> multicall -> 2x burnForFees
          trace: [
            // call to multisig
            {
              type: 'call',
              subtraces: 1,
              traceAddress: [],
              action: {
                callType: 'call',
                from: callerAddress,
                to: safeAddress,
                gas: '0x493e0',
                input: '0x', // not required
                value: toHex(auctionBaseValue * 2n), // two auctions
              },
              result: {
                gasUsed: '0x186a0',
                output: '0x',
              },
              blockHash:
                '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              blockNumber: traceBlockNumber,
              transactionHash: multiTxHash,
              transactionPosition: 0,
            },

            // call to multicall
            {
              type: 'call',
              subtraces: 2,
              traceAddress: [0],
              action: {
                callType: 'call',
                from: safeAddress,
                to: multicallAddress,
                gas: '0x30d40',
                input: '0x',
                value: toHex(auctionBaseValue * 2n), // still 2 auctions worth
              },
              result: {
                gasUsed: '0x13880',
                output: '0x',
              },
              blockHash:
                '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              blockNumber: traceBlockNumber,
              transactionHash: multiTxHash,
              transactionPosition: 0,
            },

            // burnForFees 1
            {
              type: 'call',
              subtraces: 0,
              traceAddress: [0, 0],
              action: {
                callType: 'call',
                from: multicallAddress,
                to: filecoinPayContractA,
                gas: '0x9c40',
                input: encodeFunctionData({
                  abi: FilecoinPayV1ABI,
                  functionName: 'burnForFees',
                  args: [usdfcToken.address, callerAddress, requestedAmount1],
                }),
                value: toHex(auctionBaseValue),
              },
              result: {
                gasUsed: '0x7530',
                output: '0x',
              },
              blockHash:
                '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              blockNumber: traceBlockNumber,
              transactionHash: multiTxHash,
              transactionPosition: 0,
            },

            // burnForFees 2
            {
              type: 'call',
              subtraces: 0,
              traceAddress: [0, 1],
              action: {
                callType: 'call',
                from: multicallAddress,
                to: filecoinPayContractA,
                gas: '0x9c40',
                input: encodeFunctionData({
                  abi: FilecoinPayV1ABI,
                  functionName: 'burnForFees',
                  args: [usdfcToken.address, callerAddress, requestedAmount2],
                }),
                value: toHex(auctionBaseValue),
              },
              result: {
                gasUsed: '0x7530',
                output: '0x',
              },
              blockHash:
                '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              blockNumber: traceBlockNumber,
              transactionHash: multiTxHash,
              transactionPosition: 0,
            },
          ],

          // two burnForFees calls will produce two ERC20 transfers to the
          // recipient address (plus more irrelevant here, like burn transfers)
          logs: [
            {
              address: usdfcToken.address,
              eventName: 'Transfer',
              args: {
                from: filecoinPayContractA,
                to: callerAddress,
                value: requestedAmount1,
              },
            },
            {
              address: usdfcToken.address,
              eventName: 'Transfer',
              args: {
                from: filecoinPayContractA,
                to: callerAddress,
                value: requestedAmount2,
              },
            },
          ],
        },
      ]),
    ]);

    testFilecoinClient.forwardTo(q1.endEpoch + 1n);
    await indexerOrchestrator.execute();

    const response = await request(app.getHttpServer())
      .get(`/volume/1/${orchestratorA}`)
      .expect(200);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pricingPeriods = response.body.pricingPeriods as unknown[];

    expect(pricingPeriods.length).toBe(2);
    expect(pricingPeriods[0]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(11).toString(),
      claimAttoFil: auctionBaseValue.toString(),
    });
    expect(pricingPeriods[1]).toMatchObject({
      lotAttoUsd: filToken.formatNumericValue(12).toString(),
      claimAttoFil: auctionBaseValue.toString(),
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
