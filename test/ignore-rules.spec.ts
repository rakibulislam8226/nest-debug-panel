import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DebugModule } from '../src/debug.module';
import { IgnoreRulesService } from '../src/filters/ignore-rules.service';
import { MemoryStorage } from '../src/storage/memory.storage';
import {
  normalizeIgnorePattern,
  validateIgnorePattern,
  compileIgnoreMatcher,
} from '../src/utils/ignore-match';
import type { RequestSummary } from '../src/interfaces/profile.interface';

@Controller()
class AppController {
  @Get('health')
  health(): { ok: boolean } {
    return { ok: true };
  }

  @Get('health/db')
  healthDb(): { ok: boolean } {
    return { ok: true };
  }

  @Get('orders')
  orders(): { id: number }[] {
    return [{ id: 1 }];
  }

  @Get('metrics')
  metrics(): string {
    return 'up 1';
  }
}

async function bootstrap(options: Parameters<typeof DebugModule.forRoot>[0] = {}): Promise<{
  app: INestApplication;
  rules: IgnoreRulesService;
}> {
  @Module({
    imports: [DebugModule.forRoot({ enabled: true, storage: new MemoryStorage(50), ...options })],
    controllers: [AppController],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, rules: app.get(IgnoreRulesService) };
}

const summaries = (app: INestApplication): Promise<RequestSummary[]> =>
  request(app.getHttpServer())
    .get('/__debug')
    .set('accept', 'application/json')
    .expect(200)
    .then((res) => res.body as RequestSummary[]);

describe('pattern helpers', () => {
  it('adds the leading slash and drops a trailing one', () => {
    expect(normalizeIgnorePattern('health')).toBe('/health');
    expect(normalizeIgnorePattern('  /health/  ')).toBe('/health');
    expect(normalizeIgnorePattern('/')).toBe('/');
  });

  it('rejects patterns that would silence everything or cannot work', () => {
    expect(validateIgnorePattern('')).toBeDefined();
    expect(validateIgnorePattern('/')).toBeDefined();
    expect(validateIgnorePattern('/*')).toBeDefined();
    expect(validateIgnorePattern('/two words')).toBeDefined();
    expect(validateIgnorePattern(`/${'x'.repeat(250)}`)).toBeDefined();
    expect(validateIgnorePattern('/health')).toBeUndefined();
  });

  it('matches by prefix on a segment boundary, not by raw string prefix', () => {
    const matches = compileIgnoreMatcher('/health');
    expect(matches('/health')).toBe(true);
    expect(matches('/health/db')).toBe(true);
    expect(matches('/healthz')).toBe(false);
  });

  it('treats * as a wildcard', () => {
    const matches = compileIgnoreMatcher('/v1/*/ping');
    expect(matches('/v1/orders/ping')).toBe(true);
    expect(matches('/v1/ping')).toBe(false);
  });
});

describe('runtime ignore rules', () => {
  let app: INestApplication;
  let rules: IgnoreRulesService;

  beforeEach(async () => {
    ({ app, rules } = await bootstrap());
  });

  afterEach(async () => {
    await app.close();
  });

  it('stops capturing an endpoint once a rule is added, and resumes when deleted', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    expect(await summaries(app)).toHaveLength(1);

    const added = await rules.add({ pattern: 'health', note: 'k8s probe' });
    expect(added.ok).toBe(true);

    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/health/db').expect(200);
    await request(app.getHttpServer()).get('/orders').expect(200);

    const captured = await summaries(app);
    // The pre-rule /health capture stays — rules only affect future requests.
    expect(captured.map((s) => s.url)).toEqual(['/orders', '/health']);

    await rules.remove(added.rule!.id);
    await request(app.getHttpServer()).get('/health').expect(200);
    expect((await summaries(app)).map((s) => s.url)).toContain('/health');
  });

  it('counts what each rule skipped so a rule can be seen working', async () => {
    const added = await rules.add({ pattern: '/health' });
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/health/db').expect(200);

    const listed = rules.list().find((rule) => rule.id === added.rule!.id);
    expect(listed?.hits).toBe(2);
  });

  it('honours a disabled rule without forgetting it', async () => {
    const added = await rules.add({ pattern: '/metrics' });
    await rules.update(added.rule!.id, { enabled: false });

    await request(app.getHttpServer()).get('/metrics').expect(200);
    expect((await summaries(app)).map((s) => s.url)).toEqual(['/metrics']);
    expect(rules.list()).toHaveLength(1);

    await rules.update(added.rule!.id, { enabled: true });
    await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(await summaries(app)).toHaveLength(1);
  });

  it('rejects duplicates and invalid patterns with a reason', async () => {
    await rules.add({ pattern: '/health' });
    const duplicate = await rules.add({ pattern: 'health/' });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain('already');

    const bad = await rules.add({ pattern: '/*' });
    expect(bad.ok).toBe(false);
    expect(rules.list()).toHaveLength(1);
  });

  it('lists config rules as read-only alongside runtime ones', async () => {
    await app.close();
    ({ app, rules } = await bootstrap({ ignore: ['/metrics', /^\/internal/] }));
    await rules.add({ pattern: '/health' });

    const listed = rules.list();
    expect(listed.map((rule) => rule.source)).toEqual(['runtime', 'config', 'config']);
    expect(listed.filter((rule) => rule.source === 'config').map((rule) => rule.pattern)).toEqual([
      '/metrics',
      '/^\\/internal/',
    ]);
  });

  it('persists rules through the storage driver', async () => {
    const storage = new MemoryStorage(50);
    await app.close();
    ({ app, rules } = await bootstrap({ storage }));
    await rules.add({ pattern: '/health', note: 'probe' });

    expect(storage.loadIgnoreRules()).toEqual([
      expect.objectContaining({ pattern: '/health', note: 'probe', enabled: true }),
    ]);

    // A second process pointed at the same store picks the rule up at bootstrap.
    const second = await bootstrap({ storage });
    expect(second.rules.list().map((rule) => rule.pattern)).toEqual(['/health']);
    await second.app.close();
  });

  it('keeps rules when history is cleared', async () => {
    await request(app.getHttpServer()).get('/orders').expect(200);
    await rules.add({ pattern: '/health' });

    await request(app.getHttpServer()).delete('/__debug').expect(200);

    expect(await summaries(app)).toHaveLength(0);
    expect(rules.list()).toHaveLength(1);
  });
});

