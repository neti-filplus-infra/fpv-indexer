import { RpcMetrics } from '@/lib/types';
import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

@Injectable()
export class RpcMetricsContext {
  private readonly storage = new AsyncLocalStorage<RpcMetrics>();

  public run<T>(metrics: RpcMetrics, callback: () => Promise<T>): Promise<T> {
    return this.storage.run(metrics, callback);
  }

  public current(): RpcMetrics | undefined {
    return this.storage.getStore();
  }

  public empty(): RpcMetrics {
    return {
      totalCallsCount: 0,
      totalCallsDurationMs: 0,
      averageCallDurationMs: 0,
      rpcCallsByMethod: {},
    };
  }
}
