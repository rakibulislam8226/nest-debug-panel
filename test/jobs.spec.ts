import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DebugModule } from '../src/debug.module';
import { DebugContextService } from '../src/context/debug-context.service';
import { DebugIgnore } from '../src/decorators/debug-ignore.decorator';
import { TrackJob } from '../src/decorators/track-job.decorator';
import { DEBUG_STORAGE, BULLMQ_PROCESSOR_METADATA } from '../src/constants';
import type { DebugStorage } from '../src/interfaces/storage.interface';
import type { RequestProfile, RequestSummary } from '../src/interfaces/profile.interface';

/** Stand-in for @nestjs/bullmq's abstract WorkerHost (matched by class name). */
class WorkerHost {}

interface FakeJob {
  name: string;
  id: string;
  data: unknown;
  attemptsMade?: number;
  opts?: { attempts?: number; priority?: number };
}

// A BullMQ-style processor with NO debug decorator — capture must be automatic.
@Injectable()
class EmailProcessor extends WorkerHost {
  constructor(private readonly debug: DebugContextService) {
    super();
  }
  async process(job: FakeJob): Promise<{ sent: boolean }> {
    this.debug.recordSql({ source: 'fake', sql: 'SELECT 1', durationMs: 1 });
    this.debug.recordSql({ source: 'fake', sql: 'SELECT 2', durationMs: 1 });
    return { sent: true };
  }
}
Reflect.defineMetadata(BULLMQ_PROCESSOR_METADATA, { name: 'emails' }, EmailProcessor);

@Injectable()
class FailingProcessor extends WorkerHost {
  constructor(private readonly debug: DebugContextService) {
    super();
  }
  async process(_job: FakeJob): Promise<void> {
    this.debug.recordSql({ source: 'fake', sql: 'SELECT boom', durationMs: 1 });
    throw new Error('kaboom');
  }
}
Reflect.defineMetadata(BULLMQ_PROCESSOR_METADATA, { name: 'failing' }, FailingProcessor);

// Concurrency isolation: three runs interleave; each must see only its own SQL.
@Injectable()
class ConcurrentProcessor extends WorkerHost {
  constructor(private readonly debug: DebugContextService) {
    super();
  }
  async process(job: FakeJob): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 5)); // force interleave
    this.debug.recordSql({ source: 'fake', sql: `SELECT ${job.id}`, durationMs: 1 });
    return job.id;
  }
}
Reflect.defineMetadata(BULLMQ_PROCESSOR_METADATA, { name: 'concurrent' }, ConcurrentProcessor);

// A processor explicitly opted out.
@Injectable()
@DebugIgnore()
class IgnoredProcessor extends WorkerHost {
  constructor(private readonly debug: DebugContextService) {
    super();
  }
  async process(_job: FakeJob): Promise<void> {
    this.debug.recordSql({ source: 'fake', sql: 'SELECT ignored', durationMs: 1 });
  }
}
Reflect.defineMetadata(BULLMQ_PROCESSOR_METADATA, { name: 'ignored' }, IgnoredProcessor);

// Explicit escape-hatch capture on a plain service method.
@Injectable()
class ReportService {
  constructor(private readonly debug: DebugContextService) {}
  @TrackJob({ queue: 'reports', jobName: 'daily' })
  async build(): Promise<string> {
    this.debug.recordSql({ source: 'fake', sql: 'SELECT report', durationMs: 1 });
    return 'ok';
  }
}

// A bee-queue-style imperative queue (has .process + .createJob) as a provider.
@Injectable()
class FakeBeeQueue {
  name = 'notifications';
  private handler?: (job: unknown) => unknown;
  constructor(private readonly debug: DebugContextService) {}
  process(handler: (job: unknown) => unknown): void {
    this.handler = handler;
  }
  createJob(): unknown {
    return {};
  }
  register(): void {
    this.process((_job: unknown) => {
      this.debug.recordSql({ source: 'fake', sql: 'SELECT bee', durationMs: 1 });
      return 'bee-done';
    });
  }
  run(job: unknown): unknown {
    return this.handler?.(job);
  }
}

// Not a queue: has a `process` method but no queue signature — must be ignored.
@Injectable()
class NotAQueue {
  constructor(private readonly debug: DebugContextService) {}
  process(): void {
    this.debug.recordSql({ source: 'fake', sql: 'SELECT nope', durationMs: 1 });
  }
}

@Module({
  providers: [
    EmailProcessor,
    ConcurrentProcessor,
    FailingProcessor,
    IgnoredProcessor,
    ReportService,
    FakeBeeQueue,
    NotAQueue,
  ],
})
class JobsModule {}

