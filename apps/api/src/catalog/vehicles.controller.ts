import { checkoutAvailable } from '../documents/checkout-state';
import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthRequest, parse, idSchema, fail } from '../platform/security';
import { CatalogService } from './catalog.service';
import {
  listQuery,
  normalizePlate,
  reasonInput,
  serviceEditInput,
  serviceInput,
  vehicleInput,
  vehicleUpdate,
} from './catalog.dto';
const fields =
  'v.id,v.model_id AS "modelId",v.plate,v.vin,v.year,v.transmission,v.has_casco AS "hasCasco",v.body_type AS "bodyType",v.current_mileage_km AS "currentMileageKm",v.next_maintenance_due_km AS "nextMaintenanceDueKm",v.is_ready AS "isReady",v.readiness_reason AS "readinessReason",v.needs_wash AS "needsWash",v.issue_notes AS "issueNotes",v.archived_at AS "archivedAt",v.version';
const join =
  ' FROM vehicles v JOIN vehicle_models m ON m.id=v.model_id JOIN vehicle_brands b ON b.id=m.brand_id JOIN pricing_groups p ON p.id=m.pricing_group_id';
const named =
  fields +
  ',m.name AS "modelName",b.name AS "brandName",p.id AS "pricingGroupId",p.name AS "pricingGroupName",concat_ws(E\'\\n\',nullif(v.readiness_reason,\'\'),nullif(v.issue_notes,\'\')) AS note,CASE WHEN v.body_type=\'cargo_minibus\' THEN 80 ELSE 40 END AS "tankLiters"';
