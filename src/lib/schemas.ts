import { uniq } from 'es-toolkit';
import { isAddress, isHash } from 'viem';
import z from 'zod';
import { isQuarterNumberInput, QuarterNumber } from './quarter-number';

interface PaginationSchemaParameters {
  maxLimit?: number;
}

export type SortKey<T extends string> = T extends `${'+' | '-'}${string}`
  ? T
  : T | `+${T}` | `-${T}`;

export type SortKeyBase<T extends string> = T extends `+${infer Base}`
  ? Base
  : T extends `-${infer Base}`
    ? Base
    : T;

// constants
const exampleOrchestratorAddress = '0xBD669aBd1188F52e82aF114E17aCE2842DCc0Eb4';
const exampleTransactionHash =
  '0xa56a191348e7b3edc125c1ce9ac1c1cc80f5f7e3404a90af031a96f7bc5263db';

// codecs
export const inputToBigIntCodec = z.codec(
  z.union([z.string(), z.number()]),
  z.bigint(),
  {
    decode: (value) => BigInt(value),
    encode: (value) => value.toString(),
  },
);

export const bigIntToStringCodec = z.codec(z.bigint(), z.string(), {
  decode: (value) => value.toString(),
  encode: (value) => BigInt(value),
});

export const quarterNumberInputToQuarterNumberCodec = z.codec(
  z
    .union([z.string(), z.number()])
    .refine(isQuarterNumberInput, { message: 'Invalid quarter number' }),
  z.instanceof(QuarterNumber),
  {
    decode: (value) => QuarterNumber.from(value),
    encode: (value) => value.toNumber(),
  },
);

// common
export const uintInput = inputToBigIntCodec.pipe(z.bigint().min(0n));
export const uintOutput = z.bigint().min(0n).pipe(bigIntToStringCodec);
export const epochInput = uintInput;
export const epochOutput = uintOutput;
export const logIndex = z.number().int().min(0);
export const quarterNumber = z.number().int().min(1);
export const currencyPositiveValue = z.number().min(0);
export const evmAddress = z
  .string()
  .refine((value) => isAddress(value), { message: 'Invalid EVM address' });
export const txHash = z
  .string()
  .refine((value) => isHash(value), { message: 'Invalid transaction hash' });

// user input
export const quarterNumberFilterSchema = z.object({
  quarterNumber: quarterNumberInputToQuarterNumberCodec.meta({
    description: 'Quarter number',
  }),
});
export type QuarterNumberFilter = z.output<typeof quarterNumberFilterSchema>;

export const orchestratorQuarterlyVolumeParametersSchema = z.object({
  quarterNumber: quarterNumberInputToQuarterNumberCodec.meta({
    description: `Quarter number for which postings should be returned. Integer 
      starting from 1 optionally prefixed with Q eg. Q1 for quarter number 1.`,
    example: '1',
  }),
  serviceOrchestrator: evmAddress.meta({
    description:
      'Identifying address of an Orchestrator (not payout wallet address).',
  }),
});
export type OrchestratorQuarterlyVolumeParameters = z.output<
  typeof orchestratorQuarterlyVolumeParametersSchema
>;

export const gateTargetParametersSchema = z.object({
  atEpoch: epochInput.optional().meta({
    description:
      'Provide to fetch state as of this epoch. Leave empty for most recent epoch.',
  }),
});
export type GateTargetParameters = z.output<typeof gateTargetParametersSchema>;

export const paymentsQuerySchema = z
  .object({
    serviceOrchestrator: z.string().optional().meta({
      description: `Service Orchestrator address to filter payments by`,
    }),
    fromEpoch: epochInput.optional().meta({
      description:
        'Return payments settled at or after this epoch (inclusive).',
    }),
    toEpoch: epochInput.optional().meta({
      description:
        'Return payments settled at or before this epoch (inclusive).',
    }),
    countsTowardsVolume: z
      .stringbool()
      .optional()
      .meta({
        description: `Pass truthy value to return only payments that count 
          towards volume, falsy for reverse or omit for all. Payment counts 
          towards volume only if following were true at settlement time:\n
            - Filecoin Pay contract they were made on was whitelisted\n
            - Token they were made in was whitelisted\n
            - (payer, operator) pair was bound to a Service Orchestrator\n`,
      }),
  })
  .extend(createSortingSchema(['epoch'] as const, '-epoch').shape)
  .extend(createPaginationSchema({ maxLimit: 100 }).shape);
