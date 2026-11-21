import type { PoolClient } from 'pg';
import { DatabaseService } from '../database.service';
import { audit } from '../platform/security';
import { randomUUID } from 'node:crypto';
const id = (n: number) => 1000 + n;
export async function seedCatalog(client: PoolClient, demo = false) {
  // Explicit demo IDs must also advance each table's own identity sequence.
  await client.query(
    'LOCK TABLE pricing_groups,vehicle_brands,vehicle_models,equivalence_groups,customers,vehicles IN SHARE ROW EXCLUSIVE MODE',
  );
  const advance = async (tables: string[]) => {
    for (const table of tables)
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}','id'), greatest((SELECT coalesce(max(id),1) FROM ${table}), nextval(pg_get_serial_sequence('${table}','id'))), true)`,
      );
  };
  // Stable IDs, no UPDATE/DELETE: rerunning never overwrites edited records.
  for (const [n, name] of [
    [1, 'Легковые — тест'],
    [2, 'Микроавтобусы — тест'],
  ] as const)
    await client.query(
      'INSERT INTO pricing_groups(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id(n), name],
    );
  for (const [n, name] of [
    [10, 'Тест Лада'],
    [11, 'Тест Renault'],
    [12, 'Тест Ford'],
  ] as const)
    await client.query(
      'INSERT INTO vehicle_brands(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id(n), name],
    );
  const models = [
    [20, 10, 'Седан', 1],
    [21, 10, 'Хэтчбек', 1],
    [22, 11, 'Каблук', 1],
    [23, 12, 'Грузовой', 2],
  ] as const;
  for (const [n, brand, name, pricing] of models)
    await client.query(
      'INSERT INTO vehicle_models(id,brand_id,name,pricing_group_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [id(n), id(brand), name, id(pricing)],
    );
  await client.query(
    'INSERT INTO equivalence_groups(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [id(30), 'Тестовые легковые аналоги'],
  );
  for (const n of [20, 21])
    await client.query(
      'INSERT INTO equivalence_group_models(group_id,model_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id(30), id(n)],
    );
  await advance(['pricing_groups', 'vehicle_brands', 'vehicle_models', 'equivalence_groups']);
  if (!demo) return;
  const customers = [
    ['individual', 'ТЕСТ — Клиент с минимальной анкетой', false],
    ['company', 'ТЕСТ — Организация', false],
    ['individual', 'ТЕСТ — Заблокированный клиент', true],
  ] as const;
  for (let i = 0; i < customers.length; i++) {
    const [type, name, blocked] = customers[i];
    const entity = id(100 + i);
    const inserted = await client.query(
      'INSERT INTO customers(id,type,display_name,is_blocked,blocked_reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
      [entity, type, name, blocked, blocked ? 'Тестовая блокировка' : ''],
    );
    if (inserted.rowCount)
      await audit(client, null, 'customer', 'customers.created', entity, randomUUID(), {
        synthetic: true,
      });
  }
  for (let i = 0; i < 4; i++) {
    const entity = id(200 + i),
      body = ['sedan', 'hatchback', 'compact_van', 'cargo_minibus'][i];
    const inserted = await client.query(
      'INSERT INTO vehicles(id,model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km,is_ready,readiness_reason,needs_wash,issue_notes) VALUES ($1,$2,$3,2024,$4,$5,50000,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id',
      [
        entity,
        id(20 + i),
        'A00' + i + 'AA198',
        body,
        48000 + i * 900,
        i !== 2,
        i === 2 ? 'Тестовая проверка тормозов' : '',
        i === 1,
        i === 2 ? 'Тестовая пометка' : '',
      ],
    );
    if (inserted.rowCount)
      await audit(client, null, 'vehicle', 'vehicles.created', entity, randomUUID(), {
        synthetic: true,
      });
  }
  await advance(['customers', 'vehicles']);
}
if (require.main === module) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Test seed is disabled in production.');
  const db = new DatabaseService();
  db.transaction((c) => seedCatalog(c, process.argv.includes('--demo')))
    .then(() =>
      console.log(
        'Тестовые справочники' +
          (process.argv.includes('--demo') ? ' и синтетические карточки' : '') +
          ' подготовлены.',
      ),
    )
    .catch(() => {
      console.error('Не удалось заполнить тестовые данные.');
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}
