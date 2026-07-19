import { performance } from 'node:perf_hooks';
import type { RequestProfile } from '../../interfaces/profile.interface';

export interface CorrelationToken {
  profile: RequestProfile;
  /** ORM model of the operation that opened this token, when known. */
  model?: string;
  /** ORM operation that opened this token, when known. */
  operation?: string;
  /** How many raw query events were attributed to this operation. */
  attached: number;
}

/** How long after an operation ends a raw query event may still be attributed to it. */
const GRACE_MS = 30;

/**
 * Prisma emits raw `query` log events from its engine, outside the request's
 * AsyncLocalStorage context. This correlator bridges the gap: the client
 * extension marks operation begin/end (inside the ALS context), and query
 * events are attributed to the innermost in-flight operation — or, within a
 * short grace window, to the one that just finished.
 *
 * Attribution is best-effort under concurrency; for a dev tool this trades a
 * rare mislabel for zero overhead on the query path.
 */
export class PrismaCorrelator {
  private stack: CorrelationToken[] = [];
  private recent?: { token: CorrelationToken; endedAt: number };

  begin(profile: RequestProfile, model?: string, operation?: string): CorrelationToken {
    const token: CorrelationToken = { profile, model, operation, attached: 0 };
    this.stack.push(token);
    return token;
  }

  end(token: CorrelationToken): void {
    this.stack = this.stack.filter((t) => t !== token);
    this.recent = { token, endedAt: performance.now() };
  }

  resolve(): CorrelationToken | undefined {
    if (this.stack.length > 0) return this.stack[this.stack.length - 1];
    if (this.recent && performance.now() - this.recent.endedAt <= GRACE_MS) {
      return this.recent.token;
    }
    return undefined;
  }
}
