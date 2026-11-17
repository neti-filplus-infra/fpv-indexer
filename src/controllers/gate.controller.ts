import {
  type GateTarget,
  gateTarget,
  type GateTargetParameters,
  gateTargetParameters,
} from '@/lib/schemas';
import { GateCheckService } from '@/services/gate-check.service';
import { Controller, Get, Query, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';

@Controller('/gate')
export class GateController {
  constructor(private readonly gateCheckService: GateCheckService) {}

  @Get('/target')
  @SerializeOptions({ schema: gateTarget })
  @ApiOperation({
    summary: 'Get gate target.',
  })
  @ApiOkResponse({
    description: 'Gate target.',
    standardSchema: gateTarget,
  })
  public getTarget(
    @Query({ schema: gateTargetParameters })
    params: GateTargetParameters,
  ): Promise<GateTarget> {
    return this.gateCheckService.calculateGateTarget(params);
  }
}
