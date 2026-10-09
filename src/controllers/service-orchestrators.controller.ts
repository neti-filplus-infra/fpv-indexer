import {
  serviceOrchestratorSchema,
  serviceOrchestratorsListSchema,
} from '@/lib/schemas';
import { ServiceOrchestratorService } from '@/services/service-orchestrator.service';
import { Controller, Get, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';

@Controller('/service-orchestrators')
export class ServiceOrchestratorsController {
  constructor(
    private readonly serviceOrchestratorService: ServiceOrchestratorService,
  ) {}

  @Get('/')
  @SerializeOptions({ schema: serviceOrchestratorSchema })
  @ApiOperation({
    summary: 'Get list of service orchestrators.',
  })
  @ApiOkResponse({
    description: `Service Orchestrators list.`,
    standardSchema: serviceOrchestratorsListSchema,
  })
  public getServiceOrchestratorQuarterlyVolume() {
    return this.serviceOrchestratorService.getServiceOrchestrators();
  }
}
