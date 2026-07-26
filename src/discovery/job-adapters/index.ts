import type { JobAdapter } from './types';
import { bullmqAdapter } from './bullmq.adapter';
import { scheduleAdapter } from './schedule.adapter';
import { trackJobAdapter } from './trackjob.adapter';
import { imperativeAdapter } from './imperative.adapter';

/**
 * Class-pass adapters run in the tracker's constructor (patch class prototypes
 * before frameworks bind handlers). Instance-pass adapters run at bootstrap
 * (need the instantiated queue object). Order matters only within a pass —
 * first match wins per provider.
 */
export const CLASS_ADAPTERS: JobAdapter[] = [bullmqAdapter, scheduleAdapter, trackJobAdapter];
export const INSTANCE_ADAPTERS: JobAdapter[] = [imperativeAdapter];

export * from './types';
export { bullmqAdapter, scheduleAdapter, trackJobAdapter, imperativeAdapter };
