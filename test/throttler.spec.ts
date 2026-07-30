import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DebugModule } from '../src/debug.module';
import { DebugController } from '../src/api/debug.controller';

/**
 * A global `ThrottlerGuard` — the way `@nestjs/throttler` is meant to be wired —
 * applies to every controller, the panel's included. The dashboard polls its own
 * API every two seconds, so without an opt-out it rate-limits itself and starts
 * answering `ThrottlerException` instead of data.
 *
 * The limit here is deliberately tiny so a handful of requests would blow past a
 * realistic one.
 */
@Controller()
class AppController {
  @Get('orders')
  orders(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 3 }] }),
    DebugModule.forRoot({ enabled: true }),
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class ThrottledAppModule {}

describe('a host app that rate-limits everything', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ThrottledAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('still throttles the application itself', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer()).get('/orders');
      codes.push(res.status);
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes).toContain(429);
  });

  it('never throttles the panel, however hard the dashboard polls', async () => {
    for (let i = 0; i < 15; i++) {
      await request(app.getHttpServer())
        .get('/__debug')
        .set('accept', 'application/json')
        .expect(200);
    }
  });

  it('never throttles the aggregate feeds or the rule endpoints', async () => {
    for (const feed of ['queries', 'logs', 'filters', 'queries', 'logs', 'filters']) {
      await request(app.getHttpServer())
        .get(`/__debug?feed=${feed}`)
        .set('accept', 'application/json')
        .expect(200);
    }

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .post('/__debug/filters')
        .send({ pattern: `/probe-${i}` })
        .expect(200);
      ids.push(res.body.rule.id as string);
    }
    for (const id of ids) {
      await request(app.getHttpServer()).delete(`/__debug/filters/${id}`).expect(200);
    }
  });

  it('carries the skip flag for every throttler name it covers', () => {
    for (const name of ['default', 'short', 'medium', 'long']) {
      expect(Reflect.getMetadata(`THROTTLER:SKIP${name}`, DebugController)).toBe(true);
    }
  });
});
