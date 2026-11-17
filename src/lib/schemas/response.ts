import z from 'zod';
import {
  isQuarterNumberInput,
  QuarterNumber,
  QuarterNumberInput,
} from '../quarter-number';
import { bigIntToString, evmAddress, hash } from './common';

// constants
const exampleOrchestratorAddress = '0xBD669aBd1188F52e82aF114E17aCE2842DCc0Eb4';
const exampleTransactionHash =
  '0xa56a191348e7b3edc125c1ce9ac1c1cc80f5f7e3404a90af031a96f7bc5263db';

// common zod types
const uint = z.bigint().min(0n).pipe(bigIntToString);
const nonNegativeNumber = z.number().min(0);
const quarterNumberInput = z.custom<QuarterNumberInput>(isQuarterNumberInput);
const quarterNumber = z.codec(quarterNumberInput, z.number().int().min(1), {
  decode: (value) => QuarterNumber.from(value).toNumber(),
  encode: (value) => QuarterNumber.from(value),
});
const paginationMetadata = z.object({
  pagination: z.object({
    page: z.number().int().min(1),
    pagesCount: z.bigint().min(1n).pipe(bigIntToString),
    totalCount: uint,
  }),
});

// schemas
export const indexerStatus = z.object({
  version: z.string().meta({
    description: 'Instance version',
  }),
  chainId: z.number().meta({
    description: 'Chain ID',
  }),
  indexedUpTo: uint.meta({
    description:
      'Lowest epoch number any of the indexed contract is indexed to',
  }),
  isRunning: z.boolean().meta({
    description: 'Is indexer currently syncing up',
  }),
  contracts: z.array(
    z.object({
      type: z.enum(['SRA', 'SWA', 'ERC20', 'FilecoinPayV1']),
      address: evmAddress.meta({
        description: 'Address of an indexed contract',
      }),
      indexedUpTo: uint.meta({
        description: 'This contract is indexed up to this epoch',
      }),
    }),
  ),
});
export type IndexerStatus = z.input<typeof indexerStatus>;

export const blockNumberResponse = z.object({
  blockNumber: uint.meta({
    description: 'Current block number returned by the RPC indexer is using.',
    example: 7_654_321n.toString(),
  }),
});
export type BlockNumberResponse = z.input<typeof blockNumberResponse>;

export const quarter = z.object({
  q: quarterNumber.meta({
    description: 'Quarter number. Integer starting from 1.',
    example: 1,
  }),
  startEpoch: uint.meta({
    description: 'Starting epoch of a quarter, inclusive.',
    example: 100n.toString(),
  }),
  endEpoch: uint.meta({
    description: 'Ending epoch of a quarter, inclusive.',
    example: 110n.toString(),
  }),
  completed: z.boolean().meta({
    description: `Flag telling if quarter completed or not (it's past it's end epoch).`,
  }),
});
export type Quarter = z.input<typeof quarter>;

