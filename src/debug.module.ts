import { DynamicModule, Module, Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DEBUG_OPTIONS, DEBUG_STORAGE, PATH_METADATA, REDIS_URL_ENV_VARS, STORAGE_ENV_VAR } from './constants';
import {
  DebugModuleOptions,
  normalizeRoutePrefix,
  ResolvedDebugOptions,
  resolveDebugOptions,
} from './config/debug-options';
import { DebugContextService } from './context/debug-context.service';
import { LogCaptureService } from './logging/log-capture.service';
import { DebugInterceptor } from './interceptor/debug.interceptor';
import { DebugAccessGuard } from './guards/debug-access.guard';
import { AppGuardBypassService } from './guards/app-guard-bypass.service';
import { DebugController } from './api/debug.controller';
import { PluginManager } from './plugins/plugin-manager.service';
import { AutoInstrumentService } from './discovery/auto-instrument.service';
import { SocketGatewayTracker } from './discovery/socket-gateway-tracker';
import { JobTracker } from './discovery/job-tracker.service';
import { IgnoreRulesService } from './filters/ignore-rules.service';
import { MemoryStorage } from './storage/memory.storage';
import { RedisStorage } from './storage/redis.storage';
import type { DebugStorage } from './interfaces/storage.interface';
import { Logger } from '@nestjs/common';

export interface DebugModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  useFactory: (...args: never[]) => DebugModuleOptions | Promise<DebugModuleOptions>;
  inject?: Array<string | symbol | (new (...args: never[]) => unknown)>;
  /**
   * Controller routes are registered before async factories run, so the
   * prefix must be known statically in async mode. Default: `nest-debug-panel`.
   */
  routePrefix?: string;
}

/**
 * nest-debug-panel root module.
 *
 * ```ts
 * @Module({
 *   imports: [
 *     DebugModule.forRoot({
 *       enabled: process.env.NODE_ENV !== 'production',
 *       maxRequests: 200,
 *       plugins: [prismaPlugin, redisPlugin],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Registers a global interceptor — no changes to business logic required.
 * When disabled, the interceptor passes requests straight through and the
 * debug routes return 404.
 */
@Module({})
export class DebugModule {
  static forRoot(options: DebugModuleOptions = {}): DynamicModule {
    const resolved = resolveDebugOptions(options);
    applyRoutePrefix(resolved.routePrefix);
    return this.buildModule({ provide: DEBUG_OPTIONS, useValue: resolved });
  }

  static forRootAsync(asyncOptions: DebugModuleAsyncOptions): DynamicModule {
    const prefix = normalizeRoutePrefix(asyncOptions.routePrefix);
    applyRoutePrefix(prefix);
    const optionsProvider: Provider = {
      provide: DEBUG_OPTIONS,
      useFactory: async (...args: never[]): Promise<ResolvedDebugOptions> => {
        const options = await asyncOptions.useFactory(...args);
        return { ...resolveDebugOptions(options), routePrefix: prefix };
      },
      inject: asyncOptions.inject ?? [],
    };
    return this.buildModule(optionsProvider, asyncOptions.imports);
  }

  private static buildModule(
    optionsProvider: Provider,
    imports?: DynamicModule['imports'],
  ): DynamicModule {
    return {
      module: DebugModule,
      global: true,
      imports: imports ?? [],
      controllers: [DebugController],
      providers: [
        optionsProvider,
        DebugContextService,
        LogCaptureService,
        DebugAccessGuard,
        AppGuardBypassService,
        PluginManager,
        AutoInstrumentService,
        DebugInterceptor,
        SocketGatewayTracker,
        JobTracker,
        IgnoreRulesService,
        {
          provide: DEBUG_STORAGE,
          useFactory: (resolved: ResolvedDebugOptions) => resolveStorage(resolved),
          inject: [DEBUG_OPTIONS],
        },
        // Same instance drives HTTP (global) and gateways (auto-attached by
        // SocketGatewayTracker), so both share one interceptor + one context.
        { provide: APP_INTERCEPTOR, useExisting: DebugInterceptor },
      ],
      exports: [
        DEBUG_OPTIONS,
        DEBUG_STORAGE,
        DebugContextService,
        PluginManager,
        JobTracker,
        IgnoreRulesService,
      ],
    };
  }
}

/**
 * Nest resolves controller paths from metadata at module scan time; rewriting
 * it here lets `routePrefix` move the whole debug API without a custom router.
 */
function applyRoutePrefix(prefix: string): void {
  Reflect.defineMetadata(PATH_METADATA, prefix, DebugController);
}

/**
 * Choose the storage driver.
 *
 * Precedence: a `DebugStorage` instance passed to `forRoot()` always wins (it was
 * built deliberately). Otherwise the `NEST_DEBUG_PANEL_STORAGE` env var selects
 * the mode (`redis` | `memory`), defaulting to in-memory. The `redis` mode
 * connects via {@link REDIS_URL_ENV_VARS} and is fail-open — any problem (no URL,
 * no `ioredis`, bad connection) logs a warning and falls back to in-memory rather
 * than breaking bootstrap.
 */
function resolveStorage(resolved: ResolvedDebugOptions): DebugStorage {
  if (resolved.storage) return resolved.storage;

  const logger = new Logger('NestDebugPanel');
  const mode = readStorageEnv(logger) ?? 'memory';
  if (mode !== 'redis') return new MemoryStorage(resolved.maxRequests);

  const url = readRedisUrl();
  if (!url) {
    logger.warn(
      `${STORAGE_ENV_VAR}=redis but no Redis URL found (set ${REDIS_URL_ENV_VARS.join(' or ')}) — falling back to in-memory storage.`,
    );
    return new MemoryStorage(resolved.maxRequests);
  }
  try {
    return new RedisStorage({ url, maxRequests: resolved.maxRequests });
  } catch (error) {
    logger.warn(`Redis storage unavailable (${String(error)}); falling back to in-memory storage.`);
    return new MemoryStorage(resolved.maxRequests);
  }
}

/** Read + validate the storage-mode env var. Unknown values warn and are ignored. */
function readStorageEnv(logger: Logger): 'redis' | 'memory' | undefined {
  const raw = process.env[STORAGE_ENV_VAR];
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'redis' || value === 'memory') return value;
  logger.warn(`Ignoring ${STORAGE_ENV_VAR}="${raw}" — expected "redis" or "memory".`);
  return undefined;
}

/**
 * Resolve a Redis connection string. Prefers an explicit URL
 * ({@link REDIS_URL_ENV_VARS}); otherwise builds one from the common discrete
 * vars (`REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_DB`) so apps that
 * configure Redis in parts (not a URL) need no extra variable.
 */
export function readRedisUrl(): string | undefined {
  for (const name of REDIS_URL_ENV_VARS) {
    const value = process.env[name];
    if (value) return value;
  }
  const host = process.env.REDIS_HOST;
  if (!host) return undefined;
  const port = process.env.REDIS_PORT ?? '6379';
  const password = process.env.REDIS_PASSWORD;
  const db = process.env.REDIS_DB;
  const auth = password ? `:${encodeURIComponent(password)}@` : '';
  const dbPath = db ? `/${db}` : '';
  return `redis://${auth}${host}:${port}${dbPath}`;
}
