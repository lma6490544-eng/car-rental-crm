import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseService } from './database.service';
import { audit, newUserSchema, passwordHash, parse } from './platform/security';

async function main() {
  const db = new DatabaseService();
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(24).toString('base64url');
  const input = parse(newUserSchema, {
    login: process.env.ADMIN_LOGIN ?? 'admin',
    fullName: process.env.ADMIN_FULL_NAME ?? 'Администратор',
    password,
  });
  try {
    const encoded = await passwordHash(input.password);
    const created = await db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bootstrap-admin',0))");
      if ((await client.query("SELECT id FROM users WHERE role='admin'")).rowCount) return false;
      const result = await client.query(
        "INSERT INTO users (full_name,login,password_hash,role) VALUES ($1,$2,$3,'admin') RETURNING id",
        [input.fullName, input.login, encoded],
      );
      await audit(
        client,
        null,
        'user',
        'users.admin_bootstrapped',
        result.rows[0].id,
        randomUUID(),
      );
      if (!process.env.ADMIN_PASSWORD) {
        const directory = resolve(__dirname, '../../../.local');
        await mkdir(directory, { recursive: true });
        await writeFile(
          resolve(directory, 'initial-admin.txt'),
          'Логин: ' + input.login + '\nПароль: ' + password + '\n',
          { encoding: 'utf8', mode: 0o600, flag: 'wx' },
        );
      }
      return true;
    });
    console.log(
      created
        ? 'Initial admin created. Generated credentials (if used): .local/initial-admin.txt'
        : 'Admin already exists. No account or password changed.',
    );
  } finally {
    await db.onApplicationShutdown();
  }
}
void main().catch(() => {
  console.error(
    'Admin setup failed. Check input, migrations and .local/initial-admin.txt. No password was printed.',
  );
  process.exitCode = 1;
});
