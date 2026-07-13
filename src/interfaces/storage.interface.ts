import type { RequestProfile, RequestSummary } from './profile.interface';

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
}
