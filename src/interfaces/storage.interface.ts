import type { RequestProfile, RequestSummary } from './profile.interface';
import type { IgnoreRule } from './ignore-rule.interface';

/**
 * Storage driver contract. Implementations may be sync or async.
 * The default is {@link MemoryStorage}; Redis/File/Database drivers can be
 * supplied via `DebugModule.forRoot({ storage })`.
 */
export interface DebugStorage {
  save(profile: RequestProfile): void | Promise<void>;
  find(id: string): RequestProfile | undefined | Promise<RequestProfile | undefined>;
  /** Newest first. */
  list(): RequestSummary[] | Promise<RequestSummary[]>;
  clear(): void | Promise<void>;
  count(): number | Promise<number>;

  /**
   * Optional: persistence for the ignore rules managed from the dashboard.
   *
   * A driver that implements this pair makes rules durable — and, with a shared
   * backend like Redis, visible to every process. Drivers that omit them still
   * work: rules then live in the process that created them and are lost on
   * restart, which is why `MemoryStorage` implements them as a plain field.
   */
  loadIgnoreRules?(): IgnoreRule[] | Promise<IgnoreRule[]>;
  saveIgnoreRules?(rules: IgnoreRule[]): void | Promise<void>;

  /**
   * `true` when other processes write to the same store, so the rules can change
   * without this process doing anything. Only then is a periodic re-read worth
   * its cost: with a process-local store there is nothing to poll for, and the
   * service stays completely idle after bootstrap.
   */
  readonly sharedIgnoreRules?: boolean;
}
