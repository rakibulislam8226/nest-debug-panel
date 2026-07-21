import { Inject, Injectable, Logger, UseInterceptors } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { DEBUG_OPTIONS } from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';
import { DebugInterceptor } from '../interceptor/debug.interceptor';

/** @nestjs/websockets marks gateway classes with this metadata key. */
const GATEWAY_METADATA = 'websockets:is_gateway';

/**
 * Makes socket.io capture fully automatic — the user only calls
 * `DebugModule.forRoot()`, exactly like HTTP.
 *
 * NestJS does not apply global (`APP_INTERCEPTOR`) interceptors to WebSocket
 * gateways, and it reads a gateway's `@UseInterceptors` metadata during
 * `app.init()` — before any lifecycle hook runs. Provider *constructors*,
 * however, run earlier (during `NestFactory.create()`'s instance-loading
 * phase), which is the only window left to attach the interceptor in time.
 *
 * So this provider, in its constructor, scans every module for gateway classes
 * and attaches the shared {@link DebugInterceptor} instance to each. Passing the
 * instance (not the class) means Nest uses it directly, with no extra DI
 * registration. Entirely fail-open: any error just skips socket auto-tracking.
 */
@Injectable()
export class SocketGatewayTracker {
  private readonly logger = new Logger('NestDebugPanel');

  constructor(
    @Inject(DEBUG_OPTIONS) options: ResolvedDebugOptions,
    modules: ModulesContainer,
    interceptor: DebugInterceptor,
  ) {
    if (!options.enabled || !options.captureSockets) return;
    try {
      this.attach(modules, interceptor);
    } catch (error) {
      this.logger.warn(`socket auto-tracking skipped (sockets unaffected): ${String(error)}`);
    }
  }

  private attach(modules: ModulesContainer, interceptor: DebugInterceptor): void {
    const seen = new Set<object>();
    for (const module of modules.values()) {
      for (const wrapper of module.providers.values()) {
        const metatype = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
        if (typeof metatype !== 'function' || seen.has(metatype)) continue;
        seen.add(metatype);
        if (!Reflect.getMetadata(GATEWAY_METADATA, metatype)) continue;
        if (this.alreadyAttached(metatype)) continue;
        // Same effect as putting @UseInterceptors(DebugInterceptor) on the class.
        UseInterceptors(interceptor)(metatype);
      }
    }
  }

  /** Avoid double capture if the user also added @TrackSocketEvents() manually. */
  private alreadyAttached(metatype: new (...args: never[]) => unknown): boolean {
    const existing = (Reflect.getMetadata(INTERCEPTORS_METADATA, metatype) as unknown[]) ?? [];
    return existing.some(
      (entry) => entry === DebugInterceptor || entry instanceof DebugInterceptor,
    );
  }
}