export const quarterParameters = z.object({
  minLotAttoUsd: uint.meta({
    description: `Minimum lot for Filecoin Pay auction to qualify as a pricing 
      print for FIL volume, in attoUSD, calculated as described in FIP-0118.`,
    example: '500000000000000000',
  }),
  minLotUsd: nonNegativeNumber.meta({
    description: `Approximation of "minLotAttoUsd" in USD.`,
    example: 0.5,
  }),
  minLotFloorAttoUsd: uint.meta({
    description: `Minimum lot floor in atto-USD.`,
    example: '500000000000000000',
  }),
  minLotFloorUsd: nonNegativeNumber.meta({
    description: `Approximation of "minLotFloorAttoUsd" in USD.`,
    example: 0.5,
  }),
  minLotAlphaNumerator: uint.meta({
    description: `Numerator part of MIN_LOT_ALPHA`,
    example: '1',
  }),
  minLotAlphaDenominator: uint.meta({
    description: `Denominator part of MIN_LOT_ALPHA`,
    example: '400',
  }),
  minLotAlpha: z
    .number()
    .min(0)
    .meta({
      description: `Approximate result of dividing "minLotAlphaNumerator" by 
        "minLotAlphaDenominator".`,
      example: 0.0025,
    }),
  priceBandBps: uint.meta({
    description: 'Price band in basis points.',
    example: '3000',
  }),
  priceBand: z.number().min(0).meta({
    description: `Approximate result of dividing "priceBandBps" by 10000.`,
    example: 0.3,
  }),
  registrationCutoff: uint.meta({
    description: `Registration cutoff in epochs. Pair registration in the last
      cutoff of a quarter applies from the start of next quarter.`,
    example: '20160',
  }),
  admittedStablecoins: z.array(evmAddress).meta({
    description: 'List of stablecoins addresses admitted in given quarter.',
    example: [
      '0x80b98d3aa09ffff255c3ba4a241111ff1262f045',
      '0xeb466342c4d449bc9f53a865d5cb90586f405215',
    ],
  }),
  admittedFilecoinPayContractAddresses: z.array(evmAddress).meta({
    description: `List of Filecoin Pay contract addresses admitted in given 
      quarter.`,
    example: ['0x23b1e018f08bb982348b15a86ee926eebf7f4daa'],
  }),
  previousQuarterPricePeriodsCount: z
    .number()
    .int()
    .min(0)
    .meta({
      description: `Number of qualified pricing periods in previous quarter. 
        Used in calculating "minLotAttoUsd".`,
      example: 12,
    }),
  previousQuarterBoundVolumeAttoUsd: uint.meta({
    description: `Total volume posted by Orchestrators in previous quarter. 
      Used in calculating "minLotAttoUsd".`,
    example: 3_200_000_000_000_000_000_000n.toString(),
  }),
  previousQuarterBoundVolumeUsd: nonNegativeNumber.meta({
    description: `Approximation of "previousQuarterBoundVolumeAttoUsd" in USD.`,
    example: 3200,
  }),
});
export type QuarterParameters = z.input<typeof quarterParameters>;

export const orchestratorAdmissionPeriod = z.object({
  wallet: evmAddress.meta({
    description:
      'Wallet address of Service Orchestrator during that admittance period.',
    example: exampleOrchestratorAddress,
  }),
  admissionEpoch: uint.meta({
    description: 'Admission epoch.',
    example: 1234n,
  }),
  admissionLogIndex: nonNegativeNumber.meta({
    description: 'Admission log index.',
  }),
  admissionTxHash: hash.meta({
    description: 'Hash of transaction that admitted a Service Orchestrator.',
    example: exampleTransactionHash,
  }),
  removalEpoch: uint.nullable().meta({
    description: 'Epoch at which admission ended. Null for ongoing admissions.',
    example: 4321n.toString(),
  }),
  removalLogIndex: nonNegativeNumber.nullable().meta({
    description:
      'Log index at which admission ended. Null for ongoing admissions.',
    example: null,
  }),
  removalTxHash: hash.nullable().meta({
    description:
      'Hash of transaction that ended a Service Orchestrator admission. Null for ongoing admissions',
    example: exampleTransactionHash,
  }),
});
export type OrchestratorAdmissionPeriod = z.input<
  typeof orchestratorAdmissionPeriod
>;

export const serviceOrchestrator = z.object({
  id: evmAddress.meta({
    description: 'Identyfing address of Service Orchestrator.',
    example: exampleOrchestratorAddress,
  }),
  admissionPeriods: z.array(orchestratorAdmissionPeriod).meta({
    description: 'Periods at which Service Orchestrator was admitted.',
  }),
});
export type ServiceOrchestrator = z.input<typeof serviceOrchestrator>;

export const serviceOrchestratorsList = z.array(serviceOrchestrator);
export type ServiceOrchestratorsList = z.input<typeof serviceOrchestratorsList>;

