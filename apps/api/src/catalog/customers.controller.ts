import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { AuthRequest, parse, idSchema, fail } from '../platform/security';
import { CatalogService } from './catalog.service';
import {
  customerInput,
  customerUpdate,
  documentReadiness,
  listQuery,
  noteInput,
  reasonInput,
  versionInput,
} from './catalog.dto';
const columns =
  'id,type,display_name AS "displayName",phone,email,inn,is_blocked AS "isBlocked",blocked_reason AS "blockedReason",version';
@Controller('customers')
export class CustomersController {
  constructor(private readonly service: CatalogService) {}
  @Get()
  async list(@Query() raw: unknown) {
    const q = parse(listQuery, raw);
    const where =
      "WHERE ($1='' OR strpos(lower(display_name),lower($1))>0 OR strpos(phone,$1)>0 OR strpos(inn,$1)>0) AND ($2='' OR type=$2) AND ($3='' OR is_blocked::text=$3)";
    const args = [q.q, q.type, q.blocked];
    return this.service.db.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const count = await client.query(
        'SELECT count(*)::int AS total FROM customers ' + where,
        args,
      );
      const items = await client.query(
        'SELECT ' +
          columns +
          ' FROM customers ' +
          where +
          ` ORDER BY lower(display_name) ${q.order === 'desc' ? 'DESC' : 'ASC'},id LIMIT 20 OFFSET $4`,
        [...args, (q.page - 1) * 20],
      );
      return { items: items.rows, total: count.rows[0].total };
    });
  }
  @Get(':id')
  async get(@Param('id') raw: string) {
    const id = parse(idSchema, raw);
    const { rows } = await this.service.db.pool.query(
      'SELECT ' + columns + ',details FROM customers WHERE id=$1',
      [id],
    );
    if (!rows[0]) fail(404, 'NOT_FOUND', 'Клиент не найден.');
    return {
      ...rows[0],
      documentReadiness: documentReadiness(rows[0].type, rows[0].details, rows[0].inn),
    };
  }
  @Get(':id/history') history(@Param('id') raw: string, @Query() query: unknown) {
    return this.service.history('customers', parse(idSchema, raw), parse(listQuery, query).page);
  }
  @Post()
  create(@Body() raw: unknown, @Req() request: AuthRequest) {
    const input = parse(customerInput, raw);
    return this.service.commands.run(
      request,
      'customers.create',
      input,
      async (client) => {
        const { rows } = await client.query(
          'INSERT INTO customers(type,display_name,phone,email,inn,details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ' +
            columns,
          [
            input.type,
            input.displayName,
            input.phone,
            input.email,
            input.inn,
            JSON.stringify(input.details),
          ],
        );
        await this.service.event(client, request, 'customer', 'customers.created', rows[0].id, 1, {
          type: input.type,
        });
        return rows[0];
      },
      false,
    );
  }
  @Patch(':id')
  update(@Param('id') rawId: string, @Body() raw: unknown, @Req() request: AuthRequest) {
    const id = parse(idSchema, rawId),
      input = parse(customerUpdate, raw),
      d = input.data;
    return this.service.commands.run(
      request,
      'customers.update',
      { id, ...input },
      async (client) => {
        const old = await this.service.lock(client, 'customers', id, input.expectedVersion);
        if (old.type !== d.type)
          fail(422, 'CUSTOMER_TYPE_FIXED', 'Тип клиента после создания не меняется.');
        const { rows } = await client.query(
          'UPDATE customers SET display_name=$2,phone=$3,email=$4,inn=$5,details=$6,version=version+1,updated_at=now() WHERE id=$1 RETURNING ' +
            columns,
          [id, d.displayName, d.phone, d.email, d.inn, JSON.stringify(d.details)],
        );
        await this.service.event(
          client,
          request,
          'customer',
          'customers.updated',
          id,
          rows[0].version,
          { fields: Object.keys(d) },
        );
        return rows[0];
      },
      false,
    );
  }
  @Post(':id/block') block(@Param('id') id: string, @Body() raw: unknown, @Req() r: AuthRequest) {
    return this.changeBlock(id, parse(reasonInput, raw), r, true);
  }
  @Post(':id/unblock') unblock(
    @Param('id') id: string,
    @Body() raw: unknown,
    @Req() r: AuthRequest,
  ) {
    return this.changeBlock(id, { ...parse(versionInput, raw), reason: '' }, r, false);
  }
  private changeBlock(
    rawId: string,
    input: { expectedVersion: number; reason: string },
    r: AuthRequest,
    blocked: boolean,
  ) {
    const id = parse(idSchema, rawId);
    return this.service.commands.run(
      r,
      blocked ? 'customers.block' : 'customers.unblock',
      { id, ...input },
      async (client) => {
        await this.service.lock(client, 'customers', id, input.expectedVersion);
        const { rows } = await client.query(
          'UPDATE customers SET is_blocked=$2,blocked_reason=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING ' +
            columns,
          [id, blocked, input.reason],
        );
        await this.service.event(
          client,
          r,
          'customer',
          blocked ? 'customers.blocked' : 'customers.unblocked',
          id,
          rows[0].version,
          { reason: input.reason },
        );
        return rows[0];
      },
      false,
    );
  }
  @Get(':id/notes') async notes(@Param('id') rawId: string) {
    const id = parse(idSchema, rawId);
    return {
      items: (
        await this.service.db.pool.query(
          'SELECT n.id,n.text,n.is_active AS "isActive",n.created_at AS "createdAt",n.resolved_at AS "resolvedAt",u.full_name AS author,r.full_name AS "resolvedBy" FROM customer_notes n JOIN users u ON u.id=n.created_by LEFT JOIN users r ON r.id=n.resolved_by WHERE n.customer_id=$1 ORDER BY n.created_at DESC,n.id',
          [id],
        )
      ).rows,
    };
  }
  @Post(':id/notes') note(@Param('id') rawId: string, @Body() raw: unknown, @Req() r: AuthRequest) {
    const id = parse(idSchema, rawId),
      input = parse(noteInput, raw);
    return this.service.commands.run(
      r,
      'customers.note',
      { id, ...input },
      async (client) => {
        await this.service.lock(client, 'customers', id, input.expectedVersion);
        const { rows } = await client.query(
          'INSERT INTO customer_notes(customer_id,text,created_by) VALUES ($1,$2,$3) RETURNING id',
          [id, input.text, r.auth!.user.id],
        );
        await client.query('UPDATE customers SET version=version+1,updated_at=now() WHERE id=$1', [
          id,
        ]);
        await this.service.event(
          client,
          r,
          'customer',
          'customers.note_added',
          id,
          input.expectedVersion + 1,
          { noteId: rows[0].id },
        );
        return rows[0];
      },
      false,
    );
  }
  @Post(':id/notes/:noteId/resolve') resolve(
    @Param('id') rawId: string,
    @Param('noteId') rawNote: string,
    @Body() raw: unknown,
    @Req() r: AuthRequest,
  ) {
    const id = parse(idSchema, rawId),
      noteId = parse(idSchema, rawNote),
      input = parse(versionInput, raw);
    return this.service.commands.run(
      r,
      'customers.resolve',
      { id, noteId, ...input },
      async (client) => {
        await this.service.lock(client, 'customers', id, input.expectedVersion);
        const result = await client.query(
          'UPDATE customer_notes SET is_active=false,resolved_at=now(),resolved_by=$3 WHERE id=$1 AND customer_id=$2 AND is_active RETURNING id',
          [noteId, id, r.auth!.user.id],
        );
        if (!result.rowCount) fail(404, 'NOTE_NOT_FOUND', 'Актуальная заметка не найдена.');
        await client.query('UPDATE customers SET version=version+1,updated_at=now() WHERE id=$1', [
          id,
        ]);
        await this.service.event(
          client,
          r,
          'customer',
          'customers.note_resolved',
          id,
          input.expectedVersion + 1,
          { noteId },
        );
        return result.rows[0];
      },
      false,
    );
  }
}
