import { Public } from './platform/http';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DatabaseService } from './database.service';

@ApiTags('Infrastructure')
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Check API and PostgreSQL connectivity' })
  @ApiResponse({ status: 200, description: 'API and database are ready' })
  @ApiResponse({ status: 503, description: 'Database is unavailable' })
  async check() {
    try {
      await this.database.ping();
      return { status: 'ok', api: 'up', database: 'up' };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', api: 'up', database: 'down' });
    }
  }
}
