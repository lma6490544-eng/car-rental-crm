import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../.env'), quiet: true });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.ts', './src/db/document-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL },
});
