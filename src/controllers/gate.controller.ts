import {
  type GateTargetParameters,
  gateTargetParametersSchema,
  gateTargetSchema,
} from '@/lib/schemas';
import { GateCheckService } from '@/services/gate-check.service';
import { Controller, Get, Query, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';

@Controller('/gate')
export class GateController {
  constructor(private readonly gateCheckService: GateCheckService) {}

  @Get('/target')
  @SerializeOptions({ schema: gateTargetSchema })
  @ApiOperation({
    summary: 'Get gate target.',
  })
  @ApiOkResponse({
    description: 'Gate target.',
    standardSchema: gateTargetSchema,
  })
  public getTarget(
    @Query({ schema: gateTargetParametersSchema })
    params: GateTargetParameters,
  ) {
    return this.gateCheckService.calculateGateTarget(params);
  }
}
