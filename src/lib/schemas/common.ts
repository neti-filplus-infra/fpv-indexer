import { isAddress, isHash } from 'viem';
import z from 'zod';

export type SortKey<T extends string> = T extends `${'+' | '-'}${string}`
  ? T
  : T | `+${T}` | `-${T}`;

export type SortKeyBase<T extends string> = T extends `+${infer Base}`
  ? Base
  : T extends `-${infer Base}`
    ? Base
    : T;

// zod types
export const evmAddress = z
  .string()
  .refine((value) => isAddress(value), { message: 'Invalid EVM address' });

export const hash = z
  .string()
  .refine((value) => isHash(value), { message: 'Invalid transaction hash' });

// codecs
export const stringToBigInt = z.codec(z.string(), z.bigint(), {
  decode: (value) => BigInt(value),
  encode: (value) => value.toString(),
});

export const bigIntToString = z.invertCodec(stringToBigInt);
