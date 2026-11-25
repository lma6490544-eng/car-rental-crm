const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const { DatabaseService } = require('../dist/database.service');
const { CommandsService } = require('../dist/platform/commands.service');
const { RentalReturnService } = require('../dist/documents/rental-return.service');
const { returnInspection } = require('../dist/documents/rental-return.dto');
const { CatalogService } = require('../dist/catalog/catalog.service');
const { VehiclesController } = require('../dist/catalog/vehicles.controller');
const { OperationsController } = require('../dist/identity/operations.controller');
const { InspectionsService } = require('../dist/documents/inspections.service');
const { FinanceService } = require('../dist/finance/finance.service');
const { CalendarService } = require('../dist/scheduling/calendar.service');
const { SchedulingService } = require('../dist/scheduling/scheduling.service');
const { calculate } = require('../dist/pricing/calculate');
const { ruleSets } = require('../dist/pricing/rules');

const hour = 3600000;
const day = 24 * hour;
const iso = (ms) => new Date(ms).toISOString();
const code = (status, expected) => (error) =>
  error.getStatus() === status && error.getResponse().code === expected;

test('Stage 7.1 return, settlement, reassignment and correction on temporary PostgreSQL', async (t) => {
  const database = 'crm_stage71_test_' + randomBytes(8).toString('hex');
  assert.match(database, /^crm_stage71_test_[a-f0-9]{16}$/);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString() });
  let db;
  t.after(async () => {
    if (db) await db.pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = '/' + database;
  process.env.DATABASE_URL = url.toString();
  db = new DatabaseService();
  await migrate(drizzle(db.pool), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  const commands = new CommandsService(db);
  const service = new RentalReturnService(db, commands);
  const fleet = new VehiclesController(new CatalogService(db, commands));
  const operations = new OperationsController(db, commands);
  const lookup = (operator, command, key) => operations.lookup({ command, key }, operator());
  const inspections = new InspectionsService(commands);
  const finance = new FinanceService(db, commands);
  const calendar = new CalendarService(db, new SchedulingService(db));
  const query = (sql, params) => db.pool.query(sql, params);
  const row = async (sql, params) => (await query(sql, params)).rows[0];
  async function operator(login) {
    const user = await row(
      "INSERT INTO users(full_name,login,password_hash,role) VALUES($1,$1,'unused','manager') RETURNING id",
      [login],
    );
    const tokenHash = randomUUID();
    await query(
      "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [user.id, tokenHash],
    );
    return (key = randomUUID()) => ({
      auth: { user, tokenHash },
      requestId: randomUUID(),
      headers: { 'idempotency-key': key },
    });
  }
  const first = await operator('return-first');
  const second = await operator('return-second');
  const actor = first().auth.user.id;
  const customer = await row(
    "INSERT INTO customers(type,display_name,details) VALUES('individual','Тест','{}') RETURNING id",
  );
  const tariff = await row("SELECT id FROM pricing_groups WHERE tariff_code='economy'");
  const brand = await row("INSERT INTO vehicle_brands(name) VALUES('Приёмка') RETURNING id");
  const model = await row(
    "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES($1,'Модель',$2) RETURNING id",
    [brand.id, tariff.id],
  );
  async function vehicle(plate) {
    return (
      await row(
        "INSERT INTO vehicles(model_id,plate,year,body_type,next_maintenance_due_km) VALUES($1,$2,2022,'sedan',1220) RETURNING id",
        [model.id, plate],
      )
    ).id;
  }
  const now = Date.now();
  const rules = ruleSets.at(-1);
  async function booking(vehicleId, start, days, issued) {
    const startAt = iso(start);
    const endAt = iso(start + days * day);
    const terms = calculate(
      {
        operationKind: 'initial',
        startAt,
        contractDays: days,
        dailyMileagePackageKm: 100,
        pricingGroupId: tariff.id,
        overrides: { customDailyRateRub: '1200', reason: 'Тестовая ставка' },
        wash: false,
        clearOverrides: false,
      },
      rules,
      { id: tariff.id, name: 'Эконом', code: 'economy' },
      undefined,
      actor,
    );
    const { id } = await row(
      `INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_vehicle_id,created_by)
       VALUES($1,$2,$3,'vehicle',$4,$5) RETURNING id`,
      [customer.id, startAt, endAt, vehicleId, actor],
    );
    await query('INSERT INTO booking_eligible_models VALUES($1,$2)', [id, model.id]);
    await query(
      "INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by) VALUES($1,$2,'assignment',$3,$4,'Тест',$5)",
      [vehicleId, id, startAt, endAt, actor],
    );
    const quote = await row(
      "INSERT INTO pricing_quotes(created_by,expires_at,input,snapshot) VALUES($1,now()+interval '1 hour','{}',$2) RETURNING id",
      [actor, terms],
    );
    const termsRow = await row(
      "INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) VALUES($1,1,$2,$3,'',$4) RETURNING id",
      [id, quote.id, terms, actor],
    );
    if (!issued) return id;
    const inspection = await row(
      `INSERT INTO inspection_revisions(booking_id,vehicle_id,kind,revision,vehicle_snapshot,mileage_km,fuel_eighths,no_damage,damage_notes,special_notes,no_photos_acknowledged,created_by)
       VALUES($1,$2,'pickup',1,'{"bodyType":"sedan"}',1000,8,true,'','',true,$3) RETURNING id`,
      [id, vehicleId, actor],
    );
    const contract = await row(
      "INSERT INTO contract_versions(booking_id,terms_id,revision,template_version,snapshot,created_by) VALUES($1,$2,1,'test',$3,$4) RETURNING id",
      [id, termsRow.id, { terms }, actor],
    );
    await query(
      `INSERT INTO booking_checkouts(booking_id,started_by,issued_by,issued_at,issued_vehicle_id,issued_contract_id,act_revision_id,act_signed_by,act_signed_at)
       VALUES($1,$2,$2,$3::timestamptz + interval '456 microseconds',$4,$5,$6,$2,$3)`,
      [id, actor, startAt, vehicleId, contract.id, inspection.id],
    );
    return id;
  }
  const lateVehicle = await vehicle('Х111ХХ178');
  const normalStart = now - day - 3 * hour;
  const normal = await booking(lateVehicle, normalStart, 1, true);
  const next = await booking(lateVehicle, normalStart + day, 1, false);
  const { generateVAPIDKeys } = require('web-push');
  const keys = generateVAPIDKeys();
  const vapid = { ...keys, subject: 'mailto:operator@example.test' };
  process.env.PUSH_VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.PUSH_VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.PUSH_VAPID_SUBJECT = vapid.subject;
  const { PushController } = require('../dist/push/push.controller');
  const subscriptions = new PushController(db, commands);
  for (const employee of [first, second]) {
    const device = {
      endpoint: 'https://fcm.googleapis.com/test/' + employee().auth.user.id,
      keys: { auth: randomBytes(16).toString('base64url'), p256dh: generateVAPIDKeys().publicKey },
    };
    await subscriptions.subscribe(employee(), device);
    await subscriptions.subscribe(employee(), device);
    assert.deepEqual(await subscriptions.status(employee(), device), { subscribed: true });
  }
  const checkout = new (require('../dist/documents/checkout.service').CheckoutService)(commands);
  const preparing = await booking(await vehicle('А111АА777'), now + 10 * day, 1, false);
  await Promise.all([
    checkout.start(first(), preparing, 1),
    checkout.start(second(), preparing, 1),
  ]);
  await Promise.all([service.start(first(), normal), service.start(second(), normal)]);
  for (const [bookingId, event] of [
    [preparing, 'checkout.started'],
    [normal, 'rentalReturn.started'],
  ]) {
    const logs = await query('SELECT actor_id FROM audit_logs WHERE entity_id=$1 AND action=$2', [
      bookingId,
      event,
    ]);
    assert.equal(logs.rowCount, 1);
    const jobs = await query(
      "SELECT payload FROM outbox_jobs WHERE kind='rental.push' AND payload->>'event'=$1 AND (payload->>'bookingId')::int=$2",
      [event, bookingId],
    );
    assert.deepEqual(
      jobs.rows.map((j) => j.payload.userId).sort(),
      [actor, second().auth.user.id].sort(),
    );
    if (event === 'rentalReturn.started') {
      const saved = await row(
        'SELECT return_started_by,return_started_at FROM booking_checkouts WHERE booking_id=$1',
        [bookingId],
      );
      assert.equal(saved.return_started_by, logs.rows[0].actor_id);
      assert.ok(saved.return_started_at);
    }
  }
  const window = { from: iso(now - 3 * day), to: iso(now + 3 * day) };
  assert.equal(
    (await calendar.get(window)).events.find((event) => event.booking_id === normal)
      .returnInProgress,
    true,
  );
  await t.test('two delivery workers submit each encrypted notification once', async (t) => {
    const { EventEmitter } = require('node:events');
    const requests = [];
    t.mock.method(require('node:https'), 'request', (options, respond) => {
      const request = new EventEmitter();
      request.write = (body) => {
        assert.ok(Buffer.isBuffer(body));
      };
      request.end = () => {
        requests.push(options);
        const response = new EventEmitter();
        response.statusCode = 201;
        respond(response);
        response.emit('end');
      };
      return request;
    });
    const { PushWorker } = require('../dist/push/push.worker');
    await Promise.all([new PushWorker(db).drain(vapid), new PushWorker(db).drain(vapid)]);
    await new PushWorker(db).drain(vapid);
    assert.equal(requests.length, 4);
    assert.ok(
      requests.every(
        (r) =>
          r.hostname === 'fcm.googleapis.com' && r.method === 'POST' && r.headers.Authorization,
      ),
    );
    assert.equal(
      (await query("SELECT id FROM outbox_jobs WHERE kind='rental.push' AND status='done'"))
        .rowCount,
      4,
    );
  });
  const inspect = {
    returnedAt: iso(normalStart + day + 2 * hour),
    backdateReason: 'Оператор внёс время из акта',
    mileageKm: 1250,
    fuelEighths: 7,
    remarks: 'Царапина',
    damage: true,
    photoException: true,
    photoIds: [],
    preparation: ['wash', 'maintenance'],
    expectedRevision: 0,
  };
  const pay = (id, amount, expectedVersion = 1) =>
    finance.post(
      {
        kind: 'rent_payment',
        customerId: customer.id,
        bookingId: id,
        expectedVersion,
        amountRub: amount,
        method: 'bank',
        reason: 'Тестовое поступление',
      },
      first(),
    );
  await assert.rejects(
    service.save(second(), normal, { ...inspect, mileageKm: 999 }),
    code(422, 'RETURN_MILEAGE'),
  );
  await assert.rejects(
    service.save(second(), normal, { ...inspect, backdateReason: undefined }),
    code(422, 'RETURN_REASON_REQUIRED'),
  );
  await assert.rejects(
    service.save(second(), normal, { ...inspect, photoException: false }),
    code(422, 'RETURN_DAMAGE_DETAILS'),
  );
  const legacyCheckIn = { expectedBookingVersion: 1, expectedRevision: 0, photoIds: [] };
  await assert.rejects(
    inspections.save(first(), normal, 'check_in', legacyCheckIn),
    code(422, 'RETURN_INSPECTION_REQUIRED'),
  );
  const readyPhotos = Array.from({ length: 101 }, () => randomUUID());
  const pendingPhoto = randomUUID();
  await query(
    `INSERT INTO private_files(id,booking_id,vehicle_id,category,inspection_kind,mime,size,checksum,status,created_by)
     SELECT photo_id,$1,$2,'inspection_photo',kind,'image/png',1,repeat('0',64),status,$3
     FROM unnest($4::uuid[],$5::text[],$6::text[]) AS files(photo_id,kind,status)`,
    [
      normal,
      lateVehicle,
      actor,
      [...readyPhotos, pendingPhoto, randomUUID(), randomUUID()],
      [...readyPhotos.map(() => 'check_in'), 'check_in', 'check_in', 'pickup'],
      [...readyPhotos.map(() => 'ready'), 'pending', 'failed', 'ready'],
    ],
  );
  assert.ok(returnInspection.safeParse({ ...inspect, photoIds: readyPhotos }).success);
  await assert.rejects(
    service.save(second(), normal, { ...inspect, photoException: false }),
    code(422, 'RETURN_PHOTOS_PENDING'),
  );
  await assert.rejects(
    service.save(second(), normal, { ...inspect, excludedPhotoIds: [pendingPhoto] }),
    code(422, 'RETURN_PHOTO_UNAVAILABLE'),
  );
  const [excludedPhoto, ...keptPhotos] = readyPhotos;
  const inspectWithoutPhoto = { ...inspect, excludedPhotoIds: [excludedPhoto] };
  const overlap = await Promise.allSettled([
    service.save(second(), normal, inspectWithoutPhoto),
    service.save(first(), normal, inspectWithoutPhoto),
  ]);
  assert.equal(overlap.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.ok(
    code(409, 'RETURN_CHANGED')(overlap.find(({ status }) => status === 'rejected').reason),
  );
  const formerVehicle = await vehicle('Х999ХХ178');
  const formerVehiclePhoto = randomUUID();
  await query(
    `INSERT INTO private_files(id,booking_id,vehicle_id,category,inspection_kind,mime,size,checksum,status,created_by)
     VALUES($1,$2,$3,'inspection_photo','check_in','image/png',1,repeat('0',64),'ready',$4)`,
    [formerVehiclePhoto, normal, formerVehicle, actor],
  );
  const savedReturn = await service.get(normal);
  assert.deepEqual(new Set(savedReturn.history[0].inspection.photoIds), new Set(keptPhotos));
  assert.ok(!savedReturn.photos.some(({ id }) => id === excludedPhoto));
  assert.ok(!savedReturn.photos.some(({ id }) => id === formerVehiclePhoto));
  assert.equal(savedReturn.rental.returnedAt, null);
  assert.match(
    (await calendar.get(window)).problems.find(({ id }) => id === next).problemReasons.join(),
    /ещё не принят/,
  );
  const review = {
    expectedRevision: 1,
    wash: false,
    adjustments: [{ line: 'fuel', amountRub: '450', reason: 'Согласованная доплата' }],
  };
  const tariffCalls = t.mock.method(require('../dist/pricing/calculate'), 'calculate');
  const balanceCalls = t.mock.method(require('../dist/finance/ledger'), 'bookingSummary');
  const old = await service.review(first(), normal, review, false);
  assert.equal(tariffCalls.mock.callCount(), 1);
  assert.equal(balanceCalls.mock.callCount(), 1);
  assert.equal(old.calculation.pricing.lateCandidateRub, '600');
  assert.equal(old.calculation.pricing.mileageCandidateRub, '1050');
  assert.deepEqual(old.calculation.lines, {
    rent: '1200',
    surcharge: '1050',
    fuel: '450',
    wash: '0',
  });
  await pay(normal, '1500');
  await assert.rejects(
    service.review(first(), normal, { ...review, token: old.token }, true),
    code(409, 'RETURN_REVIEW_CHANGED'),
  );
  const fresh = await service.review(first(), normal, review, false);
  assert.equal(fresh.calculation.debtRub, '1200');
  const work = await inspections.start(first(), normal, 'check_in', 1);
  assert.deepEqual((await service.get(normal)).inspectionWork, {
    id: work.id,
    kind: 'check_in',
    operatorId: actor,
    operatorName: 'return-first',
  });
  await assert.rejects(
    service.review(second(), normal, review, false),
    code(409, 'INSPECTION_IN_PROGRESS'),
  );
  await assert.rejects(
    service.review(first(), normal, { ...review, token: fresh.token }, true),
    code(409, 'INSPECTION_IN_PROGRESS'),
  );
  await assert.rejects(
    service.save(second(), normal, { ...inspect, expectedRevision: 1, workId: work.id }),
    code(409, 'INSPECTION_IN_PROGRESS'),
  );
  await assert.rejects(
    inspections.save(first(), normal, 'check_in', { ...legacyCheckIn, workId: work.id }),
    code(422, 'RETURN_INSPECTION_REQUIRED'),
  );
  const transferred = await inspections.start(second(), normal, 'check_in', 1, work.id);
  await assert.rejects(
    service.save(first(), normal, { ...inspect, expectedRevision: 1, workId: work.id }),
    code(409, 'INSPECTION_IN_PROGRESS'),
  );
  await inspections.cancel(second(), normal, 'check_in', 1, transferred.id);
  assert.equal((await service.get(normal)).inspectionWork, null);
  const confirmKey = randomUUID();
  const confirmation = { ...review, token: fresh.token };
  const result = await service.review(first(confirmKey), normal, confirmation, true);
  const retry = await service.review(first(confirmKey), normal, confirmation, true);
  assert.equal(
    (await calendar.get(window)).events.find((event) => event.booking_id === normal)
      .returnInProgress,
    undefined,
  );
  assert.equal(fresh.revision, 1);
  assert.equal(result.revision, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), retry);
  assert.deepEqual(await lookup(first, 'rentalReturn.confirm', confirmKey), {
    status: 'completed',
    result: retry,
  });
  await assert.rejects(
    lookup(second, 'rentalReturn.confirm', confirmKey),
    code(404, 'OPERATION_NOT_FOUND'),
  );
  assert.equal(
    (await row('SELECT count(*)::int AS count FROM finance_charges WHERE booking_id=$1', [normal]))
      .count,
    1,
  );
  const currentVehicle = await row(
    'SELECT current_mileage_km,is_ready,needs_wash FROM vehicles WHERE id=$1',
    [lateVehicle],
  );
  assert.deepEqual(currentVehicle, { current_mileage_km: 1250, is_ready: false, needs_wash: true });
  assert.match(
    (await calendar.get(window)).problems.find(({ id }) => id === next).problemReasons.join(),
    /не готов/,
  );
  await query("UPDATE vehicles SET is_ready=true,readiness_reason='' WHERE id=$1", [lateVehicle]);
  assert.equal(
    (await calendar.get(window)).problems.find(({ id }) => id === next),
    undefined,
  );
  const partiallyPaidEvent = (await calendar.get(window)).events.find(
    (event) => event.booking_id === normal,
  );
  assert.equal(partiallyPaidEvent.financialSummary.paidPercent, '55');
  assert.equal(partiallyPaidEvent.paidRatio, 1500 / 2700);
  const mixedReceipt = {
    kind: 'rent_payment',
    expectedVersion: 2,
    bookingId: normal,
    customerId: customer.id,
    cashRub: '400',
    bankRub: '500',
    returnDebtRub: '1200',
    reason: 'Доплата при приёмке',
  };
  const receiptKey = randomUUID();
  const receipt = await finance.postCheckoutReceipt(mixedReceipt, first(receiptKey));
  assert.deepEqual(await finance.postCheckoutReceipt(mixedReceipt, first(receiptKey)), receipt);
  assert.equal((await service.get(normal)).finance.debtRub, '300');
  assert.deepEqual(
    await query(
      `SELECT e.method,e.amount_rub::text AS amount FROM finance_external e
       JOIN financial_operations o ON o.id=e.operation_id
       WHERE o.booking_id=$1 AND o.id>=$2 ORDER BY o.id`,
      [normal, receipt.id],
    ).then(({ rows }) => rows),
    [
      { method: 'cash', amount: '400' },
      { method: 'bank', amount: '500' },
    ],
  );
  await assert.rejects(
    finance.postCheckoutReceipt(mixedReceipt, second()),
    code(409, 'RETURN_BALANCE_CHANGED'),
  );
  await finance.postCheckoutReceipt(
    { ...mixedReceipt, cashRub: '0', bankRub: '300', returnDebtRub: '300' },
    first(),
  );
  const fullyPaidEvent = (await calendar.get(window)).events.find(
    (event) => event.booking_id === normal,
  );
  assert.equal(fullyPaidEvent.financialSummary.paidPercent, '100');
  assert.equal(fullyPaidEvent.paidRatio, 1);

  const correction = {
    expectedRevision: 2,
    returnedAt: inspect.returnedAt,
    mileageKm: 1240,
    fuelEighths: 8,
    reason: 'Сверили показания в бумажном акте',
    removeLines: [],
  };
  await query(
    `WITH pickup AS (
       INSERT INTO inspection_revisions(booking_id,vehicle_id,kind,revision,vehicle_snapshot,mileage_km,fuel_eighths,no_damage,
         damage_notes,special_notes,no_photos_acknowledged,created_by)
       VALUES($1,$2,'pickup',1,'{"bodyType":"sedan"}',1300,8,true,'','',true,$3) RETURNING id
     ), contract AS (
       INSERT INTO contract_versions(booking_id,terms_id,revision,template_version,snapshot,created_by)
       SELECT $1,id,1,'test','{}',$3 FROM booking_terms WHERE booking_id=$1 RETURNING id
     )
     INSERT INTO booking_checkouts(booking_id,started_by,issued_by,issued_at,issued_vehicle_id,issued_contract_id,
       act_revision_id,act_signed_by,act_signed_at)
     SELECT $1,$3,$3,$4,$2,contract.id,pickup.id,$3,$4 FROM contract,pickup`,
    [next, lateVehicle, actor, iso(now - hour / 2)],
  );
  await assert.rejects(
    service.correct(second(), normal, { ...correction, returnedAt: iso(now - hour / 4) }, false),
    code(422, 'RETURN_AFTER_NEXT_ISSUE'),
  );
  const damage = { expectedRevision: 2, amountRub: '200', reason: 'Подтверждённая царапина' };
  const damageKey = randomUUID();
  assert.deepEqual(
    await service.chargeDamage(second(damageKey), normal, damage),
    await service.chargeDamage(second(damageKey), normal, damage),
  );
  assert.equal((await lookup(second, 'rentalReturn.damage', damageKey)).status, 'completed');
  tariffCalls.mock.resetCalls();
  balanceCalls.mock.resetCalls();
  const needsRemoval = await service.correct(second(), normal, correction, false);
  assert.equal(tariffCalls.mock.callCount(), 1);
  assert.equal(balanceCalls.mock.callCount(), 1);
  tariffCalls.mock.restore();
  balanceCalls.mock.restore();
  assert.deepEqual(needsRemoval.missingLines, ['fuel']);
  await assert.rejects(
    service.correct(second(), normal, { ...correction, token: needsRemoval.token }, true),
    code(409, 'RETURN_REVIEW_CHANGED'),
  );
  const updated = { ...correction, removeLines: ['fuel'] };
  const difference = await service.correct(second(), normal, updated, false);
  assert.equal(difference.calculation.differenceRub, '-520');
  assert.equal(difference.revision, 2);
  const correctionKey = randomUUID();
  const corrected = await service.correct(
    second(correctionKey),
    normal,
    { ...updated, token: difference.token },
    true,
  );
  assert.equal(corrected.revision, 3);
  assert.deepEqual(
    (await lookup(second, 'rentalReturn.correct', correctionKey)).result,
    JSON.parse(JSON.stringify(corrected)),
  );
  const closed = await service.get(normal);
  assert.equal(closed.finance.overpaymentRub, '320');
  assert.equal(closed.damageCharges[0].amountRub, '200');
  assert.equal(closed.history[1].calculation.totalRub, '2700');
  assert.equal(closed.history[0].actor, 'return-second');
  assert.equal(closed.history[0].calculation.adjustments.length, 0);
  assert.equal(
    (await row('SELECT current_mileage_km FROM vehicles WHERE id=$1', [lateVehicle]))
      .current_mileage_km,
    1300,
  );

  const earlyVehicle = await vehicle('Х222ХХ178');
  const earlyStart = now - 36 * hour;
  const early = await booking(earlyVehicle, earlyStart, 2, true);
  await query(
    `WITH legacy AS (
       INSERT INTO financial_operations(command_id,request_hash,kind,booking_id,customer_id,reason)
       VALUES('old-charge','old','charge',$1,$2,'Историческое начисление') RETURNING id
     )
     INSERT INTO finance_charges(operation_id,booking_id,terms_id,amount_rub)
     SELECT legacy.id,$1,t.id,120 FROM legacy,booking_terms t WHERE t.booking_id=$1`,
    [early, customer.id],
  );
  const performedOn = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  await fleet.addService(
    String(earlyVehicle),
    {
      expectedVersion: 1,
      performedOn,
      procedure: 'Запись в журнал',
      mileageKm: 1300,
      updateMileage: false,
    },
    first(),
  );
  await pay(early, '2400');
  await service.save(second(), early, {
    ...inspect,
    returnedAt: iso(earlyStart + 27 * hour),
    mileageKm: 1000,
    fuelEighths: 8,
    damage: false,
    photoException: false,
    remarks: '',
    preparation: ['wash'],
  });
  const earlyReview = { expectedRevision: 1, wash: false, adjustments: [] };
  const earlyPreview = await service.review(first(), early, earlyReview, false);
  assert.equal(earlyPreview.calculation.totalRub, '2100');
  assert.equal(earlyPreview.calculation.overpaymentRub, '300');
  assert.equal(earlyPreview.calculation.pricing.totalUsageMileageKm, 0);
  const washPreview = await service.review(first(), early, { ...earlyReview, wash: true }, false);
  assert.equal(washPreview.calculation.lines.wash, '1000');
  await service.review(first(), early, { ...earlyReview, token: earlyPreview.token }, true);
  const earlyFinance = (await service.get(early)).finance;
  assert.equal(earlyFinance.status, 'completed_early');
  assert.equal(earlyFinance.priceRub, '2100');
  assert.equal((await service.list('vehicles', earlyVehicle))[0].id, early);
  assert.equal((await service.list('customers', customer.id)).length, 3);

  const earlyCorrection = {
    ...correction,
    mileageKm: 1001,
    returnedAt: iso(earlyStart + 27 * hour),
  };
  const earlyDifference = await service.correct(first(), early, earlyCorrection, false);
  await service.correct(first(), early, { ...earlyCorrection, token: earlyDifference.token }, true);
  assert.equal(
    (await row('SELECT current_mileage_km FROM vehicles WHERE id=$1', [earlyVehicle]))
      .current_mileage_km,
    1001,
  );

  const onTimeVehicle = await vehicle('Х333ХХ178');
  const onTimeStart = now - 25 * hour;
  const onTime = await booking(onTimeVehicle, onTimeStart, 1, true);
  const lateWindow = { from: iso(now - hour / 2), to: iso(now + hour) };
  for (const range of [lateWindow, window]) {
    const view = await calendar.get(range);
    const matches = view.events.filter((e) => e.booking_id === onTime);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].checkoutPhase, 'issued');
    assert.ok(new Date(matches[0].end_at).getTime() >= now);
    assert.match(
      view.problems.find((b) => b.id === onTime).problemReasons.join(),
      /истёк срок аренды/i,
    );
  }
  const cleanInspection = {
    ...inspect,
    returnedAt: iso(onTimeStart + day),
    mileageKm: 1000,
    fuelEighths: 8,
    remarks: '',
    damage: false,
    photoException: false,
    preparation: ['repair'],
  };
  const saveKey = randomUUID();
  const saved = await service.save(first(saveKey), onTime, cleanInspection);
  assert.deepEqual((await lookup(first, 'rentalReturn.save', saveKey)).result, saved);
  await fleet.addService(
    String(onTimeVehicle),
    {
      expectedVersion: 1,
      performedOn,
      procedure: 'Сервисная проверка',
      mileageKm: 1300,
      updateMileage: true,
    },
    first(),
  );
  const previousReview = await service.review(first(), onTime, earlyReview, false);
  await service.save(second(), onTime, {
    ...cleanInspection,
    remarks: 'Уточнили замечание при сверке акта',
    expectedRevision: 1,
  });
  await assert.rejects(
    service.review(first(), onTime, { ...earlyReview, token: previousReview.token }, true),
    code(409, 'RETURN_REVIEW_CHANGED'),
  );
  const onTimeReview = { ...earlyReview, expectedRevision: 2 };
  const onTimePreview = await service.review(first(), onTime, onTimeReview, false);
  assert.deepEqual(onTimePreview.calculation.lines, {
    rent: '1200',
    surcharge: '0',
    fuel: '0',
    wash: '0',
  });
  await service.review(first(), onTime, { ...onTimeReview, token: onTimePreview.token }, true);
  const completed = await service.get(onTime);
  assert.equal(completed.finance.status, 'completed');
  assert.equal(completed.history[0].inspection.mileageKm, 1000);
  assert.deepEqual(
    await row('SELECT current_mileage_km,is_ready,readiness_reason FROM vehicles WHERE id=$1', [
      onTimeVehicle,
    ]),
    { current_mileage_km: 1300, is_ready: false, readiness_reason: 'Ремонт' },
  );
  assert.equal(
    (await calendar.get(lateWindow)).events.some((e) => e.booking_id === onTime),
    false,
  );
  assert.equal(
    (await calendar.get(window)).events.find((e) => e.booking_id === onTime).checkoutPhase,
    'completed',
  );
  assert.equal(
    (await row('SELECT count(*)::int AS count FROM finance_charges WHERE booking_id=$1', [onTime]))
      .count,
    0,
  );
  async function depositSettlementFixture(vehicleId, returnedAt, reserveRub) {
    const start = returnedAt - day;
    const bookingId = await booking(vehicleId, start, 1, true);
    const receipt = {
      kind: 'deposit_receipt',
      customerId: customer.id,
      bookingId,
      expectedVersion: 1,
      method: 'cash',
      amountRub: '15000',
      reason: 'Получен залог',
    };
    await finance.post(receipt, first());
    const settlement = {
      kind: 'deposit_settlement',
      customerId: customer.id,
      bookingId,
      expectedVersion: 2,
      expectedDepositRub: receipt.amountRub,
      reserveRub,
      reason: 'Расчёт по залогу',
    };
    await assert.rejects(
      finance.post({ ...settlement, expectedVersion: 1 }, first()),
      code(422, 'RETURN_UNAVAILABLE'),
    );
    await service.save(first(), bookingId, { ...cleanInspection, returnedAt: iso(returnedAt) });
    const preview = await service.review(first(), bookingId, earlyReview, false);
    await service.review(first(), bookingId, { ...earlyReview, token: preview.token }, true);
    const key = randomUUID();
    const operation = await finance.post(settlement, first(key));
    assert.deepEqual(await finance.post(settlement, first(key)), operation);
    await assert.rejects(finance.post(settlement, second()), code(409, 'DEPOSIT_BALANCE_CHANGED'));
    const view = await service.get(bookingId);
    assert.equal(view.finance.depositRub, '0');
    assert.deepEqual(
      await query('SELECT amount_rub::text AS amount FROM finance_external WHERE operation_id=$1', [
        operation.id,
      ]).then(({ rows }) => rows.map(({ amount }) => amount)),
      reserveRub === '15000' ? [] : [(BigInt(reserveRub) - 15000n).toString()],
    );
    return { view, operation };
  }

  const partialReturnAt = now - 2 * hour;
  const partial = await depositSettlementFixture(
    await vehicle('Х555ХХ178'),
    partialReturnAt,
    '5000',
  );
  assert.deepEqual(partial.view.reserves, [
    { amountRub: '5000', releaseAt: new Date(partialReturnAt + 21 * day) },
  ]);
  assert.equal(partial.view.finance.availableCreditRub, '0');

  const fullReturn = await depositSettlementFixture(
    await vehicle('Х666ХХ178'),
    now - 2 * hour,
    '0',
  );
  assert.deepEqual(fullReturn.view.reserves, []);

  async function correctReserveReturn(view, returnedAt) {
    const bookingId = view.finance.bookingId;
    const input = {
      expectedRevision: view.history[0].revision,
      returnedAt: iso(returnedAt),
      mileageKm: 1000,
      fuelEighths: 8,
      reason: 'Уточнили время по акту',
      removeLines: [],
    };
    const preview = await service.correct(first(), bookingId, input, false);
    await service.correct(first(), bookingId, { ...input, token: preview.token }, true);
    return service.get(bookingId);
  }

  const fullReserve = await depositSettlementFixture(
    await vehicle('Х777ХХ178'),
    now - 2 * hour,
    '15000',
  );
  assert.equal(fullReserve.view.reserves[0].amountRub, '15000');
  const reserveJournal = await db.transaction((c) => finance.journal(c, customer.id));
  assert.equal(
    reserveJournal.items
      .find(({ id }) => id === fullReserve.operation.id)
      .allocations.find(({ bucket }) => bucket === 'credit').amountRub,
    '15000',
  );
  const moneyJournal = await db.transaction((c) => finance.journal(c));
  assert.ok(!moneyJournal.items.some(({ id }) => id === fullReserve.operation.id));
  const earlierReturnAt = now - 4 * hour;
  const rescheduled = await correctReserveReturn(fullReserve.view, earlierReturnAt);
  assert.deepEqual(rescheduled.reserves, [
    { amountRub: '15000', releaseAt: new Date(earlierReturnAt + 21 * day) },
  ]);
  const reversed = {
    kind: 'reversal',
    operationId: fullReserve.operation.id,
    reason: 'Ошибка оператора',
  };
  await finance.post(reversed, first());
  const restored = await service.get(fullReserve.view.finance.bookingId);
  assert.equal(restored.finance.depositRub, '15000');
  assert.deepEqual(restored.reserves, []);

  const matured = await depositSettlementFixture(
    await vehicle('Х888ХХ178'),
    now - 22 * day,
    '15000',
  );
  assert.deepEqual(matured.view.reserves, []);
  assert.equal(matured.view.finance.availableCreditRub, '15000');
  const client = await db.transaction((c) => finance.customer(c, customer.id));
  assert.equal(client.sources.filter(({ bucket }) => bucket === 'credit').length, 1);
  const [credit] = client.sources.filter(({ bucket }) => bucket === 'credit');
  assert.equal(credit.availableRub, '15000');
  assert.equal(credit.fund, 'deposit_pool');

  const creditRefund = {
    kind: 'refund',
    customerId: customer.id,
    method: 'cash',
    reason: 'Возврат части доступного резерва',
    sources: [
      {
        lotId: credit.lotId,
        bucket: 'credit',
        bookingId: null,
        fund: credit.fund,
        amountRub: '5000',
      },
    ],
  };
  const refund = await finance.post(creditRefund, first());
  const laterReturnAt = now - 20 * day;
  const refrozen = await correctReserveReturn(matured.view, laterReturnAt);
  assert.deepEqual(refrozen.reserves, [
    { amountRub: '10000', releaseAt: new Date(laterReturnAt + 21 * day) },
  ]);
  assert.equal(refrozen.finance.availableCreditRub, '0');
  await assert.rejects(finance.post(creditRefund, first()), code(422, 'INSUFFICIENT_SOURCE'));
  assert.equal(
    (
      await row('SELECT amount_rub::text AS amount FROM finance_external WHERE operation_id=$1', [
        refund.id,
      ])
    ).amount,
    '-5000',
  );
  const releasedAgain = await correctReserveReturn(refrozen, now - 22 * day);
  assert.deepEqual(releasedAgain.reserves, []);
  assert.equal(releasedAgain.finance.availableCreditRub, '10000');

  const editedVehicle = await vehicle('Х444ХХ178');
  const editedRental = await booking(editedVehicle, onTimeStart, 1, true);
  await fleet.update(
    String(editedVehicle),
    {
      expectedVersion: 1,
      reason: 'Уточнили текущий пробег',
      data: {
        modelId: model.id,
        plate: 'X444XX178',
        year: 2022,
        bodyType: 'sedan',
        currentMileageKm: 1500,
        nextMaintenanceDueKm: 1220,
      },
    },
    first(),
  );
  await service.save(first(), editedRental, cleanInspection);
  const editedPreview = await service.review(first(), editedRental, earlyReview, false);
  await service.review(first(), editedRental, { ...earlyReview, token: editedPreview.token }, true);
  assert.equal(
    (await row('SELECT current_mileage_km FROM vehicles WHERE id=$1', [editedVehicle]))
      .current_mileage_km,
    1500,
  );

  const schemaCheck = new RentalReturnService(db, commands);
  await query('ALTER TABLE finance_allocations RENAME COLUMN available_at TO unavailable_at');
  try {
    await assert.rejects(schemaCheck.get(normal), code(503, 'RETURN_SCHEMA_REQUIRED'));
  } finally {
    await query('ALTER TABLE finance_allocations RENAME COLUMN unavailable_at TO available_at');
  }
  assert.equal((await schemaCheck.get(normal)).finance.bookingId, normal);
});
