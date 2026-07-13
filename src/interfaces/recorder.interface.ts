import type { RequestProfile } from './profile.interface';

export interface SqlEventInput {
  source: string;
  sql?: string;
  params?: string;
  model?: string;
  operation?: string;
  durationMs: number;
  /** Epoch ms; defaults to `now - durationMs`. */
  startedAt?: number;
  transactionId?: string;
}

export interface RedisEventInput {
  command: string;
  args?: string[];
  durationMs: number;
  startedAt?: number;
  error?: string;
}

export interface HttpEventInput {
  source: string;
  method: string;
  url: string;
  statusCode?: number;
  durationMs: number;
  startedAt?: number;
  requestSize?: number;
  responseSize?: number;
  error?: string;
}

/**
 * The write-side API plugins and user code use to attach events to the
 * profile of the request currently executing (resolved via AsyncLocalStorage).
 *
 * All record methods are safe to call outside a request context — they no-op.
 * The optional `target` parameter lets adapters that lose the async context
 * (e.g. engine-level event emitters) attach events to an explicit profile.
 */
export interface DebugRecorder {
  isActive(): boolean;
  getProfile(): RequestProfile | undefined;
  recordSql(event: SqlEventInput, target?: RequestProfile): void;
  recordRedis(event: RedisEventInput, target?: RequestProfile): void;
  recordHttp(event: HttpEventInput, target?: RequestProfile): void;
  recordException(error: unknown, target?: RequestProfile): void;
  /** Add a custom timeline marker, e.g. `recorder.mark('Auth Guard', 2.1)`. */
  mark(label: string, durationMs?: number): void;
  /** Attach free-form data to the current profile. */
  setCustom(key: string, value: unknown): void;
}