describe('the panel API', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app.close();
  });

  it('serves the rules and accepts CRUD over HTTP', async () => {
    ({ app } = await bootstrap());
    const base = '/__debug';

    const created = await request(app.getHttpServer())
      .post(`${base}/filters`)
      .send({ pattern: 'health', note: 'probe' })
      .expect(200);
    expect(created.body.ok).toBe(true);
    const id = created.body.rule.id as string;

    const feed = await request(app.getHttpServer())
      .get(`${base}?feed=filters`)
      .set('accept', 'application/json')
      .expect(200);
    expect(feed.body.editable).toBe(true);
    expect(feed.body.rules).toHaveLength(1);

    await request(app.getHttpServer())
      .patch(`${base}/filters/${id}`)
      .send({ enabled: false })
      .expect(200);
    expect(
      (
        await request(app.getHttpServer())
          .get(`${base}?feed=filters`)
          .set('accept', 'application/json')
      ).body.rules[0].enabled,
    ).toBe(false);

    await request(app.getHttpServer()).delete(`${base}/filters/${id}`).expect(200);
    expect(
      (
        await request(app.getHttpServer())
          .get(`${base}?feed=filters`)
          .set('accept', 'application/json')
      ).body.rules,
    ).toHaveLength(0);
  });

  it('reads the rule from the query string when there is no parsed body', async () => {
    ({ app } = await bootstrap());
    const res = await request(app.getHttpServer())
      .post('/__debug/filters?pattern=%2Fmetrics&note=scrape')
      .expect(200);
    expect(res.body.rule).toMatchObject({ pattern: '/metrics', note: 'scrape' });
  });

  it('rejects a bad pattern with 400 and a message the UI can show', async () => {
    ({ app } = await bootstrap());
    const res = await request(app.getHttpServer())
      .post('/__debug/filters')
      .send({ pattern: '/' })
      .expect(400);
    expect(res.body).toMatchObject({ ok: false });
    expect(res.body.error).toBeTruthy();
  });

  it('is read-only when runtimeIgnore is false', async () => {
    ({ app } = await bootstrap({ runtimeIgnore: false, ignore: ['/health'] }));

    const feed = await request(app.getHttpServer())
      .get('/__debug?feed=filters')
      .set('accept', 'application/json')
      .expect(200);
    expect(feed.body.editable).toBe(false);
    // Config rules are still listed, so the panel can explain a missing request.
    expect(feed.body.rules).toHaveLength(1);

    const rejected = await request(app.getHttpServer())
      .post('/__debug/filters')
      .send({ pattern: '/metrics' })
      .expect(400);
    expect(rejected.body.ok).toBe(false);

    // The static ignore keeps working regardless.
    await request(app.getHttpServer()).get('/health').expect(200);
    expect(await summaries(app)).toHaveLength(0);
  });

  it('does not shadow the profile detail route', async () => {
    ({ app } = await bootstrap());
    await request(app.getHttpServer()).get('/orders').expect(200);
    const [first] = await summaries(app);

    const detail = await request(app.getHttpServer())
      .get(`/__debug/${first!.id}`)
      .set('accept', 'application/json')
      .expect(200);
    expect(detail.body.url).toBe('/orders');

    await request(app.getHttpServer())
      .get('/__debug/filters')
      .set('accept', 'application/json')
      .expect(404);
  });
});
