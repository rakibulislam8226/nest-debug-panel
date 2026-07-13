import { BadRequestException, Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DebugModule } from '../src/debug.module';
import { DebugContextService } from '../src/context/debug-context.service';
import { DebugIgnore } from '../src/decorators/debug-ignore.decorator';
import type { RequestProfile, RequestSummary } from '../src/interfaces/profile.interface';

@Injectable()
class FakeRepository {
  constructor(private readonly debug: DebugContextService) {}

  async findUsers(): Promise<Array<{ id: number }>> {
    this.debug.recordSql({ source: 'fake-orm', sql: 'SELECT * FROM users', durationMs: 3.2 });
    this.debug.recordSql({ source: 'fake-orm', sql: 'SELECT * FROM roles WHERE user_id = 1', durationMs: 1.1 });
    return [{ id: 1 }];
  }
}

@Controller()
class TestController {
  constructor(
    private readonly repository: FakeRepository,
    private readonly debug: DebugContextService,
  ) {}

  @Get('users')
  async users(): Promise<Array<{ id: number }>> {
    this.debug.mark('Fetching users');
    return this.repository.findUsers();
  }

  @Post('users')
  create(@Body() body: { name: string; password?: string }): { created: string } {
    return { created: body.name };
  }

  @Get('boom')
  boom(): never {
    throw new BadRequestException('invalid input');
  }

  @Get('health')
  health(): { ok: boolean } {
    return { ok: true };
  }

  @DebugIgnore()
  @Get('metrics')
  metrics(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [TestController], providers: [FakeRepository] })
class TestModule {}

async function makeApp(debugModule: ReturnType<typeof DebugModule.forRoot>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [debugModule, TestModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('DebugModule (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await makeApp(
      DebugModule.forRoot({
        enabled: true,
        maxRequests: 50,
        ignore: ['/health'],
        captureResponseBody: true,
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await request(app.getHttpServer()).delete('/nest-debug-panel');
  });

  it('captures a request end-to-end: SQL, timeline, response, analysis', async () => {
    await request(app.getHttpServer()).get('/users?page=2').expect(200);

    const list = await request(app.getHttpServer()).get('/nest-debug-panel').expect(200);
    const summaries = list.body as RequestSummary[];
    expect(summaries).toHaveLength(1);
    expect(summaries[0].method).toBe('GET');
    expect(summaries[0].url).toBe('/users?page=2');
    expect(summaries[0].statusCode).toBe(200);
    expect(summaries[0].sqlCount).toBe(2);

    const detail = await request(app.getHttpServer())
      .get(`/nest-debug-panel/${summaries[0].id}`)
      .expect(200);
    const profile = detail.body as RequestProfile;
    expect(profile.queryParams).toEqual({ page: '2' });
    expect(profile.sql).toHaveLength(2);
    expect(profile.sqlAnalysis?.totalQueries).toBe(2);
    expect(profile.responseBody).toEqual([{ id: 1 }]);
    expect(profile.durationMs).toBeGreaterThan(0);
    expect(profile.memory?.after).toBeDefined();
    expect(profile.timeline.some((event) => event.label === 'Fetching users')).toBe(true);
    expect(profile.timeline[0].kind).toBe('request');
    expect(profile.timeline[profile.timeline.length - 1].kind).toBe('response');
  });

  it('redacts sensitive body fields and captures POST status 201', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'ada', password: 'hunter2' })
      .expect(201);

    const list = await request(app.getHttpServer()).get('/nest-debug-panel').expect(200);
    const detail = await request(app.getHttpServer())
      .get(`/nest-debug-panel/${list.body[0].id}`)
      .expect(200);
    const profile = detail.body as RequestProfile;
    expect(profile.statusCode).toBe(201);
    expect((profile.body as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((profile.body as Record<string, unknown>).name).toBe('ada');
    expect(profile.headers).toBeDefined();
  });

  it('captures exceptions with stack traces', async () => {
    await request(app.getHttpServer()).get('/boom').expect(400);

    const list = await request(app.getHttpServer()).get('/nest-debug-panel').expect(200);
    expect(list.body[0].hasException).toBe(true);
    const detail = await request(app.getHttpServer())
      .get(`/nest-debug-panel/${list.body[0].id}`)
      .expect(200);
    const profile = detail.body as RequestProfile;
    expect(profile.statusCode).toBe(400);
    expect(profile.exception?.name).toBe('BadRequestException');
    expect(profile.exception?.message).toContain('invalid input');
    expect(profile.exception?.stack).toBeDefined();
  });

  it('skips ignored routes (option pattern + decorator + own routes)', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/metrics').expect(200);
    await request(app.getHttpServer()).get('/nest-debug-panel').expect(200);

    const list = await request(app.getHttpServer()).get('/nest-debug-panel').expect(200);
    expect(list.body).toHaveLength(0);
  });

  it('serves the HTML dashboard and detail page to browsers', async () => {
    await request(app.getHttpServer()).get('/users').expect(200);
    const page = await request(app.getHttpServer())
      .get('/nest-debug-panel')
      .set('accept', 'text/html')
      .expect(200)
      .expect('content-type', /text\/html/);
    expect(page.text).toContain('nest');

    const list = await request(app.getHttpServer()).get('/nest-debug-panel');
    const detail = await request(app.getHttpServer())
      .get(`/nest-debug-panel/${list.body[0].id}`)
      .set('accept', 'text/html')
      .expect(200);
    expect(detail.text).toContain('Timeline');
    expect(detail.text).toContain('SQL');
  });

  it('clears history via DELETE', async () => {
    await request(app.getHttpServer()).get('/users');
    await request(app.getHttpServer()).delete('/nest-debug-panel').expect(200, { cleared: true });
    const list = await request(app.getHttpServer()).get('/nest-debug-panel');
    expect(list.body).toHaveLength(0);
  });

  it('returns 404 for unknown profile ids', async () => {
    await request(app.getHttpServer()).get('/nest-debug-panel/nope').expect(404);
  });
});

