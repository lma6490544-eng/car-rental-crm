const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

test('Stage 1: real PostgreSQL + HTTP integration', { timeout: 120000 }, async (t) => {
  const originalUrl = process.env.DATABASE_URL;
  assert.ok(originalUrl, 'DATABASE_URL required');
  const adminPool = new Pool({ connectionString: originalUrl });
  const name = 'crm_stage1_test_' + randomBytes(8).toString('hex');
  const testUrl = new URL(originalUrl);
  testUrl.pathname = '/' + name;
  let pool, child;
  let logs = '';
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    if (pool) await pool.end();
    // Only the fresh database created by this test is eligible for cleanup.
    assert.match(name, /^crm_stage1_test_[a-f0-9]{16}$/);
    await adminPool.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await adminPool.end();
  });
  await adminPool.query('CREATE DATABASE "' + name + '"');
  pool = new Pool({ connectionString: testUrl.toString() });
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  const password = randomBytes(6).toString('base64url');
  const bootstrapAdmin = (adminPassword) =>
    spawnSync(process.execPath, ['dist/bootstrap-admin.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        DATABASE_URL: testUrl.toString(),
        ADMIN_LOGIN: 'admin',
        ADMIN_FULL_NAME: 'Test admin',
        ADMIN_PASSWORD: adminPassword,
      },
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
  const rejected = bootstrapAdmin(password.slice(1));
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 1, 'bootstrap must reject a seven-character password');
  const created = bootstrapAdmin(password);
  assert.ifError(created.error);
  assert.equal(created.status, 0, 'bootstrap must accept an eight-character password');
  const admins = await pool.query("SELECT id FROM users WHERE login='admin' AND role='admin'");
  assert.equal(admins.rowCount, 1);
  const adminId = admins.rows[0].id;
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const origin = 'http://127.0.0.1:5173';
  const base = 'http://127.0.0.1:' + port + '/api/v1';
  child = spawn(process.execPath, ['dist/main.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      API_PORT: String(port),
      APP_ORIGINS: origin,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (data) => {
    logs += data.toString();
  });
  child.stderr.on('data', (data) => {
    logs += data.toString();
  });
  let started = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/health')).ok) {
        started = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(started, 'Test API should start: ' + logs);
  async function request(route, { method = 'GET', body, session, key, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
        ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...headers,
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const data = await response.json();
    return { status: response.status, data, response };
  }
  const signIn = (login, secret = password) =>
    request('/auth/login', { method: 'POST', body: { login, password: secret } });
  const sessionFrom = (result) => ({
    cookie: result.response.headers.get('set-cookie').split(';')[0],
    csrf: result.data.csrfToken,
  });
  let admin, manager, managerId, createdUser;

  await t.test('health public, all user data protected, generic wrong-password error', async () => {
    assert.equal((await request('/health')).status, 200);
    assert.equal((await request('/auth/me')).status, 401);
    assert.equal((await request('/admin/users')).status, 401);
    const bad = await signIn('admin', 'wrong');
    assert.equal(bad.status, 401);
    assert.equal(bad.data.code, 'INVALID_CREDENTIALS');
    assert.ok(bad.data.requestId);
  });
  await t.test('login cookies and safe session response', async () => {
    const result = await signIn('ADMIN');
    assert.equal(result.status, 200);
    assert.match(result.response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(result.response.headers.get('set-cookie'), /SameSite=Lax/);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(result.data.user.role, 'admin');
    assert.equal(JSON.stringify(result.data).includes('password'), false);
    admin = sessionFrom(result);
    assert.equal((await request('/auth/me', { session: admin })).data.user.id, adminId);
  });
  await t.test('malformed and oversized JSON produce safe client errors', async () => {
    const malformed = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{invalid',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, 'INVALID_JSON');
    const oversized = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'x'.repeat(40000) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, 'BODY_TOO_LARGE');
  });
  await t.test('origin, CSRF, validation and idempotency-key are enforced', async () => {
    const input = { fullName: 'Manager', login: 'manager', password };
    const options = { method: 'POST', body: input, session: admin, key: randomUUID() };
    assert.equal(
      (await request('/admin/users', { ...options, headers: { Origin: 'https://evil.example' } }))
        .status,
      403,
    );
    assert.equal(
      (await request('/admin/users', { ...options, headers: { 'X-CSRF-Token': 'wrong' } })).status,
      403,
    );
    assert.equal(
      (await request('/admin/users', { ...options, body: { ...input, role: 'admin' } })).status,
      400,
    );
    assert.equal(
      (await request('/admin/users', { ...options, body: { ...input, password: '1234567' } }))
        .status,
      400,
    );
    assert.equal((await request('/admin/users', { ...options, key: undefined })).status, 400);
    assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '1');
  });
  await t.test(
    'concurrent retries create exactly one manager, audit, event and result',
    async () => {
      const body = { fullName: 'Test manager', login: 'manager', password };
      const key = randomUUID();
      const responses = await Promise.all(
        [1, 2].map(() => request('/admin/users', { method: 'POST', body, session: admin, key })),
      );
      assert.deepEqual(
        responses.map((r) => r.status),
        [201, 201],
      );
      assert.equal(responses[0].data.id, responses[1].data.id);
      createdUser = responses[0].data;
      managerId = createdUser.id;
      assert.equal(createdUser.role, 'manager');
      assert.equal(
        (await pool.query("SELECT count(*) FROM users WHERE login='manager'")).rows[0].count,
        '1',
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM audit_logs WHERE action='users.created' AND entity_id=$1",
            [managerId],
          )
        ).rows[0].count,
        '1',
      );
      assert.equal(
        (
          await pool.query('SELECT count(*) FROM outbox_jobs WHERE business_key=$1', [
            'users.created:' + managerId,
          ])
        ).rows[0].count,
        '1',
      );
      assert.equal(
        (await request('/operations/by-key?command=users.create&key=' + key, { session: admin }))
          .data.result.id,
        managerId,
      );
      assert.equal(
        (
          await request('/admin/users', {
            method: 'POST',
            body: { ...body, fullName: 'Other' },
            session: admin,
            key,
          })
        ).status,
        409,
      );
      assert.equal(
        (await request('/admin/users', { method: 'POST', body, session: admin, key: randomUUID() }))
          .data.code,
        'LOGIN_ALREADY_EXISTS',
      );
      const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [managerId]))
        .rows[0];
      assert.match(row.password_hash, /^scrypt\$/);
      assert.ok(!row.password_hash.includes(password));
      manager = sessionFrom(await signIn('manager'));
    },
  );
  await t.test('manager cannot list, create, block or inspect admin operations', async () => {
    assert.equal((await request('/admin/users', { session: manager })).status, 403);
    assert.equal(
      (
        await request('/admin/users', {
          method: 'POST',
          body: { fullName: 'Illegal', login: 'illegal', password },
          session: manager,
          key: randomUUID(),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request('/admin/users/' + managerId + '/status', {
          method: 'PATCH',
          body: { isActive: false, expectedVersion: 1 },
          session: manager,
          key: randomUUID(),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request('/operations/by-key?command=users.create&key=' + randomUUID(), {
          session: manager,
        })
      ).status,
      403,
    );
  });
  await t.test(
    'failed outbox write rolls back user, audit and idempotency; retry succeeds',
    async () => {
      await pool.query(
        "CREATE FUNCTION test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$",
      );
      await pool.query(
        'CREATE TRIGGER test_fail BEFORE INSERT ON outbox_jobs FOR EACH ROW EXECUTE FUNCTION test_fail_outbox()',
      );
      const body = { fullName: 'Rollback test', login: 'rollback', password };
      const key = randomUUID();
      assert.equal(
        (await request('/admin/users', { method: 'POST', body, session: admin, key })).status,
        500,
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM users WHERE login='rollback'")).rows[0].count,
        '0',
      );
      assert.equal(
        (await pool.query('SELECT count(*) FROM idempotency_records WHERE key=$1', [key])).rows[0]
          .count,
        '0',
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM audit_logs WHERE action='users.created'")).rows[0]
          .count,
        '1',
      );
      await pool.query('DROP TRIGGER test_fail ON outbox_jobs');
      assert.equal(
        (await request('/admin/users', { method: 'POST', body, session: admin, key })).status,
        201,
      );
    },
  );
  await t.test(
    'version conflict, session revocation and unblock without reviving old sessions',
    async () => {
      const path = '/admin/users/' + managerId + '/status';
      const key = randomUUID();
      const body = { isActive: false, expectedVersion: createdUser.version };
      const blocked = await request(path, { method: 'PATCH', body, session: admin, key });
      assert.equal(blocked.status, 200);
      assert.equal(blocked.data.version, 2);
      assert.deepEqual(
        (await request(path, { method: 'PATCH', body, session: admin, key })).data,
        blocked.data,
      );
      assert.equal((await request('/auth/me', { session: manager })).status, 401);
      assert.equal((await signIn('manager')).status, 401);
      const stale = await request(path, {
        method: 'PATCH',
        body: { isActive: true, expectedVersion: 1 },
        session: admin,
        key: randomUUID(),
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.data.code, 'VERSION_CONFLICT');
      assert.equal(
        (
          await request(path, {
            method: 'PATCH',
            body: { isActive: true, expectedVersion: 2 },
            session: admin,
            key: randomUUID(),
          })
        ).status,
        200,
      );
      assert.equal((await request('/auth/me', { session: manager })).status, 401);
      manager = sessionFrom(await signIn('manager'));
    },
  );
  await t.test('admin protected; logout and expiry immediately revoke access', async () => {
    assert.equal(
      (
        await request('/admin/users/' + adminId + '/status', {
          method: 'PATCH',
          body: { isActive: false, expectedVersion: 1 },
          session: admin,
          key: randomUUID(),
        })
      ).data.code,
      'ADMIN_PROTECTED',
    );
    assert.equal((await request('/auth/logout', { method: 'POST', session: manager })).status, 200);
    assert.equal((await request('/auth/me', { session: manager })).status, 401);
    manager = sessionFrom(await signIn('manager'));
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [
      managerId,
    ]);
    assert.equal((await request('/auth/me', { session: manager })).status, 401);
  });
  await t.test('login throttling persisted in database', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await signIn('missing', 'wrong')).status, 401);
    const limited = await signIn('missing', 'wrong');
    assert.equal(limited.status, 429);
    assert.equal(limited.response.headers.get('retry-after'), '900');
    assert.ok(
      !(await request('/admin/users', { session: admin })).data.items.some(
        (u) => 'passwordHash' in u || 'password_hash' in u,
      ),
    );
    assert.ok(!logs.includes(password));
  });
});
