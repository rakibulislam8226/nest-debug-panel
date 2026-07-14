import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { DEBUG_OPTIONS, DEBUG_STORAGE } from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';
import type { DebugStorage } from '../interfaces/storage.interface';
import type { DebugPluginContext } from '../interfaces/plugin.interface';
import { DebugContextService } from '../context/debug-context.service';
import { PrismaPlugin } from '../plugins/prisma/prisma.plugin';
import { instrumentTypeOrmDataSource } from '../plugins/typeorm/typeorm.plugin';
import { instrumentRedisClient } from '../plugins/redis/redis.plugin';
import { instrumentAxios, AxiosInstanceLike } from '../plugins/http/axios.plugin';

/**
 * Zero-config instrumentation. After the app has fully bootstrapped, scan
 * every provider in the DI container and hook anything recognizable:
 *
 *   - PrismaClient        → operation capture + raw query events (duck-typed
 *                           on `$connect` + `$extends`)
 *   - ioredis / node-redis → command timing (duck-typed on `sendCommand`)
 *   - TypeORM DataSource   → SQL timing (duck-typed on `createQueryRunner`)
 *   - HttpService / axios  → outgoing HTTP timing (duck-typed on interceptors)
 *
 * All instrumentation is idempotent (explicit plugins win — nothing is hooked
 * twice) and fail-open (a provider that resists hooking is skipped silently).
 * Disable with `DebugModule.forRoot({ autoInstrument: false })`.
 */
@Injectable()
export class AutoInstrumentService implements OnApplicationBootstrap {
  private readonly logger = new Logger('NestDebugPanel');

  constructor(
    @Inject(DEBUG_OPTIONS) private readonly options: ResolvedDebugOptions,
    @Inject(DEBUG_STORAGE) private readonly storage: DebugStorage,
    private readonly recorder: DebugContextService,
    private readonly modulesContainer: ModulesContainer,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled || !this.options.autoInstrument) return;

    const context: DebugPluginContext = {
      recorder: this.recorder,
      options: this.options,
      storage: this.storage,
    };
    const prisma = new PrismaPlugin();
    prisma.register(context);

    const seen = new Set<unknown>();
    const found: string[] = [];

    for (const module of this.modulesContainer.values()) {
      for (const wrapper of module.providers.values()) {
        const instance: unknown = wrapper?.instance;
        if (!instance || typeof instance !== 'object' || seen.has(instance)) continue;
        seen.add(instance);
        try {
          this.inspect(instance, prisma, found);
        } catch {
          /* fail-open: never let discovery break bootstrap */
        }
      }
    }

    if (found.length > 0) {
      this.logger.log(`Auto-instrumented: ${found.join(', ')}`);
    }
  }

  private inspect(instance: object, prisma: PrismaPlugin, found: string[]): void {
    const candidate = instance as Record<string, unknown>;
    const name = instance.constructor?.name ?? 'provider';

    // PrismaClient (or a service extending it)
    if (typeof candidate['$connect'] === 'function' && typeof candidate['$extends'] === 'function') {
      prisma.instrument(instance);
      found.push(`prisma:${name}`);
      return;
    }

    // TypeORM DataSource
    if (
      typeof candidate['createQueryRunner'] === 'function' &&
      typeof candidate['getRepository'] === 'function'
    ) {
      instrumentTypeOrmDataSource(instance, this.recorder);
      found.push(`typeorm:${name}`);
      return;
    }

    // ioredis / node-redis client
    if (typeof candidate['sendCommand'] === 'function') {
      instrumentRedisClient(instance, this.recorder);
      found.push(`redis:${name}`);
      return;
    }

    // Nest HttpService (wraps an axios instance)
    const axiosRef = candidate['axiosRef'] as AxiosInstanceLike | undefined;
    if (axiosRef?.interceptors?.request && axiosRef?.interceptors?.response) {
      instrumentAxios(axiosRef, this.recorder);
      found.push(`axios:${name}`);
      return;
    }

    // A bare axios instance registered as a provider
    const interceptors = candidate['interceptors'] as AxiosInstanceLike['interceptors'] | undefined;
    if (interceptors?.request && interceptors?.response && typeof candidate['request'] === 'function') {
      instrumentAxios(instance as unknown as AxiosInstanceLike, this.recorder);
      found.push(`axios:${name}`);
    }
  }
}
