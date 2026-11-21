import { Controller, Get, Post, Patch, Body, Param, Req } from '@nestjs/common';
import { ApiTags, ApiBody, ApiHeader } from '@nestjs/swagger';
import { DatabaseService } from '../database.service';
import { CommandsService } from '../platform/commands.service';
import {
  AuthRequest,
  parse,
  newUserSchema,
  statusSchema,
  idSchema,
  fail,
  passwordHash,
  passwordFingerprint,
  userColumns,
  audit,
} from '../platform/security';

@ApiTags('Users')
@Controller('admin/users')
export class UsersController {
  constructor(
    private readonly db: DatabaseService,
    private readonly commands: CommandsService,
  ) {}
  @Get()
  async list(@Req() request: AuthRequest) {
    return this.db.transaction(async (client) => {
      await this.commands.authorize(client, request, true);
      return {
        items: (await client.query('SELECT ' + userColumns + ' FROM users ORDER BY created_at,id'))
          .rows,
      };
    });
  }
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['fullName', 'login', 'password'],
      additionalProperties: false,
      properties: {
        fullName: { type: 'string', maxLength: 120 },
        login: { type: 'string' },
        password: { type: 'string', minLength: 12, maxLength: 128, format: 'password' },
      },
    },
  })
  async create(@Body() body: unknown, @Req() request: AuthRequest) {
    if (request.auth!.user.role !== 'admin')
      fail(403, 'FORBIDDEN', 'Доступно только администратору.');
    const input = parse(newUserSchema, body);
    const key = this.commands.key(request);
    const passwordProof = await passwordFingerprint(
      input.password,
      request.auth!.user.id + ':' + key,
    );
    const encoded = await passwordHash(input.password);
    return this.commands.run(
      request,
      'users.create',
      { fullName: input.fullName, login: input.login, passwordProof },
      async (client) => {
        const inserted = await client.query(
          "INSERT INTO users (full_name,login,password_hash,role) VALUES ($1,$2,$3,'manager') ON CONFLICT (login) DO NOTHING RETURNING " +
            userColumns,
          [input.fullName, input.login, encoded],
        );
        if (!inserted.rowCount) fail(409, 'LOGIN_ALREADY_EXISTS', 'Этот логин уже занят.');
        const user = inserted.rows[0];
        await audit(
          client,
          request.auth!.user.id,
          'user',
          'users.created',
          user.id,
          request.requestId,
          { role: 'manager' },
        );
        await client.query(
          'INSERT INTO outbox_jobs (business_key,kind,payload) VALUES ($1,$2,$3)',
          [
            'users.created:' + user.id,
            'identity.user.created',
            JSON.stringify({ userId: user.id }),
          ],
        );
        return user;
      },
    );
  }
  @Patch(':id/status')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['isActive', 'expectedVersion'],
      additionalProperties: false,
      properties: {
        isActive: { type: 'boolean' },
        expectedVersion: { type: 'integer', minimum: 1 },
      },
    },
  })
  async status(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthRequest) {
    if (request.auth!.user.role !== 'admin')
      fail(403, 'FORBIDDEN', 'Доступно только администратору.');
    const id = parse(idSchema, rawId);
    const input = parse(statusSchema, body);
    return this.commands.run(request, 'users.status', { id, ...input }, async (client) => {
      const current = await client.query('SELECT role,version FROM users WHERE id=$1 FOR UPDATE', [
        id,
      ]);
      if (!current.rowCount) fail(404, 'USER_NOT_FOUND', 'Сотрудник не найден.');
      if (current.rows[0].role === 'admin')
        fail(422, 'ADMIN_PROTECTED', 'Администратора нельзя заблокировать.');
      if (current.rows[0].version !== input.expectedVersion)
        fail(409, 'VERSION_CONFLICT', 'Данные сотрудника изменились. Обновите список.', {
          currentVersion: current.rows[0].version,
        });
      const result = await client.query(
        'UPDATE users SET is_active=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING ' +
          userColumns,
        [input.isActive, id],
      );
      if (!input.isActive)
        await client.query(
          'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [id],
        );
      await audit(
        client,
        request.auth!.user.id,
        'user',
        input.isActive ? 'users.activated' : 'users.blocked',
        id,
        request.requestId,
        { isActive: input.isActive },
      );
      await client.query('INSERT INTO outbox_jobs (business_key,kind,payload) VALUES ($1,$2,$3)', [
        'users.status:' + id + ':' + result.rows[0].version,
        'identity.user.status_changed',
        JSON.stringify({ userId: id, isActive: input.isActive }),
      ]);
      return result.rows[0];
    });
  }
}
