import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { apiPort, production } from './env';
import { ApiErrorFilter } from './platform/http';
import type { AuthRequest } from './platform/security';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    (req as AuthRequest).requestId = randomUUID();
    res.setHeader('X-Request-Id', (req as AuthRequest).requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(json({ limit: '32kb' }));
  // Handle parser errors before Nest replaces them with a generic HttpException.
  app.use((error: { type?: string }, req: Request, res: Response, next: NextFunction) => {
    if (error.type !== 'entity.parse.failed' && error.type !== 'entity.too.large') {
      next(error);
      return;
    }
    const large = error.type === 'entity.too.large';
    res.status(large ? 413 : 400).json({
      code: large ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
      message: large ? 'Запрос слишком большой.' : 'Некорректный JSON.',
      requestId: (req as AuthRequest).requestId,
    });
  });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.useGlobalFilters(new ApiErrorFilter());
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  if (!production) {
    const config = new DocumentBuilder()
      .setTitle('CRM — этап 1')
      .setVersion('0.1.0')
      .addCookieAuth('crm_session')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }
  await app.listen(apiPort(), '127.0.0.1');
}
void bootstrap().catch(() => {
  console.error('API startup failed. Check database and configuration.');
  process.exitCode = 1;
});
