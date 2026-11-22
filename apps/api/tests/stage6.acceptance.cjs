const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../..');
const migrations = path.join(root, 'apps/api/drizzle');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/GioAAAAASUVORK5CYII=',
  'base64',
);

async function waitUntil(work, name, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await work();
    if (value) return value;
    await delay(200);
  }
  assert.fail('Timed out: ' + name);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t, script, args, cwd, env, url) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: 'ignore',
  });
  const ended = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => {
    child.kill();
    await ended;
  });
  await waitUntil(async () => {
    assert.equal(child.exitCode, null, 'Test server stopped');
    return fetch(url).then(
      (response) => response.ok,
      () => false,
    );
  }, 'server ' + url);
}

async function fixture(pool, number, type, actor, { label, hasFreeDay = true } = {}) {
  const details =
    type === 'individual'
      ? {
          lastName: 'Арендатор',
          firstName: 'Тестовый',
          birthDate: '1990-01-01',
          passportSeries: '0000',
          passportNumber: '000000',
          passportIssuer: 'Тестовое подразделение '.repeat(18),
          passportDate: '2020-02-02',
          registrationAddress: 'Тестовый адрес '.repeat(18),
          licenseNumber: '0000 000000',
          licenseDate: '2020-03-03',
        }
      : {
          kpp: '000000000',
          ogrn: '0000000000000',
          legalAddress: 'Юридический адрес '.repeat(19),
          bank: 'Тестовый банк',
          account: '0'.repeat(20),
          correspondentAccount: '0'.repeat(20),
          bik: '0'.repeat(9),
          representativeName: 'Тестовый Представитель',
          authority: 'Тестовая доверенность',
        };
  const { id: customerId } = (
    await pool.query(
      "INSERT INTO customers(type,display_name,inn,details,phone) VALUES($1,$2,$3,$4,'+70000000000') RETURNING id",
      [
        type,
        label ?? (type === 'individual' ? 'Тестовый Арендатор' : 'ООО «Тестовый арендатор»'),
        '0'.repeat(10),
        details,
      ],
    )
  ).rows[0];
  const { id: modelId, pricing_group_id: pricingGroupId } = (
    await pool.query(
      `WITH b AS (INSERT INTO vehicle_brands(name) VALUES($1) RETURNING id)
     INSERT INTO vehicle_models(brand_id,name,pricing_group_id)
     SELECT b.id,'Модель',(SELECT id FROM pricing_groups WHERE tariff_code='economy') FROM b RETURNING id,pricing_group_id`,
      ['Марка ' + number],
    )
  ).rows[0];
  const { id: vehicleId } = (
    await pool.query(
      "INSERT INTO vehicles(model_id,plate,year,body_type) VALUES($1,$2,2022,'sedan') RETURNING id",
      [modelId, 'X123XX77' + number],
    )
  ).rows[0];
  const start = '2026-11-24T07:00:00.000Z';
  const end = '2026-11-26T07:00:00.000Z';
  const { id: bookingId } = (
    await pool.query(
      `INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_vehicle_id,created_by)
     VALUES($1,$2,$3,'vehicle',$4,$5) RETURNING id`,
      [customerId, start, end, vehicleId, actor],
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by)
     VALUES($1,$2,'assignment',$3,$4,'Тестовое назначение',$5)`,
    [vehicleId, bookingId, start, end, actor],
  );
  const snapshot = {
    operationKind: 'initial',
    startAt: start,
    agreedReturnAt: end,
    finalTotalRub: '30000',
    includedVatRub: '1429',
    rulesSnapshot: {
      washRub: '1000',
      excessKmRub: '7',
      lateHourRub: '300',
      groups: [{ code: 'economy', category: 'passenger' }],
    },
    dailyMileagePackageKm: 250,
    effectiveMileageLimitKm: 500,
    contractDays: 2,
    billableDays: hasFreeDay ? 1 : 2,
    periods: [
      { startsAt: start, endsAt: end, dailyRateRub: '30000', pricingGroup: { id: pricingGroupId } },
    ],
    dayLines: [
      {
        dayIndex: 2,
        startAt: '2026-11-25T07:00:00.000Z',
        endAt: end,
        nonBillable: hasFreeDay,
        reason: hasFreeDay ? 'Согласованный день' : undefined,
      },
    ],
  };
  const { id: quote } = (
    await pool.query(
      "INSERT INTO pricing_quotes(created_by,expires_at,input,snapshot) VALUES($1,now()+interval '1 hour','{}',$2) RETURNING id",
      [actor, snapshot],
    )
  ).rows[0];
  await pool.query(
    "INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) VALUES($1,1,$2,$3,'',$4)",
    [bookingId, quote, snapshot, actor],
  );
  await pool.query('INSERT INTO booking_eligible_models(booking_id,model_id) VALUES($1,$2)', [
    bookingId,
    modelId,
  ]);
  return { bookingId, customerId, vehicleId };
}

test(
  'Stage 6 migrates existing data, versions inspections/contracts, enforces private files and signs on paper',
  { timeout: 240000 },
  async (t) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-stage6-'));
    const name = 'crm_stage6_test_' + randomBytes(8).toString('hex');
    assert.match(name, /^crm_stage6_test_[a-f0-9]{16}$/);
    const admin = new Pool({ connectionString: process.env.DATABASE_URL });
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = '/' + name;
    const pool = new Pool({ connectionString: url.toString() });
    t.after(async () => {
      await pool.end();
      await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      await admin.end();
      await fs.rm(workspace, { recursive: true, force: true });
    });
    await admin.query('CREATE DATABASE "' + name + '"');
    const legacy = path.join(workspace, 'legacy');
    await fs.mkdir(path.join(legacy, 'meta'), { recursive: true });
    const journal = JSON.parse(
      await fs.readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'),
    );
    journal.entries = journal.entries.filter((entry) => entry.idx <= 11);
    await fs.writeFile(path.join(legacy, 'meta/_journal.json'), JSON.stringify(journal));
    await Promise.all(
      journal.entries.map(({ tag }) =>
        fs.copyFile(path.join(migrations, tag + '.sql'), path.join(legacy, tag + '.sql')),
      ),
    );
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    const { id: actor } = (
      await pool.query(
        "INSERT INTO users(full_name,login,password_hash,role) VALUES('Тестовый оператор','stage-six','unused','manager') RETURNING id",
      )
    ).rows[0];
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [actor, digest(token)],
    );
    const tabletOperator = (
      await pool.query(
        "INSERT INTO users(full_name,login,password_hash,role) VALUES('Петров Пётр Петрович','stage-six-tablet','unused','manager') RETURNING id",
      )
    ).rows[0].id;
    const tabletToken = randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [tabletOperator, digest(tabletToken)],
    );
    const individual = await fixture(pool, 1, 'individual', actor);
    const company = await fixture(pool, 2, 'company', actor);
    const newCheckout = await fixture(pool, 3, 'individual', actor, {
      label: 'Иванова Ксения Сергеевна',
      hasFreeDay: false,
    });
    const spareVehicle = (
      await pool.query(
        "INSERT INTO vehicles(model_id,plate,year,body_type) SELECT model_id,'X321XX774',year,body_type FROM vehicles WHERE id=$1 RETURNING id",
        [newCheckout.vehicleId],
      )
    ).rows[0].id;
    // The booking keeps its brand-wide target and an explicitly assigned vehicle.
    const broadTarget = (
      await pool.query(
        'SELECT m.brand_id,m.pricing_group_id FROM vehicles v JOIN vehicle_models m ON m.id=v.model_id WHERE v.id=$1',
        [newCheckout.vehicleId],
      )
    ).rows[0];
    const otherModel = (
      await pool.query(
        "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) SELECT $1,'Другой тариф',id FROM pricing_groups WHERE id<>$2 AND tariff_code IS NOT NULL ORDER BY id LIMIT 1 RETURNING id",
        [broadTarget.brand_id, broadTarget.pricing_group_id],
      )
    ).rows[0].id;
    await pool.query(
      "UPDATE bookings SET target_type='brand',target_brand_id=$2,target_vehicle_id=NULL WHERE id=$1",
      [newCheckout.bookingId, broadTarget.brand_id],
    );
    await pool.query('INSERT INTO booking_eligible_models(booking_id,model_id) VALUES($1,$2)', [
      newCheckout.bookingId,
      otherModel,
    ]);
    await pool.query(
      "UPDATE customers SET phone='', details = (details - 'firstName') || jsonb_build_object('lastName', 'Смирнова') WHERE id=$1",
      [newCheckout.customerId],
    );
    const state = async () =>
      (
        await pool.query(
          `SELECT (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM bookings b) AS bookings,
     (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM booking_terms b) AS terms,
     (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM customers b) AS customers,
     (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM vehicles b) AS vehicles,
     (SELECT count(*) FROM financial_operations) AS operations,
     (SELECT count(*) FROM finance_charges) AS charges,
     (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM finance_funds f) AS funds`,
        )
      ).rows[0];
    const before = await state();
    const apiPort = await freePort();
    const webPort = await freePort();
    const apiOrigin = 'http://127.0.0.1:' + apiPort;
    const webOrigin = 'http://127.0.0.1:' + webPort;
    const storage = path.join(workspace, 'private');
    const apiScript = path.join(root, 'apps/api/dist/main.js');
    const apiEnv = {
      DATABASE_URL: url.toString(),
      APP_ORIGINS: webOrigin,
      CRM_PRIVATE_FILES_DIR: storage,
      CRM_PDF_BROWSER: 'msedge',
      CRM_LESSOR_JSON: JSON.stringify({
        name: 'ООО «Тестовый арендодатель»',
        signer: 'Тестовый Подписант',
        authority: 'Доверенность № Т-01',
        requisites: 'Тестовые реквизиты '.repeat(35),
      }),
    };
    await startServer(
      t,
      apiScript,
      [],
      root,
      { ...apiEnv, API_PORT: String(apiPort), CRM_CUSTOMER_DOCUMENT_UPLOADS_ENABLED: '' },
      apiOrigin + '/api/v1/health',
    );
    const base = '/bookings/' + individual.bookingId;
    const other = '/bookings/' + company.bookingId;
    const call = async (
      endpoint,
      {
        body,
        file,
        key = randomUUID(),
        status = 200,
        code,
        anonymous = false,
        csrf = true,
        verb,
        origin = apiOrigin,
      } = {},
    ) => {
      const method = verb ?? (body === undefined && !file ? 'GET' : 'POST');
      const response = await fetch(origin + '/api/v1' + endpoint, {
        method,
        headers: {
          ...(!anonymous ? { cookie: 'crm_session=' + token } : {}),
          ...(method !== 'GET'
            ? {
                origin: webOrigin,
                'idempotency-key': key,
                ...(csrf ? { 'x-csrf-token': digest('csrf:' + token) } : {}),
              }
            : {}),
          ...(method !== 'GET' ? { 'content-type': file?.mime ?? 'application/json' } : {}),
        },
        body: file?.bytes ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      assert.equal(
        response.status,
        status,
        endpoint +
          ' expected HTTP ' +
          status +
          (response.status !== status ? ' · ' + (await response.text()) : ''),
      );
      if (!response.headers.get('content-type')?.includes('application/json')) return response;
      const json = await response.json();
      if (code) assert.equal(json.code, code);
      return json;
    };

    await call(base + '/documents', { anonymous: true, status: 401, code: 'UNAUTHENTICATED' });
    await call(base + '/documents', { status: 503, code: 'DOCUMENT_SCHEMA_REQUIRED' });
    await call('/customers/' + individual.customerId + '/private-documents', {
      status: 503,
      code: 'DOCUMENT_SCHEMA_REQUIRED',
    });
    await migrate(drizzle(pool), { migrationsFolder: migrations });
    const migrated = await state();
    assert.deepEqual(migrated, {
      ...before,
      vehicles: before.vehicles.map((vehicle) => ({ ...vehicle, has_casco: null })),
    });
    await pool.query('UPDATE vehicles SET has_casco=true WHERE id=$1', [individual.vehicleId]);
    const baseline = await state();
    assert.deepEqual((await call(base + '/documents')).inspections, []);

    const photoPath = base + '/inspection-photos/pickup/1';
    const upload = { file: { mime: 'image/png', bytes: png }, status: 201 };
    await call(photoPath, { ...upload, csrf: false, status: 403, code: 'CSRF_REJECTED' });
    await call(photoPath, {
      file: { mime: 'image/png', bytes: Buffer.from('<svg/>') },
      status: 415,
      code: 'FILE_TYPE_UNSUPPORTED',
    });
    const key = randomUUID();
    const photo = await call(photoPath, { ...upload, key });
    assert.deepEqual(await call(photoPath, { ...upload, key }), photo);
    const photoUrl = base + '/inspection-photos/' + photo.id;
    await call(photoUrl, { anonymous: true, status: 401, code: 'UNAUTHENTICATED' });
    await call(other + '/inspection-photos/' + photo.id, { status: 404, code: 'NOT_FOUND' });
    await waitUntil(
      async () => (await call(base + '/documents')).photos[0]?.status === 'ready',
      'photo ready',
    );
    const response = await call(photoUrl);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const customerFiles = '/customers/' + individual.customerId + '/private-documents';
    const customerSettings = '/customer-document-settings';
    const uploadDisabled = { status: 403, code: 'CUSTOMER_DOCUMENT_UPLOAD_DISABLED' };
    assert.deepEqual(await call(customerSettings), { uploadsEnabled: false });
    await call(customerFiles, { ...upload, ...uploadDisabled });
    assert.deepEqual(await call(customerFiles), []);

    const uploadApiPort = await freePort();
    const uploadOrigin = 'http://127.0.0.1:' + uploadApiPort;
    await startServer(
      t,
      apiScript,
      [],
      root,
      {
        ...apiEnv,
        API_PORT: String(uploadApiPort),
        CRM_CUSTOMER_DOCUMENT_UPLOADS_ENABLED: 'true',
      },
      uploadOrigin + '/api/v1/health',
    );
    assert.deepEqual(await call(customerSettings, { origin: uploadOrigin }), {
      uploadsEnabled: true,
    });
    const customerFile = await call(customerFiles, { ...upload, origin: uploadOrigin });
    await waitUntil(
      async () => (await call(customerFiles))[0]?.status === 'ready',
      'private scan ready',
    );
    const customerFileUrl = customerFiles + '/' + customerFile.id;
    const scan = await call(customerFileUrl);
    assert.deepEqual(Buffer.from(await scan.arrayBuffer()), png);
    await call(customerFileUrl, { anonymous: true, status: 401, code: 'UNAUTHENTICATED' });
    await call(base + '/inspection-photos/' + customerFile.id, { status: 404, code: 'NOT_FOUND' });

    const draft = {
      expectedBookingVersion: 1,
      expectedRevision: 0,
      mileageKm: 101,
      fuelEighths: 4,
      noDamage: true,
      damageNotes: '',
      specialNotes: 'Тестовая пометка',
      photoIds: [],
      acknowledgeNoPhotos: false,
    };
    await call(base + '/inspections/pickup', {
      body: draft,
      status: 422,
      code: 'NO_PICKUP_PHOTOS',
    });
    await call(base + '/inspections/check_in', {
      body: { ...draft, photoIds: [photo.id] },
      status: 422,
      code: 'PHOTOS_NOT_AVAILABLE',
    });
    const firstKey = randomUUID();
    const first = await call(base + '/inspections/pickup', {
      key: firstKey,
      body: { ...draft, photoIds: [photo.id] },
      status: 201,
    });
    assert.equal(first.revision, 1);
    assert.deepEqual(
      (await call('/operations/by-key?command=inspections.save&key=' + firstKey)).result,
      first,
    );
    await call(base + '/inspections/pickup', {
      body: { ...draft, acknowledgeNoPhotos: true },
      status: 409,
      code: 'INSPECTION_VERSION_CONFLICT',
    });
    await call(base + '/inspections/pickup', {
      body: { ...draft, expectedRevision: 1, mileageKm: 102, acknowledgeNoPhotos: true },
      status: 201,
    });
    assert.deepEqual(
      (await call(base + '/documents')).inspections.map((revision) => [
        revision.mileageKm,
        revision.photoIds,
      ]),
      [
        [102, []],
        [101, [photo.id]],
      ],
    );
    await pool.query(
      "UPDATE private_files SET delete_after=now()-interval '1 second' WHERE id=$1",
      [photo.id],
    );
    await call(photoUrl, { status: 410, code: 'FILE_EXPIRED' });
    await waitUntil(
      async () => (await call(base + '/documents')).photos[0].status === 'deleted',
      'expired file removed',
    );
    await assert.rejects(fs.stat(path.join(storage, 'objects', photo.id)), { code: 'ENOENT' });

    const initial = {
      expectedBookingVersion: 1,
      expectedCustomerVersion: 1,
      expectedContractVersionId: null,
      securityDepositRub: '10000',
      additionalDriver: {
        fullName: 'Тестовый Водитель',
        passport: 'Тестовый паспорт',
        address: 'Тестовый адрес',
        phone: '+70000000000',
        license: 'Тестовые права',
      },
    };
    await call(base + '/contracts', { body: initial, status: 422, code: 'CHECKOUT_REQUIRED' });
    const payment = {
      kind: 'rent_payment',
      expectedVersion: 1,
      bookingId: individual.bookingId,
      customerId: individual.customerId,
      amountRub: '20000',
      method: 'cash',
      reason: 'Тест приёма оплаты при оформлении',
    };
    for (const endpoint of ['/financial-operations/preview', '/financial-operations'])
      await call(endpoint, { body: payment, status: 422, code: 'RENTAL_NOT_ISSUED' });
    await call(base + '/checkout/start', { body: { expectedBookingVersion: 1 }, status: 201 });
    const firstContract = await call(base + '/contracts', { body: initial, status: 201 });
    const getReady = (endpoint, id) =>
      waitUntil(async () => {
        const version = (await call(endpoint + '/documents')).contracts.find(
          (candidate) => candidate.id === id,
        );
        assert.notEqual(version?.status, 'failed');
        return version?.status === 'ready' && version;
      }, 'contract PDF');
    const contract = await getReady(base, firstContract.id);
    const contractUrl = base + '/contract-files/' + contract.fileId;
    await call(other + '/contract-files/' + contract.fileId, { status: 404, code: 'NOT_FOUND' });
    await call(contractUrl, { anonymous: true, status: 401, code: 'UNAUTHENTICATED' });
    const pdf = Buffer.from(await (await call(contractUrl)).arrayBuffer());
    assert.match(pdf.subarray(0, 8).toString(), /^%PDF-/);
    const confirm = { expectedBookingVersion: 1, confirmed: true };
    await call(base + '/contracts/' + firstContract.id + '/sign', { body: confirm, status: 201 });
    const next = await call(base + '/contracts', {
      body: { ...initial, expectedContractVersionId: firstContract.id },
      status: 201,
    });
    assert.notEqual(next.id, firstContract.id);
    const nextVersion = await getReady(base, next.id);
    assert.equal(nextVersion.confirmedAt, null);
    await call(base + '/contracts/' + firstContract.id + '/sign', {
      body: confirm,
      status: 409,
      code: 'CONTRACT_VERSION_CONFLICT',
    });
    await waitUntil(
      async () =>
        (await pool.query('SELECT status FROM private_files WHERE id=$1', [contract.fileId]))
          .rows[0].status === 'deleted',
      'superseded contract file retired',
    );
    await waitUntil(
      async () =>
        fs.stat(path.join(storage, 'objects', contract.fileId)).then(
          () => false,
          (error) => error.code === 'ENOENT',
        ),
      'superseded contract bytes removed',
    );
    await call(contractUrl, { status: 410, code: 'FILE_EXPIRED' });
    const reprintUrl = base + '/contracts/' + firstContract.id + '/pdf';
    await call(reprintUrl, { anonymous: true, status: 401, code: 'UNAUTHENTICATED' });
    await call(other + '/contracts/' + firstContract.id + '/pdf', {
      status: 404,
      code: 'NOT_FOUND',
    });
    assert.match(
      Buffer.from(await (await call(reprintUrl)).arrayBuffer())
        .subarray(0, 8)
        .toString(),
      /^%PDF-/,
    );
    const firstSnapshot = (
      await pool.query('SELECT snapshot,template_version FROM contract_versions WHERE id=$1', [
        firstContract.id,
      ])
    ).rows[0];
    assert.equal(firstSnapshot.snapshot.casco, true);
    assert.equal(firstSnapshot.snapshot.customer.displayName, 'Арендатор Тестовый');
    assert.ok(firstSnapshot.template_version);
    assert.deepEqual(
      (await call(base + '/documents')).contracts.map((version) => version.id),
      [next.id],
    );
    await pool.query(`CREATE FUNCTION stage6_test_reject_pdf() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.category='contract' THEN RAISE EXCEPTION 'synthetic metadata failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER stage6_test_reject_pdf BEFORE INSERT ON private_files
      FOR EACH ROW EXECUTE FUNCTION stage6_test_reject_pdf()`);
    const target = { type: 'vehicle', id: company.vehicleId };
    const pricing = {
      startAt: '2026-11-24T07:00:00.000Z',
      contractDays: 3,
      dailyMileagePackageKm: 250,
    };
    const preview = await call('/bookings/preview', {
      status: 201,
      body: { target, pricing, bookingId: company.bookingId },
    });
    await call(other + '/terms', {
      verb: 'PATCH',
      body: {
        target,
        pricing,
        expectedVersion: 1,
        previewToken: preview.previewToken,
        reason: 'Тестовый пересчёт',
      },
    });
    const previousInspection = (await call(base + '/documents')).inspections[0];
    const oldAct = await call(base + '/acts', {
      status: 201,
      body: { expectedBookingVersion: 1, inspectionRevisionId: previousInspection.id },
    });
    const oldActVersion = await waitUntil(async () => {
      const version = (await call(base + '/documents')).acts.find((item) => item.id === oldAct.id);
      return version?.status === 'ready' && version;
    }, 'first act rendered');
    await call(base + '/checkout/issue', {
      body: { expectedBookingVersion: 1, contractVersionId: next.id, actVersionId: oldAct.id },
      status: 422,
      code: 'RECEIPTS_REQUIRED',
    });
    const afterTerms = await state();
    assert.equal(
      afterTerms.terms.filter((term) => term.booking_id === company.bookingId).length,
      2,
    );
    assert.deepEqual(afterTerms.funds, before.funds);
    await call(other + '/checkout/start', { body: { expectedBookingVersion: 2 }, status: 201 });
    const corporate = await call(other + '/contracts', {
      body: { ...initial, expectedBookingVersion: 2 },
      status: 201,
    });
    const snapshot = (
      await pool.query('SELECT snapshot FROM contract_versions WHERE id=$1', [corporate.id])
    ).rows[0].snapshot;
    assert.equal(snapshot.terms.finalTotalRub, preview.calculation.finalTotalRub);
    assert.equal(snapshot.terms.contractDays, 3);
    await waitUntil(
      async () => (await call(other + '/documents')).contracts[0].status === 'failed',
      'worker failure after writing PDF',
    );
    await pool.query('DROP TRIGGER stage6_test_reject_pdf ON private_files');
    await call(other + '/contracts/' + corporate.id + '/retry', { body: {}, status: 201 });
    assert.equal((await call(other + '/documents')).contracts.length, 1);
    const corporateVersion = await getReady(other, corporate.id);
    const corporatePdf = Buffer.from(
      await (await call(other + '/contract-files/' + corporateVersion.fileId)).arrayBuffer(),
    );
    assert.match(corporatePdf.subarray(0, 8).toString(), /^%PDF-/);
    if (process.env.STAGE6_PDF_QA_DIR) {
      await fs.mkdir(process.env.STAGE6_PDF_QA_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.STAGE6_PDF_QA_DIR, 'individual.pdf'), pdf);
      await fs.writeFile(path.join(process.env.STAGE6_PDF_QA_DIR, 'company.pdf'), corporatePdf);
    }
    const { summary } = await call(base + '/finance');
    assert.equal(summary.paymentsAllowed, true);
    assert.equal(summary.debtRub, '30000');
    assert.deepEqual(await state(), afterTerms);

    await startServer(
      t,
      path.join(root, 'node_modules/vite/bin/vite.js'),
      ['--port', String(webPort), '--strictPort'],
      path.join(root, 'apps/web'),
      { API_PORT: String(apiPort) },
      webOrigin,
    );
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const browserContext = await browser.newContext({ viewport: { width: 820, height: 950 } });
    const page = await browserContext.newPage();
    await page.context().addCookies([{ name: 'crm_session', value: token, url: webOrigin }]);
    await page.goto(webOrigin + '/clients/' + individual.customerId);
    for (const group of ['Личные данные', 'Паспорт', 'Водительское удостоверение']) {
      await page.getByRole('region', { name: group, exact: true }).waitFor();
    }
    const settingsResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/v1/customer-document-settings') && response.ok(),
    );
    await page.getByRole('tab', { name: 'Документы' }).click();
    assert.deepEqual(await (await settingsResponse).json(), { uploadsEnabled: false });
    await page.getByRole('link', { name: 'Скачать' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Загрузить документ клиента' }).count(), 0);

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.clock.setFixedTime(new Date('2026-11-23T10:00:00+03:00'));
    await page.goto(webOrigin + '/calendar');
    const freshEvent = page
      .locator('.calendar-event')
      .filter({ hasText: 'Иванова Ксения Сергеевна' });
    try {
      await freshEvent.scrollIntoViewIfNeeded({ timeout: 12000 });
    } catch (error) {
      throw new Error(
        'Calendar did not render the fixture: ' +
          (await page.locator('body').innerText()).slice(0, 2500),
        { cause: error },
      );
    }
    await freshEvent.click({ button: 'right', timeout: 10000 });
    await page.getByRole('menuitem', { name: 'Создать договор', exact: true }).click();
    const freshDrawer = page.getByRole('dialog');
    const freshPath = '/bookings/' + newCheckout.bookingId;
    const stopButton = freshDrawer.getByRole('button', {
      name: 'Прекратить оформление',
      exact: true,
    });
    const stopDialog = page.getByRole('dialog', { name: 'Прекратить оформление?' });
    await freshEvent.getByRole('img', { name: 'Оформление' }).waitFor();
    await stopButton.click();
    await freshDrawer.waitFor({ state: 'hidden' });
    assert.equal((await call(freshPath + '/documents')).checkout, null);
    assert.equal(await stopDialog.count(), 0);
    await freshEvent.getByRole('img', { name: 'Оформление' }).waitFor({ state: 'hidden' });
    await freshEvent.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Создать договор', exact: true }).click();
    const freshContractHeader = freshDrawer.getByRole('tab', { name: /^Договор/, expanded: false });
    await freshContractHeader.waitFor();
    assert.equal(
      await freshDrawer.locator('.checkout-sections').getByRole('tab', { expanded: true }).count(),
      0,
    );
    await freshContractHeader.click();
    await freshDrawer.getByLabel('Залог по договору, ₽').waitFor();
    await waitUntil(
      async () =>
        (await freshDrawer.getByLabel('Залог по договору, ₽').inputValue()) === '10\u00a0000 ₽',
      'prefilled deposit for older terms',
    );
    await freshDrawer.getByRole('tab', { name: /^Водитель/ }).click();
    await freshDrawer
      .getByRole('region', { name: 'Личные данные', exact: true })
      .getByLabel('Фамилия', { exact: true })
      .waitFor();
    await freshDrawer
      .getByRole('region', { name: 'Паспорт', exact: true })
      .getByLabel('Серия паспорта', { exact: true })
      .waitFor();
    await freshDrawer
      .getByRole('region', { name: 'Водительское удостоверение', exact: true })
      .getByLabel('Дата выдачи ВУ', { exact: true })
      .waitFor();
    assert.equal(await freshDrawer.getByLabel('ФИО', { exact: true }).count(), 0);
    assert.equal(await freshDrawer.getByLabel('Фамилия', { exact: true }).inputValue(), 'Смирнова');
    assert.equal(await freshDrawer.getByLabel('Имя', { exact: true }).inputValue(), 'Ксения');
    assert.equal(
      await freshDrawer.getByLabel('Отчество', { exact: true }).inputValue(),
      'Сергеевна',
    );
    const freshDriverStep = freshDrawer
      .locator('.checkout-steps .ant-steps-item')
      .filter({ hasText: 'Водитель' });
    const freshDriverHeading = freshDrawer
      .locator('.checkout-sections')
      .getByRole('tab', { name: /^Водитель/ });
    await freshDriverStep.and(page.locator('.ant-steps-item-wait')).waitFor();
    await freshDriverStep.getByText('Заполните данные', { exact: true }).waitFor();
    const freshSteps = freshDrawer.locator('.checkout-steps');
    await freshSteps.getByText('Сформируйте договор', { exact: true }).waitFor();
    await freshDrawer
      .locator('.checkout-section-contract')
      .getByText('Сформируйте договор', { exact: true })
      .waitFor();
    await freshSteps.getByText('Проведите осмотр', { exact: true }).waitFor();
    assert.equal(await freshDriverHeading.getAttribute('aria-expanded'), 'true');
    const legacyCustomer = await call('/customers/' + newCheckout.customerId);
    assert.ok(legacyCustomer.documentReadiness.missing.includes('phone'));
    assert.equal(legacyCustomer.details.firstName, undefined);
    const saveDriver = freshDrawer.getByRole('button', { name: 'Сохранить', exact: true });
    assert.equal(await saveDriver.isEnabled(), true);
    await freshDrawer.getByLabel('Фамилия', { exact: true }).fill('Проверочная');
    await freshDrawer.getByLabel('Отчество', { exact: true }).fill('');
    await freshDrawer.getByLabel('Имя', { exact: true }).fill('Анна');
    await freshDrawer.getByLabel('Электронная почта').fill('updated@example.test');
    await freshDrawer.getByLabel('Серия паспорта', { exact: true }).fill('12');
    await saveDriver.click();
    await freshDrawer.getByText('Введите ровно 4 цифр.', { exact: true }).waitFor();
    await freshDrawer.getByLabel('Серия паспорта', { exact: true }).fill('1234');
    await saveDriver.click();
    await freshDrawer.getByText('Заполните поле «Телефон».', { exact: true }).waitFor();
    await freshDrawer.getByLabel('Телефон', { exact: true }).fill('+79991234567');
    await freshDriverStep.and(page.locator('.ant-steps-item-wait')).waitFor();
    const unsavedDialog = page.getByRole('dialog', { name: 'Несохранённые изменения' });
    await stopButton.click();
    await stopDialog.getByText(/Несохранённые изменения будут потеряны/).waitFor();
    await stopDialog.getByRole('button', { name: 'Продолжить оформление' }).click();
    await stopDialog.waitFor({ state: 'hidden' });
    assert.equal(await freshDrawer.getByLabel('Имя', { exact: true }).inputValue(), 'Анна');
    await freshDrawer.locator('button.ant-drawer-close').click();
    await unsavedDialog.getByText('Сохраните изменения перед закрытием карточки.').waitFor();
    await unsavedDialog.getByRole('button', { name: 'Перейти к сохранению' }).click();
    await unsavedDialog.waitFor({ state: 'hidden' });
    assert.equal(await freshDrawer.getByLabel('Имя', { exact: true }).inputValue(), 'Анна');
    await saveDriver.click();
    await waitUntil(async () => {
      const saved = await call('/customers/' + newCheckout.customerId);
      return (
        saved.email === 'updated@example.test' &&
        saved.displayName === 'Проверочная Анна' &&
        saved.details.middleName === ''
      );
    }, 'inline customer edit');
    await freshDriverStep.and(page.locator('.ant-steps-item-finish')).waitFor();
    assert.equal(await freshDriverHeading.getAttribute('aria-expanded'), 'false');
    const freshDriverLink = freshDrawer.getByRole('link', {
      name: 'Проверочная Анна',
      exact: true,
    });
    assert.equal(await freshDriverLink.getAttribute('href'), '/clients/' + newCheckout.customerId);
    await freshDriverStep.getByText('Водитель', { exact: true }).click();
    await freshDrawer.getByLabel('Телефон', { exact: true }).waitFor();
    assert.equal(await freshDriverHeading.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByRole('menuitem', { name: 'Автомобиль / блокировка' }).count(), 0);
    await waitUntil(
      async () => (await call('/bookings/' + newCheckout.bookingId + '/documents')).checkout,
      'first checkout started',
    );
    const startedEvent = page.locator('.calendar-event').filter({ hasText: 'Проверочная Анна' });
    await startedEvent.getByRole('img', { name: 'Оформление' }).waitFor();
    const beforeStop = (await call(freshPath + '/documents')).checkout;
    assert.equal(beforeStop.hasChanges, true);
    await call(freshPath + '/checkout/stop', {
      body: {
        expectedBookingVersion: 1,
        expectedStartedAt: beforeStop.startedAt,
        confirmed: false,
      },
      status: 409,
      code: 'CHECKOUT_STOP_CONFIRMATION_REQUIRED',
    });
    await stopButton.click();
    await stopDialog.getByRole('button', { name: 'Прекратить оформление', exact: true }).click();
    await freshDrawer.waitFor({ state: 'hidden' });
    assert.equal((await call(freshPath + '/documents')).checkout, null);
    assert.equal(
      (await call('/customers/' + newCheckout.customerId)).displayName,
      'Проверочная Анна',
    );
    await startedEvent.getByRole('img', { name: 'Оформление' }).waitFor({ state: 'hidden' });
    await startedEvent.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Создать договор', exact: true }).click();
    const restarted = await waitUntil(
      async () => (await call(freshPath + '/documents')).checkout,
      'checkout restarted',
    );
    assert.notEqual(restarted.startedAt, beforeStop.startedAt);
    await call(freshPath + '/checkout/stop', {
      body: { expectedBookingVersion: 1, expectedStartedAt: beforeStop.startedAt, confirmed: true },
      status: 409,
      code: 'CHECKOUT_CHANGED',
    });
    await startedEvent.getByRole('img', { name: 'Оформление' }).waitFor();
    await freshDrawer.locator('button.ant-drawer-close').click();
    await freshDrawer.waitFor({ state: 'hidden' });
    const checkoutIndicator = startedEvent.getByRole('img', { name: 'Оформление' });
    assert.equal(
      await checkoutIndicator.evaluate((dot) => dot === dot.parentElement.firstElementChild),
      true,
    );
    assert.equal(await startedEvent.getByText('Оформление', { exact: true }).count(), 0);
    await startedEvent.locator('.calendar-event-tooltip').hover();
    await page
      .getByRole('tooltip')
      .locator('.ant-tag')
      .filter({ hasText: /^Оформление$/ })
      .waitFor();
    await startedEvent.click({ button: 'right' });
    const contractMenuItem = page.getByRole('menuitem', { name: 'Открыть договор', exact: true });
    await contractMenuItem.waitFor();
    assert.equal(
      await page.getByRole('menuitem', { name: 'Открыть бронь', exact: true }).count(),
      0,
    );
    await contractMenuItem.click();
    await freshDrawer.locator('button.ant-drawer-close').click();
    await freshDrawer.waitFor({ state: 'hidden' });
    await startedEvent.click();
    await freshDrawer.locator('.checkout-steps').getByText('Оплата', { exact: true }).click();
    await waitUntil(
      () =>
        freshDrawer
          .getByRole('button', { name: 'Подтвердить оплату аренды', exact: true })
          .isEnabled(),
      'checkout card unlocked',
    );
    const freshActHeader = freshDrawer.locator('.checkout-section-act > .ant-collapse-header');
    await freshActHeader.getByRole('tab', { expanded: false }).click();
    const freshVehicleRow = freshDrawer.locator('.checkout-section-act .inspection-toolbar');
    await freshVehicleRow.getByRole('button', { name: 'Заменить автомобиль', exact: true }).click();
    const vehicleChooser = page.getByRole('dialog', { name: 'Выберите автомобиль' });
    const lookupVehicle = vehicleChooser.getByRole('combobox', { name: 'Назначаемый автомобиль' });
    await vehicleChooser.locator('.ant-select-selector').click();
    await lookupVehicle.fill('321');
    const spareOption = page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .booking-vehicle-plate')
      .filter({ hasText: '321' });
    try {
      await spareOption.click({ timeout: 10000 });
    } catch (error) {
      throw new Error(
        'Vehicle picker: ' +
          (await vehicleChooser.innerText()) +
          ' · ' +
          (
            await page
              .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
              .allTextContents()
          ).join(' '),
        { cause: error },
      );
    }
    const moveDialog = page.getByRole('dialog', {
      name: 'Изменение брони №' + newCheckout.bookingId,
    });
    await moveDialog.getByRole('button', { name: 'Подтвердить изменения' }).click();
    await moveDialog.waitFor({ state: 'hidden' });
    await waitUntil(async () => {
      const updated = await call('/bookings/' + newCheckout.bookingId + '/documents');
      return updated.booking.vehicleId === spareVehicle && updated.booking.version === 2;
    }, 'vehicle replaced in inspection');
    await freshActHeader.getByRole('tab', { name: /^Акт.*X321XX774/, expanded: true }).waitFor();
    const assignedVehicleLink = freshVehicleRow.getByRole('link', { name: /X321XX774/ });
    assert.equal(await assignedVehicleLink.getAttribute('href'), '/fleet/' + spareVehicle);
    const calendarUrl = page.url();
    await assignedVehicleLink.click();
    await page.waitForURL('**/fleet/' + spareVehicle);
    await page.getByRole('heading', { name: /X321XX774/ }).waitFor();
    await page.goBack();
    await page.waitForURL(calendarUrl);
    await page.getByRole('heading', { name: 'График', exact: true }).waitFor();
    await freshActHeader.getByRole('tab', { name: /^Акт.*X321XX774/ }).waitFor();
    const tablet = await browser.newPage({ viewport: { width: 820, height: 950 }, hasTouch: true });
    await tablet
      .context()
      .addCookies([{ name: 'crm_session', value: tabletToken, url: webOrigin }]);
    await tablet.clock.setFixedTime(new Date('2026-11-23T10:00:00+03:00'));
    await tablet.goto(webOrigin + '/calendar');
    await tablet.locator('.calendar-event').filter({ hasText: 'Проверочная Анна' }).click();
    const tabletDrawer = tablet.getByRole('dialog');
    const tabletAct = tabletDrawer.getByRole('tab', { name: /^Акт.*X321XX774/ });
    await tabletAct.click();
    await tabletDrawer.getByRole('button', { name: 'Начать осмотр', exact: true }).click();
    const tabletOdometer = tabletDrawer.getByRole('spinbutton', { name: 'Одометр, км' });
    await tabletOdometer.waitFor();
    await page.bringToFront();
    const observerAct = freshDrawer
      .locator('.checkout-sections')
      .getByRole('tab', { name: /^Акт.*X321XX774/ });
    await observerAct
      .getByRole('status', { name: 'Осмотр заполняется. Ответственный: Петров Пётр', exact: true })
      .locator('.ant-badge-status-processing')
      .waitFor();
    await freshDrawer
      .locator('.checkout-steps')
      .locator('.ant-steps-item', { has: page.getByText('Акт', { exact: true }) })
      .locator('.ant-steps-item-icon')
      .getByRole('status', { name: 'Осмотр заполняется', exact: true })
      .locator('.anticon-loading')
      .waitFor();
    assert.equal(await freshDrawer.getByRole('spinbutton', { name: 'Одометр, км' }).count(), 0);
    const newPath = '/bookings/' + newCheckout.bookingId;
    const work = (await call(newPath + '/documents')).inspectionWork[0];
    assert.equal(work.operatorId, tabletOperator);
    await call(newPath + '/inspections/pickup/start', {
      body: { expectedBookingVersion: 2 },
      status: 409,
      code: 'INSPECTION_IN_PROGRESS',
    });
    await tablet.bringToFront();
    const resumeInspection = tabletDrawer.getByRole('button', {
      name: 'Продолжить осмотр',
      exact: true,
    });
    assert.equal(await resumeInspection.count(), 0);
    await tabletDrawer.locator('button.ant-drawer-close').click();
    await tabletDrawer.waitFor({ state: 'hidden' });
    await tablet.locator('.calendar-event').filter({ hasText: 'Проверочная Анна' }).click();
    await resumeInspection.click();
    await tabletOdometer.waitFor();
    assert.equal(await resumeInspection.count(), 0);
    await tabletOdometer.fill('250');
    const fuel = tabletDrawer.getByRole('slider', { name: 'Топливо, делений' });
    assert.equal(await tabletDrawer.getByText('Объём бака', { exact: true }).count(), 0);
    await tabletDrawer.getByRole('button', { name: 'Указать 0 делений' }).click();
    await fuel.press('ArrowRight');
    assert.equal(await fuel.getAttribute('aria-valuenow'), '1');
    await fuel.press('ArrowLeft');
    await tabletDrawer
      .getByRole('checkbox', { name: 'Подтверждаю сохранение осмотра без фото' })
      .check();
    const tabletHeader = tabletDrawer.locator('.checkout-section-act > .ant-collapse-header');
    await tabletHeader.getByRole('button', { name: 'Отменить', exact: true }).waitFor();
    await tabletHeader.getByRole('button', { name: 'Сохранить акт', exact: true }).click();
    const actInstruction =
      'Оператор заполнил данные. Сформируйте акт и дайте его клиенту на подпись.';
    await tabletAct.getByText(actInstruction, { exact: true }).waitFor();
    await page.bringToFront();
    await observerAct.getByText(actInstruction, { exact: true }).waitFor();
    await freshDrawer
      .locator('.checkout-steps')
      .getByText('Сформируйте акт', { exact: true })
      .waitFor();
    const observerActCard = freshDrawer.locator('.checkout-sections .checkout-section').filter({
      has: page.getByRole('tab', { name: /^Акт.*X321XX774/ }),
    });
    assert.equal(
      await observerActCard
        .getByRole('button', { name: 'Сформировать акт', exact: true })
        .isEnabled(),
      true,
    );
    assert.deepEqual((await call(newPath + '/documents')).inspectionWork, []);
    await tablet.context().close();
    await freshDrawer.locator('button.ant-drawer-close').click();
    await freshDrawer.waitFor({ state: 'hidden' });

    const bookingEvent = page
      .locator('.calendar-event')
      .filter({ hasText: 'Тестовый Арендатор' })
      .first();
    await bookingEvent.scrollIntoViewIfNeeded();
    await page.getByText('Загрузка дат…', { exact: true }).waitFor({ state: 'hidden' });
    await bookingEvent.click({ button: 'right', timeout: 10000 });
    await page.getByRole('menuitem', { name: 'Открыть договор' }).click({ timeout: 10000 });
    const drawer = page.getByRole('dialog');
    const driverSection = drawer
      .locator('.checkout-sections')
      .getByRole('tab', { name: /^Водитель/ });
    await driverSection.waitFor();
    await page.setViewportSize({ width: 820, height: 950 });
    const leftSteps = drawer.locator('.checkout-steps.ant-steps-vertical');
    await leftSteps.waitFor();
    await waitUntil(
      () =>
        drawer.evaluate((element) => {
          const steps = element.querySelector('.checkout-steps')?.getBoundingClientRect();
          const driver = element
            .querySelector('.checkout-section-driver .ant-collapse-header-text')
            ?.getBoundingClientRect();
          return steps && driver && steps.left < driver.left;
        }),
      'steps stay to the left of the checkout sections',
    );
    const sections = drawer.locator('.checkout-sections');
    const checkoutCollapse = sections.locator(':scope > .ant-collapse');
    assert.equal(await checkoutCollapse.count(), 1);
    assert.equal(await checkoutCollapse.locator(':scope > .checkout-section').count(), 4);
    assert.equal(await checkoutCollapse.getByRole('tab', { expanded: true }).count(), 0);
    const closedSection = (name) =>
      sections.getByRole('tab', { name, exact: true, expanded: false });
    await closedSection('Водитель').waitFor();
    const pay = drawer.getByRole('button', { name: 'Подтвердить оплату аренды', exact: true });
    const deposit = drawer.getByRole('button', {
      name: 'Подтвердить получение залога',
      exact: true,
    });
    const issue = drawer.getByRole('button', { name: 'Выдать автомобиль', exact: true });
    const issueBlockers = drawer.locator('.checkout-issue-blockers');
    const contractPrintHint = issueBlockers.getByRole('button', {
      name: 'Распечатайте договор',
      exact: true,
    });
    const actPrintHint = issueBlockers.getByRole('button', {
      name: 'Распечатайте акт',
      exact: true,
    });
    assert.equal(await issue.isDisabled(), true);
    await contractPrintHint.waitFor();
    await actPrintHint.waitFor();
    await issueBlockers.getByText('Подтвердите оплату аренды.', { exact: true }).waitFor();
    await issueBlockers.getByText('Подтвердите получение залога.', { exact: true }).waitFor();
    const readySteps = leftSteps.locator('.ant-steps-item-finish');
    const stepsInProgress = leftSteps.locator('.ant-steps-item-process');
    await stepsInProgress.getByText('Распечатайте договор', { exact: true }).waitFor();
    await stepsInProgress.getByText('Распечатайте акт', { exact: true }).waitFor();
    await leftSteps.getByText('Договор', { exact: true }).click();
    await waitUntil(async () => {
      const colors = await stepsInProgress
        .locator('.ant-steps-item-icon')
        .evaluateAll((icons) => icons.map((icon) => getComputedStyle(icon).backgroundColor));
      return colors.length === 2 && colors[0] !== colors[1];
    }, 'only the selected unfinished step has the accent color');
    await sections
      .locator('.checkout-section-contract')
      .getByText('Распечатайте договор', { exact: true })
      .waitFor();
    const openPdf = async (link) => {
      const popup = page.waitForEvent('popup');
      await link.click();
      await (await popup).close();
    };
    await openPdf(sections.getByRole('link', { name: 'Открыть договор', exact: true }));
    await readySteps.getByText('Договор', { exact: true }).waitFor();
    await contractPrintHint.waitFor({ state: 'hidden' });
    await actPrintHint.waitFor();
    await stepsInProgress.getByText('Распечатайте акт', { exact: true }).waitFor();
    await openPdf(sections.getByRole('link', { name: 'Открыть акт', exact: true }));
    await readySteps.getByText('Акт', { exact: true }).waitFor();
    await actPrintHint.waitFor({ state: 'hidden' });
    const reopened = await page.context().newPage();
    await reopened.clock.setFixedTime(new Date('2026-11-23T10:00:00+03:00'));
    await reopened.goto(webOrigin + '/calendar?booking=' + individual.bookingId);
    await reopened.getByRole('button', { name: 'Действия с бронью' }).click();
    await reopened.getByRole('menuitem', { name: 'Открыть договор', exact: true }).click();
    const reopenedSteps = reopened.locator('.checkout-steps .ant-steps-item-finish');
    await reopenedSteps.getByText('Договор', { exact: true }).waitFor();
    await reopenedSteps.getByText('Акт', { exact: true }).waitFor();
    await reopened.close();
    await page.bringToFront();
    assert.equal(await leftSteps.locator('.ant-steps-item').count(), 4);
    assert.equal(await sections.getByText('PDF готов', { exact: true }).count(), 0);
    assert.equal(await leftSteps.getByText('PDF готов', { exact: true }).count(), 0);
    const paymentStep = drawer.locator('.ant-steps-item').filter({ hasText: 'Оплата' });
    await paymentStep.and(page.locator('.ant-steps-item-wait')).waitFor();
    await paymentStep.getByText('Примите оплату и залог', { exact: true }).waitFor();
    await leftSteps.getByText('Договор', { exact: true }).click();
    await sections.getByRole('tab', { name: /^Договор/, expanded: true }).waitFor();
    await issueBlockers
      .getByRole('button', { name: /Подтвердите оплату аренды.*30\s000 ₽/ })
      .click();
    await sections.locator('[data-checkout-target="rent"][data-checkout-highlight]').waitFor();
    await sections.getByRole('tab', { name: /^Оплата(?: |$)/, expanded: true }).waitFor();
    await closedSection(/^Договор/).waitFor();
    await issueBlockers
      .getByRole('button', { name: /Подтвердите получение залога.*10\s000 ₽/ })
      .click();
    const highlightedDeposit = sections.locator(
      '[data-checkout-target="deposit"][data-checkout-highlight]',
    );
    await highlightedDeposit.waitFor();
    assert.equal(
      await highlightedDeposit.evaluate((element) => document.activeElement === element),
      true,
    );
    assert.equal(await checkoutCollapse.getByRole('tab', { expanded: true }).count(), 1);
    await waitUntil(
      async () => (await pay.isEnabled()) && (await deposit.isEnabled()),
      'receipts available while payment step is gray',
    );
    const rentColumn = drawer.getByRole('region', { name: 'Аренда', exact: true });
    const depositColumn = drawer.getByRole('region', { name: 'Залог', exact: true });
    await drawer.getByText('Ожидает подтверждения', { exact: true }).waitFor();
    const cashAmount = rentColumn.getByLabel('Аренда наличными, ₽');
    const bankAmount = rentColumn.getByLabel('Аренда картой, ₽');
    const rentChange = rentColumn.getByText('Сдача', { exact: true }).locator('..').locator('dd');
    assert.equal(await rentColumn.getByRole('checkbox', { name: 'Частичная оплата' }).count(), 0);
    assert.equal(await rentColumn.getByLabel('Оплата аренды, ₽').count(), 0);
    await cashAmount.fill('0');
    assert.equal(await pay.isDisabled(), true);
    await cashAmount.fill('35000');
    assert.equal(await rentChange.textContent(), '5\u00a0000 ₽');
    await rentColumn.getByRole('checkbox', { name: 'Картой', exact: true }).check();
    await bankAmount.fill('31000');
    assert.equal(await pay.isDisabled(), true);
    await bankAmount.fill('10000');
    await cashAmount.fill('25000');
    assert.equal(await rentChange.textContent(), '5\u00a0000 ₽');
    await cashAmount.fill('5000');
    assert.equal(await rentChange.textContent(), '0 ₽');
    const receiptEndpoint = '/financial-operations/checkout-receipt';
    const paymentResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(receiptEndpoint) && response.request().method() === 'POST',
    );
    await pay.click();
    const receipt = await paymentResponse;
    assert.equal(receipt.status(), 201);
    const receiptRequest = receipt.request();
    assert.deepEqual(
      await call(receiptEndpoint, {
        body: receiptRequest.postDataJSON(),
        key: receiptRequest.headers()['idempotency-key'],
        status: 201,
      }),
      await receipt.json(),
    );
    await paymentStep.and(page.locator('.ant-steps-item-process')).waitFor();
    await paymentStep.getByText('Подтвердите залог', { exact: true }).waitFor();
    await issueBlockers.getByText('Подтвердите оплату аренды.', { exact: true }).waitFor({
      state: 'hidden',
    });
    const rentSummary = rentColumn.locator('.checkout-payment-summary');
    const rentTotal = rentSummary
      .getByText('К оплате', { exact: true })
      .locator('..')
      .locator('dd');
    const rentPaid = rentSummary.getByText('Оплачено', { exact: true }).locator('..').locator('dd');
    const rentBalance = rentSummary
      .getByText('Осталось', { exact: true })
      .locator('..')
      .locator('dd');
    const editRent = rentColumn.getByRole('button', { name: 'Редактировать', exact: true });
    await waitUntil(
      () => editRent.isEnabled(),
      'rent receipt saved and additional payment available',
    );
    assert.equal(await rentTotal.textContent(), '30\u00a0000 ₽');
    assert.equal(await rentPaid.textContent(), '15\u00a0000 ₽');
    assert.equal(await rentBalance.textContent(), '15\u00a0000 ₽');
    assert.equal(await pay.isDisabled(), true);
    assert.equal(await cashAmount.isDisabled(), true);
    assert.equal(await bankAmount.isDisabled(), true);
    await editRent.click();
    assert.equal(await cashAmount.inputValue(), '0');
    assert.equal(await pay.isDisabled(), true);
    await cashAmount.fill('5000');
    await rentColumn.getByRole('button', { name: 'Отменить доплату', exact: true }).click();
    assert.equal(await pay.isDisabled(), true);
    assert.equal(await rentPaid.textContent(), '15\u00a0000 ₽');
    await editRent.click();
    assert.equal(await cashAmount.inputValue(), '0');
    await cashAmount.fill('5000');
    await pay.click();
    await waitUntil(() => editRent.isEnabled(), 'additional rent receipt saved');
    assert.equal(await rentTotal.textContent(), '30\u00a0000 ₽');
    assert.equal(await rentPaid.textContent(), '20\u00a0000 ₽');
    assert.equal(await rentBalance.textContent(), '10\u00a0000 ₽');
    assert.equal(await pay.isDisabled(), true);
    assert.equal(await depositColumn.getByRole('checkbox', { name: 'Картой' }).isDisabled(), true);
    assert.equal(await depositColumn.getByLabel('Залог, ₽', { exact: true }).count(), 0);
    await depositColumn
      .locator('.checkout-payment-summary')
      .getByText('10\u00a0000 ₽', { exact: true })
      .waitFor();
    const depositCash = depositColumn.getByLabel('Залог наличными, ₽');
    await depositCash.fill('9000');
    assert.equal(await deposit.isDisabled(), true);
    await depositCash.fill('15000');
    assert.equal(
      await depositColumn.locator('.checkout-payment-change').textContent(),
      '5\u00a0000 ₽',
    );
    const paymentDraftBlocker = issueBlockers.getByText('Сохраните изменения в разделе «Оплата».', {
      exact: true,
    });
    await paymentDraftBlocker.waitFor();
    await page.route(
      '**/api/v1' + receiptEndpoint,
      async (route) => {
        assert.equal((await route.fetch()).status(), 201);
        await route.abort();
      },
      { times: 1 },
    );
    await deposit.click();
    const checkReceipt = drawer.getByRole('button', { name: 'Проверить результат', exact: true });
    await checkReceipt.waitFor();
    await paymentStep.and(page.locator('.ant-steps-item-finish')).waitFor();
    assert.equal(await paymentStep.locator('.checkout-step-hint').count(), 0);
    await depositColumn
      .locator('.checkout-payment-summary')
      .getByText('10\u00a0000 ₽', { exact: true })
      .waitFor();
    await paymentDraftBlocker.waitFor({ state: 'hidden' });
    assert.equal(await depositCash.inputValue(), '0');
    assert.equal(await depositCash.isDisabled(), true);
    assert.equal(await deposit.isDisabled(), true);
    await checkReceipt.click();
    await checkReceipt.waitFor({ state: 'hidden' });
    const { items: receiptJournal } = await call(base + '/finance');
    assert.deepEqual(
      receiptJournal.flatMap(({ kind, external }) => external.map((entry) => ({ kind, ...entry }))),
      [
        { kind: 'deposit_receipt', method: 'cash', amountRub: '10000' },
        { kind: 'rent_payment', method: 'cash', amountRub: '5000' },
        { kind: 'rent_payment', method: 'bank', amountRub: '10000' },
        { kind: 'rent_payment', method: 'cash', amountRub: '5000' },
      ],
    );
    await issueBlockers.waitFor({ state: 'hidden' });
    assert.equal(await issue.isEnabled(), true);
    await waitUntil(
      async () => (await call(base + '/documents')).checkout.depositReceived,
      'both receipts before handover',
    );
    await sections.locator('.checkout-section-act').getByRole('tab', { expanded: false }).click();
    await closedSection('Оплата').waitFor();
    const currentStep = leftSteps.locator('[aria-current="step"]');
    assert.equal(await currentStep.count(), 1);
    await currentStep.getByText('Акт', { exact: true }).waitFor();
    const inspectionHeader = sections.locator('.checkout-section-act > .ant-collapse-header');
    const editInspection = sections
      .locator('.checkout-section-act .inspection-toolbar')
      .getByRole('button', { name: 'Изменить осмотр', exact: true });
    assert.equal(
      await inspectionHeader.getByRole('button', { name: 'Изменить осмотр' }).count(),
      0,
    );
    await editInspection.click();
    await inspectionHeader.getByRole('tab', { expanded: true }).waitFor();
    const odometer = drawer.getByRole('spinbutton', { name: 'Одометр, км' });
    await odometer.fill('103');
    await sections.locator('.inspection-toolbar').getByRole('link').click();
    await unsavedDialog.getByText('Сохраните изменения перед закрытием карточки.').waitFor();
    await unsavedDialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await unsavedDialog.waitFor({ state: 'hidden' });
    assert.equal(await odometer.inputValue(), '103');
    await drawer.getByRole('button', { name: 'Выдать автомобиль', exact: true }).click();
    await unsavedDialog.getByText('Сохраните изменения перед выдачей автомобиля.').waitFor();
    await unsavedDialog.getByRole('button', { name: 'Перейти к сохранению' }).click();
    await unsavedDialog.waitFor({ state: 'hidden' });
    assert.equal((await call(base + '/documents')).checkout.issuedAt, null);
    await delay(5500);
    assert.equal(await odometer.inputValue(), '103');
    assert.equal(await drawer.getByRole('checkbox', { name: 'Повреждений нет' }).count(), 0);
    const photoInput = drawer.locator('input[type="file"][multiple]');
    const filePayload = { name: 'inspection.png', mimeType: 'image/png', buffer: png };
    const uploadUrl = '**/api/v1' + base + '/inspection-photos/pickup/1';
    await page.route(
      uploadUrl,
      async (route) => {
        assert.equal((await route.fetch()).status(), 201);
        await route.abort();
      },
      { times: 1 },
    );
    await photoInput.setInputFiles([filePayload, { ...filePayload, name: 'dashboard.png' }]);
    await drawer.getByRole('button', { name: 'Проверить результат', exact: true }).click();
    const thumbnails = drawer.locator('.ant-upload-list-item-image');
    function waitForThumbnails(count) {
      return waitUntil(
        () =>
          thumbnails.evaluateAll(
            (images, expected) =>
              images.length === expected &&
              images.every((img) => img.complete && img.naturalWidth > 0),
            count,
          ),
        'private photo thumbnails',
      );
    }
    await waitForThumbnails(2);
    assert.equal(await drawer.getByRole('button', { name: 'Сделать снимок' }).isVisible(), false);
    const device = await page.context().newCDPSession(page);
    await device.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page.setViewportSize({ width: 390, height: 844 });
    const camera = drawer.locator('input[type="file"][capture="environment"]');
    assert.equal(await camera.getAttribute('accept'), 'image/jpeg,image/png');
    const chooserPending = page.waitForEvent('filechooser');
    await drawer.getByRole('button', { name: 'Сделать снимок' }).click();
    const chooser = await chooserPending;
    assert.equal(await chooser.isMultiple(), false);
    assert.equal(await chooser.element().getAttribute('capture'), 'environment');
    await chooser.setFiles({ ...filePayload, name: 'camera.png' });
    await device.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await waitForThumbnails(3);
    const editPhoto = drawer.locator('.inspection-photos-edit .ant-upload-list-item-done').first();
    assert.equal(
      await editPhoto.locator('img').evaluate((image) => getComputedStyle(image).objectFit),
      'cover',
    );
    assert.equal(
      await editPhoto.evaluate((photo) => getComputedStyle(photo, '::before').display),
      'none',
    );
    const photoActions = editPhoto.locator('.ant-upload-list-item-actions');
    await page.mouse.move(0, 0);
    await waitUntil(
      () => photoActions.evaluate((actions) => getComputedStyle(actions).opacity === '0'),
      'remove button is hidden outside the thumbnail',
    );
    await editPhoto.hover();
    await waitUntil(
      () => photoActions.evaluate((actions) => getComputedStyle(actions).opacity === '1'),
      'remove button is visible on hover',
    );
    assert.equal(await photoActions.locator('a').count(), 0);
    assert.equal(await drawer.getByRole('link', { name: 'Скачать', exact: true }).count(), 0);
    await editPhoto.locator('a.ant-upload-list-item-thumbnail').click();
    const photoPreview = page.getByRole('dialog', { name: 'Фото осмотра' });
    await photoPreview.getByRole('img', { name: 'Фото осмотра' }).waitFor();
    await photoPreview.locator('button.ant-modal-close').click();
    await photoPreview.waitFor({ state: 'hidden' });
    await editPhoto.hover();
    await photoActions.locator('button').click();
    await waitForThumbnails(2);
    await page.setViewportSize({ width: 820, height: 950 });
    await inspectionHeader.getByRole('button', { name: 'Сохранить акт', exact: true }).click();
    await sections.locator('.inspection-metrics').getByText('103 км', { exact: true }).waitFor();
    await sections.getByRole('heading', { name: 'Параметры при осмотре', exact: true }).waitFor();
    assert.equal(await sections.getByText('Объём бака', { exact: true }).count(), 0);
    assert.equal(await sections.locator('.inspection-photo-count').innerText(), '2');
    const savedPhoto = sections
      .locator('.inspection-photos a.ant-upload-list-item-thumbnail')
      .first();
    await savedPhoto.focus();
    await savedPhoto.press('Enter');
    await photoPreview.getByRole('img', { name: 'Фото осмотра' }).waitFor();
    await photoPreview.locator('button.ant-modal-close').click();
    await photoPreview.waitFor({ state: 'hidden' });
    const savedNotes = sections.locator('.inspection-notes');
    assert.deepEqual(
      (await savedNotes.locator('dt').allTextContents()).map((label) => label.trim()),
      ['Описание повреждений', 'Особые пометки'],
    );
    assert.deepEqual(await savedNotes.locator('dd').allTextContents(), [
      'Повреждений нет',
      'Тестовая пометка',
    ]);
    const savedInspection = (await call(base + '/documents')).inspections[0];
    assert.equal(savedInspection.noDamage, true);
    assert.equal(new Set(savedInspection.photoIds).size, 2);
    assert.equal(await drawer.getByRole('link', { name: 'Открыть договор' }).count(), 1);
    assert.equal(
      await drawer.getByRole('button', { name: 'Подтвердить подпись договора' }).count(),
      0,
    );
    await call(base + '/checkout/issue', {
      body: { expectedBookingVersion: 1 },
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    await call(base + '/checkout/issue', {
      body: { expectedBookingVersion: 1, contractVersionId: next.id, actVersionId: oldAct.id },
      status: 422,
      code: 'DOCUMENTS_NOT_READY',
    });
    await closedSection('Водитель').waitFor();
    await leftSteps.getByText('Договор', { exact: true }).click();
    await sections.getByRole('tab', { name: /^Договор/, expanded: true }).click();
    const closedContract = closedSection(/^Договор/);
    await closedContract.waitFor();
    assert.match(await closedContract.innerText(), /30\s000 ₽/);
    const printClosedContract = sections
      .locator('.checkout-section')
      .filter({ has: page.getByRole('tab', { name: /^Договор/, expanded: false }) })
      .locator('.ant-collapse-header')
      .getByRole('link', { name: 'Открыть договор' });
    await printClosedContract.waitFor();
    assert.equal(await printClosedContract.innerText(), 'Открыть');
    await leftSteps.getByText('Договор', { exact: true }).click();
    const contractHeading = sections.getByRole('tab', {
      name: /^Договор/,
      expanded: true,
    });
    await contractHeading.waitFor();
    assert.equal(await checkoutCollapse.getByRole('tab', { expanded: true }).count(), 1);
    assert.ok(
      await contractHeading.evaluate((heading) => {
        const scrollPane = heading.closest('.ant-drawer-body').getBoundingClientRect();
        const position = heading.getBoundingClientRect();
        return (
          document.activeElement === heading &&
          position.top >= scrollPane.top - 1 &&
          position.bottom <= scrollPane.bottom
        );
      }),
    );
    const contractCard = sections.locator('.checkout-section').filter({
      has: page.getByRole('tab', { name: /^Договор/, expanded: true }),
    });
    await contractCard.getByRole('heading', { name: 'Условия аренды', exact: true }).waitFor();
    await contractCard.getByRole('link', { name: 'Открыть договор' }).waitFor();
    const contractSummary = contractCard.locator('.contract-summary');
    await contractSummary.getByText('2 дня', { exact: true }).waitFor();
    const dailyRate = contractSummary.locator('dt').filter({ hasText: /^Стоимость суток$/ });
    await dailyRate.locator('+ dd').getByText('30\u00a0000 ₽', { exact: true }).waitFor();
    await contractSummary.getByText('10\u00a0000 ₽', { exact: true }).waitFor();
    assert.equal(
      await contractSummary.locator('.contract-summary-mileage [aria-current="true"]').innerText(),
      '250 км',
    );
    await contractSummary.getByRole('button', { name: 'Лояльность и скидки' }).click();
    await contractSummary.getByText('№ 2 — Согласованный день', { exact: true }).waitFor();
    const inlineDays = contractCard.getByRole('combobox', { name: 'Срок аренды' });
    assert.equal(await inlineDays.count(), 0);
    assert.equal(await contractCard.getByLabel('Залог по договору, ₽').count(), 0);
    await contractCard.getByRole('button', { name: 'Изменить договор', exact: true }).click();
    await inlineDays.waitFor();
    await contractCard.getByText('2 дня', { exact: true }).waitFor();
    await contractHeading.getByText('Редактирование договора', { exact: true }).waitFor();
    await contractCard.getByRole('link', { name: 'Открыть договор' }).waitFor();
    await contractCard.getByRole('textbox', { name: 'Стоимость аренды' }).waitFor();
    await contractCard.getByRole('button', { name: 'Сохранить изменения' }).waitFor();
    const editViewport = page.viewportSize();
    const termsFields = contractCard.locator('.contract-terms-fields');
    const financeFields = contractCard.locator('.contract-edit-finance');
    const assertFieldRows = async (locator, expected) => {
      const layout = await locator.evaluate((fields) => ({
        rows: new Set(Array.from(fields.children, (field) => field.getBoundingClientRect().top))
          .size,
        width: fields.clientWidth,
        scrollWidth: fields.scrollWidth,
        columns: getComputedStyle(fields).gridTemplateColumns,
      }));
      assert.equal(layout.rows, expected, JSON.stringify(layout));
      assert.equal(layout.scrollWidth, layout.width, JSON.stringify(layout));
    };
    await page.setViewportSize({ width: 1440, height: 950 });
    await assertFieldRows(termsFields, 1);
    await assertFieldRows(financeFields, 1);
    await page.setViewportSize({ width: 390, height: 950 });
    await assertFieldRows(termsFields, 3);
    await assertFieldRows(financeFields, 2);
    await page.setViewportSize(editViewport);
    assert.equal(
      await contractCard.getByRole('button', { name: 'Изменить условия аренды' }).count(),
      0,
    );
    assert.equal(
      await contractCard.getByRole('button', { name: 'Сохранить', exact: true }).count(),
      0,
    );
    await inlineDays.fill('3');
    await inlineDays.press('Enter');
    await contractCard.getByRole('link', { name: 'Открыть договор' }).waitFor({ state: 'hidden' });
    assert.equal(
      await contractCard.getByRole('button', { name: 'Открыть договор' }).isDisabled(),
      true,
    );
    await contractCard.getByRole('button', { name: 'Отменить', exact: true }).click();
    await contractSummary.getByText('2 дня', { exact: true }).waitFor();
    await contractCard.getByRole('link', { name: 'Открыть договор' }).waitFor();
    const latestInspection = (await call(base + '/documents')).inspections.find(
      (i) => i.kind === 'pickup',
    );
    const actInput = { expectedBookingVersion: 1, inspectionRevisionId: latestInspection.id };
    await call(base + '/checkout/sign-act', {
      body: { ...actInput, actVersionId: 999999, confirmed: true },
      status: 422,
      code: 'ACT_NOT_READY',
    });
    const actCard = sections.locator('.checkout-section-act');
    const actHeading = actCard.getByRole('tab');
    await issueBlockers
      .getByRole('button', { name: 'Сформируйте актуальный акт.', exact: true })
      .click();
    await actCard
      .locator('[data-checkout-target="act-document"][data-checkout-highlight]')
      .waitFor();
    await actCard.getByRole('tab', { name: /^Акт/, expanded: true }).click();
    await actCard.getByRole('tab', { expanded: false }).waitFor();
    const generation = Promise.withResolvers();
    await page.route(
      '**/api/v1' + base + '/acts',
      async (route) => {
        await generation.promise;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await actCard
        .locator('.ant-collapse-header')
        .getByRole('button', { name: 'Сформировать акт', exact: true })
        .click();
      const generatingButton = actCard.getByRole('button', { name: 'Формируем акт…', exact: true });
      await generatingButton.locator('.ant-btn-loading-icon').waitFor();
      assert.equal(await generatingButton.getAttribute('aria-busy'), 'true');
      await actHeading.getByText('Формируем акт…', { exact: true }).waitFor();
      await stepsInProgress.getByText('Формируем акт…', { exact: true }).waitFor();
      await issueBlockers.getByRole('button', { name: 'Формируем акт…', exact: true }).waitFor();
      assert.equal(await actCard.getByText('PDF акта формируется', { exact: true }).count(), 0);
      await openPdf(sections.getByRole('link', { name: 'Открыть договор', exact: true }));
    } finally {
      generation.resolve();
    }
    assert.equal(await actHeading.getAttribute('aria-expanded'), 'false');
    const printAct = actCard
      .locator('.ant-collapse-header')
      .getByRole('link', { name: 'Открыть акт' });
    await printAct.waitFor();
    assert.equal(
      await issueBlockers.getByRole('button', { name: 'Формируем акт…', exact: true }).count(),
      0,
    );
    assert.equal(await printAct.innerText(), 'Открыть');
    assert.equal(await actHeading.getAttribute('aria-expanded'), 'false');
    await stepsInProgress.getByText('Распечатайте акт', { exact: true }).waitFor();
    const act = (await call(base + '/documents')).acts[0];
    assert.equal(
      await printAct.getAttribute('href'),
      '/api/v1' + base + '/acts/' + act.id + '/pdf',
    );
    await openPdf(printAct);
    await readySteps.getByText('Акт', { exact: true }).waitFor();
    await actHeading.click();
    const duplicateAct = await call(base + '/acts', { body: actInput, status: 201 });
    assert.equal(duplicateAct.id, act.id);
    const actPath = base + '/act-files/' + act.fileId;
    await call(other + '/act-files/' + act.fileId, { status: 404, code: 'NOT_FOUND' });
    await call(actPath, { anonymous: true, status: 401, code: 'UNAUTHENTICATED' });
    await waitUntil(
      async () =>
        fs.stat(path.join(storage, 'objects', oldActVersion.fileId)).then(
          () => false,
          (error) => error.code === 'ENOENT',
        ),
      'superseded act bytes removed',
    );
    assert.deepEqual(
      (await call(base + '/documents')).acts.map((version) => version.id),
      [act.id],
    );
    const restoredAct = Buffer.from(
      await (await call(base + '/acts/' + oldAct.id + '/pdf')).arrayBuffer(),
    );
    assert.match(restoredAct.subarray(0, 8).toString(), /^%PDF-/);
    const actPdf = Buffer.from(await (await call(actPath)).arrayBuffer());
    assert.match(actPdf.subarray(0, 8).toString(), /^%PDF-/);
    if (process.env.STAGE6_PDF_QA_DIR)
      await fs.writeFile(path.join(process.env.STAGE6_PDF_QA_DIR, 'inspection-act.pdf'), actPdf);
    assert.equal(await drawer.getByRole('button', { name: 'Подтвердить подпись акта' }).count(), 0);
    await call(base + '/checkout/issue', {
      body: { expectedBookingVersion: 1, contractVersionId: next.id, actVersionId: oldAct.id },
      status: 409,
      code: 'ISSUE_DOCUMENTS_CHANGED',
    });
    await call(base + '/cancel', {
      body: { expectedVersion: 1, reason: 'Синтетическая попытка отмены' },
      status: 409,
      code: 'CHECKOUT_HAS_MONEY',
    });
    const beforeIssue = (await call(base + '/documents')).checkout;
    await call(base + '/checkout/stop', {
      body: {
        expectedBookingVersion: 1,
        expectedStartedAt: beforeIssue.startedAt,
        confirmed: true,
      },
      status: 409,
      code: 'CHECKOUT_HAS_MONEY',
    });
    assert.equal(beforeIssue.issuedAt, null);
    assert.equal(beforeIssue.currentContractSigned, false);
    assert.equal(beforeIssue.currentActSigned, false);
    await drawer.getByRole('button', { name: 'Выдать автомобиль' }).click();
    const issuedCheckout = await waitUntil(async () => {
      const { checkout } = await call(base + '/documents');
      return checkout.issuedAt && checkout;
    }, 'actual handover');
    assert.equal(issuedCheckout.currentContractSigned, true);
    assert.equal(issuedCheckout.currentActSigned, true);
    await closedSection(/^Акт.*Марка 1 Модель/).waitFor();
    await drawer.getByText('Автомобиль выдан', { exact: true }).waitFor();
    assert.equal(await leftSteps.getByText('Подписан', { exact: true }).count(), 2);
    await call(base + '/checkout/issue', {
      body: { expectedBookingVersion: 1, contractVersionId: next.id, actVersionId: act.id },
      status: 409,
      code: 'VEHICLE_ALREADY_ISSUED',
    });
    await closedSection('Оплата').waitFor();
    await leftSteps.getByText('Оплата', { exact: true }).click();
    await waitUntil(() => editRent.isEnabled(), 'issued checkout can accept additional rent');
    assert.equal(await pay.isDisabled(), true);
    await drawer.locator('button.ant-drawer-close').click();
    await drawer.waitFor({ state: 'hidden' });
    await bookingEvent.and(page.locator('.booking-unpaid')).waitFor();
    await bookingEvent.click();
    const issuedTag = drawer
      .locator('.ant-drawer-title .ant-tag')
      .getByText('Автомобиль выдан', { exact: true });
    await issuedTag.waitFor();
    await checkoutCollapse.getByRole('tab', { name: 'Акт приемки', exact: true }).waitFor();
    assert.equal(await checkoutCollapse.locator(':scope > .checkout-section').count(), 6);
    assert.equal(await leftSteps.locator('.ant-steps-item').count(), 6);
    assert.equal(await checkoutCollapse.getByRole('tab', { expanded: true }).count(), 0);
    await drawer.getByRole('link', { name: 'Арендатор Тестовый', exact: true }).click();
    await page.waitForURL('**/clients/' + individual.customerId);
    await page.goBack();
    await issuedTag.waitFor();
    await drawer.locator('button.ant-drawer-close').click();
    await drawer.waitFor({ state: 'hidden' });

    await bookingEvent.click({ button: 'right' });
    const completeRental = page.getByRole('menuitem', { name: 'Завершить аренду', exact: true });
    await completeRental.waitFor();
    const rentalMenu = page.getByRole('menu').filter({ has: completeRental });
    assert.equal(
      await rentalMenu.getByRole('menuitem', { name: 'Открыть бронь', exact: true }).count(),
      0,
    );
    await rentalMenu.getByRole('menuitem', { name: 'Открыть договор', exact: true }).click();
    await issuedTag.waitFor();
    await drawer.locator('button.ant-drawer-close').click();
    await drawer.waitFor({ state: 'hidden' });
    await bookingEvent.click({ button: 'right' });
    await completeRental.click();
    await checkoutCollapse
      .getByRole('tab', { name: 'Акт приемки', exact: true, expanded: true })
      .waitFor();
    await leftSteps.getByText('Сдача автомобиля', { exact: true }).click();
    await checkoutCollapse
      .getByRole('tab', { name: 'Сдача автомобиля', exact: true, expanded: true })
      .waitFor();
    await drawer.locator('button.ant-drawer-close').click();
    await drawer.waitFor({ state: 'hidden' });

    const finalPayment = await call('/financial-operations', {
      body: { ...payment, amountRub: '10000' },
      status: 201,
    });
    await bookingEvent.and(page.locator('.booking-paid')).waitFor();
    const { items: paidJournal } = await call(base + '/finance');
    assert.equal(paidJournal.length, receiptJournal.length + 1);
    assert.deepEqual(paidJournal.slice(1), receiptJournal);
    assert.equal(paidJournal[0].id, finalPayment.id);
    assert.equal(paidJournal[0].kind, 'rent_payment');
    assert.deepEqual(paidJournal[0].external, [{ method: 'cash', amountRub: '10000' }]);
    assert.equal(
      (
        await pool.query('SELECT act_version_id FROM booking_checkouts WHERE booking_id=$1', [
          individual.bookingId,
        ])
      ).rows[0].act_version_id,
      act.id,
    );
    assert.equal((await call(base + '/finance')).summary.depositRub, '10000');
    await call('/financial-operations', {
      body: {
        ...payment,
        customerId: newCheckout.customerId,
        bookingId: newCheckout.bookingId,
        expectedVersion: 2,
      },
      status: 201,
    });
    const previousContract = await call(freshPath + '/contracts', {
      status: 201,
      body: { ...initial, expectedCustomerVersion: 2, expectedBookingVersion: 2 },
    });
    await getReady(freshPath, previousContract.id);
    const freshInspection = (await call(freshPath + '/documents')).inspections.find(
      (inspection) => inspection.kind === 'pickup',
    );
    const freshAct = await call(freshPath + '/acts', {
      status: 201,
      body: { expectedBookingVersion: 2, inspectionRevisionId: freshInspection.id },
    });
    await waitUntil(
      async () =>
        (await call(freshPath + '/documents')).acts.some(
          (act) => act.id === freshAct.id && act.status === 'ready',
        ),
      'current act ready before contract generation',
    );
    const existingEvent = page.locator('.calendar-event').filter({ hasText: 'Проверочная Анна' });
    await existingEvent.click();
    const revisionCard = page
      .getByRole('dialog')
      .locator('.checkout-sections .checkout-section')
      .filter({
        has: page.getByRole('tab', { name: /^Договор/ }),
      });
    await revisionCard.getByRole('tab', { name: /^Договор/, expanded: false }).click();
    const oldPrint = revisionCard.getByRole('link', { name: 'Открыть договор' });
    await oldPrint.waitFor();
    const revisionSummary = revisionCard.locator('.contract-summary');
    await revisionSummary.getByRole('heading', { name: 'Условия аренды', exact: true }).waitFor();
    assert.equal(
      await revisionSummary.getByText('Лояльность и скидки', { exact: true }).count(),
      0,
    );
    assert.equal(await revisionCard.getByText(/^КАСКО:/).count(), 0);
    assert.equal(
      await revisionCard.getByRole('button', { name: 'Сохранить', exact: true }).count(),
      0,
    );
    for (const label of [
      'Тип клиента',
      'Фамилия',
      'Марка и модель',
      'Автомобиль',
      'Модель или группа аналогов',
    ]) {
      assert.equal(await revisionCard.getByLabel(label, { exact: true }).count(), 0, label);
    }
    assert.equal(
      await revisionCard.getByText('Другие варианты бронирования', { exact: true }).count(),
      0,
    );
    await revisionCard.getByRole('button', { name: 'Изменить договор' }).click();
    const depositField = revisionCard.getByLabel('Залог по договору, ₽');
    await depositField.fill('12500');
    const additionalDriver = revisionCard.getByRole('checkbox', {
      name: 'Указать дополнительного водителя',
    });
    assert.equal(await additionalDriver.isChecked(), true);
    const additionalDriverName = revisionCard.getByLabel('ФИО', { exact: true });
    await additionalDriverName.fill('Проверочный Дополнительный Водитель');
    const revisionDays = revisionCard.getByRole('combobox', { name: 'Срок аренды' });
    await revisionDays.fill('3');
    await revisionDays.press('Enter');
    await oldPrint.waitFor({ state: 'hidden' });
    await depositField.waitFor({ state: 'visible' });
    assert.equal(await depositField.inputValue(), '12\u00a0500 ₽');
    assert.equal(await depositField.isEnabled(), true);
    assert.equal(await additionalDriver.isEnabled(), true);
    assert.equal(await additionalDriverName.inputValue(), 'Проверочный Дополнительный Водитель');
    assert.equal(
      await revisionCard.getByRole('button', { name: 'Сохранить', exact: true }).count(),
      0,
    );
    const saveTerms = page.waitForRequest(
      (request) => request.method() === 'PATCH' && request.url().endsWith(freshPath + '/terms'),
    );
    const revisionHeading = revisionCard.getByRole('tab', { name: /^Договор/ });
    const contractGeneration = Promise.withResolvers();
    await page.route(
      '**/api/v1' + freshPath + '/terms',
      async (route) => {
        await contractGeneration.promise;
        await route.continue();
      },
      { times: 1 },
    );
    const reissueDrawer = page.getByRole('dialog');
    try {
      await revisionCard.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
      await revisionHeading.click();
      assert.equal(await revisionHeading.getAttribute('aria-expanded'), 'false');
      const generatingContract = revisionCard.getByRole('button', {
        name: 'Формируем договор…',
        exact: true,
      });
      await generatingContract.locator('.ant-btn-loading-icon').waitFor();
      assert.equal(await generatingContract.getAttribute('aria-busy'), 'true');
      await revisionHeading.getByText('Формируем договор…', { exact: true }).waitFor();
      await reissueDrawer
        .locator('.checkout-steps')
        .getByText('Формируем договор…', { exact: true })
        .waitFor();
      await reissueDrawer
        .locator('.checkout-issue-blockers')
        .getByRole('button', { name: 'Формируем договор…', exact: true })
        .waitFor();
      assert.equal(
        await revisionCard.getByText('PDF договора формируется…', { exact: true }).count(),
        0,
      );
      await openPdf(reissueDrawer.getByRole('link', { name: 'Открыть акт', exact: true }));
    } finally {
      contractGeneration.resolve();
    }
    assert.equal(await revisionHeading.getAttribute('aria-expanded'), 'false');
    const submittedTerms = (await saveTerms).postDataJSON();
    assert.equal(submittedTerms.customer, undefined);
    assert.equal(submittedTerms.vehicleId, spareVehicle);
    assert.deepEqual(submittedTerms.target, { type: 'brand', id: broadTarget.brand_id });
    const changedBooking = await waitUntil(async () => {
      const booking = await call(freshPath);
      return booking.version === 3 && booking;
    }, 'changed terms persisted through booking editor');
    const savedTerms = changedBooking.terms[0].snapshot;
    assert.equal(savedTerms.contractDays, 3);
    assert.equal(changedBooking.vehicle_id, spareVehicle);
    assert.equal((await call('/customers/' + newCheckout.customerId)).version, 2);
    const updatedPrice =
      new Intl.NumberFormat('ru-RU').format(BigInt(savedTerms.finalTotalRub)) + ' ₽';
    const changed = await waitUntil(async () => {
      const latest = (await call(freshPath + '/documents')).contracts[0];
      return latest?.bookingVersion === 3 && latest;
    }, 'new PDF requested for the recalculated terms');
    const changedSnapshot = (
      await pool.query('SELECT snapshot FROM contract_versions WHERE id=$1', [changed.id])
    ).rows[0].snapshot;
    assert.equal(changedSnapshot.terms.finalTotalRub, savedTerms.finalTotalRub);
    assert.equal(changedSnapshot.terms.contractDays, 3);
    assert.equal(changedSnapshot.securityDepositRub, '12500');
    assert.equal(changedSnapshot.additionalDriver.fullName, 'Проверочный Дополнительный Водитель');
    await getReady(freshPath, changed.id);
    const printRevision = revisionCard
      .locator('.ant-collapse-header')
      .getByRole('link', { name: 'Открыть договор' });
    await printRevision.waitFor();
    assert.equal(await printRevision.innerText(), 'Открыть');
    assert.equal(
      await reissueDrawer
        .locator('.checkout-issue-blockers')
        .getByText('Формируем договор…', { exact: true })
        .count(),
      0,
    );
    assert.equal(await revisionHeading.getAttribute('aria-expanded'), 'false');
    assert.equal(
      await printRevision.getAttribute('href'),
      '/api/v1' + freshPath + '/contracts/' + changed.id + '/pdf',
    );
    await revisionHeading.click();
    await revisionCard
      .locator('.contract-summary-finance')
      .getByText(updatedPrice, { exact: true })
      .waitFor();
    await revisionCard
      .locator('.contract-summary-terms')
      .getByText('3 дня', { exact: true })
      .waitFor();
    await revisionCard
      .locator('.contract-summary-finance')
      .getByText('12\u00a0500 ₽', { exact: true })
      .waitFor();
    assert.equal((await call(freshPath + '/finance')).summary.coverageRub, payment.amountRub);
    await call('/vehicles/' + individual.vehicleId + '/archive', {
      body: { expectedVersion: 1, reason: 'Синтетическая попытка архивации' },
      status: 409,
      code: 'VEHICLE_ALREADY_ISSUED',
    });

    const actAfterTerms = {
      expectedBookingVersion: changedBooking.version,
      inspectionRevisionId: freshInspection.id,
    };
    const actBeforeCustomerChange = await call(freshPath + '/acts', {
      status: 201,
      body: actAfterTerms,
    });
    await waitUntil(async () => {
      const [act] = (await call(freshPath + '/documents')).acts;
      return (
        act?.id === actBeforeCustomerChange.id && act.status === 'ready' && act.matchesCustomer
      );
    }, 'act is current before editing the customer');
    const customerPath = '/customers/' + newCheckout.customerId;
    const { version, type, phone, email, inn, details } = await call(customerPath);
    const customerAfterEdit = await call(customerPath, {
      verb: 'PATCH',
      body: {
        expectedVersion: version,
        data: {
          type,
          phone,
          email,
          inn,
          displayName: 'Проверочная Мария',
          details: { ...details, firstName: 'Мария' },
        },
      },
    });
    const [staleAct] = (await call(freshPath + '/documents')).acts;
    assert.equal(staleAct.id, actBeforeCustomerChange.id);
    assert.equal(staleAct.matchesCustomer, false);
    await call(freshPath + '/checkout/sign-act', {
      body: { ...actAfterTerms, actVersionId: staleAct.id, confirmed: true },
      status: 422,
      code: 'ACT_NOT_READY',
    });
    const currentContract = await call(freshPath + '/contracts', {
      status: 201,
      body: {
        ...initial,
        expectedBookingVersion: changedBooking.version,
        expectedCustomerVersion: customerAfterEdit.version,
        expectedContractVersionId: changed.id,
      },
    });
    await getReady(freshPath, currentContract.id);
    await call(freshPath + '/checkout/issue', {
      body: {
        expectedBookingVersion: changedBooking.version,
        contractVersionId: currentContract.id,
        actVersionId: staleAct.id,
      },
      status: 422,
      code: 'DOCUMENTS_NOT_READY',
    });
    const updatedAct = await call(freshPath + '/acts', { body: actAfterTerms, status: 201 });
    assert.notEqual(updatedAct.id, staleAct.id);
    assert.deepEqual(
      await call(freshPath + '/acts', { body: actAfterTerms, status: 201 }),
      updatedAct,
    );
    const {
      rows: [actSnapshot],
    } = await pool.query(
      'SELECT customer_version,snapshot FROM inspection_act_versions WHERE id=$1',
      [updatedAct.id],
    );
    assert.equal(actSnapshot.customer_version, customerAfterEdit.version);
    assert.equal(actSnapshot.snapshot.customerSigner, 'Проверочная Мария');
  },
);