const activeBookingIds = `ARRAY(
  SELECT b.id FROM schedule_blocks s JOIN bookings b ON b.id=s.booking_id
  WHERE s.vehicle_id=v.id AND s.kind='assignment' AND s.retired_at IS NULL
    AND s.end_at>now() AND b.status='confirmed'
  ORDER BY s.start_at,b.id
)`;
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly service: CatalogService) {}
  private async assertNoActiveBookings(client: PoolClient, vehicleId: number) {
    if (await checkoutAvailable(client)) {
      const issued = await client.query(
        'SELECT booking_id FROM booking_checkouts WHERE issued_vehicle_id=$1',
        [vehicleId],
      );
      if (issued.rowCount) fail(409, 'VEHICLE_ALREADY_ISSUED', 'Автомобиль выдан клиенту.');
    }
    const { rows } = await client.query<{ bookingIds: number[] }>(
      'SELECT ' + activeBookingIds + ' AS "bookingIds" FROM vehicles v WHERE v.id=$1',
      [vehicleId],
    );
    const { bookingIds } = rows[0];
    if (bookingIds.length)
      fail(
        409,
        'VEHICLE_HAS_ACTIVE_BOOKINGS',
        'На автомобиль есть брони. Сначала замените автомобиль в этих бронях.',
        {
          bookingIds,
        },
      );
  }
  @Get() async list(@Query() raw: unknown) {
    const q = parse(listQuery, raw);
    const where =
      " WHERE ($1='' OR strpos(lower(b.name||' '||m.name||' '||v.plate||' '||coalesce(v.vin,'')),lower($1))>0 OR strpos(v.plate,$5)>0) AND ($2='' OR v.body_type=$2) AND (v.archived_at IS NOT NULL)=$3 AND ($4='' OR ($4='ready' AND v.is_ready) OR ($4='not_ready' AND NOT v.is_ready) OR ($4='wash' AND v.needs_wash) OR ($4='issue' AND (v.issue_notes<>'' OR v.readiness_reason<>'')) OR ($4='maintenance' AND v.next_maintenance_due_km-v.current_mileage_km<=1000))";
    const args = [q.q, q.bodyType, q.archived === 'true', q.state, normalizePlate(q.q)];
    const sort = {
      name: 'lower(b.name||m.name)',
      mileage: 'v.current_mileage_km',
      maintenance: 'v.next_maintenance_due_km-v.current_mileage_km',
    }[q.sort];
    return this.service.db.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const count = await client.query('SELECT count(*)::int AS total' + join + where, args);
      const items = await client.query(
        'SELECT ' +
          named +
          join +
          where +
          ` ORDER BY ${sort} ${q.order === 'desc' ? 'DESC' : 'ASC'},v.id LIMIT 20 OFFSET $6`,
        [...args, (q.page - 1) * 20],
      );
      return { items: items.rows, total: count.rows[0].total };
    });
  }
  @Get(':id') async get(@Param('id') raw: string) {
    const { rows } = await this.service.db.pool.query(
      'SELECT ' +
        named +
        ', ' +
        activeBookingIds +
        ' AS "activeBookingIds"' +
        join +
        ' WHERE v.id=$1',
      [parse(idSchema, raw)],
    );
    if (!rows[0]) fail(404, 'NOT_FOUND', 'Автомобиль не найден.');
    return rows[0];
  }
  @Get(':id/history') history(@Param('id') raw: string, @Query() query: unknown) {
    return this.service.history('vehicles', parse(idSchema, raw), parse(listQuery, query).page);
  }
  @Post() create(@Body() raw: unknown, @Req() r: AuthRequest) {
    const d = parse(vehicleInput, raw);
    return this.service.commands.run(
      r,
      'vehicles.create',
      d,
      async (client) => {
        const modelId = await this.service.resolveVehicleModel(client, d);
        const { rows } = await client.query(
          'INSERT INTO vehicles(model_id,plate,vin,year,body_type,current_mileage_km,next_maintenance_due_km,is_ready,readiness_reason,needs_wash,issue_notes,transmission,has_casco) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id,version',
          [
            modelId,
            d.plate,
            d.vin || null,
            d.year,
            d.bodyType,
            d.currentMileageKm,
            d.nextMaintenanceDueKm,
            d.isReady,
            d.isReady ? '' : d.note || d.readinessReason || d.issueNotes,
            d.needsWash,
            d.isReady ? d.note || d.issueNotes : '',
            d.transmission,
            d.hasCasco ?? null,
          ],
        );
        if (!rows[0])
          fail(
            409,
            'VEHICLE_DUPLICATE',
            'Госномер или VIN уже используется, в том числе в архиве.',
          );
        await this.service.event(client, r, 'vehicle', 'vehicles.created', rows[0].id, 1, {
          data: d,
        });
        return rows[0];
      },
      false,
    );
  }
  @Patch(':id') update(@Param('id') rawId: string, @Body() raw: unknown, @Req() r: AuthRequest) {
    const id = parse(idSchema, rawId),
      input = parse(vehicleUpdate, raw),
      d = input.data;
    return this.service.commands.run(
      r,
      'vehicles.update',
      { id, ...input },
      async (client) => {
        const old = await this.service.lock(client, 'vehicles', id, input.expectedVersion);
        d.transmission ??= old.transmission;
        const modelId = await this.service.resolveVehicleModel(client, d);
        if (modelId !== old.model_id) await this.assertNoActiveBookings(client, id);
        if (
          (old.current_mileage_km !== d.currentMileageKm ||
            old.next_maintenance_due_km !== d.nextMaintenanceDueKm) &&
          !input.reason
        )
          fail(
            422,
            'CHANGE_COMMENT_REQUIRED',
            'Укажите комментарий к изменению пробега или порога ТО.',
          );
        let rows;
        try {
          ({ rows } = await client.query(
            'UPDATE vehicles SET model_id=$2,plate=$3,vin=$4,year=$5,body_type=$6,current_mileage_km=$7,next_maintenance_due_km=$8,is_ready=$9,readiness_reason=$10,needs_wash=$11,issue_notes=$12,transmission=$13,has_casco=$14,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,version',
            [
              id,
              modelId,
              d.plate,
              d.vin || null,
              d.year,
              d.bodyType,
              d.currentMileageKm,
              d.nextMaintenanceDueKm,
              d.isReady,
              d.isReady ? '' : d.note || d.readinessReason || d.issueNotes,
              d.needsWash,
              d.isReady ? d.note || d.issueNotes : '',
              d.transmission ?? old.transmission,
              d.hasCasco === undefined ? old.has_casco : d.hasCasco,
            ],
          ));
        } catch (e) {
          if ((e as { code: string }).code === '23505')
            fail(
              409,
              'VEHICLE_DUPLICATE',
              'Госномер или VIN уже используется, в том числе в архиве.',
            );
          throw e;
        }
        await this.service.event(client, r, 'vehicle', 'vehicles.updated', id, rows[0].version, {
          reason: input.reason,
          before: old,
          after: {
            ...d,
            modelId,
            readinessReason: d.isReady ? '' : d.note || d.readinessReason || d.issueNotes,
            issueNotes: d.isReady ? d.note || d.issueNotes : '',
          },
        });
        return rows[0];
      },
      false,
    );
  }
  @Post(':id/archive') archive(
    @Param('id') rawId: string,
    @Body() raw: unknown,
    @Req() r: AuthRequest,
  ) {
    const id = parse(idSchema, rawId),
      input = parse(reasonInput, raw);
    return this.service.commands.run(
      r,
      'vehicles.archive',
      { id, ...input },
      async (client) => {
        await this.service.lock(client, 'vehicles', id, input.expectedVersion);
        await this.assertNoActiveBookings(client, id);
        await client.query(
          'UPDATE vehicles SET archived_at=now(),version=version+1,updated_at=now() WHERE id=$1',
          [id],
        );
        await this.service.event(
          client,
          r,
          'vehicle',
          'vehicles.archived',
          id,
          input.expectedVersion + 1,
          { reason: input.reason },
        );
        return { id, version: input.expectedVersion + 1 };
      },
      false,
    );
  }
  @Get(':id/service-records') async services(@Param('id') raw: string, @Query() query: unknown) {
    const id = parse(idSchema, raw),
      q = parse(listQuery, query);
    await this.get(String(id));
    return {
      total: (
        await this.service.db.pool.query(
          'SELECT count(*)::int AS total FROM vehicle_service_records WHERE vehicle_id=$1',
          [id],
        )
      ).rows[0].total,
      items: (
        await this.service.db.pool.query(
          'SELECT s.id,s.performed_on AS "performedOn",s.procedure,s.mileage_km AS "mileageKm",s.note,s.created_at AS "createdAt",u.full_name AS author FROM vehicle_service_records s JOIN users u ON u.id=s.created_by WHERE vehicle_id=$1 ORDER BY performed_on DESC,s.created_at DESC,s.id LIMIT 20 OFFSET $2',
          [id, (q.page - 1) * 20],
        )
      ).rows,
    };
  }
  @Post(':id/service-records') addService(
    @Param('id') raw: string,
    @Body() body: unknown,
    @Req() r: AuthRequest,
  ) {
    const id = parse(idSchema, raw),
      d = parse(serviceInput, body);
    return this.service.commands.run(
      r,
      'vehicles.service',
      { id, ...d },
      async (client) => {
        const old = await this.service.lock(client, 'vehicles', id, d.expectedVersion);
        const { rows } = await client.query(
          'INSERT INTO vehicle_service_records(vehicle_id,performed_on,procedure,mileage_km,note,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [id, d.performedOn, d.procedure, d.mileageKm, d.note, r.auth!.user.id],
        );
        await client.query(
          'UPDATE vehicles SET current_mileage_km=$2,next_maintenance_due_km=$3,version=version+1,updated_at=now() WHERE id=$1',
          [
            id,
            d.updateMileage ? d.mileageKm : old.current_mileage_km,
            d.nextMaintenanceDueKm ?? old.next_maintenance_due_km,
          ],
        );
        await this.service.event(client, r, 'vehicle', 'vehicles.serviced', id, old.version + 1, {
          recordId: rows[0].id,
          procedure: d.procedure,
          performedOn: d.performedOn,
          mileageKm: d.mileageKm,
          note: d.note,
          mileageChange:
            d.updateMileage && old.current_mileage_km !== d.mileageKm
              ? { before: old.current_mileage_km, after: d.mileageKm }
              : null,
          maintenanceChange:
            d.nextMaintenanceDueKm !== undefined &&
            old.next_maintenance_due_km !== d.nextMaintenanceDueKm
              ? { before: old.next_maintenance_due_km, after: d.nextMaintenanceDueKm }
              : null,
        });
        return rows[0];
      },
      false,
    );
  }
  @Patch(':id/service-records/:recordId') editService(
    @Param('id') raw: string,
    @Param('recordId') rawRecord: string,
    @Body() body: unknown,
    @Req() r: AuthRequest,
  ) {
    const id = parse(idSchema, raw),
      recordId = parse(idSchema, rawRecord),
      d = parse(serviceEditInput, body);
    return this.service.commands.run(
      r,
      'vehicles.service.update',
      { id, recordId, ...d },
      async (client) => {
        const vehicle = await this.service.lock(client, 'vehicles', id, d.expectedVersion);
        const old = (
          await client.query(
            'SELECT * FROM vehicle_service_records WHERE id=$1 AND vehicle_id=$2 FOR UPDATE',
            [recordId, id],
          )
        ).rows[0];
        if (!old) fail(404, 'SERVICE_NOT_FOUND', 'Запись обслуживания не найдена.');
        await client.query(
          'UPDATE vehicle_service_records SET performed_on=$3,procedure=$4,mileage_km=$5,note=$6 WHERE id=$1 AND vehicle_id=$2',
          [recordId, id, d.performedOn, d.procedure, d.mileageKm, d.note],
        );
        await client.query('UPDATE vehicles SET version=version+1,updated_at=now() WHERE id=$1', [
          id,
        ]);
        await this.service.event(
          client,
          r,
          'vehicle',
          'vehicles.service_updated',
          id,
          vehicle.version + 1,
          {
            recordId,
            before: {
              performedOn: old.performed_on,
              procedure: old.procedure,
              mileageKm: old.mileage_km,
              note: old.note,
            },
            after: {
              performedOn: d.performedOn,
              procedure: d.procedure,
              mileageKm: d.mileageKm,
              note: d.note,
            },
          },
        );
        return { id: recordId };
      },
      false,
    );
  }
}
@Controller()
export class ReferenceController {
  constructor(private readonly service: CatalogService) {}
  @Get('vehicle-brands') async brands() {
    return {
      items: (await this.service.db.pool.query('SELECT * FROM vehicle_brands ORDER BY name')).rows,
    };
  }
  @Get('pricing-groups') async pricing() {
    return {
      items: (await this.service.db.pool.query('SELECT * FROM pricing_groups ORDER BY name')).rows,
    };
  }
  @Get('vehicle-models') async models() {
    return {
      items: (
        await this.service.db.pool.query(
          'SELECT m.id,m.name,m.brand_id AS "brandId",b.name AS "brandName",m.pricing_group_id AS "pricingGroupId",p.name AS "pricingGroupName" FROM vehicle_models m JOIN vehicle_brands b ON b.id=m.brand_id JOIN pricing_groups p ON p.id=m.pricing_group_id ORDER BY b.name,m.name',
        )
      ).rows,
    };
  }
  @Get('equivalence-groups') async groups() {
    return {
      items: (
        await this.service.db.pool.query(
          'SELECT g.id,g.name,coalesce(json_agg(e.model_id) FILTER (WHERE e.model_id IS NOT NULL),\'[]\') AS "modelIds" FROM equivalence_groups g LEFT JOIN equivalence_group_models e ON e.group_id=g.id GROUP BY g.id ORDER BY g.name',
        )
      ).rows,
    };
  }
}
