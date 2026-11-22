import { BookingService } from './booking.service';
import { getAccountingEmailStatus } from './accounting-email';
import { BookingQueryService } from './booking-query.service';
import { CalendarService } from './calendar.service';
import {
  id,
  reason,
  bookingPreview,
  period,
  evaluation,
  create,
  change,
  assignVehicle,
  cancelBooking,
  movePreview,
  moveBooking,
} from './booking.dto';
import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { AuthRequest, idSchema, parse } from '../platform/security';
import { SchedulingService } from './scheduling.service';
import { TechnicalBlockService } from './technical-block.service';
import { technicalInput } from './technical-block.dto';
const version = z.object({ expectedVersion: id, reason }).strict();
@Controller()
export class SchedulingController {
  constructor(
    private readonly s: SchedulingService,
    private readonly bookings: BookingService,
    private readonly calendarService: CalendarService,
    private readonly technicalBlocks: TechnicalBlockService,
    private readonly bookingQueries: BookingQueryService,
  ) {}
  @Get('booking-customers') async customers(@Query() raw: unknown) {
    const { q } = parse(z.object({ q: z.string().trim().max(250) }).strict(), raw);
    if (q.length < 2) return { items: [] };
    return {
      items: (
        await this.s.db.pool.query(
          `SELECT id,type,display_name AS "displayName",phone,is_blocked AS "isBlocked" FROM customers WHERE strpos(lower(display_name),lower($1))>0 OR ($2<>'' AND strpos(regexp_replace(phone,'[^0-9]','','g'),$2)>0) OR strpos(inn,$1)>0 ORDER BY lower(display_name),id LIMIT 20`,
          [q, q.replace(/\D/g, '')],
        )
      ).rows,
    };
  }
  @Get('booking-options') async options() {
    return this.s.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const vehicles = (
        await c.query(
          `SELECT v.id,v.model_id AS "modelId",m.brand_id AS "brandId",m.name AS "modelName",v.plate,b.name||' '||m.name||' · '||v.plate AS label,v.is_ready AS "isReady",v.readiness_reason AS "readinessReason" FROM vehicles v JOIN vehicle_models m ON m.id=v.model_id JOIN vehicle_brands b ON b.id=m.brand_id WHERE v.archived_at IS NULL ORDER BY b.name,m.name,v.plate`,
        )
      ).rows;
      const models = (
        await c.query(
          `SELECT m.id,m.brand_id AS "brandId",m.pricing_group_id AS "pricingGroupId",b.name||' '||m.name AS label FROM vehicle_models m JOIN vehicle_brands b ON b.id=m.brand_id ORDER BY b.name,m.name`,
        )
      ).rows;
      const brands = (await c.query('SELECT id,name AS label FROM vehicle_brands ORDER BY name'))
        .rows;
      const groups = (
        await c.query('SELECT id,name AS label FROM equivalence_groups ORDER BY name')
      ).rows;
      return { vehicles, models, brands, groups };
    });
  }
  @Post('bookings/preview') async preview(@Body() raw: unknown, @Req() request: AuthRequest) {
    const input = parse(bookingPreview, raw);
    return this.bookings.preview(input, request);
  }
  @Get('vehicles/:id/schedule')
  async vehicleSchedule(
    @Param('id')
    raw: string,
  ) {
    return {
      items: (
        await this.s.db.pool.query(
          "SELECT * FROM schedule_blocks WHERE vehicle_id=$1 AND kind='technical' AND retired_at IS NULL ORDER BY start_at",
          [parse(idSchema, raw)],
        )
      ).rows,
    };
  }
  @Get('calendar')
  async calendar(
    @Query()
    raw: unknown,
  ) {
    const q = parse(
      z
        .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
        .strict()
        .refine(
          (v) =>
            Date.parse(v.to) > Date.parse(v.from) &&
            Date.parse(v.to) - Date.parse(v.from) <= 93 * 86400000,
        ),
      raw,
    );
    return this.calendarService.get(q);
  }
  @Post('schedule-blocks/preview')
  async previewTechnical(@Body() raw: unknown) {
    const input = parse(
      z
        .object({ vehicleId: id, ...period, blockId: id.optional() })
        .strict()
        .refine((v) => Date.parse(v.endAt) > Date.parse(v.startAt)),
      raw,
    );
    return this.technicalBlocks.preview(input);
  }
  @Post('schedule-blocks')
  technical(@Body() raw: unknown, @Req() r: AuthRequest) {
    return this.technicalBlocks.save(parse(technicalInput, raw), r);
  }
  @Patch('schedule-blocks/:id')
  updateTechnical(@Param('id') raw: string, @Body() body: unknown, @Req() r: AuthRequest) {
    return this.technicalBlocks.save(parse(technicalInput, body), r, parse(idSchema, raw));
  }
  @Post('schedule-blocks/:id/cancel')
  cancelTechnical(
    @Param('id')
    raw: string,
    @Body()
    body: unknown,
    @Req()
    r: AuthRequest,
  ) {
    const blockId = parse(idSchema, raw),
      input = parse(version, body);
    return this.technicalBlocks.cancel(input, r, blockId);
  }
  @Get('booking-targets')
  async targets(
    @Query()
    raw: unknown,
  ) {
    const q = parse(z.object({ q: z.string().max(100).default('') }).strict(), raw).q;
    const items = (
      await this.s.db.pool
        .query(`SELECT 'vehicle' AS type,v.id,b.name||' '||m.name||' · '||v.plate AS label FROM vehicles v JOIN vehicle_models m ON m.id=v.model_id JOIN vehicle_brands b ON b.id=m.brand_id WHERE v.archived_at IS NULL
      UNION ALL SELECT 'model',m.id,b.name||' '||m.name FROM vehicle_models m JOIN vehicle_brands b ON b.id=m.brand_id
      UNION ALL SELECT 'brand',id,name FROM vehicle_brands UNION ALL SELECT 'equivalence_group',id,name FROM equivalence_groups`)
    ).rows;
    return { items: items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())) };
  }
  @Post('availability/evaluate')
  async evaluate(
    @Body()
    raw: unknown,
  ) {
    const input = parse(evaluation, raw);
    return this.s.evaluateRequest(input);
  }
  @Get('bookings/:id')
  async get(
    @Param('id')
    raw: string,
  ) {
    const bookingId = parse(idSchema, raw);
    return this.bookingQueries.get(bookingId);
  }
  @Get('bookings/:id/history')
  async history(
    @Param('id')
    raw: string,
  ) {
    const items = (
      await this.s.db.pool.query(
        'SELECT a.id,a.action,a.details,a.created_at AS "createdAt",u.full_name AS author FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.entity_type=\'booking\' AND a.entity_id=$1 ORDER BY a.id DESC LIMIT 100',
        [parse(idSchema, raw)],
      )
    ).rows;
    const terms = (
      await this.s.db.pool.query(
        `SELECT t.id,t.revision,t.snapshot->>'finalTotalRub' AS "priceRub",t.reason,t.created_at AS "createdAt",u.full_name AS author FROM booking_terms t LEFT JOIN users u ON u.id=t.created_by WHERE t.booking_id=$1 ORDER BY t.revision DESC`,
        [parse(idSchema, raw)],
      )
    ).rows;
    return { items, total: items.length, terms };
  }
  @Get('bookings/:id/accounting-email')
  accountingEmail(@Param('id') raw: string) {
    return getAccountingEmailStatus(this.s.db.pool, parse(idSchema, raw));
  }
  @Post('bookings/:id/accounting-email')
  requestAccountingEmail(@Param('id') raw: string, @Body() body: unknown, @Req() r: AuthRequest) {
    const input = parse(z.object({ expectedVersion: id }).strict(), body);
    return this.bookings.requestAccountingEmail(r, parse(idSchema, raw), input.expectedVersion);
  }
  @Post('bookings')
  create(
    @Body()
    raw: unknown,
    @Req()
    r: AuthRequest,
  ) {
    return this.bookings.create(parse(create, raw), r);
  }
  @Patch('bookings/:id/terms')
  update(
    @Param('id')
    raw: string,
    @Body()
    body: unknown,
    @Req()
    r: AuthRequest,
  ) {
    return this.bookings.update(parse(change, body), r, parse(idSchema, raw));
  }
  @Post('bookings/:id/move/preview')
  async previewMove(@Param('id') raw: string, @Body() body: unknown, @Req() r: AuthRequest) {
    const bookingId = parse(idSchema, raw);
    const input = parse(movePreview, body);
    return this.bookings.previewMove(input, r, bookingId);
  }
  @Post('bookings/:id/move')
  move(@Param('id') raw: string, @Body() body: unknown, @Req() r: AuthRequest) {
    const bookingId = parse(idSchema, raw);
    const input = parse(moveBooking, body);
    return this.bookings.move(input, r, bookingId);
  }
  @Post('bookings/:id/assign-vehicle')
  assignment(
    @Param('id')
    raw: string,
    @Body()
    body: unknown,
    @Req()
    r: AuthRequest,
  ) {
    const bookingId = parse(idSchema, raw);
    const input = parse(assignVehicle, body);
    return this.bookings.assign(input, r, bookingId);
  }
  @Post('bookings/:id/cancel')
  cancel(
    @Param('id')
    raw: string,
    @Body()
    body: unknown,
    @Req()
    r: AuthRequest,
  ) {
    const bookingId = parse(idSchema, raw);
    const input = parse(cancelBooking, body);
    return this.bookings.cancel(input, r, bookingId);
  }
}
