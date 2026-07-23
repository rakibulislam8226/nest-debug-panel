import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { performance } from 'node:perf_hooks';
import { DEBUG_IGNORE_METADATA, DEBUG_OPTIONS, DEBUG_STORAGE } from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';
import type { DebugStorage } from '../interfaces/storage.interface';
import type { JobMeta, RequestProfile } from '../interfaces/profile.interface';
import { DebugContextService } from '../context/debug-context.service';
import { PluginManager } from '../plugins/plugin-manager.service';
import { captureJobSuccess, createJobProfile, finalizeProfile } from '../context/profile-lifecycle';
import { CLASS_ADAPTERS, INSTANCE_ADAPTERS, Ctor, JobWrapContext } from './job-adapters';

/** Process-wide handle so the functional `trackJob()` helper can reach the tracker. */
let activeTracker: JobTracker | undefined;

/**
 * Auto-captures background-job / message / scheduled runs as their own profiles.
 *
 * Two passes:
 *  - **constructor** (before any lifecycle hook, matching SocketGatewayTracker):
 *    patch decorated CLASS prototypes — BullMQ binds `instance.process` when it
 *    builds its Worker, so we must wrap the prototype before that happens.
 *  - **onApplicationBootstrap**: patch imperative INSTANCE registrars whose queue
 *    object only exists after instantiation.
 *
 * Everything is fail-open: a provider that resists wrapping is skipped, and the
 * app is never affected. Disable with `DebugModule.forRoot({ jobs: false })`.
 */
@Injectable()
export class JobTracker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('NestDebugPanel');
  private readonly wrapped: string[] = [];

  constructor(
    @Inject(DEBUG_OPTIONS) private readonly options: ResolvedDebugOptions,
    @Inject(DEBUG_STORAGE) private readonly storage: DebugStorage,
    private readonly debugContext: DebugContextService,
    private readonly plugins: PluginManager,
    private readonly modules: ModulesContainer,
  ) {
    activeTracker = this;
    try {
      if (this.options.enabled && this.options.captureJobs) this.wrapClasses();
    } catch {
      /* fail-open: never let discovery break bootstrap */
    }
  }

  onApplicationBootstrap(): void {
    try {
      if (!this.options.enabled || !this.options.captureJobs) return;
      this.wrapInstances();
      if (this.wrapped.length > 0) {
        this.logger.log(`Job capture attached: ${this.wrapped.join(', ')}`);
      }
    } catch {
      /* fail-open */
    }
  }

  onModuleDestroy(): void {
    // Release the process-wide handle so `trackJob()` never routes into a
    // torn-down tracker after shutdown (matters for tests / hot reload).
    if (activeTracker === this) activeTracker = undefined;
  }

  /** The capture primitive. Runs `handler` inside a fresh job profile context. */
  track<T>(meta: JobMeta, handler: () => T, data?: unknown): T {
    if (!this.options.enabled || !this.options.captureJobs) return handler();
    let profile: RequestProfile;
    try {
      profile = createJobProfile(meta, data, this.options);
    } catch {
      return handler();
    }
    return this.debugContext.run(profile, () => {
      this.safe(() => this.plugins.dispatchRequestStart(profile));
      const startedHr = performance.now();
      let result: T;
      try {
        result = handler();
      } catch (err) {
        this.fail(profile, err);
        this.finalize(profile, startedHr);
        throw err;
      }
      if (isPromiseLike(result)) {
        return (result as PromiseLike<unknown>).then(
          (value) => {
            this.safe(() => captureJobSuccess(profile, value, this.options));
            this.finalize(profile, startedHr);
            return value;
          },
          (err) => {
            this.fail(profile, err);
            this.finalize(profile, startedHr);
            throw err;
          },
        ) as unknown as T;
      }
      this.safe(() => captureJobSuccess(profile, result, this.options));
      this.finalize(profile, startedHr);
      return result;
    });
  }

  private fail(profile: RequestProfile, error: unknown): void {
    if (profile.job) profile.job.failedReason = error instanceof Error ? error.message : String(error);
    this.debugContext.recordException(error, profile);
  }

  private finalize(profile: RequestProfile, startedHr: number): void {
    this.safe(() =>
      finalizeProfile(profile, {
        startedHr,
        options: this.options,
        plugins: this.plugins,
        storage: this.storage,
        logger: this.logger,
      }),
    );
  }

  private wrapClasses(): void {
    const ctx = this.wrapContext();
    const seen = new Set<unknown>();
    for (const module of this.modules.values()) {
      for (const wrapper of module.providers.values()) {
        const metatype = wrapper?.metatype as Ctor | undefined;
        if (typeof metatype !== 'function' || !metatype.prototype || seen.has(metatype)) continue;
        seen.add(metatype);
        if (this.isIgnored(metatype)) continue;
        for (const adapter of CLASS_ADAPTERS) {
          try {
            const label = adapter.wrapClass?.(metatype, ctx);
            if (label) {
              this.wrapped.push(`${adapter.library}(${label})`);
              break;
            }
          } catch {
            /* fail-open per adapter */
          }
        }
      }
    }
  }

  private wrapInstances(): void {
    const ctx = this.wrapContext();
    const seen = new Set<unknown>();
    for (const module of this.modules.values()) {
      for (const wrapper of module.providers.values()) {
        const instance = wrapper?.instance as object | undefined;
        if (!instance || typeof instance !== 'object' || seen.has(instance)) continue;
        seen.add(instance);
        const ctor = (instance.constructor as Ctor | undefined) ?? undefined;
        if (ctor && this.isIgnored(ctor)) continue;
        for (const adapter of INSTANCE_ADAPTERS) {
          try {
            const label = adapter.wrapInstance?.(instance, ctx);
            if (label) {
              this.wrapped.push(`${adapter.library}(${label})`);
              break;
            }
          } catch {
            /* fail-open per adapter */
          }
        }
      }
    }
  }

  private wrapContext(): JobWrapContext {
    return {
      track: this.track.bind(this),
      isIgnored: (target: Ctor) => this.isIgnored(target),
    };
  }

  private isIgnored(target: Ctor): boolean {
    try {
      return Reflect.getMetadata(DEBUG_IGNORE_METADATA, target) === true;
    } catch {
      return false;
    }
  }

  private safe(step: () => void): void {
    try {
      step();
    } catch {
      /* capture step failure never affects the job */
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value != null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Functional escape hatch for out-of-DI workers (raw `bullmq.Worker`, custom
 * loops). Wraps `fn` so its SQL/Redis/HTTP is captured as a job profile. A
 * no-op passthrough when the panel is disabled or not yet initialized.
 */
export function trackJob<T>(meta: JobMeta, fn: () => T, data?: unknown): T {
  if (!activeTracker) return fn();
  return activeTracker.track(meta, fn, data);
}
