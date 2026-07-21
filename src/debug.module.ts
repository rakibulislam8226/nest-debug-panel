import { DynamicModule, Module, Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DEBUG_OPTIONS, DEBUG_STORAGE, PATH_METADATA } from './constants';
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
import { DebugController } from './api/debug.controller';
import { PluginManager } from './plugins/plugin-manager.service';
import { AutoInstrumentService } from './discovery/auto-instrument.service';
import { SocketGatewayTracker } from './discovery/socket-gateway-tracker';
import { MemoryStorage } from './storage/memory.storage';

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
        PluginManager,
        AutoInstrumentService,
        DebugInterceptor,
        SocketGatewayTracker,
        {
          provide: DEBUG_STORAGE,
          useFactory: (resolved: ResolvedDebugOptions) =>
            resolved.storage ?? new MemoryStorage(resolved.maxRequests),
          inject: [DEBUG_OPTIONS],
        },
        // Same instance drives HTTP (global) and gateways (auto-attached by
        // SocketGatewayTracker), so both share one interceptor + one context.
        { provide: APP_INTERCEPTOR, useExisting: DebugInterceptor },
      ],
      exports: [DEBUG_OPTIONS, DEBUG_STORAGE, DebugContextService, PluginManager],
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
