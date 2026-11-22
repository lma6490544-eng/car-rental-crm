import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  CanActivate,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { DatabaseService } from '../database.service';
import { allowedOrigins } from '../env';
import { AuthRequest, fail, hash, safeEqual, sessionToken } from './security';

export const Public = () => SetMetadata('public', true);
export const BinaryUpload = () => SetMetadata('binaryUpload', true);
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly origins = allowedOrigins();
  constructor(
    private readonly db: DatabaseService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (write) {
      if (
        !request.headers.origin ||
        !this.origins.includes(request.headers.origin) ||
        request.headers['sec-fetch-site'] === 'cross-site'
      )
        fail(403, 'ORIGIN_REJECTED', 'Запрос отправлен с недопустимого адреса.');
      if (this.reflector.get<boolean>('binaryUpload', context.getHandler())) {
        const mime = request.headers['content-type'];
        if (!mime || !['image/jpeg', 'image/png', 'application/pdf'].includes(mime))
          fail(415, 'FILE_TYPE_UNSUPPORTED', 'Допустимы JPEG, PNG или PDF для документов клиента.');
      } else if (!request.is('application/json')) {
        fail(415, 'JSON_REQUIRED', 'Ожидается JSON.');
      }
    }
    if (this.reflector.getAllAndOverride('public', [context.getHandler(), context.getClass()]))
      return true;
    const token = sessionToken(request);
    if (!token) fail(401, 'UNAUTHENTICATED', 'Войдите в систему.');
    const result = await this.db.pool.query(
      'SELECT u.id, u.full_name AS "fullName", u.login, u.role, u.is_active AS "isActive", u.version, u.created_at AS "createdAt" FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.is_active',
      [hash(token)],
    );
    if (!result.rowCount) fail(401, 'UNAUTHENTICATED', 'Сессия завершена. Войдите снова.');
    const csrfToken = hash('csrf:' + token);
    if (
      write &&
      (typeof request.headers['x-csrf-token'] !== 'string' ||
        !safeEqual(request.headers['x-csrf-token'], csrfToken))
    )
      fail(403, 'CSRF_REJECTED', 'Обновите страницу и повторите действие.');
    request.auth = { user: result.rows[0], tokenHash: hash(token), csrfToken };
    return true;
  }
}
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<AuthRequest>();
    let status = 500;
    let body: Record<string, unknown> = {
      code: 'INTERNAL_ERROR',
      message: 'Не удалось выполнить запрос. Повторите позже.',
    };
    if (error instanceof HttpException) {
      status = error.getStatus();
      const value = error.getResponse();
      body = typeof value === 'object' ? (value as Record<string, unknown>) : { message: value };
      if (!body.code) body = { ...body, code: 'HTTP_' + status };
    } else {
      const code = (error as { code?: string })?.code;
      if (code === '23P01') {
        response.status(409).json({
          code: 'VEHICLE_ASSIGNMENT_CONFLICT',
          message: 'Автомобиль занят на выбранный период.',
          requestId: request.requestId,
        });
        return;
      }
      const parserError = error as { type?: string };
      if (parserError?.type === 'entity.parse.failed' || parserError?.type === 'entity.too.large') {
        status = parserError.type === 'entity.too.large' ? 413 : 400;
        body = {
          code: status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
          message: status === 413 ? 'Запрос слишком большой.' : 'Некорректный JSON.',
        };
        response.status(status).json({ ...body, requestId: request.requestId });
        return;
      }
      if (['ECONNREFUSED', 'ECONNRESET', '57P01', '53300', '55P03'].includes(code ?? '')) {
        status = 503;
        body = {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Сервер временно недоступен. Повторите позже.',
        };
      }
      // Deliberately omit SQL, payloads, cookies and exception text from logs.
      console.error(
        JSON.stringify({ event: 'request_failed', requestId: request.requestId, status }),
      );
    }
    if (status === 429) response.setHeader('Retry-After', '900');
    response.status(status).json({ ...body, requestId: request.requestId });
  }
}
