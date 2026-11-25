export type User = {
  id: number;
  fullName: string;
  login: string;
  role: 'admin' | 'manager';
  isActive: boolean;
  version: number;
  createdAt: string;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
let csrfToken: string | null = null;

export function createIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  // randomUUID requires a secure context, but getRandomValues also works over local HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export const setCsrfToken = (value: string | null) => {
  csrfToken = value;
};
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; anonymous?: boolean; file?: File } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch('/api/v1' + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
      headers: {
        ...(method !== 'GET' ? { 'Content-Type': options.file?.type || 'application/json' } : {}),
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      },
      ...(method !== 'GET' ? { body: options.file ?? JSON.stringify(options.body ?? {}) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Нет ответа от сервера. Проверьте соединение.');
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      response.status >= 500 ? 503 : 0,
      'INVALID_RESPONSE',
      'Сервер временно недоступен. Повторите позже.',
    );
  }
  if (!response.ok) {
    // The error envelope is separate from successful endpoint-specific results.
    const failure = data as {
      code?: string;
      message?: string;
      requestId?: string;
      details?: unknown;
    };
    if (response.status === 401 && !options.anonymous)
      window.dispatchEvent(new Event('crm-session-expired'));
    throw new ApiError(
      response.status,
      failure.code ?? 'REQUEST_FAILED',
      failure.message ?? 'Не удалось выполнить запрос.',
      failure.requestId,
      failure.details,
    );
  }
  return data as T;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие.';
}
