import { BadRequestException, Controller, Get, Module, Post, Body } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { DebugModule } from '../src/debug.module';
import { DebugContextService } from '../src/context/debug-context.service';
import { renderListPage } from '../src/ui/render-list';
import type { RequestProfile, RequestSummary } from '../src/interfaces/profile.interface';

@Controller()
class FastifyTestController {
  constructor(private readonly debug: DebugContextService) {}

  @Get('users')
  users(): Array<{ id: number }> {
    this.debug.recordSql({ source: 'fake-orm', sql: 'SELECT * FROM users', durationMs: 2 });
    this.debug.mark('Fastify handler');
    return [{ id: 1 }];
  }

  @Post('users')
  create(@Body() body: { name: string; password?: string }): { created: string } {
    return { created: body.name };
  }

  @Get('boom')
  boom(): never {
    throw new BadRequestException('fastify boom');
  }
}

@Module({ controllers: [FastifyTestController] })
class FastifyTestModule {}

describe('DebugModule on Fastify', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DebugModule.forRoot({ enabled: true }), FastifyTestModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await request(app.getHttpServer()).delete('/__debug');
  });

  it('captures requests end-to-end on the Fastify adapter', async () => {
    await request(app.getHttpServer()).get('/users?page=3').expect(200);

    const list = await request(app.getHttpServer()).get('/__debug').expect(200);
    const summaries = list.body as RequestSummary[];
    expect(summaries).toHaveLength(1);
    expect(summaries[0].url).toBe('/users?page=3');
    expect(summaries[0].statusCode).toBe(200);
    expect(summaries[0].sqlCount).toBe(1);

    const detail = await request(app.getHttpServer())
      .get(`/__debug/${summaries[0].id}`)
      .expect(200);
    const profile = detail.body as RequestProfile;
    expect(profile.queryParams).toEqual({ page: '3' });
    expect(profile.sql).toHaveLength(1);
    expect(profile.responseBody).toEqual([{ id: 1 }]);
    expect(profile.timeline.some((event) => event.label === 'Fastify handler')).toBe(true);
    expect(profile.ip).toBeDefined();
  });

  it('redacts request bodies and reports POST 201', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'ada', password: 'hunter2' })
      .expect(201);

    const list = await request(app.getHttpServer()).get('/__debug').expect(200);
    const detail = await request(app.getHttpServer()).get(`/__debug/${list.body[0].id}`);
    expect(detail.body.statusCode).toBe(201);
    expect(detail.body.body.password).toBe('[REDACTED]');
  });

  it('captures exceptions', async () => {
    await request(app.getHttpServer()).get('/boom').expect(400);
    const list = await request(app.getHttpServer()).get('/__debug').expect(200);
    expect(list.body[0].hasException).toBe(true);
    expect(list.body[0].statusCode).toBe(400);
  });

  it('serves the HTML dashboard through Fastify', async () => {
    await request(app.getHttpServer()).get('/users').expect(200);
    const page = await request(app.getHttpServer())
      .get('/__debug')
      .set('accept', 'text/html')
      .expect(200)
      .expect('content-type', /text\/html/);
    expect(page.text).toContain('nest');
  });

  // Fastify parses bodies and writes responses differently from Express, and the
  // rule endpoints are the only ones that read a body — so they get their own
  // pass on this adapter rather than relying on the Express suite.
  it('manages ignore rules through Fastify', async () => {
    const created = await request(app.getHttpServer())
      .post('/__debug/filters')
      .send({ pattern: '/users', note: 'noisy' })
      .expect(200);
    expect(created.body).toMatchObject({ ok: true, rule: { pattern: '/users' } });
    const id = created.body.rule.id as string;

    // The rule takes effect: this request is no longer captured.
    await request(app.getHttpServer()).get('/users').expect(200);
    const feed = await request(app.getHttpServer())
      .get('/__debug?feed=filters')
      .set('accept', 'application/json')
      .expect(200);
    expect(feed.body.rules[0]).toMatchObject({ pattern: '/users' });
    expect(await summaries()).toHaveLength(0);

    await request(app.getHttpServer())
      .patch(`/__debug/filters/${id}`)
      .send({ enabled: false })
      .expect(200);
    await request(app.getHttpServer()).get('/users').expect(200);
    expect(await summaries()).toHaveLength(1);

    await request(app.getHttpServer()).delete(`/__debug/filters/${id}`).expect(200);
    const empty = await request(app.getHttpServer())
      .get('/__debug?feed=filters')
      .set('accept', 'application/json')
      .expect(200);
    expect(empty.body.rules).toHaveLength(0);
  });

  /**
   * Fastify refuses an empty body sent with `content-type: application/json`, so a
   * DELETE must not advertise one. The dashboard's fetch() is the only caller that
   * sets headers on every request, and supertest omits the header unless asked —
   * which is exactly how this slipped through the first time.
   */
  it('deletes a rule the way the dashboard sends it', async () => {
    const created = await request(app.getHttpServer())
      .post('/__debug/filters')
      .send({ pattern: '/users' })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/__debug/filters/${created.body.rule.id}`)
      .set('accept', 'application/json')
      .expect(200);
  });

  it('does not put a content-type on the body-less request', () => {
    const script = renderListPage('__debug');
    // The header object is built conditionally; a hard-coded content-type here
    // would 400 on Fastify again.
    expect(script).toContain("if (body) headers['content-type'] = 'application/json';");
    expect(script).not.toContain("headers: { 'content-type': 'application/json', accept:");
  });

  it('rejects a bad rule with 400 through Fastify', async () => {
    const res = await request(app.getHttpServer())
      .post('/__debug/filters')
      .send({ pattern: '/' })
      .expect(400)
      .expect('content-type', /application\/json/);
    expect(res.body).toMatchObject({ ok: false });
    expect(res.body.error).toBeTruthy();
  });

  async function summaries(): Promise<unknown[]> {
    const res = await request(app.getHttpServer())
      .get('/__debug')
      .set('accept', 'application/json')
      .expect(200);
    return res.body as unknown[];
  }
});

describe('DebugModule on Fastify behind a global prefix', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DebugModule.forRoot({ enabled: true }), FastifyTestModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('points the dashboard at the prefixed path, with the panel CSP', async () => {
    const page = await request(app.getHttpServer())
      .get('/api/__debug')
      .set('accept', 'text/html')
      .expect(200);
    expect(page.text).toContain("var PREFIX = '/api/__debug'");
    expect(page.headers['content-security-policy']).toContain("'unsafe-inline'");
  });
});
