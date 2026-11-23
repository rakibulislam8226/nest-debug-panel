import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ModuleRef, ModulesContainer, APP_GUARD } from '@nestjs/core';
import { DEBUG_OPTIONS } from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';
import { DebugController } from '../api/debug.controller';

const PATCHED = Symbol.for('nest-debug-panel.guardBypass');

interface GuardWrapper {
  instance?: unknown;
  metatype?: unknown;
  isDependencyTreeStatic?: () => boolean;
}

interface AppConfigLike {
  getGlobalGuards?: () => unknown[];
  getGlobalRequestGuards?: () => GuardWrapper[];
}

/**
 * Lets the panel's routes past the host app's global guards.
 *
 * A global auth guard (`APP_GUARD` / `app.useGlobalGuards()`) runs on every
 * controller, including the panel's, and answers 401 because the dashboard has
 * no session — so the panel would only open after the app marked it public with
 * its own decorator. Instead, each global guard's `canActivate` is wrapped once
 * at bootstrap: for a request to `DebugController` it returns true, for every
 * other route it calls the original unchanged. The panel's own
 * `DebugAccessGuard` (a controller guard, not a global one) still runs, so
 * `enabled` and `authorize` keep deciding who gets in.
 *
 * Only runs while the panel is enabled; with it off nothing is touched.
 */
@Injectable()
export class AppGuardBypassService implements OnApplicationBootstrap {
  private readonly logger = new Logger('DebugPanel');

  constructor(
    @Inject(DEBUG_OPTIONS) private readonly options: ResolvedDebugOptions,
    private readonly moduleRef: ModuleRef,
    private readonly modules: ModulesContainer,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled || !this.options.bypassAppGuards) return;
    try {
      const config = this.applicationConfig();
      if (config) {
        for (const guard of config.getGlobalGuards?.() ?? []) patchGuard(guard);
        for (const wrapper of config.getGlobalRequestGuards?.() ?? []) patchWrapper(wrapper);
        return;
      }
      // Fallback: APP_GUARD providers are registered as "APP_GUARD (UUID: …)".
      for (const module of this.modules.values()) {
        for (const [token, wrapper] of module.providers) {
          if (typeof token === 'string' && token.startsWith(APP_GUARD)) {
            patchWrapper(wrapper as GuardWrapper);
          }
        }
      }
    } catch (error) {
      // Never break the host app over this; the panel just stays behind its guards.
      this.logger.warn(`Could not let the panel past global guards: ${(error as Error).message}`);
    }
  }

  /** Nest keeps global guards on ApplicationConfig, reachable via the container. */
  private applicationConfig(): AppConfigLike | undefined {
    const container = (this.moduleRef as unknown as { container?: { applicationConfig?: AppConfigLike } })
      .container;
    return container?.applicationConfig;
  }
}

function isPanelRequest(context: ExecutionContext): boolean {
  try {
    return context?.getType?.() === 'http' && context.getClass?.() === DebugController;
  } catch {
    return false;
  }
}

/** Static guards are shared instances; request-scoped ones are built per request, so wrap the class. */
function patchWrapper(wrapper: GuardWrapper | undefined): void {
  if (!wrapper) return;
  const isStatic = wrapper.isDependencyTreeStatic?.() ?? true;
  if (isStatic && wrapper.instance) patchGuard(wrapper.instance);
  else if (typeof wrapper.metatype === 'function') patchGuard((wrapper.metatype as { prototype: unknown }).prototype);
}

export function patchGuard(target: unknown): void {
  const guard = target as (CanActivate & { [PATCHED]?: boolean }) | undefined;
  if (!guard || typeof guard.canActivate !== 'function' || guard[PATCHED]) return;
  const original = guard.canActivate;
  Object.defineProperty(guard, 'canActivate', {
    configurable: true,
    writable: true,
    value: function (this: unknown, context: ExecutionContext) {
      if (isPanelRequest(context)) return true;
      return original.call(this, context);
    },
  });
  Object.defineProperty(guard, PATCHED, { value: true });
}
