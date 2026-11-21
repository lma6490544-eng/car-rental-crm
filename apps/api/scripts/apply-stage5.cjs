// Explicit operator-run migration: private dump, transactional migration, old-row verification.
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const root = path.resolve(__dirname, '../../..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const digest = (text) => createHash('sha256').update(text).digest('hex');
const qi = (name) => '"' + name.replaceAll('"', '""') + '"';
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '15432')
    throw new Error('Unexpected database destination');
  const pool = new Pool({ connectionString: url.toString() }),
    c = await pool.connect();
  let committed = false;
  try {
    const applied = (
      await c.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')
    ).rows;
    const dir = path.join(root, 'apps/api/drizzle'),
      journal = JSON.parse(fs.readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8'));
    for (const row of applied) {
      const entry = journal.entries.find((e) => String(e.when) === row.created_at);
      if (
        !entry ||
        digest(fs.readFileSync(path.join(dir, entry.tag + '.sql'), 'utf8')) !== row.hash
      )
        throw new Error('Previously applied migration differs from source');
    }
    const pending = journal.entries.filter((e) => e.when > Number(applied.at(-1)?.created_at ?? 0));
    if (!pending.length) {
      console.log('Stage 5 migrations already applied; no changes.');
      return;
    }
    if (pending.some((e) => e.idx < 10 || e.idx > 11))
      throw new Error('Unexpected migration range');
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='8s'");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('crm:schedule',0))");
    const tables = (
      await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    ).rows.map((x) => x.tablename);
    for (const table of tables)
      await c.query('LOCK TABLE ' + qi(table) + ' IN SHARE ROW EXCLUSIVE MODE');
    const snapshot = {};
    for (const table of tables)
      snapshot[table] = (
        await c.query('SELECT row_to_json(t)::text AS row FROM ' + qi(table) + ' t')
      ).rows.map((x) => digest(x.row));
    const backupDir = path.join(root, '.local');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, 'pre-stage5-' + Date.now() + '.dump');
    const dump = execFileSync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '-U',
        decodeURIComponent(url.username),
        '-d',
        url.pathname.slice(1),
        '--format=custom',
      ],
      {
        cwd: root,
        windowsHide: true,
        maxBuffer: 128 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (dump.length < 100 || dump.subarray(0, 5).toString() !== 'PGDMP')
      throw new Error('Invalid private backup');
    fs.writeFileSync(backup, dump, { flag: 'wx' });
    execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'pg_restore', '--list'], {
      cwd: root,
      windowsHide: true,
      input: dump,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    console.log('Private PostgreSQL dump created and archive directory verified.');
    for (const entry of pending) {
      const sql = fs.readFileSync(path.join(dir, entry.tag + '.sql'), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint'))
        if (statement.trim()) await c.query(statement);
      await c.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ($1,$2)', [
        digest(sql),
        entry.when,
      ]);
    }
    for (const table of tables) {
      const current = new Map();
      for (const x of (await c.query('SELECT row_to_json(t)::text AS row FROM ' + qi(table) + ' t'))
        .rows) {
        const key = digest(x.row);
        current.set(key, (current.get(key) ?? 0) + 1);
      }
      for (const key of snapshot[table]) {
        if (!current.get(key)) throw new Error('Existing row changed during migration: ' + table);
        current.set(key, current.get(key) - 1);
      }
    }
    for (const table of [
      'finance_external',
      'finance_lots',
      'finance_allocations',
      'finance_fund_entries',
    ])
      if ((await c.query('SELECT count(*)::int n FROM ' + table)).rows[0].n !== 0)
        throw new Error('Migration must not create money');
    await c.query('COMMIT');
    committed = true;
    console.log(
      JSON.stringify({
        migrations: pending.map((e) => e.idx),
        oldTablesVerified: tables.length,
        oldRowsPreserved: Object.values(snapshot).reduce((n, rows) => n + rows.length, 0),
        moneyCreated: false,
        backup: path.relative(root, backup),
      }),
    );
  } finally {
    if (!committed) await c.query('ROLLBACK').catch(() => {});
    c.release();
    await pool.end();
  }
}
main().catch((e) => {
  console.error(
    'Stage 5 migration failed; transaction rolled back. ' +
      (e.code ??
        (String(e.message).startsWith('Existing row') || String(e.message).includes('migration')
          ? e.message
          : 'Check local database and Docker access.')),
  );
  process.exitCode = 1;
});