export const pricingPeriod = z.object({
  auctionTransactionHash: hash.meta({
    description: 'Hash of transaction that created this pricing period.',
  }),
  startEpoch: uint.meta({
    description: 'Epoch from which pricing period applies (inclusive).',
    example: '110',
  }),
  startTxPosition: nonNegativeNumber.meta({
    description:
      'Transaction position within a tipset from which pricing period applies (inclusive).',
    example: 0,
  }),
  startCallIndex: nonNegativeNumber.meta({
    description: `Call index within a transaction from which pricing period
      applies (inclusive).`,
    example: 0,
  }),
  endEpoch: uint.meta({
    description: `Epoch to which pricing period applies (inclusive). Also epoch 
      at which fee auction that created this pricing period occurred.`,
    example: '120',
  }),
  endTxPosition: nonNegativeNumber.meta({
    description: `Transaction position within a tipset to which pricing period
      applies (inclusive). Also transaction position at which fee auction that
      created this pricing period occurred.`,
    example: 10,
  }),
  endCallIndex: nonNegativeNumber.meta({
    description: `Call indexed within a transaction to which this pricing period
      applies. Also a position of a trace that created the pricing period,
      within it's transaction.`,
    example: 10,
  }),
  lotAttoUsd: uint.meta({
    description: `Amount of fees auctioned in auction that created this pricing 
      period, in atto-USD.`,
    example: 432_100_000_000_000_000_000n.toString(),
  }),
  lotUsd: nonNegativeNumber.meta({
    description: 'Approximation of "lotAttoUsd" in USD.',
    example: 432.1,
  }),
  claimAttoFil: uint.meta({
    description: `Amount of FIL burned in auction that created this pricing 
      period, in atto-FIL.`,
    example: 123_400_000_000_000_000_000n.toString(),
  }),
  claimFil: nonNegativeNumber.meta({
    description: 'Approximation of "claimAttoFil" in FIL.',
    example: 1.23,
  }),
  impliedRate: z.number().min(0),
});
export type PricingPeriod = z.input<typeof pricingPeriod>;

export const pricingPeriodWithVolume = pricingPeriod.extend({
  volumeAttoFil: uint.meta({
    description: `Amount of Orchestrator's FIL volume priced by this pricing 
      period, in atto-FIL.`,
    example: 123_400_000_000_000_000_000n.toString(),
  }),
  volumeFil: nonNegativeNumber.meta({
    description: `Approximation of "volumeAttoFil" in FIL.`,
    example: 123.4,
  }),
  volumeAttoUsd: uint.meta({
    description: `Total FIL volume of Orchestrator accrued in given pricing 
      period, converted to atto-USD and floored.`,
    example: 432_100_000_000_000_000_000n.toString(),
  }),
  volumeUsd: nonNegativeNumber.meta({
    description: `Approximation of "volumeAttoUsd" in USD.`,
    example: 432.1,
  }),
});
export type PricingPeriodWithVolume = z.input<typeof pricingPeriodWithVolume>;

export const quarterlyVolume = z.object({
  quarter: quarter.meta({
    description: `Quarter attributed to volume reported here.`,
  }),
  volumeAttoUsd: uint.meta({
    description: `Orchestrator's total volume in given quarter. Sum of total 
      stablecoin volume and total FIL volume. This is the figure Orchestrator 
      should post after quarter end.`,
    example: 200_000_000_000_000_000_000n.toString(),
  }),
  volumeUsd: nonNegativeNumber.meta({
    description: `Approximation of "volumeAttoUsd" in USD.`,
    example: 200,
  }),
  filVolumeAttoUsd: uint.meta({
    description: `Orchestrator's total FIL volume in given quarter. Sum of FIL 
      volume converted to USD for each pricing period.`,
    example: 100_000_000_000_000_000_000n.toString(),
  }),
  filVolumeUsd: nonNegativeNumber.meta({
    description: `Approximation of "filVolumeAttoUsd" in USD.`,
    example: 100,
  }),
  stablecoinVolumeAttoUsd: uint.meta({
    description: `Orchestrator's total stablecoin volume in given quarter.`,
    example: 100_000_000_000_000_000_000n.toString(),
  }),
  stablecoinVolumeUsd: nonNegativeNumber.meta({
    description: `Approximation of "stablecoinVolumeAttoUsd" in USD.`,
    example: 100,
  }),
  pricingPeriods: z.array(pricingPeriodWithVolume).meta({
    description: `List of pricing periods that priced FIL volume during given quarter.`,
  }),
});
export type QuarterlyVolume = z.input<typeof quarterlyVolume>;

