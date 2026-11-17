import {
  serviceOrchestrator,
  type ServiceOrchestratorsList,
  serviceOrchestratorsList,
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
  @SerializeOptions({ schema: serviceOrchestrator })
  @ApiOperation({
    summary: 'Get list of service orchestrators.',
  })
  @ApiOkResponse({
    description: `Service Orchestrators list.`,
    standardSchema: serviceOrchestratorsList,
  })
  public getServiceOrchestratorQuarterlyVolume(): Promise<ServiceOrchestratorsList> {
    return this.serviceOrchestratorService.getServiceOrchestrators();
  }
}
