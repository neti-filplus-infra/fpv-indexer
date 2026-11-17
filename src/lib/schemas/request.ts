import { uniq } from 'es-toolkit';
import z from 'zod';
import { isQuarterNumberInput, QuarterNumber } from '../quarter-number';
import { evmAddress, SortKey, SortKeyBase, stringToBigInt } from './common';

// common zod types
const uint = stringToBigInt.pipe(z.bigint().min(0n));
const quarterNumber = z.codec(
  z
    .string()
    .refine(isQuarterNumberInput, { message: 'Invalid quarter number' }),
  z.instanceof(QuarterNumber),
  {
    decode: (value) => QuarterNumber.from(value),
    encode: (value) => value.toString(),
  },
);

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

function createPaginationSchema({ maxLimit }: { maxLimit?: number } = {}) {
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

// schemas
export const quarterNumberFilter = z.object({
  quarterNumber: quarterNumber.meta({
    description: 'Quarter number',
  }),
});
export type QuarterNumberFilter = z.output<typeof quarterNumberFilter>;

export const orchestratorQuarterlyVolumeParameters = z.object({
  quarterNumber: quarterNumber.meta({
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
  typeof orchestratorQuarterlyVolumeParameters
>;

export const gateTargetParameters = z.object({
  atEpoch: uint.optional().meta({
    description:
      'Provide to fetch state as of this epoch. Leave empty for most recent epoch.',
  }),
});
export type GateTargetParameters = z.output<typeof gateTargetParameters>;

export const paymentsQuery = z
  .object({
    serviceOrchestrator: z.string().optional().meta({
      description: `Service Orchestrator address to filter payments by`,
    }),
    fromEpoch: uint.optional().meta({
      description:
        'Return payments settled at or after this epoch, or, in the case of FIL payments, priced at or after this epoch (inclusive).',
    }),
    toEpoch: uint.optional().meta({
      description:
        'Return payments settled at or before this epoch, or, in the case of FIL payments, priced at or before this epoch (inclusive).',
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
export type PaymentsQuery = z.output<typeof paymentsQuery>;