export type PaymentsQuery = z.output<typeof paymentsQuerySchema>;

// server output
const paginationMetadataSchema = z.object({
  pagination: z.object({
    page: z.number().int().min(1),
    pagesCount: z.bigint().min(1n).pipe(bigIntToStringCodec),
    totalCount: uintOutput,
  }),
});
export type PaginationMetadata = z.input<typeof paginationMetadataSchema>;

export const indexerStatusSchema = z.object({
  version: z.string().meta({
    description: 'Instance version',
  }),
  indexedUpTo: epochOutput.meta({
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
      indexedUpTo: epochOutput.meta({
        description: 'This contract is indexed up to this epoch',
      }),
    }),
  ),
});
export type IndexerStatus = z.input<typeof indexerStatusSchema>;

export const blockNumberResponseSchema = z.object({
  blockNumber: uintOutput.meta({
    description: 'Current block number returned by the RPC indexer is using.',
    example: 7_654_321n.toString(),
  }),
});
export type BlockNumberResponse = z.input<typeof blockNumberResponseSchema>;

export const quarterSchema = z.object({
  q: quarterNumber.meta({
    description: 'Quarter number. Integer starting from 1.',
    example: 1,
  }),
  startEpoch: epochOutput.meta({
    description: 'Starting epoch of a quarter, inclusive.',
    example: 100n.toString(),
  }),
  endEpoch: epochOutput.meta({
    description: 'Ending epoch of a quarter, inclusive.',
    example: 110n.toString(),
  }),
  completed: z.boolean().meta({
    description: `Flag telling if quarter completed or not (it's past it's end epoch).`,
  }),
});
export type Quarter = z.input<typeof quarterSchema>;

