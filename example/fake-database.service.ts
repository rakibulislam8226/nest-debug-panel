import { Injectable } from '@nestjs/common';
import { DebugContextService } from '../src';

/**
 * Stands in for a real ORM so the example runs with zero infrastructure.
 * It records SQL events exactly the way the Prisma adapter does — swap it
 * for `PrismaPlugin` in a real project (see README).
 */
@Injectable()
export class FakeDatabaseService {
  private readonly users = [
    { id: 1, name: 'Ada Lovelace' },
    { id: 2, name: 'Grace Hopper' },
    { id: 3, name: 'Margaret Hamilton' },
    { id: 4, name: 'Katherine Johnson' },
    { id: 5, name: 'Annie Easley' },
    { id: 6, name: 'Radia Perlman' },
  ];

  constructor(private readonly debug: DebugContextService) {}

  private async query<T>(sql: string, result: T, ms: number): Promise<T> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    this.debug.recordSql({ source: 'fake-orm', sql, durationMs: ms });
    return result;
  }

  findUsers(): Promise<Array<{ id: number; name: string }>> {
    return this.query('SELECT "id", "name" FROM "users" ORDER BY "id" ASC', this.users, 4);
  }

  findUser(id: number): Promise<{ id: number; name: string } | undefined> {
    return this.query(
      `SELECT "id", "name" FROM "users" WHERE "id" = ${id} LIMIT 1`,
      this.users.find((user) => user.id === id),
      2,
    );
  }

  /** Deliberately queries posts per-user to trigger the N+1 detector. */
  async findUsersWithPosts(): Promise<Array<{ id: number; name: string; posts: number }>> {
    const users = await this.findUsers();
    const result = [];
    for (const user of users) {
      const posts = await this.query<number>(
        `SELECT COUNT(*) FROM "posts" WHERE "user_id" = ${user.id}`,
        user.id * 2,
        3,
      );
      result.push({ ...user, posts });
    }
    return result;
  }

  slowReport(): Promise<{ rows: number }> {
    return this.query('SELECT * FROM "orders" JOIN "items" ON ... -- full scan', { rows: 90210 }, 180);
  }
}
