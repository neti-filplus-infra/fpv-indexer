import { RECENT_NODE_CLIENT } from '@/lib/constants';
import type { ERC20Metadata, FilecoinPublicClient } from '@/lib/types';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { type Address } from 'viem';
import { filecoinCalibration } from 'viem/chains';
import * as z from 'zod';

const contractDeploymentEpochResponseSchema = z.object({
  createHeight: z.number().int().min(0),
});

const erc20MetadataSchema = z.object({
  decimals: z.number().int(),
  symbol: z.string(),
});

const erc20TokenResponseSchema = z
  .object({
    type: z.literal('ERC20'),
  })
  .extend(erc20MetadataSchema.shape);

@Injectable()
export class FilfoxApiService {
  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @Inject(RECENT_NODE_CLIENT)
    protected readonly recentNodeClient: FilecoinPublicClient,
  ) {}

  public async getContractDeploymentEpoch(
    contractAddress: Address,
  ): Promise<bigint> {
    const cacheKey = `${contractAddress}_deployment_epoch`;
    const cachedValue = await this.cacheManager.get(cacheKey);

    if (typeof cachedValue === 'bigint') {
      return cachedValue;
    }

    try {
      const response = await fetch(
        `${this.getPrefix()}/api/v1/address/${contractAddress}`,
      );

      if (!response.ok) {
        throw new Error(`Filfox API returned status ${response.status}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const json = await response.json();
      const parseResult = contractDeploymentEpochResponseSchema.safeParse(json);

      if (!parseResult.success) {
        throw new TypeError(
          'Invalid response from Filfox API or not a contract address',
        );
      }

      const deploymentEpoch = BigInt(parseResult.data.createHeight);
      await this.cacheManager.set(cacheKey, deploymentEpoch, 0);
      return deploymentEpoch;
    } catch (error) {
      throw new Error(
        `Could not get deployment epoch of contract ${contractAddress}; Error:\n\n${String(error)}`,
      );
    }
  }

  public async getERC20Metadata(tokenAddress: string): Promise<ERC20Metadata> {
    const cacheKey = `${tokenAddress}_erc20_metadata`;
    const cachedValue = await this.cacheManager.get(cacheKey);
    const cachedValueParsed = erc20MetadataSchema.safeParse(cachedValue);

    if (cachedValueParsed.success) {
      return cachedValueParsed.data;
    }

    try {
      const response = await fetch(
        `${this.getPrefix()}/api/v1/token/${tokenAddress}`,
      );

      if (!response.ok) {
        throw new Error(`Filfox API returned status ${response.status}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const json = await response.json();
      const parseResult = erc20TokenResponseSchema.safeParse(json);

      if (!parseResult.success) {
        throw new TypeError(
          `"${tokenAddress}" does not point to a valid ERC20 token contract`,
        );
      }

      const metadata = {
        decimals: parseResult.data.decimals,
        symbol: parseResult.data.symbol,
      } satisfies ERC20Metadata;

      await this.cacheManager.set(cacheKey, metadata, 0);

      return metadata;
    } catch (error) {
      throw new Error(
        `Could not get metadata of ERC20 token "${tokenAddress}"; Error:\n\n${String(error)}`,
      );
    }
  }

  private getPrefix(): string {
    return this.recentNodeClient.chain.id === filecoinCalibration.id
      ? 'https://calibration.filfox.info'
      : 'https://filfox.info';
  }
}