describe('DebugModule disabled', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await makeApp(DebugModule.forRoot({ enabled: false }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('hides debug routes and does not intercept', async () => {
    await request(app.getHttpServer()).get('/users').expect(200);
    await request(app.getHttpServer()).get('/nest-debug-panel').expect(404);
  });
});

describe('DebugModule fail-safety', () => {
  it('never breaks requests even when storage and plugins blow up', async () => {
    const app = await makeApp(
      DebugModule.forRoot({
        enabled: true,
        storage: {
          // every storage method fails
          save: () => {
            throw new Error('disk on fire');
          },
          find: () => {
            throw new Error('disk on fire');
          },
          list: () => {
            throw new Error('disk on fire');
          },
          clear: () => {
            throw new Error('disk on fire');
          },
          count: () => {
            throw new Error('disk on fire');
          },
        },
        plugins: [
          {
            name: 'saboteur',
            onRequestStart: () => {
              throw new Error('plugin exploded');
            },
            onRequestEnd: () => {
              throw new Error('plugin exploded');
            },
          },
        ],
      }),
    );
    // business routes keep working — profiling failures are bypassed
    await request(app.getHttpServer()).get('/users').expect(200);
    await request(app.getHttpServer())
      .post('/users')
      .send({ name: 'ok' })
      .expect(201);
    await app.close();
  });
});

describe('DebugModule custom prefix + authorize', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app.close();
  });

  it('honors a custom route prefix', async () => {
    app = await makeApp(DebugModule.forRoot({ enabled: true, routePrefix: '/_inspector' }));
    await request(app.getHttpServer()).get('/users').expect(200);
    const list = await request(app.getHttpServer()).get('/_inspector').expect(200);
    expect(list.body).toHaveLength(1);
    // restore default for other suites (metadata is module-static)
    DebugModule.forRoot({ enabled: true });
  });

  it('enforces the authorize callback', async () => {
    app = await makeApp(
      DebugModule.forRoot({
        enabled: true,
        authorize: (req) =>
          (req as { headers: Record<string, string> }).headers['x-debug-key'] === 'secret',
      }),
    );
    await request(app.getHttpServer()).get('/nest-debug-panel').expect(403);
    await request(app.getHttpServer()).get('/nest-debug-panel').set('x-debug-key', 'secret').expect(200);
  });
});
