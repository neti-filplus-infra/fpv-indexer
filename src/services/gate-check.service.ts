import { db } from '@/db/db';
import { GateTarge, GateTargetParameters } from '@/lib/schemas';
import { divideBigInt, numericToBigInt } from '@/lib/utils';
import { Injectable, InternalServerErrorException } from '@nestjs/common';

@Injectable()
export class GateCheckService {
  public static INITIAL_BASE_ATTO_USD = 3_500_000_000_000_000_000_000n; // 3,500 USD
  public static INITIAL_STEP_RATIO = 2_700_000_000_000_000_000n; // 2.7

  public async calculateGateTarget({
    atEpoch,
  }: GateTargetParameters): Promise<GateTarge> {
    let paramsQuery = db
      .selectFrom('stream_weight_actor_parameters')
      .select(['base_atto_usd', 'step_ratio'])
      .orderBy('epoch', 'desc')
      .orderBy('log_index', 'desc');

    let lastGateCheckResultQuery = db
      .selectFrom('quarterly_gate_check')
      .select(['epoch', 'steps_after'])
      .orderBy('epoch', 'desc')
      .orderBy('log_index', 'desc');

    if (typeof atEpoch === 'bigint') {
      paramsQuery = paramsQuery.where('epoch', '<=', atEpoch.toString());

      lastGateCheckResultQuery = lastGateCheckResultQuery.where(
        'epoch',
        '<=',
        atEpoch.toString(),
      );
    }

    const [params, lastGateCheckResult] = await Promise.all([
      paramsQuery.executeTakeFirst(),
      lastGateCheckResultQuery.executeTakeFirst(),
    ]);

    const baseAttoUsd = params
      ? numericToBigInt(params.base_atto_usd)
      : GateCheckService.INITIAL_BASE_ATTO_USD;
    const stepRatio = params
      ? numericToBigInt(params.step_ratio)
      : GateCheckService.INITIAL_STEP_RATIO;
    const steps = lastGateCheckResult
      ? numericToBigInt(lastGateCheckResult.steps_after)
      : 0n;

    const lastCheckEpoch = lastGateCheckResult
      ? numericToBigInt(lastGateCheckResult.epoch)
      : null;
    const scale = 10n ** 18n;
    const denominator = scale ** steps;

    if (denominator === 0n) {
      return {
        atEpoch: atEpoch ?? null,
        lastCheckEpoch,
        targetAttoUsd: 0n,
        targetUsd: 0,
      };
    }

    const numerator = baseAttoUsd * stepRatio ** steps;

    if (numerator % denominator !== 0n) {
      throw new InternalServerErrorException('Non-exact gate target');
    }

    const targetAttoUsd = numerator / denominator;

    return {
      atEpoch: atEpoch ?? null,
      lastCheckEpoch: lastGateCheckResult
        ? numericToBigInt(lastGateCheckResult.epoch)
        : null,
      targetAttoUsd,
      targetUsd: divideBigInt(targetAttoUsd, scale, 2),
    };
  }
}
