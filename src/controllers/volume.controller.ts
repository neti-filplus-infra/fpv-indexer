import {
  type OrchestratorQuarterlyVolumeParameters,
  orchestratorQuarterlyVolumeParametersSchema,
  QuarterlyVolume,
  quarterlyVolumeSchema,
  type QuarterNumberFilter,
  quarterNumberFilterSchema,
} from '@/lib/schemas';
import { VolumeCalculationService } from '@/services/volume-calculation.service';
import { Controller, Get, Param, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';

@Controller('/volume')
export class VolumeController {
  constructor(
    private readonly volumeCalculationService: VolumeCalculationService,
  ) {}

  @Get('/:quarterNumber/:serviceOrchestrator')
  @SerializeOptions({ schema: quarterlyVolumeSchema })
  @ApiOperation({
    summary: 'Get quarterly volume of service orchestrator with details.',
  })
  @ApiOkResponse({
    description: `Service Orchestrator volume details in given quarter along 
      with FIL pricing prints.`,
    standardSchema: quarterlyVolumeSchema,
  })
  public getServiceOrchestratorQuarterlyVolume(
    @Param({ schema: orchestratorQuarterlyVolumeParametersSchema })
    params: OrchestratorQuarterlyVolumeParameters,
  ): Promise<QuarterlyVolume> {
    return this.volumeCalculationService.getQuarterlyVolume(params);
  }

  @Get('/:quarterNumber')
  @SerializeOptions({ schema: quarterlyVolumeSchema })
  @ApiOperation({
    summary: 'Get quarterly volume with details.',
  })
  @ApiOkResponse({
    description: `Quarterly volume details along with FIL pricing prints.`,
    standardSchema: quarterlyVolumeSchema,
  })
  public getQuarterlyVolume(
    @Param({ schema: quarterNumberFilterSchema })
    params: QuarterNumberFilter,
  ): Promise<QuarterlyVolume> {
    return this.volumeCalculationService.getQuarterlyVolume(params);
  }
}
