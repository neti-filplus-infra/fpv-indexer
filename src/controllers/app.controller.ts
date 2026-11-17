import {
  type BlockNumberResponse,
  blockNumberResponse,
  type IndexerStatus,
  indexerStatus,
} from '@/lib/schemas';
import { BlockNumberService } from '@/services/block-number-service';
import { IndexerOrchestratorService } from '@/services/indexer-orchestrator.service';
import { Controller, Get, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

@Controller()
export class AppController {
  constructor(
    private readonly indexerOrchestratorService: IndexerOrchestratorService,
    private readonly blockNumberService: BlockNumberService,
  ) {}

  @Get('/status')
  @SerializeOptions({ schema: indexerStatus })
  @ApiOkResponse({
    description: 'Indexer status',
    standardSchema: indexerStatus,
  })
  public getStatus(): Promise<IndexerStatus> {
    return this.indexerOrchestratorService.getStatus();
  }

  @Get('/block-number')
  @SerializeOptions({ schema: blockNumberResponse })
  @ApiOkResponse({
    description: 'Block number response.',
    standardSchema: blockNumberResponse,
  })
  public async getBlockNumber(): Promise<BlockNumberResponse> {
    const blockNumber = await this.blockNumberService.getBlockNumber();
    return { blockNumber };
  }
}
