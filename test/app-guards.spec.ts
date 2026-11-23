import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  Scope,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { DebugModule } from '../src/debug.module';
import type { DebugModuleOptions } from '../src/config/debug-options';

/** A host app's global auth guard: nothing gets through without a token. */
@Injectable()
class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    if (req.headers['x-token'] !== 'ok') throw new UnauthorizedException();
    return true;
  }
}

@Injectable({ scope: Scope.REQUEST })
class ScopedGuard extends SessionGuard {}

@Controller()
class AppController {
  @Get('users')
  users(): string[] {
    return ['ada'];
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

type Setup = { guard: 'app' | 'scoped' | 'useGlobal'; prefix?: string; fastify?: boolean };

async function makeApp(setup: Setup, options: DebugModuleOptions = {}): Promise<INestApplication> {
  const providers =
    setup.guard === 'app'
      ? [{ provide: APP_GUARD, useClass: SessionGuard }]
      : setup.guard === 'scoped'
        ? [{ provide: APP_GUARD, useClass: ScopedGuard }]
        : [];
  const moduleRef = await Test.createTestingModule({
    imports: [DebugModule.forRoot({ enabled: true, ...options }), AppModule],
    providers,
  }).compile();
  const app = setup.fastify
    ? moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    : moduleRef.createNestApplication();
  if (setup.guard === 'useGlobal') app.useGlobalGuards(new SessionGuard());
  if (setup.prefix) app.setGlobalPrefix(setup.prefix);
  await app.init();
  if (setup.fastify) await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  return app;
}

describe('the panel behind the host app\'s global guards', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it.each<Setup>([
    { guard: 'app' },
    { guard: 'scoped' },
    { guard: 'useGlobal' },
    { guard: 'app', prefix: 'api' },
    { guard: 'app', prefix: 'api', fastify: true },
  ])('opens the panel but keeps app routes guarded (%o)', async (setup) => {
    app = await makeApp(setup);
    const base = setup.prefix ? `/${setup.prefix}` : '';

    await request(app.getHttpServer()).get(`${base}/users`).expect(401);
    await request(app.getHttpServer()).get(`${base}/users`).set('x-token', 'ok').expect(200);

    const list = await request(app.getHttpServer()).get(`${base}/__debug`).expect(200);
    expect(list.body).toHaveLength(1);
    await request(app.getHttpServer()).get(`${base}/__debug`).set('accept', 'text/html').expect(200);
    await request(app.getHttpServer())
      .post(`${base}/__debug/filters`)
      .send({ pattern: '/health' })
      .expect(200);
    await request(app.getHttpServer()).delete(`${base}/__debug`).expect(200);
  });

  it('still applies the panel\'s own authorize callback', async () => {
    app = await makeApp(
      { guard: 'app' },
      { authorize: (req) => (req as { headers: Record<string, string> }).headers['x-debug'] === '1' },
    );
    await request(app.getHttpServer()).get('/__debug').expect(403);
    await request(app.getHttpServer()).get('/__debug').set('x-debug', '1').expect(200);
  });

  it('keeps the app guards on the panel with bypassAppGuards: false', async () => {
    app = await makeApp({ guard: 'app' }, { bypassAppGuards: false });
    await request(app.getHttpServer()).get('/__debug').expect(401);
    await request(app.getHttpServer()).get('/__debug').set('x-token', 'ok').expect(200);
  });

  it('touches nothing when the panel is disabled', async () => {
    app = await makeApp({ guard: 'app' }, { enabled: false });
    await request(app.getHttpServer()).get('/__debug').expect(401);
    await request(app.getHttpServer()).get('/users').expect(401);
  });
});