describe('Background-job auto-capture', () => {
  let app: INestApplication;
  let storage: DebugStorage;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DebugModule.forRoot({ enabled: true }), JobsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    storage = app.get<DebugStorage>(DEBUG_STORAGE);
  });

  afterAll(async () => {
    await app.close();
  });

  async function jobs(): Promise<RequestSummary[]> {
    const list = await storage.list();
    return list.filter((s) => s.kind === 'job');
  }

  async function findByQueue(queue: string): Promise<RequestProfile | undefined> {
    const summary = (await jobs()).find((s) => s.queue === queue);
    return summary ? ((await storage.find(summary.id)) ?? undefined) : undefined;
  }

  const job: FakeJob = {
    name: 'welcome',
    id: '42',
    data: { to: 'a@b.co', password: 'secret' },
    attemptsMade: 0,
    opts: { attempts: 3, priority: 5 },
  };

  it('captures a BullMQ processor with only DebugModule.forRoot() — even through a bound handler', async () => {
    const proc = app.get(EmailProcessor, { strict: false });
    // Simulate @nestjs/bullmq: it binds instance.process when building the Worker.
    // A prototype patch (applied in the tracker constructor) must survive this.
    const bound = proc.process.bind(proc);
    const result = await bound(job);
    expect(result).toEqual({ sent: true });

    const profile = await findByQueue('emails');
    expect(profile).toBeDefined();
    expect(profile!.kind).toBe('job');
    expect(profile!.job?.library).toBe('bullmq');
    expect(profile!.job?.jobName).toBe('welcome');
    expect(profile!.job?.jobId).toBe('42');
    expect(profile!.job?.maxAttempts).toBe(3);
    expect(profile!.sql).toHaveLength(2);
    expect(profile!.job?.returnValue).toEqual({ sent: true });
    // Payload captured + redacted.
    expect(JSON.stringify(profile!.body)).toContain('a@b.co');
    expect(JSON.stringify(profile!.body)).not.toContain('secret');
  });

  it('records the exception and rethrows so retry semantics are preserved', async () => {
    const proc = app.get(FailingProcessor, { strict: false });
    await expect(proc.process(job)).rejects.toThrow('kaboom');

    const profile = await findByQueue('failing');
    expect(profile).toBeDefined();
    expect(profile!.exception?.message).toBe('kaboom');
    expect(profile!.job?.failedReason).toBe('kaboom');
    expect(profile!.sql).toHaveLength(1);
  });

  it('skips a processor marked with @DebugIgnore()', async () => {
    const proc = app.get(IgnoredProcessor, { strict: false });
    await proc.process(job);
    expect(await findByQueue('ignored')).toBeUndefined();
  });

  it('captures a method annotated with @TrackJob()', async () => {
    const svc = app.get(ReportService, { strict: false });
    const out = await svc.build();
    expect(out).toBe('ok');

    const profile = await findByQueue('reports');
    expect(profile).toBeDefined();
    expect(profile!.job?.jobName).toBe('daily');
    expect(profile!.sql).toHaveLength(1);
  });

  it('captures an imperative bee-queue handler registered after bootstrap', async () => {
    const queue = app.get(FakeBeeQueue, { strict: false });
    queue.register();
    const result = await queue.run({ id: 'b1', data: { x: 1 } });
    expect(result).toBe('bee-done');

    const profile = await findByQueue('notifications');
    expect(profile).toBeDefined();
    expect(profile!.job?.library).toBe('bee-queue');
    expect(profile!.sql).toHaveLength(1);
  });

  it('isolates concurrent job runs — each profile sees only its own SQL', async () => {
    const proc = app.get(ConcurrentProcessor, { strict: false });
    await Promise.all(
      ['1', '2', '3'].map((id) => proc.process({ name: `c${id}`, id, data: {} })),
    );

    const profiles = await Promise.all(
      (await jobs())
        .filter((s) => s.queue === 'concurrent')
        .map((s) => storage.find(s.id)),
    );
    expect(profiles).toHaveLength(3);
    for (const profile of profiles) {
      expect(profile!.sql).toHaveLength(1);
      // The one SQL row must be the one this run recorded — never a sibling's.
      expect(profile!.sql[0].sql).toBe(`SELECT ${profile!.job?.jobId}`);
    }
  });

  it('does not false-positive on an unrelated provider that has a process() method', async () => {
    const before = (await jobs()).length;
    const svc = app.get(NotAQueue, { strict: false });
    svc.process();
    expect((await jobs()).length).toBe(before);
  });
});