export const quarterParametersSchema = z.object({
  minLotAttoUsd: uintOutput.meta({
    description: `Minimum lot for Filecoin Pay auction to qualify as a pricing 
      print for FIL volume, in attoUSD, calculated as described in FIP-0118.`,
    example: '500000000000000000',
  }),
  minLotUsd: currencyPositiveValue.meta({
    description: `Approximation of "minLotAttoUsd" in USD.`,
    example: 0.5,
  }),
  minLotFloorAttoUsd: uintOutput.meta({
    description: `Minimum lot floor in atto-USD.`,
    example: '500000000000000000',
  }),
  minLotFloorUsd: currencyPositiveValue.meta({
    description: `Approximation of "minLotFloorAttoUsd" in USD.`,
    example: 0.5,
  }),
  minLotAlphaNumerator: uintOutput.meta({
    description: `Numerator part of MIN_LOT_ALPHA`,
    example: '1',
  }),
  minLotAlphaDenominator: uintOutput.meta({
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
  priceBandBps: uintOutput.meta({
    description: 'Price band in basis points.',
    example: '3000',
  }),
  priceBand: z.number().min(0).meta({
    description: `Approximate result of dividing "priceBandBps" by 10000.`,
    example: 0.3,
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
  previousQuarterBoundVolumeAttoUsd: uintOutput.meta({
    description: `Total volume posted by Orchestrators in previous quarter. 
      Used in calculating "minLotAttoUsd".`,
    example: 3_200_000_000_000_000_000_000n.toString(),
  }),
  previousQuarterBoundVolumeUsd: currencyPositiveValue.meta({
    description: `Approximation of "previousQuarterBoundVolumeAttoUsd" in USD.`,
    example: 3200,
  }),
});
export type QuarterParameters = z.input<typeof quarterParametersSchema>;

export const orchestratorAdmissionPeriodSchema = z.object({
  wallet: evmAddress.meta({
    description:
      'Wallet address of Service Orchestrator during that admittance period.',
    example: exampleOrchestratorAddress,
  }),
  admissionEpoch: epochOutput.meta({
    description: 'Admission epoch.',
    example: 1234n,
  }),
  admissionLogIndex: logIndex.meta({
    description: 'Admission log index.',
  }),
  admissionTxHash: txHash.meta({
    description: 'Hash of transaction that admitted a Service Orchestrator.',
    example: exampleTransactionHash,
  }),
  removalEpoch: epochOutput.nullable().meta({
    description: 'Epoch at which admission ended. Null for ongoing admissions.',
    example: 4321n.toString(),
  }),
  removalLogIndex: logIndex.nullable().meta({
    description:
      'Log index at which admission ended. Null for ongoing admissions.',
    example: null,
  }),
  removalTxHash: txHash.nullable().meta({
    description:
      'Hash of transaction that ended a Service Orchestrator admission. Null for ongoing admissions',
    example: exampleTransactionHash,
  }),
});
export type OrchestratorAdmissionPeriod = z.input<
  typeof orchestratorAdmissionPeriodSchema
>;

export const serviceOrchestratorSchema = z.object({
  id: evmAddress.meta({
    description: 'Identyfing address of Service Orchestrator.',
    example: exampleOrchestratorAddress,
  }),
  admissionPeriods: z.array(orchestratorAdmissionPeriodSchema).meta({
    description: 'Periods at which Service Orchestrator was admitted.',
  }),
});
export type ServiceOrchestrator = z.input<typeof serviceOrchestratorSchema>;

export const serviceOrchestratorsListSchema = z.array(
  serviceOrchestratorSchema,
);
export type ServiceOrchestratorsList = z.input<
  typeof serviceOrchestratorsListSchema
>;

export const pricingPeriodSchema = z.object({
  startEpoch: epochOutput.meta({
    description: 'Epoch from which pricing period applies (inclusive).',
    example: '110',
  }),
  startLogIndex: logIndex.meta({
    description: 'Log index from which pricing period applies (inclusive).',
    example: 0,
  }),
  endEpoch: epochOutput.meta({
    description: 'Epoch to which pricing period applies (inclusive).',
    example: '120',
  }),
  endLogIndex: logIndex.meta({
    description: 'Log index to which pricing period applies (inclusive).',
    example: 10,
  }),
  lotAttoUsd: uintOutput.meta({
    description: `Amount of fees auctioned in auction that created this pricing 
      period, in atto-USD.`,
    example: 432_100_000_000_000_000_000n.toString(),
  }),
  lotUsd: currencyPositiveValue.meta({
    description: 'Approximation of "lotAttoUsd" in USD.',
    example: 432.1,
  }),
  claimAttoFil: uintOutput.meta({
    description: `Amount of FIL burned in auction that created this pricing 
      period, in atto-FIL.`,
    example: 123_400_000_000_000_000_000n.toString(),
  }),
  claimFil: currencyPositiveValue.meta({
    description: 'Approximation of "claimAttoFil" in FIL.',
    example: 1.23,
  }),
  impliedRate: z.number().min(0),
});
export type PricingPeriod = z.input<typeof pricingPeriodSchema>;

export const pricingPeriodWithVolumeSchema = pricingPeriodSchema.extend({
  volumeAttoFil: uintOutput.meta({
    description: `Amount of Orchestrator's FIL volume priced by this pricing 
      period, in atto-FIL.`,
    example: 123_400_000_000_000_000_000n.toString(),
  }),
  volumeFil: currencyPositiveValue.meta({
    description: `Approximation of "volumeAttoFil" in FIL.`,
    example: 123.4,
  }),
  volumeAttoUsd: uintOutput.meta({
    description: `Total FIL volume of Orchestrator accrued in given pricing 
      period, converted to atto-USD and floored.`,
    example: 432_100_000_000_000_000_000n.toString(),
  }),
  volumeUsd: currencyPositiveValue.meta({
    description: `Approximation of "volumeAttoUsd" in USD.`,
    example: 432.1,
  }),
});
export type PricingPeriodWithVolume = z.input<
  typeof pricingPeriodWithVolumeSchema
>;

export const quarterlyVolumeSchema = z.object({
  quarter: quarterSchema.meta({
    description: `Quarter attributed to volume reported here.`,
  }),
  volumeAttoUsd: uintOutput.meta({
    description: `Orchestrator's total volume in given quarter. Sum of total 
      stablecoin volume and total FIL volume. This is the figure Orchestrator 
      should post after quarter end.`,
    example: 200_000_000_000_000_000_000n.toString(),
  }),
  volumeUsd: currencyPositiveValue.meta({
    description: `Approximation of "volumeAttoUsd" in USD.`,
    example: 200,
  }),
  filVolumeAttoUsd: uintOutput.meta({
    description: `Orchestrator's total FIL volume in given quarter. Sum of FIL 
      volume converted to USD for each pricing period.`,
    example: 100_000_000_000_000_000_000n.toString(),
  }),
  filVolumeUsd: currencyPositiveValue.meta({
    description: `Approximation of "filVolumeAttoUsd" in USD.`,
    example: 100,
  }),
  stablecoinVolumeAttoUsd: uintOutput.meta({
    description: `Orchestrator's total stablecoin volume in given quarter.`,
    example: 100_000_000_000_000_000_000n.toString(),
  }),
  stablecoinVolumeUsd: currencyPositiveValue.meta({
    description: `Approximation of "stablecoinVolumeAttoUsd" in USD.`,
    example: 100,
  }),
  pricingPeriods: z.array(pricingPeriodWithVolumeSchema).meta({
    description: `List of pricing periods that priced FIL volume during given quarter.`,
  }),
});
export type QuarterlyVolume = z.input<typeof quarterlyVolumeSchema>;

export const volumePostingOrCorrectionSchema = z.object({
  serviceOrchestrator: evmAddress.meta({
    description: `Identifying address of Service Orchestrator.`,
    example: exampleOrchestratorAddress,
  }),
  volumeAttoUsd: uintOutput.meta({
    description: `Volume declared or corrected in atto-USD.`,
    example: 65_432_100_000_000_000_000_000n.toString(),
  }),
  correction: z.boolean().meta({
    description: `Boolean flag telling if posting is a correction (based on 
      "VolumeCorrected" events).`,
    example: false,
  }),
  postingEpoch: epochOutput.meta({
    description: `Epoch at posting or correction was made for given quarter.`,
    example: '111',
  }),
  postingTxHash: txHash.meta({
    description: `Hash of transaction responsible for posting or correction.`,
    example: exampleTransactionHash,
  }),
});
export type VolumePostingOrCorrection = z.input<
  typeof volumePostingOrCorrectionSchema
>;

export const orchestratorQuarterlyVolumePostingSchema = z.object({
  serviceOrchestrator: evmAddress.meta({
    description: `Identifying address of Service Orchestrator.`,
    example: exampleOrchestratorAddress,
  }),
  quarterNum: quarterNumber.meta({
    description: `Quarter number attributed to the volume posting.`,
    example: 1,
  }),
  volumeAttoUsd: uintOutput.nullable().meta({
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
  postingEpoch: epochOutput.nullable().meta({
    description: `Epoch at which final volume after corrections was decided. 
      Null if "volumeAttoUsd" is null.`,
    example: '111',
  }),
  postingTxHash: txHash.nullable().meta({
    description: `Hash of transaction that decided the final volume. Null if 
      "volumeAttoUsd" is null.`,
    example: exampleTransactionHash,
  }),
  postings: z.array(volumePostingOrCorrectionSchema).meta({
    description: `List of all Orchestrator postings and corections made.`,
  }),
});
export type OrchestratorQuarterlyVolumePosting = z.input<
  typeof orchestratorQuarterlyVolumePostingSchema
>;

export const gateTargetSchema = z.object({
  atEpoch: epochOutput.nullable().meta({
    description: 'State as of epoch. Null means most recent epoch.',
    example: 4321n.toString(),
  }),
  lastCheckEpoch: epochOutput.nullable().meta({
    description:
      'Epoch at which last check occured. Null if no checks occured.',
    example: 1234n.toString(),
  }),
  targetAttoUsd: uintOutput.meta({
    description: 'Calculated gate target in atto USD.',
    example: 3_500_000_000_000_000_000_000n.toString(),
  }),
  targetUsd: currencyPositiveValue.meta({
    description: 'Approximated gate target in USD.',
    example: 3_500,
  }),
});
export type GateTarge = z.input<typeof gateTargetSchema>;

export const paginatedPaymentsListSchema = z
  .object({
    data: z.array(
      z.object({
        filecoinPayContract: z.string().nonempty(),
        epoch: epochOutput,
        logIndex: z.number().int().min(0),
        transactionHash: z.string().nonempty(),
        railId: z.bigint().min(1n).pipe(bigIntToStringCodec),
        payer: z.string().nonempty(),
        payee: z.string().nonempty(),
        operator: z.string().nonempty(),
        tokenAddress: z.string().nonempty(),
        tokenDecimals: z.number().int().min(0),
        tokenSymbol: z.string().nonempty(),
        totalAmountBaseUnits: uintOutput,
        totalAmount: currencyPositiveValue,
        netPayeeAmountBaseUnits: uintOutput,
        netPayeeAmount: currencyPositiveValue,
        networkFeeBaseUnits: uintOutput,
        networkFee: currencyPositiveValue,
        operatorComissionBaseUnits: uintOutput,
        operatorComission: currencyPositiveValue,
        serviceOrchestrator: z.string().nullable(),
        filecoinPayContractWhitelisted: z.boolean(),
        tokenWhitelisted: z.boolean(),
        quarter: quarterSchema.nullable(),
        pricingPeriod: pricingPeriodSchema.nullable(),
      }),
    ),
  })
  .extend(paginationMetadataSchema.shape);

export type PaginatedPaymentsList = z.input<typeof paginatedPaymentsListSchema>;

// utils
export function sortKeyBase<T extends string>(
  input: T | SortKey<T>,
): SortKeyBase<T> {
  const base =
    input.startsWith('-') || input.startsWith('+') ? input.slice(1) : input;

  return base as SortKeyBase<T>;
}

function fieldsToSortKeys<T extends string>(input: [T, ...T[]]): SortKey<T>[] {
  const options = input.flatMap((key) => {
    const base = sortKeyBase(key);
    return [base, `-${base}`, `+${base}`];
  });

  return uniq(options) as [SortKey<T>, ...SortKey<T>[]];
}

function createSortingSchema<T extends string>(
  allowedFields: [T, ...T[]],
  defaultSort: SortKey<T>,
) {
  const allowedKeys = fieldsToSortKeys(allowedFields);
  const exampleField =
    allowedFields[0].startsWith('-') || allowedFields[0].startsWith('+')
      ? allowedFields[0].slice(1)
      : allowedFields[0];

  return z.object({
    sort: z
      .preprocess(
        (value) => {
          if (typeof value === 'string') {
            return value.split(',').map((field) => field.trim());
          }

          return value;
        },
        z.array(z.enum(allowedKeys)).min(1).default([defaultSort]),
      )
      .meta({
        description: `Sort order. For multiple fields sorting pass array or 
          comma separated string. Prefix with "-" for descending sort.`,
        example: `-${exampleField}`,
        default: [defaultSort],
      }),
  });
}

function createPaginationSchema({ maxLimit }: PaginationSchemaParameters = {}) {
  let limitSchema = z.coerce.number().int().min(1);

  if (maxLimit !== undefined) {
    if (!limitSchema.safeParse(maxLimit).success) {
      throw new TypeError('maxLimit must be an integer of at least 1');
    }

    limitSchema = limitSchema.max(maxLimit);
  }

  return z.object({
    page: z.coerce.number().int().min(1).default(1).meta({
      title: `Page number. Integer starting from 1.`,
      description: `Page number. Integer starting from 1.`,
      default: 1,
      example: 1,
    }),
    limit: limitSchema.optional().meta({
      description: `Number of items per page. Integer starting. Minimum 1.`,
    }),
  });
}
