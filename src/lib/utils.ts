import { BigNumber } from 'bignumber.js';
import { createPublicClient, extractChain, http } from 'viem';
import { prettifyError } from 'zod';
import { CONFIG_SCHEMA, SUPPORTED_CHAINS } from './constants';
import type { ConfigShape } from './types';

export interface CreateClientForChainParameters {
  chainId: (typeof SUPPORTED_CHAINS)[number]['id'];
  rpcUrl?: string | null;
  authToken?: string | null;
}

export class StrictMap<K, V> extends Map<K, V> {
  override get(key: K): V {
    const value = super.get(key);

    if (value === undefined) {
      throw new Error(`Key "${String(key)}" does not exist in StrictMap.`);
    }

    return value;
  }
}

export function validateConfig(config: Record<string, unknown>): ConfigShape {
  const result = CONFIG_SCHEMA.safeParse(config);

  if (!result.success) {
    throw new TypeError(
      `Invalid PoRep config provided:\n\n${prettifyError(result.error)}`,
    );
  }

  return result.data;
}

export function createClientForChain({
  chainId,
  rpcUrl,
  authToken,
}: CreateClientForChainParameters) {
  const chain = extractChain({ chains: SUPPORTED_CHAINS, id: chainId });

  return createPublicClient({
    chain: chain,
    transport: http(rpcUrl ?? undefined, {
      fetchOptions:
        typeof authToken === 'string' && authToken !== ''
          ? {
              headers: {
                Authorization: `Bearer ${authToken}`,
              },
            }
          : undefined,
      timeout: 60_000,
    }),
  });
}

export function divideBigInt(
  numerator: bigint,
  denominator: bigint,
  precision = 2,
): number {
  if (denominator === 0n) {
    throw new TypeError('Cannot divide by zero');
  }

  const precisionExponent = 10n ** BigInt(precision);
  const numeratorWithPrecision = numerator * precisionExponent;
  const fraction = numeratorWithPrecision / denominator;

  return Number(fraction) / Math.pow(10, precision);
}

export function maxBigInt(...inputs: [bigint, ...bigint[]]): bigint {
  return inputs.reduce((max, current) => {
    return current > max ? current : max;
  });
}

export function minBigInt(...inputs: [bigint, ...bigint[]]): bigint {
  return inputs.reduce((min, current) => {
    return current < min ? current : min;
  });
}

export function numericToBigInt(value: string | number | bigint): bigint {
  const result = BigNumber(value.toString()).toBigInt();

  if (result === null) {
    throw new TypeError(`Expected an integer numeric value, received ${value}`);
  }

  return result;
}

export function compareNullableNumber<T extends number | bigint>(
  a: T | null,
  b: T | null,
  order: 'asc' | 'desc',
): -1 | 1 | 0 {
  const lowerValue = order === 'asc' ? -1 : 1;
  const higherValue = (lowerValue * -1) as -1 | 1;

  if (a === null && b === null) return 0;
  if (a === null) return lowerValue;
  if (b === null) return higherValue;

  return a < b ? lowerValue : a > b ? higherValue : 0;
}
