import {
  type FilecoinPublicClient,
  InjectRecentNodeClient,
} from '@/lib/filecoin-client';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class BlockNumberService {
  private static BLOCK_NUMBER_CACHE_KEY = `${BlockNumberService.name}_block_number`;

  constructor(
    @InjectRecentNodeClient()
    private readonly recentNodeClient: FilecoinPublicClient,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  public async getBlockNumber(): Promise<bigint> {
    const cachedValue = await this.cacheManager.get(
      BlockNumberService.BLOCK_NUMBER_CACHE_KEY,
    );

    if (typeof cachedValue === 'bigint') {
      return cachedValue;
    }

    const blockNumber = await this.recentNodeClient.getBlockNumber();
    await this.cacheManager.set(
      BlockNumberService.BLOCK_NUMBER_CACHE_KEY,
      blockNumber,
      30_000, // 30 seconds
    );
    return blockNumber;
  }
}
