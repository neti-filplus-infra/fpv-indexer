import {
  type OrchestratorQuarterlyVolumeParameters,
  orchestratorQuarterlyVolumeParameters,
  type OrchestratorQuarterlyVolumePosting,
  orchestratorQuarterlyVolumePosting,
  type Quarter,
  quarter,
  type QuarterlyVolumePostings,
  quarterlyVolumePostings,
  type QuarterNumberFilter,
  quarterNumberFilter,
  type QuarterParameters,
  quarterParameters,
} from '@/lib/schemas';
import { QuartersService } from '@/services/quarters.service';
import { Controller, Get, Param, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import z from 'zod';

@Controller('/quarters')
export class QuartersController {
  constructor(private readonly quartersService: QuartersService) {}

  @Get()
  @SerializeOptions({ schema: quarter })
  @ApiOperation({
    summary: 'Get list of quarters with their boundaries.',
  })
  @ApiOkResponse({
    description: 'List of quarters with their boundaries.',
    standardSchema: z.array(quarter),
  })
  getQuarters(): Promise<Quarter[]> {
    return this.quartersService.getQuarters();
  }

  @Get('/:quarterNumber/parameters')
  @SerializeOptions({ schema: quarterParameters })
  @ApiOperation({
    summary:
      'Get parameters for given quarters, like admitted lists, pricing parameters etc.',
  })
  @ApiOkResponse({
    description: 'Quarter parameters.',
    standardSchema: quarterParameters,
  })
  public getQuarterParameters(
    @Param({ schema: quarterNumberFilter })
    params: QuarterNumberFilter,
  ): Promise<QuarterParameters> {
    return this.quartersService.getQuarterParameters(params);
  }

  @Get('/:quarterNumber/postings')
  @SerializeOptions({ schema: quarterlyVolumePostings })
  @ApiOperation({
    summary: 'Get posted volume for in given quarter.',
  })
  @ApiOkResponse({
    description: 'Posted volume information.',
    standardSchema: quarterlyVolumePostings,
  })
  public getQuarterPostings(
    @Param({ schema: quarterNumberFilter })
    params: QuarterNumberFilter,
  ): Promise<QuarterlyVolumePostings> {
    return this.quartersService.getQuarterlyVolumePostings(params);
  }

  @Get('/:quarterNumber/postings/:serviceOrchestrator')
  @SerializeOptions({ schema: orchestratorQuarterlyVolumePosting })
  @ApiOperation({
    summary: 'Get posted volume for Orchestrator in given quarter.',
  })
  @ApiOkResponse({
    description: 'Posted volume information with list of corrections.',
    standardSchema: orchestratorQuarterlyVolumePosting,
  })
  public getQuarterPostingsByOrchestrator(
    @Param({ schema: orchestratorQuarterlyVolumeParameters })
    params: OrchestratorQuarterlyVolumeParameters,
  ): Promise<OrchestratorQuarterlyVolumePosting> {
    return this.quartersService.getServiceOrchestratorsQuarterlyVolumePostings(
      params,
    );
  }
}
