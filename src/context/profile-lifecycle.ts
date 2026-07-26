import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Logger } from '@nestjs/common';
import type { ResolvedDebugOptions } from '../config/debug-options';
import type { DebugStorage } from '../interfaces/storage.interface';
import type { JobMeta, RequestProfile } from '../interfaces/profile.interface';
import type { PluginManager } from '../plugins/plugin-manager.service';
import { analyzeSql } from '../analysis/sql-analyzer';
import { round2, safeSerialize, sanitizeValue } from '../utils/common';

/**
 * Shared profile finalize used by both the HTTP/socket interceptor and the
 * background-job tracker: stamp timings, push the closing timeline entry, run
 * SQL analysis, fire the plugin end-hook and persist. Keeping one copy means
 * the three execution kinds can never drift apart.
 */
export interface FinalizeDeps {
  startedHr: number;
  options: ResolvedDebugOptions;
  plugins: PluginManager;
  storage: DebugStorage;
  logger: Logger;
}

export function finalizeProfile(profile: RequestProfile, deps: FinalizeDeps): void {
  const { startedHr, options, plugins, storage, logger } = deps;
  const durationMs = round2(performance.now() - startedHr);
  profile.durationMs = durationMs;
  profile.endedAtMs = Date.now();
  profile.slow = durationMs >= options.slowRequestThreshold;
  profile.timeline.push({
    at: durationMs,
    label: closingLabel(profile),
    kind: 'response',
  });
  profile.sqlAnalysis = analyzeSql(profile.sql, options);
  plugins.dispatchRequestEnd(profile);
  Promise.resolve(storage.save(profile)).catch((error) =>
    logger.warn(`Failed to persist request profile: ${String(error)}`),
  );
}

function closingLabel(profile: RequestProfile): string {
  if (profile.kind === 'socket') return 'Completed';
  if (profile.kind === 'job') return profile.exception ? 'Failed' : 'Completed';
  return `Response${profile.statusCode !== undefined ? ` ${profile.statusCode}` : ''}`;
}

/**
 * Build a fresh profile for a background-job / message / scheduled run,
 * mirroring the interceptor's socket profile. The payload is captured (redacted
 * + size-limited) only when `captureJobData` is on.
 */
export function createJobProfile(
  meta: JobMeta,
  data: unknown,
  options: ResolvedDebugOptions,
): RequestProfile {
  const body =
    options.captureJobData && data !== undefined
      ? safeSerialize(sanitizeValue(data, options.redactKeys), options.maxBodyLength).value
      : undefined;
  return {
    id: randomUUID(),
    kind: 'job',
    method: 'JOB',
    url: `${meta.queue}#${meta.jobName}`,
    queryParams: {},
    routeParams: {},
    body,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    sql: [],
    redis: [],
    http: [],
    logs: [],
    timeline: [
      {
        at: 0,
        label: `${jobLabel(meta.library)} — ${meta.queue}:${meta.jobName}`,
        kind: 'request',
      },
    ],
    job: meta,
    custom: {},
  };
}

/** Record a job's return value on success (serialized + size-limited). */
export function captureJobSuccess(
  profile: RequestProfile,
  returnValue: unknown,
  options: ResolvedDebugOptions,
): void {
  if (!profile.job || returnValue === undefined) return;
  if (options.captureResponseBody) {
    const serialized = safeSerialize(
      sanitizeValue(returnValue, options.redactKeys),
      options.maxBodyLength,
    );
    profile.job.returnValue = serialized.value;
    profile.responseSize = serialized.size;
  }
}

function jobLabel(library: string): string {
  if (library === 'microservice') return 'Message received';
  if (library === 'cron') return 'Scheduled run';
  return 'Job started';
}
