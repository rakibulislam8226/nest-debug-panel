import { BULLMQ_PROCESSOR_METADATA } from '../../constants';
import type { JobMeta } from '../../interfaces/profile.interface';
import { Ctor, hasConstructorNamed, JobAdapter, wrapMethod } from './types';

/** Shape of a BullMQ `Job`, accessed defensively (no hard dependency). */
interface BullJobLike {
  name?: string;
  id?: string | number;
  data?: unknown;
  attemptsMade?: number;
  opts?: { attempts?: number; priority?: number; delay?: number };
}

/**
 * `@nestjs/bullmq`: a `@Processor()` class extending `WorkerHost` with a
 * `process(job)` method. The explorer binds `instance.process` when it builds
 * the Worker, so we patch the class prototype in the tracker's constructor —
 * before that bind — via the class pass.
 */
export const bullmqAdapter: JobAdapter = {
  library: 'bullmq',
  wrapClass(metatype: Ctor, ctx): string | null {
    const proto = metatype?.prototype as Record<string, unknown> | undefined;
    if (!proto || typeof proto.process !== 'function') return null;

    const opts = Reflect.getMetadata(BULLMQ_PROCESSOR_METADATA, metatype) as
      | { name?: string; queueName?: string }
      | undefined;
    const isBullmq = opts !== undefined || hasConstructorNamed(metatype, 'WorkerHost');
    if (!isBullmq) return null;

    const queue = opts?.name ?? opts?.queueName ?? metatype.name;
    const wrapped = wrapMethod(
      proto,
      'process',
      ctx.track,
      (args) => bullmqMeta(queue, args[0] as BullJobLike | undefined),
      (args) => (args[0] as BullJobLike | undefined)?.data,
    );
    return wrapped ? queue : null;
  },
};

function bullmqMeta(queue: string, job: BullJobLike | undefined): JobMeta {
  return {
    library: 'bullmq',
    queue,
    jobName: job?.name || 'process',
    jobId: job?.id != null ? String(job.id) : undefined,
    attemptsMade: typeof job?.attemptsMade === 'number' ? job.attemptsMade : undefined,
    maxAttempts: job?.opts?.attempts,
    priority: job?.opts?.priority,
    delayMs: job?.opts?.delay,
  };
}
