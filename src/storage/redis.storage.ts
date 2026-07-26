import type { DebugStorage } from '../interfaces/storage.interface';
import { toRequestSummary } from '../interfaces/profile.interface';
import type { RequestProfile, RequestSummary } from '../interfaces/profile.interface';

/**
 * Minimal structural view of an ioredis-compatible client. BullMQ already uses
 * ioredis, so apps that run jobs have a matching client to hand — pass it in and
 * the package stays dependency-free.
 */
export interface RedisClientLike {
  set(key: string, value: string, mode: string, ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  lpush(key: string, ...values: string[]): Promise<unknown>;
  lrem(key: string, count: number, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

export interface RedisStorageOptions {
  /**
   * An ioredis-compatible client (e.g. your existing BullMQ connection).
   * Preferred — reuses a connection the app already manages.
   */
  client?: RedisClientLike;
  /**
   * Redis connection string. Used only when `client` is omitted: the driver
   * lazily creates its own ioredis client from it (and closes it on shutdown).
   */
  url?: string;
  /** Extra ioredis options, applied only when connecting via `url`. */
  redisOptions?: Record<string, unknown>;
  /** Key namespace. Default `nest-debug-panel`. Use the same value in every process. */
  prefix?: string;
  /** Max profiles retained (newest kept). Default 200. */
  maxRequests?: number;
  /** Per-profile TTL in seconds (a safety net against orphans). Default 3600. */
  ttlSeconds?: number;
}

/**
 * Redis-backed storage — the shared store for multi-process apps.
 *
 * In a typical NestJS setup the HTTP API and the BullMQ worker run as separate
 * processes, each with its own memory. Point both at the **same** Redis with
 * this driver and one panel shows everything — API requests, socket events and
 * the worker's jobs — because every process reads and writes the same keys.
 *
 * ```ts
 * import IORedis from 'ioredis';
 * import { DebugModule, RedisStorage } from 'nest-debug-panel';
 *
 * const connection = new IORedis(process.env.REDIS_URL);
 * // Use the SAME config in both the API module and the worker module:
 * DebugModule.forRoot({ storage: new RedisStorage({ client: connection }) });
 * ```
 *
 * Data model: each profile is a JSON string at `<prefix>:p:<id>` (with its
 * summary at `<prefix>:s:<id>`), and a capped, newest-first list of ids lives at
 * `<prefix>:order`. `list()` reads the ordered summaries in one round-trip.
 */
export class RedisStorage implements DebugStorage {
  private readonly client: RedisClientLike;
  private readonly ownsClient: boolean;
  private readonly prefix: string;
  private readonly maxRequests: number;
  private readonly ttlSeconds: number;

  constructor(options: RedisStorageOptions) {
    if (options?.client) {
      this.client = options.client;
      this.ownsClient = false;
    } else if (options?.url) {
      this.client = createIoredisClient(options.url, options.redisOptions);
      this.ownsClient = true;
    } else {
      throw new Error('RedisStorage requires an ioredis-compatible `client` or a `url`.');
    }
    this.prefix = options.prefix ?? 'nest-debug-panel';
    this.maxRequests = Math.max(1, options.maxRequests ?? 200);
    // Redis rejects a non-positive EX, so keep TTL at least 1s.
    this.ttlSeconds = Math.max(1, options.ttlSeconds ?? 3600);
  }

  /** Close the connection — but only one this store opened itself (`url` mode). */
  async disconnect(): Promise<void> {
    if (!this.ownsClient) return;
    const client = this.client as { quit?: () => Promise<unknown>; disconnect?: () => void };
    try {
      if (client.quit) await client.quit();
      else client.disconnect?.();
    } catch {
      /* best-effort close */
    }
  }

  async save(profile: RequestProfile): Promise<void> {
    const id = profile.id;
    const full = safeStringify(profile);
    const summary = JSON.stringify(toRequestSummary(profile));
    // Store the profile + its summary, then move the id to the front of the
    // capped order list (LREM first so a re-saved profile isn't duplicated).
    await this.client.set(this.key('p', id), full, 'EX', this.ttlSeconds);
    await this.client.set(this.key('s', id), summary, 'EX', this.ttlSeconds);
    await this.client.lrem(this.orderKey, 0, id);
    await this.client.lpush(this.orderKey, id);
    await this.client.ltrim(this.orderKey, 0, this.maxRequests - 1);
  }

  async find(id: string): Promise<RequestProfile | undefined> {
    const raw = await this.client.get(this.key('p', id));
    return raw ? safeParse<RequestProfile>(raw) : undefined;
  }

  async list(): Promise<RequestSummary[]> {
    const ids = await this.client.lrange(this.orderKey, 0, this.maxRequests - 1);
    if (!ids.length) return [];
    const raw = await this.client.mget(...ids.map((id) => this.key('s', id)));
    const out: RequestSummary[] = [];
    for (const item of raw) {
      const parsed = item ? safeParse<RequestSummary>(item) : undefined;
      if (parsed) out.push(parsed);
    }
    return out;
  }

  async clear(): Promise<void> {
    const ids = await this.client.lrange(this.orderKey, 0, -1);
    const keys = ids.flatMap((id) => [this.key('p', id), this.key('s', id)]);
    if (keys.length) await this.client.del(...keys);
    await this.client.del(this.orderKey);
  }

  async count(): Promise<number> {
    return this.client.llen(this.orderKey);
  }

  private get orderKey(): string {
    return `${this.prefix}:order`;
  }

  private key(kind: 'p' | 's', id: string): string {
    return `${this.prefix}:${kind}:${id}`;
  }
}

/**
 * Serialize a profile for Redis. Unlike in-memory storage, Redis needs JSON —
 * and a profile can carry values plain `JSON.stringify` rejects (a `BigInt`, or
 * a circular reference, usually via user-set `custom` data). We handle both so
 * persistence never throws, and if all else fails we store a *valid* skeleton
 * (empty arrays, real id) so `find()` always returns something the detail page
 * can render, rather than a stub that would crash it.
 */
function safeStringify(profile: RequestProfile): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(profile, (_key, val) => {
      if (typeof val === 'bigint') return `${val}`;
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  } catch {
    return JSON.stringify(skeletonProfile(profile));
  }
}

/** A minimal but structurally valid profile — safe for the detail UI to render. */
function skeletonProfile(profile: RequestProfile): RequestProfile {
  return {
    id: profile?.id ?? 'unknown',
    kind: profile?.kind,
    method: profile?.method ?? '',
    url: profile?.url ?? '',
    queryParams: {},
    routeParams: {},
    startedAt: profile?.startedAt ?? new Date(profile?.startedAtMs ?? 0).toISOString(),
    startedAtMs: profile?.startedAtMs ?? 0,
    durationMs: profile?.durationMs,
    sql: [],
    redis: [],
    http: [],
    logs: [],
    timeline: [],
    custom: {},
  };
}

function safeParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Lazily construct an ioredis client from a URL. `ioredis` is an optional peer —
 * only required when you use the `url` form (or `NEST_DEBUG_PANEL_STORAGE=redis`). Apps that
 * pass their own `client` never touch this, so the package stays dependency-free.
 */
function createIoredisClient(url: string, redisOptions?: Record<string, unknown>): RedisClientLike {
  let mod: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('ioredis');
  } catch {
    throw new Error(
      'RedisStorage({ url }) needs the "ioredis" package. Install it (`npm i ioredis`), ' +
        'or pass an existing `client` instead.',
    );
  }
  const IORedis = ((mod as { default?: unknown }).default ?? mod) as new (
    url: string,
    options?: Record<string, unknown>,
  ) => RedisClientLike;
  return redisOptions ? new IORedis(url, redisOptions) : new IORedis(url);
}