export const volumePostingOrCorrection = z.object({
  serviceOrchestrator: evmAddress.meta({
    description: `Identifying address of Service Orchestrator.`,
    example: exampleOrchestratorAddress,
  }),
  volumeAttoUsd: uint.meta({
    description: `Volume declared or corrected in atto-USD.`,
    example: 65_432_100_000_000_000_000_000n.toString(),
  }),
  correction: z.boolean().meta({
    description: `Boolean flag telling if posting is a correction (based on 
      "VolumeCorrected" events).`,
    example: false,
  }),
  postingEpoch: uint.meta({
    description: `Epoch at posting or correction was made for given quarter.`,
    example: '111',
  }),
  postingTxHash: hash.meta({
    description: `Hash of transaction responsible for posting or correction.`,
    example: exampleTransactionHash,
  }),
});
export type VolumePostingOrCorrection = z.input<
  typeof volumePostingOrCorrection
>;

export const quarterlyVolumePostings = z.object({
  quarterNumber: quarterNumber.meta({
    description: 'Quarter number.',
  }),
  aggregatedVolumeAttoUsd: uint.meta({
    description: 'Sum of all orchestrators final postings.',
  }),
  postings: z.array(volumePostingOrCorrection).meta({
    description: 'Orchestrators final postings list in given quarter.',
  }),
});
export type QuarterlyVolumePostings = z.input<typeof quarterlyVolumePostings>;

export const orchestratorQuarterlyVolumePosting = z.object({
  serviceOrchestrator: evmAddress.meta({
    description: `Identifying address of Service Orchestrator.`,
    example: exampleOrchestratorAddress,
  }),
  quarterNum: quarterNumber.meta({
    description: `Quarter number attributed to the volume posting.`,
    example: 1,
  }),
  volumeAttoUsd: uint.nullable().meta({
    description: `Final volume after corrections in atto-USD. Null if no volume 
      was posted or if volume was corrected to 0.`,
    example: 65_432_100_000_000_000_000_000n.toString(),
  }),
  corrected: z.boolean().meta({
    description: `Boolean flag telling if volume was corrected after initial 
      posting by Orchestrator.`,
    example: false,
  }),
  missed: z.boolean().meta({
    description: `Boolean flag telling if Service Orchestrator missed volume 
      posting window.`,
    example: false,
  }),
  postingEpoch: uint.nullable().meta({
    description: `Epoch at which final volume after corrections was decided. 
      Null if "volumeAttoUsd" is null.`,
    example: '111',
  }),
  postingTxHash: hash.nullable().meta({
    description: `Hash of transaction that decided the final volume. Null if 
      "volumeAttoUsd" is null.`,
    example: exampleTransactionHash,
  }),
  postings: z.array(volumePostingOrCorrection).meta({
    description: `List of all Orchestrator postings and corections made.`,
  }),
});
export type OrchestratorQuarterlyVolumePosting = z.input<
  typeof orchestratorQuarterlyVolumePosting
>;

