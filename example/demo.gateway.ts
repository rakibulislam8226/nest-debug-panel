import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { FakeDatabaseService } from './fake-database.service';

/**
 * Socket.io gateway for the demo. No debug-panel setup here at all — every
 * @SubscribeMessage handler is captured automatically (just like HTTP), and the
 * SQL each one runs shows up in the panel with N+1 detection.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class DemoGateway {
  constructor(private readonly db: FakeDatabaseService) {}

  @SubscribeMessage('users.list')
  async listUsers(): Promise<{ users: Array<{ id: number; name: string }> }> {
    const users = await this.db.findUsers();
    return { users };
  }

  @SubscribeMessage('users.get')
  async getUser(@MessageBody() payload: { id: number }): Promise<{ user: unknown }> {
    const user = await this.db.findUser(Number(payload?.id ?? 1));
    return { user };
  }

  // Triggers the N+1 detector — one query per user, captured on the Sockets page.
  @SubscribeMessage('users.withPosts')
  async withPosts(): Promise<{ users: unknown[] }> {
    const users = await this.db.findUsersWithPosts();
    return { users };
  }

  @SubscribeMessage('chat.send')
  async send(
    @MessageBody() payload: { room?: string; text: string },
    @ConnectedSocket() client: Socket,
  ): Promise<{ delivered: true }> {
    await this.db.findUser(1); // pretend we persist the message
    if (payload?.room) client.to(payload.room).emit('chat.new', payload);
    return { delivered: true };
  }

  @SubscribeMessage('boom')
  fail(): never {
    throw new Error('socket handler blew up on purpose');
  }
}
