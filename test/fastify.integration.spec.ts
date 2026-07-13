import { BadRequestException, Controller, Get, Module, Post, Body } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { DebugModule } from '../src/debug.module';
import { DebugContextService } from '../src/context/debug-context.service';
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
});
