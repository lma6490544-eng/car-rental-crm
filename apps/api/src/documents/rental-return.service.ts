import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database.service';
import {
  bookingSummary,
  bounded,
  depositReserve,
  positive,
  recordEvent,
  rescheduleDepositReserve,
} from '../finance/ledger';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, audit, fail, hash } from '../platform/security';
import { calculate, type Calculation } from '../pricing/calculate';
import { ruleSets } from '../pricing/rules';
import { recordRentalStart } from '../push/rental-event';
import type { QuoteInput } from '../pricing/pricing.dto';
import {
  assertInspectionIdle,
  assertInspectionWorkOwner,
  findInspectionWork,
} from './inspection-work';
import type {
  ReturnCorrection,
  ReturnDamage,
  ReturnInspection,
  ReturnLine,
  ReturnReview,
} from './rental-return.dto';

type Inspection = Omit<ReturnInspection, 'expectedRevision' | 'returnedAt' | 'workId'> & {
  returnedAt: string;
};
type Adjustment = ReturnReview['adjustments'][number] & {
  originalRub: string;
  actorId: number;
  at: string;
};
type Settlement = {
  pricing: Calculation;
  lines: Record<ReturnLine, string>;
  adjustments: Adjustment[];
  wash: boolean;
  totalRub: string;
  differenceRub: string;
  receivedRub: string;
  debtRub: string;
  overpaymentRub: string;
};
type Revision = {
  revision: number;
  inspection: Inspection;
  calculation: Settlement | null;
  actor: string;
  at: Date;
  reason: string | null;
};
type Rental = {
  issuedAt: Date;
  returnedAt: Date | null;
  vehicleId: number;
  customerId: number;
  termsId: number;
  terms: Calculation;
  mileageOut: number;
  fuelOut: number;
  bodyType: NonNullable<QuoteInput['usages']>[number]['bodyType'];
  maintenanceDue: number | null;
  version: number;
};