export const gateTarget = z.object({
  atEpoch: uint.nullable().meta({
    description: 'State as of epoch. Null means most recent epoch.',
    example: 4321n.toString(),
  }),
  lastCheckEpoch: uint.nullable().meta({
    description:
      'Epoch at which last check occurred. Null if no checks occurred.',
    example: 1234n.toString(),
  }),
  capReached: z.boolean(),
  targetAttoUsd: uint.meta({
    description: 'Calculated gate target in atto USD.',
    example: 3_500_000_000_000_000_000_000n.toString(),
  }),
  targetUsd: nonNegativeNumber.meta({
    description: 'Approximated gate target in USD.',
    example: 3_500,
  }),
});
export type GateTarget = z.input<typeof gateTarget>;

export const paginatedPaymentsList = z
  .object({
    data: z.array(
      z.object({
        filecoinPayContract: z.string().nonempty().meta({
          description:
            'Address of Filecoin Pay contract the payment was made on.',
        }),
        epoch: uint.meta({
          description: 'Epoch at which the payment was made.',
        }),
        logIndex: z.number().int().min(0).meta({
          description: 'Log index on which the payment event occurred.',
        }),
        transactionHash: z.string().nonempty().meta({
          description: 'Hash of the transaction containing the payment.',
        }),
        railId: uint.meta({
          description: 'ID of Filecoin Pay rail the payment was made on.',
        }),
        payer: z.string().nonempty().meta({
          description: 'Address of the payer.',
        }),
        payee: z.string().nonempty().meta({
          description: 'Address of the payee (recipient of the funds).',
        }),
        operator: z.string().nonempty().meta({
          description: 'Rail operator contract address.',
        }),
        tokenAddress: z.string().nonempty().meta({
          description:
            'Address of the ERC20 token the payment was made in or zero address for FIL payments.',
        }),
        tokenDecimals: z.number().int().min(0).meta({
          description:
            'Number of decimal places of the token the payment was made in.',
        }),
        tokenSymbol: z.string().nonempty().meta({
          description: 'Symbol of the token the payment was made in.',
        }),
        totalAmountBaseUnits: uint.meta({
          description: 'Total payment amount in underlying token base units.',
        }),
        totalAmount: nonNegativeNumber.meta({
          description: 'totalAmountBaseUnits / 10^tokenDecimals',
        }),
        netPayeeAmountBaseUnits: uint.meta({
          description:
            'Net payee amount (amount payee receives after fees and commissions) in underlying token base units.',
        }),
        netPayeeAmount: nonNegativeNumber.meta({
          description: 'netPayeeAmountBaseUnits / 10^tokenDecimals',
        }),
        networkFeeBaseUnits: uint.meta({
          description: 'Network fee in underlying token base units.',
        }),
        networkFee: nonNegativeNumber.meta({
          description: 'networkFeeBaseUnits / 10^tokenDecimals',
        }),
        operatorComissionBaseUnits: uint.meta({
          description: 'Operator commission in underlying token base units.',
        }),
        operatorComission: nonNegativeNumber.meta({
          description: 'operatorComission / 10^tokenDecimals',
        }),
        serviceOrchestrator: z.string().nullable().meta({
          description:
            "Identifying address of the Service Orchestrator the payment is attributed to. Null if it can't be attributed to any Orchestrator.",
        }),
        filecoinPayContractWhitelisted: z.boolean().meta({
          description:
            'Flag telling if the Filecoin Pay contract address the payment was made on was whitelisted in the quarter the payment was made in.',
        }),
        tokenWhitelisted: z.boolean().meta({
          description:
            'Flag telling if the address of the token the payment was made in was whitelisted in the quarter the payment was made in. Always true for FIL payments.',
        }),
        quarter: quarter.nullable().meta({
          description:
            'Quarter the payment was made in. Null if made before the activation epoch.',
        }),
        pricingPeriod: pricingPeriod.nullable().meta({
          description:
            'Price period that prices this payment. Null if no qualifying price was found for the payment or if the payment was made in a token other than FIL.',
        }),
      }),
    ),
  })
  .extend(paginationMetadata.shape);

export type PaginatedPaymentsList = z.input<typeof paginatedPaymentsList>;
