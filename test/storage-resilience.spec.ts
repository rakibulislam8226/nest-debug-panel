import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DebugModule } from '../src/debug.module';
import type { DebugStorage } from '../src/interfaces/storage.interface';
import type { RequestProfile, RequestSummary } from '../src/interfaces/profile.interface';

/** A storage backend that always fails — simulates a live Redis outage. */
class FailingStorage implements DebugStorage {
  save(): void {
    throw new Error('connection refused');
  }
  find(): RequestProfile | undefined {
    throw new Error('connection refused');
  }
  list(): RequestSummary[] {
    throw new Error('connection refused');
  }
  clear(): void {
    throw new Error('connection refused');
  }
  count(): number {
    throw new Error('connection refused');
  }
}

describe('Panel resilience when storage is unreachable', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DebugModule.forRoot({ enabled: true, storage: new FailingStorage() })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /__debug degrades to an empty list instead of 500ing', async () => {
    const res = await request(app.getHttpServer())
      .get('/__debug')
      .set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /__debug/:id degrades to 404 (not a 500) when find() fails', async () => {
    const res = await request(app.getHttpServer())
      .get('/__debug/some-id')
      .set('Accept', 'application/json');
    expect(res.status).toBe(404);
  });

  it('GET /__debug?feed=queries degrades to an empty feed', async () => {
    const res = await request(app.getHttpServer())
      .get('/__debug?feed=queries')
      .set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queries: [] });
  });

  it('DELETE /__debug reports cleared:false instead of erroring', async () => {
    const res = await request(app.getHttpServer()).delete('/__debug');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: false });
  });

  it('a normal (non-debug) request is completely unaffected', async () => {
    // The panel's own storage failing must never surface outside /__debug.
    const res = await request(app.getHttpServer()).get('/does-not-exist');
    expect(res.status).toBe(404); // Nest's normal 404 — no panel-related 500
  });
});