@Injectable()
export class RentalReturnService {
  private schemaReady = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly commands: CommandsService,
  ) {}

  private async requireSchema(c: Pick<PoolClient, 'query'>) {
    if (this.schemaReady) return;
    const {
      rows: [schema],
    } = await c.query<{ ready: boolean }>(
      `SELECT to_regclass('rental_return_revisions') IS NOT NULL
        AND to_regclass('push_subscriptions') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid=to_regclass('finance_allocations')
            AND attname='available_at' AND NOT attisdropped
        ) AS ready`,
    );
    if (!schema.ready)
      fail(503, 'RETURN_SCHEMA_REQUIRED', 'Для приёмки нужны миграции базы данных 0019–0021.');
    this.schemaReady = true;
  }

  async list(source: 'customers' | 'vehicles', id: number) {
    await this.requireSchema(this.db.pool);
    const filter = source === 'customers' ? 'b.customer_id' : 'x.issued_vehicle_id';
    const { rows } = await this.db.pool.query<{
      id: number;
      issuedAt: Date;
      returnedAt: Date | null;
      status: string;
      plate: string;
      customer: string;
    }>(
      `SELECT b.id,x.issued_at AS "issuedAt",x.returned_at AS "returnedAt",b.status,v.plate,u.display_name AS customer
       FROM booking_checkouts x JOIN bookings b ON b.id=x.booking_id
       JOIN customers u ON u.id=b.customer_id JOIN vehicles v ON v.id=x.issued_vehicle_id
       WHERE x.issued_at IS NOT NULL AND ${filter}=$1 ORDER BY x.issued_at DESC,b.id DESC`,
      [id],
    );
    return rows;
  }

  private async rental(c: PoolClient, id: number, lock = false) {
    await this.requireSchema(c);
    if (lock) {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('crm:schedule',0))");
      await c.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [id]);
    }
    const {
      rows: [rental],
    } = await c.query<Rental>(
      `SELECT x.issued_at AS "issuedAt", x.returned_at AS "returnedAt",
       x.issued_vehicle_id AS "vehicleId", b.customer_id AS "customerId", b.version,
       t.id AS "termsId", t.snapshot AS terms, i.mileage_km AS "mileageOut", i.fuel_eighths AS "fuelOut",
       i.vehicle_snapshot->>'bodyType' AS "bodyType", v.next_maintenance_due_km AS "maintenanceDue"
       FROM booking_checkouts x JOIN bookings b ON b.id=x.booking_id
       JOIN vehicles v ON v.id=x.issued_vehicle_id JOIN inspection_revisions i ON i.id=x.act_revision_id
       JOIN LATERAL (SELECT id,snapshot FROM booking_terms WHERE booking_id=b.id ORDER BY revision DESC LIMIT 1) t ON true
       WHERE b.id=$1 AND x.issued_at IS NOT NULL`,
      [id],
    );
    if (!rental) fail(404, 'RENTAL_NOT_FOUND', 'Выданная аренда не найдена.');
    return rental;
  }

  private async history(c: PoolClient, id: number, latest = false) {
    return (
      await c.query<Revision>(
        `SELECT r.revision,r.inspection,r.calculation,r.reason,r.created_at AS at,u.full_name AS actor
       FROM rental_return_revisions r JOIN users u ON u.id=r.actor_id WHERE booking_id=$1
       ORDER BY revision DESC ${latest ? 'LIMIT 1' : ''}`,
        [id],
      )
    ).rows;
  }

  start(request: AuthRequest, id: number) {
    return this.commands.run(
      request,
      'rentalReturn.start',
      { id },
      async (c) => {
        const rental = await this.rental(c, id, true);
        if (rental.returnedAt) fail(409, 'RENTAL_COMPLETED', 'Приёмка этой аренды уже завершена.');
        const started = await c.query(
          `UPDATE booking_checkouts SET return_started_at=clock_timestamp(),return_started_by=$2
         WHERE booking_id=$1 AND return_started_at IS NULL`,
          [id, request.auth!.user.id],
        );
        if (started.rowCount) await recordRentalStart(c, request, id, 'rentalReturn.started');
        return { id };
      },
      false,
    );
  }

  get(id: number) {
    return this.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const rental = await this.rental(c, id);
      const history = await this.history(c, id);
      const excludedPhotoIds = history[0]?.inspection.excludedPhotoIds ?? [];
      const inspectionWork = rental.returnedAt
        ? null
        : ((await findInspectionWork(c, id, rental.version, 'check_in')) ?? null);
      const finance = await bookingSummary(c, id);
      const photos = (
        await c.query<{
          id: string;
          status: string;
          addedAt: Date;
          addedBy: string;
          deleteAfter: Date | null;
        }>(
          `SELECT f.id,CASE WHEN f.status<>'deleted' AND f.delete_after<=clock_timestamp()
         THEN 'expired' ELSE f.status END AS status, f.created_at AS "addedAt", u.full_name AS "addedBy",
         f.delete_after AS "deleteAfter"
         FROM private_files f JOIN users u ON u.id=f.created_by
         WHERE f.booking_id=$1 AND f.vehicle_id=$2 AND f.inspection_kind='check_in'
           AND NOT (f.id=ANY($3::uuid[]))
         ORDER BY f.created_at`,
          [id, rental.vehicleId, excludedPhotoIds],
        )
      ).rows;
      const { rows: damageCharges } = await c.query<{
        id: number;
        amountRub: string;
        reason: string;
        at: Date;
        actor: string;
      }>(
        `SELECT o.id,f.amount_rub::text AS "amountRub",o.reason,o.created_at AS at,u.full_name AS actor
         FROM finance_charges f JOIN financial_operations o ON o.id=f.operation_id
         JOIN users u ON u.id=o.actor_id WHERE f.booking_id=$1 AND o.command_id LIKE 'rental-damage:%'
         ORDER BY o.id DESC`,
        [id],
      );
      const reserves = rental.returnedAt ? await depositReserve(c, id) : [];
      return { rental, history, inspectionWork, finance, reserves, photos, damageCharges };
    });
  }

  private async checkMeasurements(
    c: PoolClient,
    id: number,
    rental: Rental,
    inspection: Inspection,
  ) {
    const {
      rows: [time],
    } = await c.query<{ valid: boolean }>(
      'SELECT $2::timestamptz BETWEEN issued_at AND clock_timestamp() AS valid FROM booking_checkouts WHERE booking_id=$1',
      [id, inspection.returnedAt],
    );
    if (!time.valid)
      fail(422, 'RETURN_TIME', 'Возврат должен быть между фактической выдачей и текущим временем.');
    if (inspection.mileageKm < rental.mileageOut)
      fail(422, 'RETURN_MILEAGE', 'Пробег при возврате меньше пробега при выдаче.');
  }

  save(request: AuthRequest, id: number, input: ReturnInspection) {
    return this.commands.run(
      request,
      'rentalReturn.save',
      { id, input },
      async (c) => {
        const rental = await this.rental(c, id, true);
        const [latest] = await this.history(c, id, true);
        if (rental.returnedAt || (latest?.revision ?? 0) !== input.expectedRevision)
          fail(409, 'RETURN_CHANGED', 'Осмотр изменился. Откройте актуальную редакцию.');
        const work = await findInspectionWork(c, id, rental.version, 'check_in');
        assertInspectionWorkOwner(work, input.workId, request.auth!.user.id);
        if (
          input.returnedAt &&
          input.returnedAt !== latest?.inspection.returnedAt &&
          !input.backdateReason
        )
          fail(422, 'RETURN_REASON_REQUIRED', 'Укажите причину ввода прошедшего времени.');
        const { expectedRevision, workId, photoIds, excludedPhotoIds = [], ...fields } = input;
        const previousExclusions = latest?.inspection.excludedPhotoIds ?? [];
        const returnedAt =
          fields.returnedAt ??
          (await c.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
        const { rows: photos } = await c.query<{ id: string; status: 'pending' | 'ready' }>(
          `SELECT id,status FROM private_files WHERE booking_id=$1 AND vehicle_id=$2
         AND inspection_kind='check_in' AND status IN ('pending','ready')
         AND NOT (id=ANY($3::uuid[]))
         AND (delete_after IS NULL OR delete_after>clock_timestamp())
         ORDER BY created_at,id FOR SHARE`,
          [id, rental.vehicleId, previousExclusions],
        );
        const readyIds = new Set(
          photos.filter(({ status }) => status === 'ready').map(({ id }) => id),
        );
        const exclusions = new Set(excludedPhotoIds.map((photoId) => photoId.toLowerCase()));
        for (const photoId of exclusions) {
          if (!readyIds.delete(photoId))
            fail(422, 'RETURN_PHOTO_UNAVAILABLE', 'Фото недоступно для удаления из акта.');
        }
        const inspection: Inspection = {
          ...fields,
          photoIds: [...readyIds],
          ...(previousExclusions.length || exclusions.size
            ? { excludedPhotoIds: [...previousExclusions, ...exclusions] }
            : {}),
          returnedAt,
          backdateReason:
            fields.backdateReason ??
            (fields.returnedAt === latest?.inspection.returnedAt
              ? latest?.inspection.backdateReason
              : undefined),
        };
        await this.checkMeasurements(c, id, rental, inspection);
        if (
          inspection.damage &&
          (!inspection.remarks || (!inspection.photoIds.length && !inspection.photoException))
        )
          fail(
            422,
            'RETURN_DAMAGE_DETAILS',
            'Опишите повреждение и добавьте фото или отметьте сбой загрузки.',
          );
        const submittedIds = new Set(photoIds.map((photoId) => photoId.toLowerCase()));
        if (
          submittedIds.size !== photoIds.length ||
          [...submittedIds].some((photoId) => !readyIds.has(photoId)) ||
          (!inspection.photoException && photos.some(({ status }) => status === 'pending'))
        )
          fail(422, 'RETURN_PHOTOS_PENDING', 'Дождитесь готовности фотографий.');
        const revision = expectedRevision + 1;
        await this.writeRevision(c, request, id, revision, inspection);
        if (workId !== undefined)
          await c.query('DELETE FROM inspection_work WHERE id=$1', [workId]);
        return { revision };
      },
      false,
    );
  }

  private async writeRevision(
    c: PoolClient,
    request: AuthRequest,
    id: number,
    revision: number,
    inspection: Inspection,
    calculation?: Settlement,
    reason?: string,
  ) {
    await c.query(
      'INSERT INTO rental_return_revisions(booking_id,revision,actor_id,inspection,calculation,reason) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        revision,
        request.auth!.user.id,
        JSON.stringify(inspection),
        calculation ? JSON.stringify(calculation) : null,
        reason ?? null,
      ],
    );
    const action = reason ? 'corrected' : calculation ? 'confirmed' : 'inspectionSaved';
    await audit(
      c,
      request.auth!.user.id,
      'booking',
      'rentalReturn.' + action,
      id,
      request.requestId,
      { revision, reason, photoException: inspection.photoException },
    );
  }

  private priceLines(id: number, rental: Rental, inspection: Inspection, wash: boolean) {
    const base = rental.terms;
    const rules = ruleSets.find((row) => row.version === base.ruleVersion);
    if (!rules) fail(422, 'TARIFF_NOT_FOUND', 'Версия тарифа договора недоступна.');
    const actual = Date.parse(inspection.returnedAt);
    const start = Date.parse(base.startAt);
    const early = actual < start + base.contractDays * 86400000;
    const pricing = calculate(
      {
        operationKind: early ? 'early_return' : 'return',
        actualReturnAt: new Date(Math.max(actual, start + 1)).toISOString(),
        wash,
        clearOverrides: false,
        usages: [
          {
            key: String(id),
            bodyType: rental.bodyType,
            odometerOutKm: rental.mileageOut,
            odometerInKm: inspection.mileageKm,
            fuelOutEighths: rental.fuelOut,
            fuelInEighths: inspection.fuelEighths,
          },
        ],
      },
      rules,
      undefined,
      base,
    );
    if (pricing.earlyReturn) pricing.earlyReturn.actualReturnAt = inspection.returnedAt;
    const originalLines = {
      rent: pricing.finalTotalRub,
      surcharge: pricing.selectedSurchargeRub,
      fuel: pricing.fuelTotalRub,
      wash: pricing.washRub,
    };
    return { pricing, originalLines, wash };
  }

  private async settle(
    c: PoolClient,
    id: number,
    priced: ReturnType<RentalReturnService['priceLines']>,
    adjustments: Adjustment[],
    previousTotalRub?: string,
  ) {
    const { pricing, originalLines, wash } = priced;
    const lines = { ...originalLines };
    for (const row of adjustments) lines[row.line] = row.amountRub;
    const total = bounded(Object.values(lines).reduce((sum, value) => sum + BigInt(value), 0n));
    const finance = await bookingSummary(c, id);
    const received = BigInt(finance.coverageRub);
    const previousTotal = BigInt(previousTotalRub ?? finance.priceRub);
    const independentCharges = BigInt(finance.priceRub) - previousTotal;
    const outstanding = bounded(total + independentCharges) - received;
    const calculation: Settlement = {
      pricing,
      lines,
      adjustments,
      wash,
      totalRub: total.toString(),
      differenceRub: bounded(total - previousTotal).toString(),
      receivedRub: finance.coverageRub,
      debtRub: positive(outstanding).toString(),
      overpaymentRub: positive(-outstanding).toString(),
    };
    const {
      rows: [payment],
    } = await c.query<{ generation: number | null }>(
      `SELECT max(o.id) AS generation FROM financial_operations o WHERE o.booking_id=$1
       OR EXISTS (SELECT 1 FROM finance_allocations a WHERE a.booking_id=$1 AND a.operation_id=o.id)`,
      [id],
    );
    return { calculation, originalLines, payment };
  }

  review(request: AuthRequest, id: number, input: ReturnReview, commit: boolean) {
    const work = async (c: PoolClient) => {
      const rental = await this.rental(c, id, commit);
      const [latest] = await this.history(c, id, true);
      if (!latest || rental.returnedAt)
        fail(
          409,
          'RETURN_UNAVAILABLE',
          'Для подтверждения нужен сохранённый осмотр активной аренды.',
        );
      await assertInspectionIdle(c, id, rental.version, 'check_in');
      const { inspection } = latest;
      const priced = this.priceLines(id, rental, inspection, input.wash);
      const at = new Date().toISOString();
      const adjustments = input.adjustments.map((row) => ({
        ...row,
        originalRub: priced.originalLines[row.line],
        actorId: request.auth!.user.id,
        at,
      }));
      const reviewed = await this.settle(c, id, priced, adjustments);
      const token = hash(
        JSON.stringify([
          id,
          rental.termsId,
          latest.revision,
          input.wash,
          input.adjustments,
          reviewed.calculation.totalRub,
          reviewed.calculation.receivedRub,
          reviewed.payment,
        ]),
      );
      const revision = commit ? latest.revision + 1 : latest.revision;
      if (commit) {
        if (latest.revision !== input.expectedRevision || input.token !== token)
          fail(
            409,
            'RETURN_REVIEW_CHANGED',
            'Осмотр или платежи изменились. Проверьте обновлённый расчёт.',
          );
        await this.finish(c, request, id, rental, revision, inspection, reviewed.calculation);
      }
      return { ...reviewed, missingLines: [], revision, token };
    };
    if (commit)
      return this.commands.run(request, 'rentalReturn.confirm', { id, input }, work, false);
    return this.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return work(c);
    });
  }

  correct(request: AuthRequest, id: number, input: ReturnCorrection, commit: boolean) {
    const work = async (c: PoolClient) => {
      const rental = await this.rental(c, id, commit);
      const [latest] = await this.history(c, id, true);
      if (!rental.returnedAt || !latest?.calculation || input.expectedRevision !== latest.revision)
        fail(
          409,
          'RETURN_CHANGED',
          'Завершённая приёмка изменилась. Откройте актуальную редакцию.',
        );
      const { returnedAt, mileageKm, fuelEighths } = input;
      const inspection = { ...latest.inspection, returnedAt, mileageKm, fuelEighths };
      await this.checkMeasurements(c, id, rental, inspection);
      const next = await c.query(
        `SELECT 1 FROM booking_checkouts current_usage JOIN booking_checkouts later
           ON later.issued_vehicle_id=current_usage.issued_vehicle_id
           AND later.issued_at>current_usage.issued_at
         WHERE current_usage.booking_id=$1 AND later.issued_at<$2 LIMIT 1`,
        [id, returnedAt],
      );
      if (next.rowCount)
        fail(422, 'RETURN_AFTER_NEXT_ISSUE', 'Возврат позже следующей фактической выдачи.');
      const { wash, adjustments, totalRub } = latest.calculation;
      const priced = this.priceLines(id, rental, inspection, wash);
      const missingLines = adjustments
        .filter(
          ({ line, originalRub }) => originalRub !== '0' && priced.originalLines[line] === '0',
        )
        .map(({ line }) => line);
      if (input.removeLines.some((line) => !missingLines.includes(line)))
        fail(
          422,
          'RETURN_ADJUSTMENT_PRESENT',
          'Можно снять только строки, у которых исчезло основание.',
        );
      const reviewed = await this.settle(
        c,
        id,
        priced,
        adjustments.filter(({ line }) => !input.removeLines.includes(line)),
        totalRub,
      );
      const token = hash(
        JSON.stringify([
          id,
          rental.termsId,
          latest.revision,
          inspection,
          input.reason,
          input.removeLines,
          reviewed.calculation.totalRub,
          reviewed.calculation.receivedRub,
          reviewed.payment,
        ]),
      );
      const revision = commit ? latest.revision + 1 : latest.revision;
      if (commit) {
        if (token !== input.token || missingLines.some((line) => !input.removeLines.includes(line)))
          fail(
            409,
            'RETURN_REVIEW_CHANGED',
            'Проверьте разницу и подтвердите снятие строк без основания.',
          );
        await this.finish(c, request, id, rental, revision, inspection, reviewed.calculation, {
          reason: input.reason,
          previousMileageKm: latest.inspection.mileageKm,
        });
      }
      return { ...reviewed, missingLines, token, revision };
    };
    if (commit)
      return this.commands.run(request, 'rentalReturn.correct', { id, input }, work, false);
    return this.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await this.commands.authorize(c, request, false);
      return work(c);
    });
  }

  chargeDamage(request: AuthRequest, id: number, input: ReturnDamage) {
    return this.commands.run(
      request,
      'rentalReturn.damage',
      { id, input },
      async (c) => {
        const rental = await this.rental(c, id, true);
        const [latest] = await this.history(c, id, true);
        if (
          !rental.returnedAt ||
          !latest?.calculation ||
          latest.revision !== input.expectedRevision
        )
          fail(409, 'RETURN_CHANGED', 'Откройте актуальную завершённую приёмку.');
        const balance = await bookingSummary(c, id);
        bounded(BigInt(balance.priceRub) + BigInt(input.amountRub));
        const command = `rental-damage:${id}:${request.auth!.user.id}:${this.commands.key(request)}`;
        return this.recordCharge(c, request, id, rental, command, input.amountRub, input.reason, {
          revision: latest.revision,
          purpose: 'damage',
        });
      },
      false,
    );
  }

  private async finish(
    c: PoolClient,
    request: AuthRequest,
    id: number,
    rental: Rental,
    revision: number,
    inspection: Inspection,
    calculation: Settlement,
    correction?: { reason: string; previousMileageKm: number },
  ) {
    const reason = correction?.reason;
    await this.writeRevision(c, request, id, revision, inspection, calculation, reason);
    await c.query('UPDATE booking_checkouts SET returned_at=$2 WHERE booking_id=$1', [
      id,
      inspection.returnedAt,
    ]);
    if (correction && rental.returnedAt?.getTime() !== Date.parse(inspection.returnedAt))
      await rescheduleDepositReserve(c, id, rental.customerId);
    await c.query('UPDATE bookings SET status=$2,version=version+1,updated_at=now() WHERE id=$1', [
      id,
      calculation.pricing.earlyReturn ? 'completed_early' : 'completed',
    ]);
    await c.query(
      'UPDATE schedule_blocks SET retired_at=now() WHERE booking_id=$1 AND retired_at IS NULL',
      [id],
    );
    // A backdated inspection can arrive after a newer reading from the fleet card or service journal.
    const {
      rows: [catalog],
    } = await c.query<{ newerReading: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM audit_logs WHERE entity_type='vehicle' AND entity_id=$1 AND created_at>$2
          AND ((action='vehicles.serviced' AND (details->>'updateMileage'='true' OR details->>'mileageChange' IS NOT NULL))
            OR (action='vehicles.updated' AND details#>>'{before,current_mileage_km}' IS DISTINCT FROM details#>>'{after,currentMileageKm}'))
      ) AS "newerReading"`,
      [rental.vehicleId, inspection.returnedAt],
    );
    if (!correction) {
      const readiness = inspection.preparation
        .filter((item) => item !== 'wash')
        .map((item) => (item === 'maintenance' ? 'ТО' : 'Ремонт'))
        .join(', ');
      await c.query(
        `UPDATE vehicles SET current_mileage_km=CASE WHEN $5 THEN current_mileage_km ELSE $2 END,needs_wash=$4,is_ready=CASE WHEN $3='' THEN is_ready ELSE false END,
         readiness_reason=CASE WHEN $3='' THEN readiness_reason ELSE $3 END,version=version+1,updated_at=now() WHERE id=$1`,
        [
          rental.vehicleId,
          inspection.mileageKm,
          readiness,
          inspection.preparation.includes('wash'),
          catalog.newerReading,
        ],
      );
    } else if (!catalog.newerReading) {
      await c.query(
        `UPDATE vehicles SET current_mileage_km=COALESCE((
           SELECT COALESCE(("return".inspection->>'mileageKm')::int,pickup.mileage_km)
           FROM booking_checkouts x JOIN inspection_revisions pickup ON pickup.id=x.act_revision_id
           LEFT JOIN LATERAL (
             SELECT inspection FROM rental_return_revisions WHERE booking_id=x.booking_id AND calculation IS NOT NULL
             ORDER BY revision DESC LIMIT 1
           ) "return" ON true
           WHERE x.issued_vehicle_id=$1
             AND x.issued_at>(SELECT issued_at FROM booking_checkouts WHERE booking_id=$4)
           ORDER BY x.issued_at DESC LIMIT 1
         ),$2),version=version+1,updated_at=now()
         WHERE id=$1 AND current_mileage_km IS NOT DISTINCT FROM $3`,
        [rental.vehicleId, inspection.mileageKm, correction.previousMileageKm, id],
      );
    }
    await c.query(
      `UPDATE private_files SET delete_after=$2::timestamptz+interval '720 hours'
       WHERE booking_id=$1 AND category='inspection_photo' AND deleted_at IS NULL`,
      [id, inspection.returnedAt],
    );
    if (calculation.differenceRub !== '0') {
      await this.recordCharge(
        c,
        request,
        id,
        rental,
        `rental-return:${id}:${revision}`,
        calculation.differenceRub,
        reason ?? 'Итоговый расчёт приёмки',
        { revision },
      );
    }
  }

  private async recordCharge(
    c: PoolClient,
    request: AuthRequest,
    id: number,
    rental: Rental,
    command: string,
    amountRub: string,
    reason: string,
    details: Record<string, unknown>,
  ) {
    const {
      rows: [operation],
    } = await c.query<{ id: number }>(
      `INSERT INTO financial_operations(command_id,request_hash,kind,booking_id,customer_id,actor_id,reason)
         VALUES($1,$2,'charge',$3,$4,$5,$6) RETURNING id`,
      [command, hash(command), id, rental.customerId, request.auth!.user.id, reason],
    );
    await c.query(
      'INSERT INTO finance_charges(operation_id,booking_id,terms_id,amount_rub) VALUES($1,$2,$3,$4)',
      [operation.id, id, rental.termsId, amountRub],
    );
    await recordEvent(c, request, operation.id, 'charge', id, details);
    return operation;
  }
}
