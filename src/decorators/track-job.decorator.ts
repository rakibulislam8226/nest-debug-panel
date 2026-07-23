import { SetMetadata } from '@nestjs/common';
import { TRACK_JOB_METADATA } from '../constants';
import type { TrackJobOptions } from '../discovery/job-adapters/trackjob.adapter';

/**
 * Explicitly mark a method as a background-job handler so nest-debug-panel
 * captures each run (SQL/Redis/HTTP, timeline, exceptions) as its own profile.
 *
 * Only needed when auto-detection can't reach the worker — e.g. a queue library
 * whose handler is registered outside Nest's DI, or legacy `@nestjs/bull`. For
 * `@nestjs/bullmq`, `@nestjs/microservices`, `@nestjs/schedule` and DI-provided
 * bee-queue/Agenda, capture is automatic and this is unnecessary.
 *
 * ```ts
 * @TrackJob({ queue: 'emails', jobName: 'welcome' })
 * async handle(job: Job) { ... }
 * ```
 */
export function TrackJob(options: TrackJobOptions = {}): MethodDecorator {
  return SetMetadata(TRACK_JOB_METADATA, options);
}

export type { TrackJobOptions };
