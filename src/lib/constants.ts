import { major, parse } from 'semver';
import { isAddress, type Address, type Chain } from 'viem';
import { filecoin, filecoinCalibration } from 'viem/chains';
import * as z from 'zod';
import packageJson from '../../package.json';

type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]['id'];

export const packageSemver = parse(packageJson.version);
export const packageMajorVersion = packageSemver ? major(packageSemver) : 0;

export const RECENT_NODE_CLIENT = 'RECENT_NODE_CLIENT';
export const ARCHIVE_NODE_CLIENT = 'ARCHIVE_NODE_CLIENT';

export const SUPPORTED_CHAINS = [
  filecoin,
  filecoinCalibration,
] as const satisfies Chain[];

const supportedChainId = z.coerce
  .number()
  .refine((input): input is SupportedChainId => {
    return SUPPORTED_CHAINS.map((chain) => chain.id as number).includes(input);
  }, 'Unsupported Chain ID');

const evmAddress = z.custom<Address>((value) => {
  return typeof value === 'string' && isAddress(value);
}, 'Invalid EVM address');

export const CONFIG_SCHEMA = z.object({
  CHAIN_ID: supportedChainId.nullish(),
  INTERVAL_CRON_EXPRESSION: z.string().nullish(),
  BATCH_BLOCK_SIZE: z.coerce.number().int().min(1).nullish(),
  ARCHIVE_RPC_URL: z.url(),
  ARCHIVE_RPC_AUTH_TOKEN: z.string().nullish(),
  ARCHIVE_RPC_THRESHOLD: z.coerce.number().int().min(0),
  RECENT_RPC_URL: z.url().nullish(),
  RECENT_RPC_AUTH_TOKEN: z.string().nullish(),
  ACTIVATION_EPOCH: z.coerce.bigint().min(0n),
  EPOCHS_PER_QUARTER: z.coerce.bigint().min(1n),
  SERVICE_REWARDS_ACTOR_ADDRESS: evmAddress,
  STREAM_WEIGHT_ACTOR_ADDRESS: evmAddress,
  POST_PERIOD: z.coerce.bigint().min(0n),
});
