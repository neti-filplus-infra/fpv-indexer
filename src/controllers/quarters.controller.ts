import {
  type OrchestratorQuarterlyVolumeParameters,
  orchestratorQuarterlyVolumeParametersSchema,
  orchestratorQuarterlyVolumePostingSchema,
  Quarter,
  type QuarterNumberFilter,
  quarterNumberFilterSchema,
  QuarterParameters,
  quarterParametersSchema,
  quarterSchema,
} from '@/lib/schemas';
import { QuartersService } from '@/services/quarters.service';
import { Controller, Get, Param, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import z from 'zod';

@Controller('/quarters')
export class QuartersController {
  constructor(private readonly quartersService: QuartersService) {}

  @Get()
  @SerializeOptions({ schema: quarterSchema })
  @ApiOperation({
    summary: 'Get list of quarters with their boundaries.',
  })
  @ApiOkResponse({
    description: 'List of quarters with their boundaries.',
    standardSchema: z.array(quarterSchema),
  })
  getQuarters(): Promise<Quarter[]> {
    return this.quartersService.getQuarters();
  }

  @Get('/:quarterNumber/parameters')
  @SerializeOptions({ schema: quarterParametersSchema })
  @ApiOperation({
    summary:
      'Get parameters for given quarters, like admitted lists, pricing parameters etc.',
  })
  @ApiOkResponse({
    description: 'Quarter parameters.',
    standardSchema: quarterParametersSchema,
  })
  public getQuarterParameters(
    @Param({ schema: quarterNumberFilterSchema })
    params: QuarterNumberFilter,
  ): Promise<QuarterParameters> {
    return this.quartersService.getQuarterParameters(params);
  }

  @Get('/:quarterNumber/postings/:serviceOrchestrator')
  @SerializeOptions({ schema: orchestratorQuarterlyVolumePostingSchema })
  @ApiOperation({
    summary: 'Get posted volume for Orchestrator in given quarter.',
  })
  @ApiOkResponse({
    description: 'Posted volume information with list of corrections.',
    standardSchema: orchestratorQuarterlyVolumePostingSchema,
  })
  public getQuarterPostings(
    @Param({ schema: orchestratorQuarterlyVolumeParametersSchema })
    params: OrchestratorQuarterlyVolumeParameters,
  ) {
    return this.quartersService.getServiceOrchestratorsQuarterlyVolumePostings(
      params,
    );
  }
}
