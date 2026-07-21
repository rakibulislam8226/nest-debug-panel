import 'reflect-metadata';
import type { CallHandler, ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { DebugModule } from '../src/debug.module';
import { DebugInterceptor } from '../src/interceptor/debug.interceptor';
import { DebugContextService } from '../src/context/debug-context.service';
import { PluginManager } from '../src/plugins/plugin-manager.service';
import { DEBUG_OPTIONS, DEBUG_STORAGE, SOCKET_MESSAGE_METADATA } from '../src/constants';
import type { ResolvedDebugOptions } from '../src/config/debug-options';
import type { DebugStorage } from '../src/interfaces/storage.interface';
import type { RequestProfile, RequestSummary } from '../src/interfaces/profile.interface';

/** A handler function carrying the @SubscribeMessage() metadata Nest sets. */
function handlerFor(event: string): () => void {
  const fn = (): void => undefined;
  Reflect.defineMetadata(SOCKET_MESSAGE_METADATA, event, fn);
  return fn;
}

/** A synthetic `ws` ExecutionContext mimicking what NestJS passes gateways. */
function wsContext(handler: () => void, client: unknown, data: unknown): ExecutionContext {
  return {
    getType: () => 'ws',
    getHandler: () => handler,
    getClass: () => class Gateway {},
    switchToWs: () => ({ getClient: () => client, getData: () => data, getPattern: () => '' }),
    switchToHttp: () => {
      throw new Error('switchToHttp must not be called for a socket profile');
    },
  } as unknown as ExecutionContext;
}

function fakeClient(): unknown {
  return {
    id: 'sock-123',
    nsp: { name: '/chat' },
    rooms: new Set(['sock-123', 'room:42']),
    handshake: {
      headers: { authorization: 'Bearer secret', 'user-agent': 'jest' },
      query: { token: 'abc' },
      auth: { password: 'hunter2' },
      address: '127.0.0.1',
    },
    data: { user: { id: 7, name: 'ada' } },
  };
}

async function run(interceptor: DebugInterceptor, ctx: ExecutionContext, next: CallHandler): Promise<void> {
  await new Promise<void>((resolve) => {
    interceptor.intercept(ctx, next).subscribe({
      next: () => undefined,
      error: () => resolve(),
      complete: () => resolve(),
    });
  });
}

describe('DebugInterceptor — socket.io capture', () => {
  let app: INestApplication;
  let interceptor: DebugInterceptor;
  let context: DebugContextService;
  let storage: DebugStorage;
  let options: ResolvedDebugOptions;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DebugModule.forRoot({ enabled: true, captureResponseBody: true })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    options = app.get<ResolvedDebugOptions>(DEBUG_OPTIONS);
    storage = app.get<DebugStorage>(DEBUG_STORAGE);
    context = app.get(DebugContextService);
    interceptor = new DebugInterceptor(
      options,
      storage,
      context,
      app.get(PluginManager),
      app.get(Reflector),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await storage.clear();
  });

  it('captures a socket event with its SQL and acknowledgement', async () => {
    const handler = handlerFor('chat.send');
    const next: CallHandler = {
      handle: () => {
        // Runs inside the interceptor's ALS context, so SQL attaches here.
        context.recordSql({ source: 'fake', sql: 'INSERT INTO messages', durationMs: 4 });
        context.recordSql({ source: 'fake', sql: 'SELECT * FROM messages', durationMs: 2 });
        return of({ delivered: true });
      },
    };

    await run(interceptor, wsContext(handler, fakeClient(), { text: 'hi', password: 'hunter2' }), next);

    const list = (await storage.list()) as RequestSummary[];
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('socket');
    expect(list[0].event).toBe('chat.send');
    expect(list[0].namespace).toBe('/chat');
    expect(list[0].sqlCount).toBe(2);

    const profile = (await storage.find(list[0].id)) as RequestProfile;
    expect(profile.kind).toBe('socket');
    expect(profile.method).toBe('WS');
    expect(profile.socket?.event).toBe('chat.send');
    expect(profile.socket?.socketId).toBe('sock-123');
    expect(profile.socket?.rooms).toEqual(expect.arrayContaining(['room:42']));
    expect(profile.socket?.ack).toEqual({ delivered: true });
    expect(profile.sql).toHaveLength(2);
    expect(profile.sqlAnalysis?.totalQueries).toBe(2);
    // status codes are meaningless for sockets
    expect(profile.statusCode).toBeUndefined();
    // sensitive fields redacted in payload + handshake
    expect((profile.body as Record<string, unknown>).password).toBe('[REDACTED]');
    const handshake = profile.socket?.handshake as Record<string, Record<string, unknown>>;
    expect(handshake.headers.authorization).toBe('[REDACTED]');
    expect(handshake.auth.password).toBe('[REDACTED]');
  });

  it('records exceptions thrown in a socket handler without a status code', async () => {
    const handler = handlerFor('chat.fail');
    const next: CallHandler = {
      handle: () => throwError(() => new Error('boom')),
    };

    await run(interceptor, wsContext(handler, fakeClient(), {}), next);

    const list = (await storage.list()) as RequestSummary[];
    expect(list[0].hasException).toBe(true);
    const profile = (await storage.find(list[0].id)) as RequestProfile;
    expect(profile.exception?.message).toContain('boom');
    expect(profile.statusCode).toBeUndefined();
  });

  it('skips socket capture when sockets are disabled', async () => {
    const disabled: ResolvedDebugOptions = { ...options, captureSockets: false };
    const off = new DebugInterceptor(disabled, storage, context, app.get(PluginManager), app.get(Reflector));
    const handler = handlerFor('chat.send');
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await run(off, wsContext(handler, fakeClient(), {}), next);
    expect(await storage.list()).toHaveLength(0);
  });

  it('shows socket events in the unified list with a kind tag', async () => {
    const handler = handlerFor('room.join');
    const next: CallHandler = { handle: () => of({ joined: true }) };
    await run(interceptor, wsContext(handler, fakeClient(), {}), next);

    // one shared list; the socket event carries kind === 'socket'
    const list = await request(app.getHttpServer()).get('/__debug').expect(200);
    const summaries = list.body as RequestSummary[];
    expect(summaries).toHaveLength(1);
    expect(summaries[0].kind).toBe('socket');
    expect(summaries[0].event).toBe('room.join');

    // The dashboard is a client-rendered SPA: it ships the app shell with a
    // Sockets monitor in the sidebar; the event rows are hydrated from the JSON
    // feed above, not baked into the initial HTML.
    const page = await request(app.getHttpServer())
      .get('/__debug')
      .set('accept', 'text/html')
      .expect(200)
      .expect('content-type', /text\/html/);
    expect(page.text).toContain('<!DOCTYPE html>');
    expect(page.text).toContain('data-view="sockets"');
  });
});
