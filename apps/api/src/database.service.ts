import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool, PoolClient } from 'pg';
import { databaseUrl } from './env';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly pool = new Pool({
    connectionString: databaseUrl(),
    connectionTimeoutMillis: 3000,
    query_timeout: 10000,
    max: 10,
  });
  readonly db = drizzle(this.pool);
  constructor() {
    this.pool.on('error', () => console.error('PostgreSQL connection lost'));
  }
  async ping(): Promise<void> {
    await this.db.execute(sql.raw('select 1'));
  }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        const code = (error as { code?: string }).code;
        if (attempt < 2 && (code === '40001' || code === '40P01')) continue;
        throw error;
      } finally {
        client.release();
      }
    }
  }
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
