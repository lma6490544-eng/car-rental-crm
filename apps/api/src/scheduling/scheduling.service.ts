import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database.service';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, audit, fail } from '../platform/security';
import { evaluateAvailability, overlaps, Demand } from './availability';
import type { EvaluateAvailabilityInput } from './booking.dto';
import type { BookingRow } from './booking-write';
export const scheduleLock = (client: PoolClient) =>
  client.query("SELECT pg_advisory_xact_lock(hashtextextended('crm:schedule',0))");
export type Target = {
  type: 'vehicle' | 'model' | 'brand' | 'equivalence_group';
  id: number;
};

export type AvailabilityInput = {
  id?: number;
  target: Target;
  models: number[];
  startAt: string;
  endAt: string;
  vehicleId?: number | null;
};
type AvailabilityVehicle = Readonly<{
  id: number;
  model_id: number;
  is_ready: boolean;
  version: number;
}>;
type AvailabilityBlock = Readonly<{
  id: number;
  vehicle_id: number;
  booking_id: number | null;
  start_at: Date;
  end_at: Date;
}>;
type AvailabilityBooking = Readonly<{
  id: number;
  start_at: Date | string;
  end_at: Date | string;
  models: readonly number[];
  target_type: Target['type'];
  target_vehicle_id: number | null;
}>;
type AvailabilityInterval = Readonly<Pick<Demand, 'start' | 'end'>>;
type AvailabilityPreparation = {
  readonly bookings: ReadonlyMap<
    number,
    {
      readonly interval: AvailabilityInterval;
      readonly pool: readonly AvailabilityVehicle[];
    }
  >;
  readonly blockIntervals: ReadonlyMap<number, AvailabilityInterval>;
};
function availabilityInterval(
  row: Pick<AvailabilityBooking, 'start_at' | 'end_at'>,
): AvailabilityInterval {
  return { start: new Date(row.start_at).getTime(), end: new Date(row.end_at).getTime() };
}
function availabilityPool(
  vehicles: readonly AvailabilityVehicle[],
  booking: Pick<AvailabilityBooking, 'models' | 'target_vehicle_id'>,
  fixed: number | null | undefined,
) {
  return vehicles.filter(
    (v) =>
      booking.models.includes(v.model_id) &&
      (!fixed || v.id === fixed) &&
      (!booking.target_vehicle_id || v.id === booking.target_vehicle_id),
  );
}
export type AvailabilityFacts = {
  readonly vehicles: readonly AvailabilityVehicle[];
  readonly blocks: readonly AvailabilityBlock[];
  readonly bookings: readonly AvailabilityBooking[];
  readonly blocksByVehicle: ReadonlyMap<number, readonly AvailabilityBlock[]>;
  readonly firstAssignmentByBooking: ReadonlyMap<number, AvailabilityBlock>;
  readonly preparation?: AvailabilityPreparation;
};
type InspectionVehicle = Readonly<{
  id: number;
  modelId: number;
  modelName: string;
  plate: string;
  label: string;
  isReady: boolean;
  readinessReason: string | null;
}>;
type DisplacementAudit = { details: { reason?: unknown } };
type CalendarInspectionData = {
  labels: Map<string, readonly InspectionVehicle[]>;
  displacements: ReadonlyMap<number, DisplacementAudit | undefined>;
};

