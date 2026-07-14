import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DebugModule } from '../src/debug.module';
import type { RequestProfile } from '../src/interfaces/profile.interface';

type Middleware = (
  params: { model?: string; action?: string },
  next: (params: unknown) => Promise<unknown>,
) => Promise<unknown>;

/** Duck-types as a PrismaClient with $use middleware support (Prisma 2–5 style). */
@Injectable()
class FakePrismaService {
  private readonly middlewares: Middleware[] = [];

  $connect(): void {}
  $extends(): this {
    return this;
  }
  $use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  async findManyUsers(): Promise<unknown> {
    const run = async (): Promise<unknown> => [{ id: 1 }];
    const chain = this.middlewares.reduceRight<() => Promise<unknown>>(
      (next, middleware) => () => middleware({ model: 'User', action: 'findMany' }, next),
      run,
    );
    return chain();
  }
}

/** Duck-types as an ioredis client. */
@Injectable()
class FakeRedisService {
  async sendCommand(command: { name: string; args: string[] }): Promise<string> {
    return `OK:${command.name}`;
  }
}

@Controller()
class AutoTestController {
  constructor(
    private readonly prisma: FakePrismaService,
    private readonly redis: FakeRedisService,
  ) {}

  @Get('drivers')
  async drivers(): Promise<unknown> {
    await this.redis.sendCommand({ name: 'get', args: ['drivers:list'] });
    return this.prisma.findManyUsers();
  }
}

@Module({
  controllers: [AutoTestController],
  providers: [FakePrismaService, FakeRedisService],
})
class AutoTestModule {}

async function bootApp(autoInstrument: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [DebugModule.forRoot({ enabled: true, autoInstrument }), AutoTestModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('Auto-instrumentation (zero-config)', () => {
  it('detects prisma-like and redis-like providers with NO plugin wiring', async () => {
    const app = await bootApp(true);
    await request(app.getHttpServer()).get('/drivers').expect(200);

    const list = await request(app.getHttpServer()).get('/__debug').expect(200);
    expect(list.body[0].sqlCount).toBe(1);
    expect(list.body[0].redisCount).toBe(1);

    const detail = await request(app.getHttpServer()).get(`/__debug/${list.body[0].id}`);
    const profile = detail.body as RequestProfile;
    expect(profile.sql[0].source).toBe('prisma');
    expect(profile.sql[0].sql).toBe('User.findMany');
    expect(profile.sql[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(profile.redis[0].command).toBe('GET');
    expect(profile.timeline.some((event) => event.label === 'Prisma User.findMany')).toBe(true);
    await app.close();
  });

  it('does nothing when autoInstrument is false', async () => {
    const app = await bootApp(false);
    await request(app.getHttpServer()).get('/drivers').expect(200);

    const list = await request(app.getHttpServer()).get('/__debug').expect(200);
    expect(list.body[0].sqlCount).toBe(0);
    expect(list.body[0].redisCount).toBe(0);
    await app.close();
  });
});
