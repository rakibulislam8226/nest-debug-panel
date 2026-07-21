/** A single database query captured during a request. */
export interface SqlQueryEvent {
  id: string;
  /** Adapter that produced the event, e.g. `prisma`, `typeorm`. */
  source: string;
  /** ORM model, when known (e.g. `User`). */
  model?: string;
  /** ORM operation, when known (e.g. `findMany`). */
  operation?: string;
  /** Raw SQL, when the adapter can capture it. */
  sql?: string;
  /** Serialized query parameters. */
  params?: string;
  durationMs: number;
  /** Epoch ms. */
  startedAt: number;
  transactionId?: string;
}

/** A Redis command captured during a request. */
export interface RedisCommandEvent {
  id: string;
  command: string;
  args: string[];
  durationMs: number;
  startedAt: number;
  error?: string;
}

/** An outgoing HTTP call captured during a request. */
export interface HttpClientEvent {
  id: string;
  /** Adapter that produced the event, e.g. `axios`, `fetch`. */
  source: string;
  method: string;
  url: string;
  statusCode?: number;
  durationMs: number;
  startedAt: number;
  requestSize?: number;
  responseSize?: number;
  error?: string;
}

export type TimelineKind =
  | 'request'
  | 'sql'
  | 'redis'
  | 'http'
  | 'exception'
  | 'custom'
  | 'response';

/** One entry on the per-request timeline. `at` is the offset in ms from request start. */
export interface TimelineEvent {
  at: number;
  label: string;
  kind: TimelineKind;
  durationMs?: number;
}

export interface ExceptionInfo {
  name: string;
  message: string;
  stack?: string;
  statusCode?: number;
  /** Offset in ms from request start when the exception was recorded. */
  at: number;
}

export interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers?: number;
}

export interface MemoryProfile {
  before?: MemorySnapshot;
  after?: MemorySnapshot;
  heapUsedDelta?: number;
  /** Mean event-loop delay (ms) observed while the request was in flight. */
  eventLoopDelayMs?: number;
}

export interface DuplicateQueryGroup {
  /** A representative query of the group (first occurrence). */
  sql: string;
  count: number;
  totalTimeMs: number;
}

export interface SqlAnalysis {
  totalQueries: number;
  totalTimeMs: number;
  /** Index into `profile.sql` of the slowest query, -1 when there are none. */
  slowestIndex: number;
  /** Queries at or above `slowQueryThreshold`. */
  slowQueryCount: number;
  /** Normalized queries executed more than once. */
  duplicates: DuplicateQueryGroup[];
  /** Duplicate SELECT-style queries repeated often enough to look like N+1. */
  possibleNPlusOne: DuplicateQueryGroup[];
}

/** Metadata for a captured socket.io event (inbound `@SubscribeMessage`). */
export interface SocketMeta {
  /** The event name the handler is subscribed to. */
  event: string;
  /** Namespace the socket belongs to (e.g. `/` or `/chat`). */
  namespace?: string;
  /** The socket's id. */
  socketId?: string;
  /** Rooms the socket has joined. */
  rooms?: string[];
  /** Sanitized handshake info (headers, query, auth, address). */
  handshake?: Record<string, unknown>;
  /** Handler return value / acknowledgement payload. */
  ack?: unknown;
}

/**
 * Everything captured for a single unit of work — an HTTP request (default)
 * or an inbound socket.io event. The shape is shared so the storage, SQL
 * analysis, timeline and detail UI work for both.
 */
export interface RequestProfile {
  id: string;
  /** What produced this profile. Absent is treated as `'http'`. */
  kind?: 'http' | 'socket';
  method: string;
  url: string;
  /** Route pattern when available (e.g. `/users/:id`). */
  route?: string;
  queryParams: Record<string, unknown>;
  routeParams: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  user?: unknown;
  ip?: string;
  /** ISO timestamp of request start. */
  startedAt: string;
  /** Epoch ms of request start (used for timeline offsets). */
  startedAtMs: number;
  endedAtMs?: number;
  durationMs?: number;
  statusCode?: number;
  responseBody?: unknown;
  responseSize?: number;
  slow?: boolean;
  sql: SqlQueryEvent[];
  redis: RedisCommandEvent[];
  http: HttpClientEvent[];
  timeline: TimelineEvent[];
  exception?: ExceptionInfo;
  memory?: MemoryProfile;
  sqlAnalysis?: SqlAnalysis;
  /** Socket metadata, present when `kind === 'socket'`. */
  socket?: SocketMeta;
  /** Free-form data recorded by plugins or user code. */
  custom: Record<string, unknown>;
}

/** Lightweight row for the request/socket list. */
export interface RequestSummary {
  id: string;
  kind: 'http' | 'socket';
  method: string;
  url: string;
  /** Socket event name, when `kind === 'socket'`. */
  event?: string;
  /** Socket namespace, when `kind === 'socket'`. */
  namespace?: string;
  statusCode?: number;
  durationMs?: number;
  startedAt: string;
  sqlCount: number;
  redisCount: number;
  httpCount: number;
  hasException: boolean;
  slow: boolean;
}

export function toRequestSummary(profile: RequestProfile): RequestSummary {
  return {
    id: profile.id,
    kind: profile.kind ?? 'http',
    method: profile.method,
    url: profile.url,
    event: profile.socket?.event,
    namespace: profile.socket?.namespace,
    statusCode: profile.statusCode,
    durationMs: profile.durationMs,
    startedAt: profile.startedAt,
    sqlCount: profile.sql.length,
    redisCount: profile.redis.length,
    httpCount: profile.http.length,
    hasException: profile.exception !== undefined,
    slow: profile.slow === true,
  };
}
