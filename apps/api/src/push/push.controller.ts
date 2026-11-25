import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database.service';
import { vapidConfig } from '../env';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, fail, parse } from '../platform/security';

// Only accept browser push services. The endpoint becomes an outbound server request.
const endpoint = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === 'fcm.googleapis.com' ||
        url.hostname.endsWith('.push.apple.com') ||
        url.hostname === 'updates.push.services.mozilla.com')
    );
  });
const subscription = z.object({
  endpoint,
  keys: z.object({
    p256dh: z.string().regex(/^B[A-Za-z0-9_-]{86}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});

@Controller('push')
export class PushController {
  constructor(
    private readonly db: DatabaseService,
    private readonly commands: CommandsService,
  ) {}

  @Get('config')
  config() {
    return { publicKey: vapidConfig()?.publicKey ?? null };
  }

  @Post('status')
  async status(@Req() request: AuthRequest, @Body() body: unknown) {
    const input = parse(z.object({ endpoint }), body);
    const row = await this.db.pool.query(
      'SELECT id FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2',
      [input.endpoint, request.auth!.user.id],
    );
    return { subscribed: !!row.rowCount };
  }

  @Post('subscribe')
  async subscribe(@Req() request: AuthRequest, @Body() body: unknown) {
    if (!vapidConfig()) fail(503, 'PUSH_DISABLED', 'Уведомления ещё не настроены на сервере.');
    const input = parse(subscription, body);
    await this.db.transaction(async (c) => {
      await this.commands.authorize(c, request);
      await c.query(
        `INSERT INTO push_subscriptions(endpoint,p256dh,auth,user_id,session_id)
         SELECT $1,$2,$3,user_id,id FROM sessions WHERE token_hash=$4
         ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,
         user_id=excluded.user_id,session_id=excluded.session_id`,
        [input.endpoint, input.keys.p256dh, input.keys.auth, request.auth!.tokenHash],
      );
    });
    return { subscribed: true };
  }

  @Post('unsubscribe')
  async unsubscribe(@Req() request: AuthRequest, @Body() body: unknown) {
    const input = parse(z.object({ endpoint }), body);
    await this.db.pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2', [
      input.endpoint,
      request.auth!.user.id,
    ]);
    return { subscribed: false };
  }
}
