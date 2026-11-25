import { Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database.service';
import { CommandsService, commandName } from '../platform/commands.service';
import { AuthRequest, parse, fail } from '../platform/security';

@Controller('operations')
export class OperationsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly commands: CommandsService,
  ) {}
  @Get('by-key')
  async lookup(@Query() query: unknown, @Req() request: AuthRequest) {
    const input = parse(
      z
        .object({
          key: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
          command: commandName,
        })
        .strict(),
      query,
    );
    return this.db.transaction(async (client) => {
      await this.commands.authorize(client, request, input.command.startsWith('users.'));
      const result = await client.query(
        'SELECT result FROM idempotency_records WHERE actor_id=$1 AND command=$2 AND key=$3',
        [request.auth!.user.id, input.command, input.key],
      );
      if (!result.rowCount && input.command === 'finance.post') {
        const permanent = await client.query(
          'SELECT id FROM financial_operations WHERE command_id=$1',
          [request.auth!.user.id + ':' + input.key],
        );
        if (permanent.rowCount)
          return { status: 'completed', result: { id: permanent.rows[0].id } };
      }
      if (!result.rowCount)
        fail(
          404,
          'OPERATION_NOT_FOUND',
          'Результат пока не найден. Повторите действие с тем же ключом.',
        );
      return { status: 'completed', result: result.rows[0].result };
    });
  }
}
