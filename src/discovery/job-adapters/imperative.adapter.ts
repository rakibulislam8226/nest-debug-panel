import type { JobMeta } from '../../interfaces/profile.interface';
import { JobAdapter, TrackFn, isWrapped, markWrapped } from './types';

/**
 * Imperative queue libraries whose handler is registered at call time rather
 * than via a class decorator: bee-queue (`.process`) and Agenda (`.define`).
 * When the queue/agenda object is a DI provider we patch its registrar so the
 * user's handler is wrapped transparently. Best-effort: if the handler is
 * registered before bootstrap (e.g. in a constructor) it is missed — use
 * `@TrackJob()` there. Fully fail-open and gated by strict multi-signature
 * detection to avoid false positives.
 */
export const imperativeAdapter: JobAdapter = {
  library: 'imperative',
  wrapInstance(instance: object, ctx): string | null {
    const inst = instance as Record<string, unknown>;

    // bee-queue: Queue has both .process and .createJob
    if (isFn(inst.process) && isFn(inst.createJob)) {
      const queue = strOr(inst.name, 'bee-queue');
      const ok = wrapRegistrar(
        inst,
        'process',
        ctx.track,
        (_reg, hArgs) => beeMeta(queue, hArgs[0]),
        (hArgs) => (hArgs[0] as { data?: unknown } | undefined)?.data,
      );
      return ok ? `bee-queue:${queue}` : null;
    }

    // Agenda: has .define + .every + .schedule
    if (isFn(inst.define) && isFn(inst.every) && isFn(inst.schedule)) {
      const ok = wrapRegistrar(
        inst,
        'define',
        ctx.track,
        (regArgs, hArgs) => agendaMeta(regArgs[0], hArgs[0]),
        (hArgs) => (hArgs[0] as { attrs?: { data?: unknown } } | undefined)?.attrs?.data,
      );
      return ok ? 'agenda' : null;
    }

    return null;
  },
};

function beeMeta(queue: string, job: unknown): JobMeta {
  const j = job as { id?: string | number } | undefined;
  return { library: 'bee-queue', queue, jobName: 'job', jobId: j?.id != null ? String(j.id) : undefined };
}

function agendaMeta(name: unknown, job: unknown): JobMeta {
  const j = job as { attrs?: { _id?: unknown } } | undefined;
  const id = j?.attrs?._id;
  return {
    library: 'agenda',
    queue: 'agenda',
    jobName: typeof name === 'string' ? name : 'job',
    jobId: id != null ? String(id) : undefined,
  };
}

/** Wrap a registrar (`.process`/`.define`) so its handler argument is tracked. */
function wrapRegistrar(
  holder: Record<string, unknown>,
  key: string,
  track: TrackFn,
  metaFrom: (regArgs: unknown[], handlerArgs: unknown[]) => JobMeta,
  dataFrom: (handlerArgs: unknown[]) => unknown,
): boolean {
  const original = holder[key] as ((...a: unknown[]) => unknown) | undefined;
  if (typeof original !== 'function') return false;
  if (isWrapped(original)) return true;
  const wrapped = function (this: unknown, ...regArgs: unknown[]) {
    const idx = lastFunctionIndex(regArgs);
    if (idx < 0) return original.apply(this, regArgs);
    const userHandler = regArgs[idx] as (...a: unknown[]) => unknown;
    regArgs[idx] = function (this: unknown, ...hArgs: unknown[]) {
      let meta: JobMeta;
      try {
        meta = metaFrom(regArgs, hArgs);
      } catch {
        return userHandler.apply(this, hArgs);
      }
      return track(meta, () => userHandler.apply(this, hArgs), safeCall(dataFrom, hArgs));
    };
    return original.apply(this, regArgs);
  };
  markWrapped(wrapped);
  holder[key] = wrapped;
  return true;
}

function lastFunctionIndex(args: unknown[]): number {
  for (let i = args.length - 1; i >= 0; i--) if (typeof args[i] === 'function') return i;
  return -1;
}

function safeCall(fn: (args: unknown[]) => unknown, args: unknown[]): unknown {
  try {
    return fn(args);
  } catch {
    return undefined;
  }
}

function isFn(value: unknown): boolean {
  return typeof value === 'function';
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}
