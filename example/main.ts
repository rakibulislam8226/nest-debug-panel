import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { io } from 'socket.io-client';
import { AppModule } from './app.module';

/**
 * Fires a few socket events at our own server so the panel has socket data to
 * show as soon as you open it — no separate command needed. Dev-demo only.
 */
async function driveSocketDemo(port: number): Promise<void> {
  const socket = io(`http://localhost:${port}`, { transports: ['websocket'] });
  const emit = (event: string, payload?: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve('(no ack)'), 1000);
      socket.emit(event, payload, (ack: unknown) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });

  await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
  await emit('users.list');
  await emit('users.get', { id: 2 });
  await emit('users.withPosts'); // N+1 demo
  await emit('chat.send', { text: 'hello', password: 's3cret' });
  socket.disconnect();
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new IoAdapter(app)); // enable socket.io
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  // Populate some socket events automatically (dev demo).
  void driveSocketDemo(port).catch(() => undefined);

  console.log(`
  Example app:     http://localhost:${port}
  Debug panel:     http://localhost:${port}/__debug   (HTTP + Socket, filter at the top)

  Try more HTTP:
    curl http://localhost:${port}/users
    curl http://localhost:${port}/n-plus-one   # N+1 detection demo
    curl http://localhost:${port}/boom         # exception capture

  Socket events are fired automatically at startup and show up in the panel
  under the "Socket" filter — no extra command, no gateway setup needed.
`);
}

void bootstrap();
