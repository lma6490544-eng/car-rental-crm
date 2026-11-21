import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database.service';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, audit, fail, idSchema, parse } from '../platform/security';
import { calculate, Calculation } from './calculate';
import { confirmInput, quoteInput } from './pricing.dto';
import { ruleSets } from './rules';
import type { PricingQuoteRow } from './pricing.types';

@Controller('pricing')
export class PricingController {
  constructor(
    private readonly db: DatabaseService,
    private readonly commands: CommandsService,
  ) {}
  @Get('catalog') async catalog() {
    return {
      ruleVersions: ruleSets.map((r) => ({
        version: r.version,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
      })),
      items: (
        await this.db.pool.query(
          'SELECT id,name,tariff_code AS code FROM pricing_groups WHERE tariff_code IS NOT NULL ORDER BY id',
        )
      ).rows.map((g) => ({ ...g, ...ruleSets.at(-1)!.groups.find((r) => r.code === g.code) })),
    };
  }
  @Get('quotes') async list(@Query() query: unknown) {
    const { page } = parse(
      z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).strict(),
      query,
    );
    return {
      items: (
        await this.db.pool.query(
          `SELECT q.id,q.base_quote_id AS "baseQuoteId",q.version,q.created_at AS "createdAt",q.confirmed_at AS "confirmedAt",q.expires_at AS "expiresAt",q.snapshot->>'operationKind' AS "operationKind",q.snapshot->>'finalTotalRub' AS "finalTotalRub",u.full_name AS author FROM pricing_quotes q JOIN users u ON u.id=q.created_by ORDER BY q.id DESC LIMIT 20 OFFSET $1`,
          [(page - 1) * 20],
        )
      ).rows,
      total: (await this.db.pool.query('SELECT count(*)::int AS n FROM pricing_quotes')).rows[0].n,
    };
  }
  @Get('quotes/:id') async get(@Param('id') raw: string) {
    const row = (
      await this.db.pool.query('SELECT * FROM pricing_quotes WHERE id=$1', [parse(idSchema, raw)])
    ).rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'Расчёт не найден.');
    return this.view(row);
  }
  private view(row: PricingQuoteRow) {
    return {
      id: row.id,
      baseQuoteId: row.base_quote_id,
      version: row.version,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      confirmedAt: row.confirmed_at,
      createdBy: row.created_by,
      confirmedBy: row.confirmed_by,
      confirmedOverrides: row.confirmed_overrides,
      input: row.input,
      calculation: row.snapshot as Calculation,
    };
  }
  private async group(client: PoolClient, id: number) {
    const g = (
      await client.query(
        'SELECT id,name,tariff_code AS code FROM pricing_groups WHERE id=$1 FOR SHARE',
        [id],
      )
    ).rows[0];
    if (!g?.code)
      fail(
        422,
        'TARIFF_NOT_CONFIGURED',
        'У этой группы нет точной ставки прайса. Выберите настроенную группу; кузов не определяет тариф.',
      );
    return g;
  }
  @Post('quote') async quote(@Body() body: unknown, @Req() request: AuthRequest) {
    const input = parse(quoteInput, body);
    return this.commands.run(
      request,
      'pricing.quote',
      input,
      async (client) => {
        let base: Calculation | undefined;
        if (input.baseQuoteId) {
          const old = (
            await client.query('SELECT * FROM pricing_quotes WHERE id=$1 FOR SHARE', [
              input.baseQuoteId,
            ])
          ).rows[0];
          if (!old) fail(404, 'NOT_FOUND', 'Исходный расчёт не найден.');
          if (!old.confirmed_at || old.version !== input.expectedTermsVersion)
            fail(409, 'QUOTE_STALE', 'Нужна актуальная подтверждённая редакция.', {
              currentVersion: old.version,
            });
          base = old.snapshot;
        }
        const at = Date.now(),
          rules = ruleSets.findLast(
            (r) =>
              Date.parse(r.effectiveFrom) <= at &&
              (!r.effectiveTo || Date.parse(r.effectiveTo) > at),
          );
        if (!rules) fail(422, 'TARIFF_NOT_FOUND', 'На дату расчёта нет действующего прайса.');
        const calculation = calculate(
          input,
          rules,
          input.pricingGroupId ? await this.group(client, input.pricingGroupId) : undefined,
          base,
          request.auth!.user.id,
        );
        const row = (
          await client.query(
            `INSERT INTO pricing_quotes(base_quote_id,created_by,expires_at,input,snapshot) VALUES ($1,$2,now()+interval '30 minutes',$3,$4) RETURNING *`,
            [
              input.baseQuoteId ?? null,
              request.auth!.user.id,
              JSON.stringify(input),
              JSON.stringify(calculation),
            ],
          )
        ).rows[0];
        await audit(
          client,
          request.auth!.user.id,
          'pricing_quote',
          'pricing.quoted',
          row.id,
          request.requestId,
          { baseQuoteId: input.baseQuoteId ?? null, ruleVersion: rules.version },
        );
        await client.query('INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,$2,$3)', [
          'pricing.quoted:' + row.id,
          'pricing.quoted',
          JSON.stringify({ id: row.id }),
        ]);
        return this.view(row);
      },
      false,
    );
  }
  @Post('quotes/:id/confirm') async confirm(
    @Param('id') raw: string,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    const id = parse(idSchema, raw),
      input = parse(confirmInput, body);
    return this.commands.run(
      request,
      'pricing.confirm',
      { id, ...input },
      async (client) => {
        const row = (
          await client.query('SELECT * FROM pricing_quotes WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        if (!row) fail(404, 'NOT_FOUND', 'Расчёт не найден.');
        if (row.version !== input.expectedVersion || row.confirmed_at)
          fail(409, 'QUOTE_STALE', 'Расчёт уже подтверждён или изменился. Перечитайте его.');
        if (new Date(row.expires_at).getTime() <= Date.now())
          fail(409, 'QUOTE_STALE', 'Срок предварительного расчёта истёк. Выполните новый расчёт.');
        const snapshot = row.snapshot as Calculation;
        const current = ruleSets.findLast(
          (r) =>
            Date.parse(r.effectiveFrom) <= Date.now() &&
            (!r.effectiveTo || Date.parse(r.effectiveTo) > Date.now()),
        );
        if (current?.version !== snapshot.ruleVersion)
          fail(409, 'QUOTE_STALE', 'Прайс изменился. Выполните новый расчёт.');
        const required = [...snapshot.overridesToConfirm].sort(),
          confirmed = [...new Set(input.confirmedOverrides)].sort();
        if (JSON.stringify(required) !== JSON.stringify(confirmed))
          fail(
            422,
            'OVERRIDES_CONFIRMATION_REQUIRED',
            'Явно подтвердите все ручные условия этой редакции.',
          );
        const updated = (
          await client.query(
            'UPDATE pricing_quotes SET confirmed_at=now(),confirmed_by=$2,confirmed_overrides=$3,version=version+1 WHERE id=$1 RETURNING *',
            [id, request.auth!.user.id, JSON.stringify(confirmed)],
          )
        ).rows[0];
        await audit(
          client,
          request.auth!.user.id,
          'pricing_quote',
          'pricing.confirmed',
          id,
          request.requestId,
          {
            confirmedOverrides: confirmed,
            reason: snapshot.overrides?.reason,
            surchargeReason: snapshot.surchargeOverride?.reason,
          },
        );
        await client.query('INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,$2,$3)', [
          'pricing.confirmed:' + id,
          'pricing.confirmed',
          JSON.stringify({ id, version: updated.version }),
        ]);
        return this.view(updated);
      },
      false,
    );
  }
}
