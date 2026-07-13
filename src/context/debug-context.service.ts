import { Inject, Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEBUG_OPTIONS } from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';
import type {
  DebugRecorder,
  HttpEventInput,
  RedisEventInput,
  SqlEventInput,
} from '../interfaces/recorder.interface';
import type { RequestProfile, TimelineKind } from '../interfaces/profile.interface';
import { eventId, round2 } from '../utils/common';

/**
 * Holds the per-request profile in AsyncLocalStorage so any code executing
 * within a request (services, plugins, monkey-patched clients) can attach
 * events without global mutable state and without passing the profile around.
 */
@Injectable()
export class DebugContextService implements DebugRecorder {
  private readonly als = new AsyncLocalStorage<RequestProfile>();

  constructor(@Inject(DEBUG_OPTIONS) private readonly options: ResolvedDebugOptions) {}

  /** Run `fn` with `profile` as the active request context. */
  run<T>(profile: RequestProfile, fn: () => T): T {
    return this.als.run(profile, fn);
  }

  getProfile(): RequestProfile | undefined {
    return this.als.getStore();
  }

  isActive(): boolean {
    return this.als.getStore() !== undefined;
  }

  /**
   * Recorder calls happen inside application code paths (patched clients,
   * user services). They must never throw — a broken event is dropped.
   */
  private safely(record: () => void): void {
    try {
      record();
    } catch {
      /* drop the event, never break the caller */
    }
  }

  recordSql(event: SqlEventInput, target?: RequestProfile): void {
    this.safely(() => this.doRecordSql(event, target));
  }

  private doRecordSql(event: SqlEventInput, target?: RequestProfile): void {
    if (!this.options.captureSql) return;
    const profile = target ?? this.getProfile();
    if (!profile) return;
    const startedAt = event.startedAt ?? Date.now() - event.durationMs;
    profile.sql.push({
      id: eventId(),
      source: event.source,
      model: event.model,
      operation: event.operation,
      sql: event.sql,
      params: event.params,
      durationMs: round2(event.durationMs),
      startedAt,
      transactionId: event.transactionId,
    });
    const label = event.sql ?? [event.model, event.operation].filter(Boolean).join('.');
    this.pushTimeline(profile, 'sql', `SQL ${truncate(label, 80)}`, startedAt, event.durationMs);
  }

  recordRedis(event: RedisEventInput, target?: RequestProfile): void {
    this.safely(() => this.doRecordRedis(event, target));
  }

  private doRecordRedis(event: RedisEventInput, target?: RequestProfile): void {
    if (!this.options.captureRedis) return;
    const profile = target ?? this.getProfile();
    if (!profile) return;
    const startedAt = event.startedAt ?? Date.now() - event.durationMs;
    profile.redis.push({
      id: eventId(),
      command: event.command,
      args: event.args ?? [],
      durationMs: round2(event.durationMs),
      startedAt,
      error: event.error,
    });
    this.pushTimeline(profile, 'redis', `Redis ${event.command}`, startedAt, event.durationMs);
  }

  recordHttp(event: HttpEventInput, target?: RequestProfile): void {
    this.safely(() => this.doRecordHttp(event, target));
  }

  private doRecordHttp(event: HttpEventInput, target?: RequestProfile): void {
    if (!this.options.captureHttp) return;
    const profile = target ?? this.getProfile();
    if (!profile) return;
    const startedAt = event.startedAt ?? Date.now() - event.durationMs;
    profile.http.push({
      id: eventId(),
      source: event.source,
      method: event.method.toUpperCase(),
      url: event.url,
      statusCode: event.statusCode,
      durationMs: round2(event.durationMs),
      startedAt,
      requestSize: event.requestSize,
      responseSize: event.responseSize,
      error: event.error,
    });
    this.pushTimeline(
      profile,
      'http',
      `HTTP ${event.method.toUpperCase()} ${truncate(event.url, 80)}`,
      startedAt,
      event.durationMs,
    );
  }

  recordException(error: unknown, target?: RequestProfile): void {
    this.safely(() => this.doRecordException(error, target));
  }

  private doRecordException(error: unknown, target?: RequestProfile): void {
    const profile = target ?? this.getProfile();
    if (!profile) return;
    const err = error as { name?: string; message?: string; stack?: string; getStatus?: () => number };
    const at = round2(Math.max(0, Date.now() - profile.startedAtMs));
    profile.exception = {
      name: err?.name ?? 'Error',
      message: err?.message ?? String(error),
      stack: err?.stack,
      statusCode: typeof err?.getStatus === 'function' ? safeStatus(err) : undefined,
      at,
    };
    profile.timeline.push({ at, label: `Exception ${profile.exception.name}: ${truncate(profile.exception.message, 100)}`, kind: 'exception' });
  }

  mark(label: string, durationMs?: number): void {
    this.safely(() => {
      const profile = this.getProfile();
      if (!profile) return;
      const startedAt = Date.now() - (durationMs ?? 0);
      this.pushTimeline(profile, 'custom', label, startedAt, durationMs);
    });
  }

  setCustom(key: string, value: unknown): void {
    this.safely(() => {
      const profile = this.getProfile();
      if (!profile) return;
      profile.custom[key] = value;
    });
  }

  private pushTimeline(
    profile: RequestProfile,
    kind: TimelineKind,
    label: string,
    startedAt: number,
    durationMs?: number,
  ): void {
    profile.timeline.push({
      at: round2(Math.max(0, startedAt - profile.startedAtMs)),
      label,
      kind,
      durationMs: durationMs !== undefined ? round2(durationMs) : undefined,
    });
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safeStatus(err: { getStatus?: () => number }): number | undefined {
  try {
    return err.getStatus?.();
  } catch {
    return undefined;
  }
}
