import { Controller, Get, Post, Body, Req, Res, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../database.service';
import { production } from '../env';
import { Public } from '../platform/http';
import { CommandsService } from '../platform/commands.service';
import {
  AuthRequest,
  parse,
  loginField,
  fail,
  hash,
  randomToken,
  verifyPassword,
  audit,
} from '../platform/security';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly commands: CommandsService,
  ) {}
  @Post('login')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Вход; устанавливает HttpOnly-cookie на 12 часов' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['login', 'password'],
      additionalProperties: false,
      properties: { login: { type: 'string' }, password: { type: 'string', format: 'password' } },
    },
  })
  async login(
    @Body() body: unknown,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(
      z.object({ login: loginField, password: z.string().min(1).max(128) }).strict(),
      body,
    );
    // Reserve attempt atomically before password hashing. Buckets survive process restarts.
    const limited = await this.db.transaction(async (client) => {
      for (const [key, limit] of [
        ['ip:' + hash(request.ip ?? 'unknown'), 100],
        ['login:' + hash(input.login), 10],
      ] as const) {
        const result = await client.query(
          "INSERT INTO login_limits (key,attempts,expires_at) VALUES ($1,1,now()+interval '15 minutes') ON CONFLICT (key) DO UPDATE SET attempts=CASE WHEN login_limits.expires_at<=now() THEN 1 ELSE login_limits.attempts+1 END, expires_at=CASE WHEN login_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE login_limits.expires_at END RETURNING attempts",
          [key],
        );
        if (result.rows[0].attempts > limit) return true;
      }
      return false;
    });
    if (limited)
      fail(429, 'LOGIN_RATE_LIMITED', 'Слишком много попыток входа. Повторите через 15 минут.');
    const found = await this.db.pool.query('SELECT id,password_hash FROM users WHERE login=$1', [
      input.login,
    ]);
    const record = found.rows[0];
    const valid = await verifyPassword(input.password, record?.password_hash ?? '');
    if (!valid || !record) fail(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль.');
    const token = randomToken();
    const result = await this.db.transaction(async (client) => {
      const current = await client.query(
        'SELECT id,full_name AS "fullName",login,role,is_active AS "isActive",version,created_at AS "createdAt" FROM users WHERE id=$1 AND is_active AND password_hash=$2 FOR SHARE',
        [record.id, record.password_hash],
      );
      if (!current.rowCount) fail(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль.');
      const session = await client.query(
        "INSERT INTO sessions (user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '12 hours') RETURNING expires_at",
        [record.id, hash(token)],
      );
      await client.query('DELETE FROM login_limits WHERE key=$1', ['login:' + hash(input.login)]);
      await audit(client, record.id, 'user', 'auth.login', record.id, request.requestId);
      return {
        user: current.rows[0],
        expiresAt: session.rows[0].expires_at,
        csrfToken: hash('csrf:' + token),
      };
    });
    response.cookie('crm_session', token, {
      httpOnly: true,
      secure: production,
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 60 * 60 * 1000,
    });
    return result;
  }
  @Get('me')
  @ApiOperation({ summary: 'Текущий сотрудник и CSRF-токен' })
  me(@Req() request: AuthRequest) {
    return { user: request.auth!.user, csrfToken: request.auth!.csrfToken };
  }
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    await this.db.transaction(async (client) => {
      await this.commands.authorize(client, request);
      await client.query(
        'DELETE FROM push_subscriptions WHERE session_id=(SELECT id FROM sessions WHERE token_hash=$1)',
        [request.auth!.tokenHash],
      );
      await client.query(
        'UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',
        [request.auth!.tokenHash],
      );
      await audit(
        client,
        request.auth!.user.id,
        'user',
        'auth.logout',
        request.auth!.user.id,
        request.requestId,
      );
    });
    response.clearCookie('crm_session', {
      httpOnly: true,
      secure: production,
      sameSite: 'lax',
      path: '/',
    });
    return { ok: true };
  }
}
