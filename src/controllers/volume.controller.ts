import {
  type OrchestratorQuarterlyVolumeParameters,
  orchestratorQuarterlyVolumeParameters,
  QuarterlyVolume,
  quarterlyVolume,
  type QuarterNumberFilter,
  quarterNumberFilter,
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
  @SerializeOptions({ schema: quarterlyVolume })
  @ApiOperation({
    summary: 'Get quarterly volume of service orchestrator with details.',
  })
  @ApiOkResponse({
    description: `Service Orchestrator volume details in given quarter along 
      with FIL pricing prints.`,
    standardSchema: quarterlyVolume,
  })
  public getServiceOrchestratorQuarterlyVolume(
    @Param({ schema: orchestratorQuarterlyVolumeParameters })
    params: OrchestratorQuarterlyVolumeParameters,
  ): Promise<QuarterlyVolume> {
    return this.volumeCalculationService.getQuarterlyVolume(params);
  }

  @Get('/:quarterNumber')
  @SerializeOptions({ schema: quarterlyVolume })
  @ApiOperation({
    summary: 'Get quarterly volume with details.',
  })
  @ApiOkResponse({
    description: `Quarterly volume details along with FIL pricing prints.`,
    standardSchema: quarterlyVolume,
  })
  public getQuarterlyVolume(
    @Param({ schema: quarterNumberFilter })
    params: QuarterNumberFilter,
  ): Promise<QuarterlyVolume> {
    return this.volumeCalculationService.getQuarterlyVolume(params);
  }
}