@Injectable()
export class SchedulingService {
  private readonly tokenKey = randomBytes(32);
  constructor(
    readonly db: DatabaseService,
    readonly commands: CommandsService,
  ) {}
  evaluateRequest(input: EvaluateAvailabilityInput) {
    return this.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const old = input.bookingId
        ? (await c.query<BookingRow>('SELECT * FROM bookings WHERE id=$1', [input.bookingId]))
            .rows[0]
        : undefined;
      if (input.bookingId && !old) fail(404, 'NOT_FOUND', 'Бронь не найдена.');
      const same =
        old &&
        old.target_type === input.target.type &&
        (old.target_vehicle_id ??
          old.target_model_id ??
          old.target_brand_id ??
          old.target_group_id) === input.target.id;
      const models = same
        ? (
            await c.query<{ model_id: number }>(
              'SELECT model_id FROM booking_eligible_models WHERE booking_id=$1 ORDER BY model_id',
              [old.id],
            )
          ).rows.map((x) => x.model_id)
        : await this.models(c, input.target);
      const inspection = await this.inspect(c, {
        id: input.bookingId,
        target: input.target,
        models,
        startAt: input.startAt,
        endAt: input.endAt,
        vehicleId: input.target.type === 'vehicle' ? input.target.id : input.vehicleId,
      });
      return { ...inspection.availability, ...inspection };
    });
  }
  async conflicts(
    c: PoolClient,
    vehicleId: number,
    startAt: string,
    endAt: string,
    bookingId = 0,
    excludeBlockId = 0,
  ) {
    return (
      await c.query(
        `SELECT s.id,s.vehicle_id,s.booking_id,s.kind,s.start_at,s.end_at,s.reason,s.version,b.version AS booking_version,c.display_name AS customer_name,
          greatest(s.start_at,$2::timestamptz) AS overlap_start,least(s.end_at,$3::timestamptz) AS overlap_end
          FROM schedule_blocks s LEFT JOIN bookings b ON b.id=s.booking_id LEFT JOIN customers c ON c.id=b.customer_id
          WHERE s.retired_at IS NULL AND s.vehicle_id=$1 AND s.id<>$5 AND (s.booking_id IS NULL OR s.booking_id<>$4)
          AND s.start_at<$3 AND s.end_at>$2 ORDER BY s.start_at,s.id`,
        [vehicleId, startAt, endAt, bookingId, excludeBlockId],
      )
    ).rows;
  }
  async technicalPreview(
    c: PoolClient,
    input: { vehicleId: number; startAt: string; endAt: string; blockId?: number },
  ) {
    const vehicle = (
      await c.query('SELECT id,version,archived_at FROM vehicles WHERE id=$1', [input.vehicleId])
    ).rows[0];
    if (!vehicle || vehicle.archived_at) fail(404, 'NOT_FOUND', 'Автомобиль не найден.');
    const conflicts = await this.conflicts(
      c,
      input.vehicleId,
      input.startAt,
      input.endAt,
      0,
      input.blockId,
    );
    const token = createHmac('sha256', this.tokenKey)
      .update(JSON.stringify({ input, vehicle, conflicts }))
      .digest('hex');
    return { conflicts, token };
  }
  async inspect(c: PoolClient, input: AvailabilityInput, facts?: AvailabilityFacts) {
    return this.inspectWithData(c, input, facts);
  }
  // Create and consume only within CalendarService's single RR transaction.
  // The closure owns its maps; no request state is retained on this service.
  async createCalendarInspector(
    c: PoolClient,
    facts: AvailabilityFacts | undefined,
    unassignedBookingIds: number[],
  ) {
    const displacements = new Map<number, DisplacementAudit | undefined>();
    for (const id of unassignedBookingIds) displacements.set(id, undefined);
    if (unassignedBookingIds.length) {
      const rows = (
        await c.query<DisplacementAudit & { entity_id: number }>(
          `SELECT DISTINCT ON (entity_id) entity_id,details FROM audit_logs
           WHERE entity_type='booking' AND entity_id=ANY($1::int[]) AND action='bookings.displaced'
           ORDER BY entity_id,id DESC`,
          [unassignedBookingIds],
        )
      ).rows;
      for (const row of rows) displacements.set(row.entity_id, row);
    }
    const data: CalendarInspectionData = { labels: new Map(), displacements };
    const preparedFacts = facts ? this.prepareAvailabilityFacts(facts) : undefined;
    return (input: AvailabilityInput) => this.inspectWithData(c, input, preparedFacts, data);
  }
  private async inspectionVehicles(
    c: PoolClient,
    models: number[],
    cache?: Map<string, readonly InspectionVehicle[]>,
  ): Promise<readonly InspectionVehicle[]> {
    const key = cache ? JSON.stringify(models) : undefined;
    if (cache && key !== undefined) {
      const cached = cache.get(key);
      if (cached) return cached;
    }
    const vehicles = (
      await c.query<InspectionVehicle>(
        `SELECT v.id,v.model_id AS "modelId",m.name AS "modelName",v.plate,b.name||' '||m.name||' · '||v.plate AS label,v.is_ready AS "isReady",v.readiness_reason AS "readinessReason"
          FROM vehicles v JOIN vehicle_models m ON m.id=v.model_id JOIN vehicle_brands b ON b.id=m.brand_id
          WHERE v.archived_at IS NULL AND v.model_id=ANY($1::int[]) ORDER BY b.name,m.name,v.plate`,
        [models],
      )
    ).rows;
    if (cache && key !== undefined) cache.set(key, vehicles);
    return vehicles;
  }
  private async inspectionDisplacement(
    c: PoolClient,
    bookingId: number,
    data?: CalendarInspectionData,
  ): Promise<DisplacementAudit | undefined> {
    // has() distinguishes an observed absence from an ID outside the batch.
    if (data?.displacements.has(bookingId)) return data.displacements.get(bookingId);
    return (
      await c.query<DisplacementAudit>(
        "SELECT details FROM audit_logs WHERE entity_type='booking' AND entity_id=$1 AND action='bookings.displaced' ORDER BY id DESC LIMIT 1",
        [bookingId],
      )
    ).rows[0];
  }
  private async inspectWithData(
    c: PoolClient,
    input: AvailabilityInput,
    facts?: AvailabilityFacts,
    data?: CalendarInspectionData,
  ) {
    const availability = await this.evaluate(c, input, facts);
    let conflicts = input.vehicleId
      ? await this.conflicts(c, input.vehicleId, input.startAt, input.endAt, input.id)
      : [];
    if (!input.vehicleId && availability.status !== 'feasible') {
      conflicts = (
        await c.query(
          `SELECT s.id,s.vehicle_id,s.booking_id,s.kind,s.start_at,s.end_at,s.reason,c.display_name AS customer_name,
              greatest(s.start_at,$2::timestamptz) AS overlap_start,least(s.end_at,$3::timestamptz) AS overlap_end
              FROM schedule_blocks s JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN bookings b ON b.id=s.booking_id LEFT JOIN customers c ON c.id=b.customer_id
              WHERE s.retired_at IS NULL AND v.model_id=ANY($1::int[]) AND (s.booking_id IS NULL OR s.booking_id<>$4) AND s.start_at<$3 AND s.end_at>$2 ORDER BY s.start_at,s.id`,
          [input.models, input.startAt, input.endAt, input.id ?? 0],
        )
      ).rows;
      const unassigned = (
        await c.query(
          `SELECT 'booking-'||b.id AS id,NULL::int AS vehicle_id,b.id AS booking_id,'unassigned' AS kind,b.start_at,b.end_at,'' AS reason,c.display_name AS customer_name,
              greatest(b.start_at,$2::timestamptz) AS overlap_start,least(b.end_at,$3::timestamptz) AS overlap_end
              FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.id=ANY($1::int[]) AND b.id<>$4 AND b.status='confirmed' AND b.start_at<$3 AND b.end_at>$2
              AND NOT EXISTS(SELECT 1 FROM schedule_blocks s WHERE s.booking_id=b.id AND s.retired_at IS NULL) ORDER BY b.start_at,b.id`,
          [availability.bookingIds, input.startAt, input.endAt, input.id ?? 0],
        )
      ).rows;
      conflicts.push(...unassigned);
    }
    const vehicles = await this.inspectionVehicles(c, input.models, data?.labels);
    const pool = await this.evaluate(
      c,
      {
        ...input,
        target: { type: 'model', id: input.models[0] },
        vehicleId: null,
      },
      facts,
    );
    const alternatives = vehicles.filter((v) => pool.candidates.includes(v.id));
    const assigned = vehicles.find((v) => v.id === input.vehicleId);
    const problemReasons: string[] = [];
    if (assigned && !assigned.isReady)
      problemReasons.push(
        'Назначенный автомобиль не готов: ' + (assigned.readinessReason || 'причина не указана'),
      );
    if (input.vehicleId && conflicts.length)
      problemReasons.push('Пересечение назначения с расписанием');
    if (availability.status === 'unknown') problemReasons.push('Доступность не подтверждена');
    else if (availability.status === 'deficit' && !problemReasons.length)
      problemReasons.push('Нет свободного автомобиля на весь период');
    const displaced =
      input.id && !input.vehicleId
        ? await this.inspectionDisplacement(c, input.id, data)
        : undefined;
    const replacementReason = displaced
      ? 'Автомобиль снят с назначения из-за технической блокировки: ' + displaced.details.reason
      : undefined;
    if (displaced) problemReasons.push('Требуется замена автомобиля');
    const targetLabel =
      [...new Set(vehicles.map((v) => v.label.split(' · ')[0]))].join(' / ') ||
      'Сохранённый набор допустимых моделей';
    return {
      availability,
      conflicts,
      alternatives,
      problemReasons,
      vehicle: assigned,
      replacementReason,
      targetLabel,
    };
  }
  async reviseTarget(
    c: PoolClient,
    bookingId: number,
    revision: number,
    target: Target,
    reason: string,
    actor: number,
  ) {
    await c.query(
      `INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by)
          SELECT booking_id,$2,quote_id,jsonb_set(snapshot,'{target}',$3::jsonb),$4,$5 FROM booking_terms WHERE booking_id=$1 ORDER BY revision DESC LIMIT 1`,
      [bookingId, revision, JSON.stringify(target), reason, actor],
    );
  }
  async assertAssignable(
    c: PoolClient,
    vehicleId: number,
    startAt: string,
    endAt: string,
    bookingId = 0,
  ) {
    const v = (
      await c.query('SELECT is_ready FROM vehicles WHERE id=$1 AND archived_at IS NULL FOR SHARE', [
        vehicleId,
      ])
    ).rows[0];
    if (!v) fail(404, 'NOT_FOUND', 'Автомобиль не найден.');
    const conflicts = await this.conflicts(c, vehicleId, startAt, endAt, bookingId);
    if (conflicts.length)
      fail(
        409,
        'VEHICLE_ASSIGNMENT_CONFLICT',
        'Автомобиль занят на выбранный период. Выберите замену или сохраните бронь без автомобиля.',
        { conflicts },
      );
    if (!v.is_ready)
      fail(
        422,
        'VEHICLE_NOT_READY',
        'Автомобиль не готов к выдаче. Выберите замену или сохраните бронь без автомобиля.',
      );
  }
  async models(c: PoolClient, target: Target): Promise<number[]> {
    const query = {
      vehicle: 'SELECT model_id AS id FROM vehicles WHERE id=$1 AND archived_at IS NULL',
      model: 'SELECT id FROM vehicle_models WHERE id=$1',
      brand: 'SELECT id FROM vehicle_models WHERE brand_id=$1',
      equivalence_group: 'SELECT model_id AS id FROM equivalence_group_models WHERE group_id=$1',
    }[target.type];
    const ids = (await c.query(query, [target.id])).rows.map((r) => r.id);
    if (!ids.length) fail(422, 'EMPTY_TARGET', 'У выбранной цели нет доступных моделей.');
    return ids;
  }
  // Reuse only inside the same read-only transaction snapshot. Writers omit prepared facts.
  async loadAvailabilityFacts(c: PoolClient, excludedBookingId = 0): Promise<AvailabilityFacts> {
    const vehicles = (
      await c.query<AvailabilityVehicle>(
        'SELECT id,model_id,is_ready,version FROM vehicles WHERE archived_at IS NULL ORDER BY id',
      )
    ).rows;
    const blocks = (
      await c.query<AvailabilityBlock>(
        'SELECT id,vehicle_id,booking_id,start_at,end_at FROM schedule_blocks WHERE retired_at IS NULL ORDER BY id',
      )
    ).rows;
    const bookings = (
      await c.query<AvailabilityBooking>(
        "SELECT b.*,array(SELECT model_id FROM booking_eligible_models WHERE booking_id=b.id ORDER BY model_id) AS models FROM bookings b WHERE status='confirmed' AND id<>$1 ORDER BY id",
        [excludedBookingId],
      )
    ).rows;
    const blocksByVehicle = new Map<number, AvailabilityBlock[]>();
    const firstAssignmentByBooking = new Map<number, AvailabilityBlock>();
    for (const block of blocks) {
      const vehicleBlocks = blocksByVehicle.get(block.vehicle_id) ?? [];
      vehicleBlocks.push(block);
      blocksByVehicle.set(block.vehicle_id, vehicleBlocks);
      // Preserve the first match from the original blocks.find() in ORDER BY id order.
      if (block.booking_id !== null && !firstAssignmentByBooking.has(block.booking_id))
        firstAssignmentByBooking.set(block.booking_id, block);
    }
    return { vehicles, blocks, bookings, blocksByVehicle, firstAssignmentByBooking };
  }
  async evaluate(c: PoolClient, input: AvailabilityInput, facts?: AvailabilityFacts) {
    const loaded = facts ?? (await this.loadAvailabilityFacts(c, input.id ?? 0));
    const vehicles = loaded.vehicles;
    const blocks = loaded.blocks.filter((b) => b.booking_id !== input.id);
    const rows = loaded.bookings.filter((b) => b.id !== (input.id ?? 0));
    const root = input.id ?? 0;
    rows.push({
      id: root,
      start_at: input.startAt,
      end_at: input.endAt,
      models: input.models,
      target_type: input.target.type,
      target_vehicle_id: input.target.type === 'vehicle' ? input.target.id : null,
    });
    const demands: Demand[] = rows.map((b) => {
      // The root can change target, models, dates and assignment in either context.
      const prepared = b.id !== root ? loaded.preparation?.bookings.get(b.id) : undefined;
      const interval = prepared?.interval ?? availabilityInterval(b);
      const fixed =
        b.id === root ? input.vehicleId : loaded.firstAssignmentByBooking.get(b.id)?.vehicle_id;
      const pool = prepared?.pool ?? availabilityPool(vehicles, b, fixed);
      return {
        id: b.id,
        ...interval,
        pool: pool.map((v) => v.id),
        candidates: pool
          .filter(
            (v) =>
              v.is_ready &&
              // The shared index includes the root booking's old assignment; ignore it here.
              !(loaded.blocksByVehicle.get(v.id) ?? []).some(
                (x) =>
                  x.booking_id !== input.id &&
                  x.booking_id !== b.id &&
                  x.vehicle_id === v.id &&
                  overlaps(
                    interval,
                    loaded.preparation?.blockIntervals.get(x.id) ?? availabilityInterval(x),
                  ),
              ),
          )
          .map((v) => v.id),
      };
    });
    const result = evaluateAvailability(demands, root);
    const snapshot = { ...result, candidates: demands.find((d) => d.id === root)!.candidates };
    // Bind acceptance to the full evaluated input and current facts. Restart
    // invalidates previews safely; tokens are not reservations.
    const normalizedInput = {
      id: input.id ?? 0,
      target: input.target,
      models: [...input.models].sort((a, b) => a - b),
      startAt: new Date(input.startAt).toISOString(),
      endAt: new Date(input.endAt).toISOString(),
      vehicleId: input.vehicleId ?? null,
    };
    const token = createHmac('sha256', this.tokenKey)
      .update(JSON.stringify({ input: normalizedInput, demands, blocks, vehicles, snapshot }))
      .digest('hex');
    return { ...snapshot, token, evaluatedAt: new Date().toISOString() };
  }
  // Calendar-only indices. Raw rows and their serialization remain untouched.
  private prepareAvailabilityFacts(facts: AvailabilityFacts): AvailabilityFacts {
    const bookings = new Map(
      facts.bookings.map((b) => [
        b.id,
        {
          interval: availabilityInterval(b),
          pool: availabilityPool(
            facts.vehicles,
            b,
            facts.firstAssignmentByBooking.get(b.id)?.vehicle_id,
          ),
        },
      ]),
    );
    const blockIntervals = new Map(facts.blocks.map((b) => [b.id, availabilityInterval(b)]));
    return { ...facts, preparation: { bookings, blockIntervals } };
  }
  accept(
    result: Awaited<ReturnType<SchedulingService['evaluate']>>,
    acceptance?: {
      token: string;
      reason: string;
    },
  ) {
    if (result.status !== 'feasible' && acceptance?.token !== result.token)
      fail(
        409,
        'RISK_ACCEPTANCE_REQUIRED',
        'Доступность изменилась. Обновите проверку перед сохранением.',
        result,
      );
  }
  async event(
    c: PoolClient,
    r: AuthRequest,
    entity: 'booking' | 'schedule_block',
    id: number,
    version: number,
    action: string,
    details: Record<string, unknown>,
  ) {
    await audit(c, r.auth!.user.id, entity, action, id, r.requestId, details);
    await c.query('INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,$2,$3)', [
      `${action}:${id}:${version}`,
      action,
      JSON.stringify({ id, version }),
    ]);
  }
  async assignment(
    c: PoolClient,
    bookingId: number,
    vehicleId: number,
    startAt: string | Date,
    endAt: string | Date,
    actor: number,
    reason: string,
  ) {
    const conflict = await c.query(
      "SELECT id FROM schedule_blocks WHERE retired_at IS NULL AND vehicle_id=$1 AND tstzrange(start_at,end_at,'[)') && tstzrange($2,$3,'[)')",
      [vehicleId, startAt, endAt],
    );
    if (conflict.rowCount)
      fail(409, 'VEHICLE_ASSIGNMENT_CONFLICT', 'Автомобиль занят на выбранный период.');
    await c.query(
      "INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by) VALUES ($1,$2,'assignment',$3,$4,$5,$6)",
      [vehicleId, bookingId, startAt, endAt, reason, actor],
    );
  }
}
