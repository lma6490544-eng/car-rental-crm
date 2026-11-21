import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';

export type User = {
  id: number;
  fullName: string;
  login: string;
  role: 'admin' | 'manager';
  isActive: boolean;
  version: number;
  createdAt: string;
};
export type AuthRequest = Request & {
  requestId: string;
  auth?: { user: User; tokenHash: string; csrfToken: string };
};
export const userColumns =
  'id, full_name AS "fullName", login, role, is_active AS "isActive", version, created_at AS "createdAt"';
export function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new HttpException({ code, message, ...(details ? { details } : {}) }, status);
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    fail(400, 'VALIDATION_ERROR', 'Проверьте заполнение полей.', {
      fields: result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  return result.data;
}
export const loginField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9._-]{2,63}$/,
    'Логин: 3–64 латинских символа, цифры, точка, дефис или подчёркивание.',
  );
export const newUserSchema = z
  .object({
    fullName: z.string().trim().min(1, 'Укажите ФИО.').max(120),
    login: loginField,
    password: z.string().min(12, 'Пароль должен содержать не менее 12 символов.').max(128),
  })
  .strict();
export const statusSchema = z
  .object({ isActive: z.boolean(), expectedVersion: z.number().int().positive() })
  .strict();
export const idSchema = z.coerce.number().int().positive().max(2147483647);
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return 'scrypt$N=32768,r=8,p=3$' + salt + '$' + (await derive(password, salt)).toString('hex');
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, parameters, salt, key] = encoded.split('$');
  const supported =
    algorithm === 'scrypt' &&
    parameters === 'N=32768,r=8,p=3' &&
    /^[a-f0-9]{32}$/.test(salt ?? '') &&
    /^[a-f0-9]{128}$/.test(key ?? '');
  const actual = await derive(password, supported ? salt : 'invalid-account-padding');
  const expected = Buffer.from(supported ? key : '00'.repeat(64), 'hex');
  return timingSafeEqual(actual, expected) && supported;
}
export async function passwordFingerprint(password: string, scope: string): Promise<string> {
  return (await derive(password, hash(scope))).toString('hex');
}
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function sessionToken(request: Request): string | undefined {
  const match = (request.headers.cookie ?? '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('crm_session='));
  const token = match?.slice('crm_session='.length);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
export type AuditEntityType =
  | 'user'
  | 'customer'
  | 'vehicle'
  | 'pricing_quote'
  | 'booking'
  | 'schedule_block'
  | 'financial_operation';
export async function audit(
  client: PoolClient,
  actor: number | null,
  entityType: AuditEntityType,
  action: string,
  entityId: number | null,
  requestId: string,
  details: Record<string, unknown> = {},
) {
  await client.query(
    'INSERT INTO audit_logs (actor_id, entity_type, action, entity_id, request_id, details) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor, entityType, action, entityId, requestId, JSON.stringify(details)],
  );
}
