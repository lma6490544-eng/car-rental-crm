import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database.service';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, audit, fail } from '../platform/security';
import type { vehicleInput } from './catalog.dto';

@Injectable()
export class CatalogService {
  constructor(
    readonly db: DatabaseService,
    readonly commands: CommandsService,
  ) {}
  async lock(client: PoolClient, table: 'customers' | 'vehicles', id: number, expected: number) {
    const { rows } = await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    if (!rows[0]) fail(404, 'NOT_FOUND', 'Запись не найдена.');
    if (rows[0].version !== expected)
      fail(
        409,
        'VERSION_CONFLICT',
        'Запись изменена другим сотрудником. Сравните изменения перед сохранением.',
        { currentVersion: rows[0].version },
      );
    if (rows[0].archived_at) fail(422, 'ARCHIVED', 'Автомобиль находится в архиве.');
    return rows[0];
  }
  async event(
    client: PoolClient,
    request: AuthRequest,
    entityType: 'customer' | 'vehicle',
    action: string,
    id: number,
    version: number,
    details: Record<string, unknown>,
  ) {
    await audit(client, request.auth!.user.id, entityType, action, id, request.requestId, details);
    await client.query('INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,$2,$3)', [
      action + ':' + id + ':' + version,
      action,
      JSON.stringify({ id, version }),
    ]);
  }
  async history(table: 'customers' | 'vehicles', id: number, page = 1) {
    if (!(await this.db.pool.query(`SELECT id FROM ${table} WHERE id=$1`, [id])).rowCount)
      fail(404, 'NOT_FOUND', 'Запись не найдена.');
    const entityType = table === 'customers' ? 'customer' : 'vehicle';
    return {
      total: (
        await this.db.pool.query(
          'SELECT count(*)::int AS total FROM audit_logs WHERE entity_type=$1 AND entity_id=$2',
          [entityType, id],
        )
      ).rows[0].total,
      items: (
        await this.db.pool.query(
          'SELECT a.id,a.action,a.details,a.created_at AS "createdAt",u.full_name AS author FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.entity_type=$1 AND a.entity_id=$2 ORDER BY a.created_at DESC,a.id DESC LIMIT 50 OFFSET $3',
          [entityType, id, (page - 1) * 50],
        )
      ).rows,
    };
  }
  async resolveVehicleModel(client: PoolClient, d: ReturnType<typeof vehicleInput.parse>) {
    if (d.modelId) {
      if (!(await client.query('SELECT id FROM vehicle_models WHERE id=$1', [d.modelId])).rowCount)
        fail(422, 'MODEL_NOT_FOUND', 'Модель не найдена.');
      return d.modelId;
    }
    const brand = d.brandName.trim().replace(/\s+/g, ' '),
      name = d.modelName.trim().replace(/\s+/g, ' ');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'brand:' + brand.toLowerCase(),
    ]);
    let b = (
      await client.query('SELECT id FROM vehicle_brands WHERE lower(trim(name))=lower($1)', [brand])
    ).rows[0];
    if (!b)
      b = (await client.query('INSERT INTO vehicle_brands(name) VALUES ($1) RETURNING id', [brand]))
        .rows[0];
    const existing = (
      await client.query(
        'SELECT id,pricing_group_id FROM vehicle_models WHERE brand_id=$1 AND lower(trim(name))=lower($2)',
        [b.id, name],
      )
    ).rows[0];
    if (existing) return existing.id;
    if (
      !d.pricingGroupId ||
      !(await client.query('SELECT id FROM pricing_groups WHERE id=$1', [d.pricingGroupId]))
        .rowCount
    )
      fail(422, 'PRICING_GROUP_REQUIRED', 'Выберите тарифную группу новой модели.');
    return (
      await client.query(
        'INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,$2,$3) RETURNING id',
        [b.id, name, d.pricingGroupId],
      )
    ).rows[0].id;
  }
}
