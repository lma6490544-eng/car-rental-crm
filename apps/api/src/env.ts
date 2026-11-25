import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(__dirname, '../../../.env'), quiet: true });
export function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required. Copy .env.example to .env.');
  return value;
}
export function apiPort(): number {
  const port = Number(process.env.API_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT');
  return port;
}
export const production = process.env.NODE_ENV === 'production';
export function vapidConfig() {
  const {
    PUSH_VAPID_PUBLIC_KEY: publicKey,
    PUSH_VAPID_PRIVATE_KEY: privateKey,
    PUSH_VAPID_SUBJECT: subject,
  } = process.env;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : undefined;
}
export function allowedOrigins(): string[] {
  const configured = process.env.APP_ORIGINS;
  if (production && !configured) throw new Error('APP_ORIGINS is required in production');
  const values = (configured ?? 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((s) => s.trim());
  for (const value of values) {
    const url = new URL(value);
    if (url.origin !== value || (production && url.protocol !== 'https:'))
      throw new Error('Invalid APP_ORIGINS');
  }
  return values;
}
