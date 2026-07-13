import { Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Body } from '@nestjs/common';
import { DebugContextService, DebugIgnore } from '../src';
import { FakeDatabaseService } from './fake-database.service';

@Controller()
export class DemoController {
  constructor(
    private readonly db: FakeDatabaseService,
    private readonly debug: DebugContextService,
  ) {}

  @Get('users')
  async listUsers(): Promise<unknown> {
    this.debug.mark('Listing users');
    return this.db.findUsers();
  }

  @Get('users/:id')
  async getUser(@Param('id', ParseIntPipe) id: number): Promise<unknown> {
    const user = await this.db.findUser(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  @Post('users')
  createUser(@Body() body: { name: string; password?: string }): unknown {
    // `password` will show up as [REDACTED] in the captured body
    return { id: 4, name: body.name };
  }

  /** Triggers the N+1 detector — open the SQL tab for this request. */
  @Get('n-plus-one')
  nPlusOne(): Promise<unknown> {
    return this.db.findUsersWithPosts();
  }

  /** Flagged as a slow request with a slow query. */
  @Get('slow')
  async slow(): Promise<unknown> {
    this.debug.mark('Generating report');
    return this.db.slowReport();
  }

  /** Makes an outgoing HTTP call captured by FetchPlugin. */
  @Get('external')
  async external(): Promise<unknown> {
    const response = await fetch('https://jsonplaceholder.typicode.com/todos/1');
    return response.json();
  }

  /** Captured with full stack trace in the Exception tab. */
  @Get('boom')
  boom(): never {
    throw new Error('Something exploded in the demo handler');
  }

  @DebugIgnore()
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
