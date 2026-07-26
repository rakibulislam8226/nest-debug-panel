import { SCHEDULE_METADATA_KEYS } from '../../constants';
import type { JobMeta } from '../../interfaces/profile.interface';
import { Ctor, JobAdapter, prototypeMethodNames, wrapMethod } from './types';

/**
 * `@nestjs/schedule`: methods decorated with `@Cron()` / `@Interval()` /
 * `@Timeout()`. The orchestrator binds the method reference at bootstrap, so we
 * patch the class prototype in the constructor pass. Best-effort: if the
 * package's metadata keys differ, this is a silent no-op (fail-open).
 */
export const scheduleAdapter: JobAdapter = {
  library: 'cron',
  wrapClass(metatype: Ctor, ctx): string | null {
    const proto = metatype?.prototype as Record<string, unknown> | undefined;
    if (!proto) return null;
    let wrappedAny: string | null = null;
    for (const name of prototypeMethodNames(metatype)) {
      const fn = proto[name];
      const detail = readScheduleMeta(fn);
      if (detail === null) continue;
      const jobName = detail || name;
      const ok = wrapMethod(
        proto,
        name,
        ctx.track,
        () => scheduleMeta(jobName),
        () => undefined,
      );
      if (ok) wrappedAny = `${metatype.name}.${name}`;
    }
    return wrappedAny;
  },
};

/** Returns a schedule label when the method carries any schedule metadata, else null. */
function readScheduleMeta(fn: unknown): string | null {
  if (typeof fn !== 'function') return null;
  for (const key of SCHEDULE_METADATA_KEYS) {
    const value = Reflect.getMetadata(key, fn);
    if (value === undefined) continue;
    if (typeof value === 'string') return value;
    const asObj = value as { name?: string; cronTime?: string };
    return asObj?.name ?? asObj?.cronTime ?? '';
  }
  return null;
}

function scheduleMeta(jobName: string): JobMeta {
  return { library: 'cron', queue: 'schedule', jobName };
}
