import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { DebugModule } from '../src/debug.module';
import { DebugContextService } from '../src/context/debug-context.service';
import type { RequestSummary } from '../src/interfaces/profile.interface';

// A gateway with NO debug decorator — capture must be fully automatic.
@Injectable()
@WebSocketGateway({ cors: { origin: '*' } })
class PlainGateway {
  constructor(private readonly debug: DebugContextService) {}

  @SubscribeMessage('ping')
  ping(): { pong: true } {
    this.debug.recordSql({ source: 'fake', sql: 'SELECT 1', durationMs: 1 });
    this.debug.recordSql({ source: 'fake', sql: 'SELECT 2', durationMs: 1 });
    return { pong: true };
  }
}

@Module({ providers: [PlainGateway] })
class GatewayModule {}

describe('Socket auto-tracking (real gateway, no decorator)', () => {
  let app: INestApplication;
  let client: Socket;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DebugModule.forRoot({ enabled: true }), GatewayModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    client?.disconnect();
    await app.close();
  });

  it('captures a gateway event and its SQL with only DebugModule.forRoot()', async () => {
    // Default transports (polling → websocket upgrade) survive CPU contention
    // when the whole test suite runs in parallel better than websocket-only.
    client = io(baseUrl, {
      reconnection: true,
      reconnectionAttempts: 10,
      timeout: 8000,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timed out')), 12000);
      client.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const ack = await new Promise<unknown>((resolve) =>
      client.emit('ping', { hello: 'world' }, resolve),
    );
    expect(ack).toEqual({ pong: true });

    // Give the finalize/save a tick to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`${baseUrl}/__debug`, { headers: { accept: 'application/json' } });
    const summaries = (await res.json()) as RequestSummary[];
    const socketEvents = summaries.filter((s) => s.kind === 'socket');
    expect(socketEvents).toHaveLength(1);
    expect(socketEvents[0].event).toBe('ping');
    expect(socketEvents[0].sqlCount).toBe(2);
  }, 20000);
});
