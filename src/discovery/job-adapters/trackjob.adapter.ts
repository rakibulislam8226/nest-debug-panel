import { TRACK_JOB_METADATA } from '../../constants';
import type { JobMeta } from '../../interfaces/profile.interface';
import { Ctor, JobAdapter, prototypeMethodNames, wrapMethod } from './types';

export interface TrackJobOptions {
  queue?: string;
  jobName?: string;
  library?: string;
}

/**
 * Explicit escape hatch: methods annotated with `@TrackJob()`. Covers workers
 * the auto-adapters can't see (out-of-DI libraries, custom loops, legacy Bull).
 */
export const trackJobAdapter: JobAdapter = {
  library: 'custom',
  wrapClass(metatype: Ctor, ctx): string | null {
    const proto = metatype?.prototype as Record<string, unknown> | undefined;
    if (!proto) return null;
    let wrappedAny: string | null = null;
    for (const name of prototypeMethodNames(metatype)) {
      const opts = Reflect.getMetadata(TRACK_JOB_METADATA, proto[name] as object) as
        | TrackJobOptions
        | undefined;
      if (opts === undefined) continue;
      const queue = opts.queue ?? metatype.name;
      const jobName = opts.jobName ?? name;
      const ok = wrapMethod(proto, name, ctx.track, () => trackJobMeta(opts, queue, jobName));
      if (ok) wrappedAny = `${metatype.name}.${name}`;
    }
    return wrappedAny;
  },
};

function trackJobMeta(opts: TrackJobOptions, queue: string, jobName: string): JobMeta {
  return { library: opts.library ?? 'custom', queue, jobName };
}
