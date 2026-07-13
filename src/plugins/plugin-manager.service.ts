import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { DEBUG_OPTIONS, DEBUG_STORAGE } from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';
import type { DebugPlugin, DebugPluginContext } from '../interfaces/plugin.interface';
import type { DebugStorage } from '../interfaces/storage.interface';
import type { RequestProfile } from '../interfaces/profile.interface';
import { DebugContextService } from '../context/debug-context.service';
import { MemoryPlugin } from './memory/memory.plugin';

/**
 * Registers built-in + user plugins at bootstrap and fans request lifecycle
 * events out to them. A misbehaving plugin never breaks the request or the
 * other plugins.
 */
@Injectable()
export class PluginManager implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('NestLens');
  private plugins: DebugPlugin[] = [];

  constructor(
    @Inject(DEBUG_OPTIONS) private readonly options: ResolvedDebugOptions,
    @Inject(DEBUG_STORAGE) private readonly storage: DebugStorage,
    private readonly recorder: DebugContextService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.options.enabled) return;
    const context: DebugPluginContext = {
      recorder: this.recorder,
      options: this.options,
      storage: this.storage,
    };
    const builtIns: DebugPlugin[] = this.options.captureMemory ? [new MemoryPlugin()] : [];
    for (const plugin of [...builtIns, ...this.options.plugins]) {
      try {
        await plugin.register?.(context);
        this.plugins.push(plugin);
      } catch (error) {
        this.logger.warn(`Plugin "${plugin.name}" failed to register: ${String(error)}`);
      }
    }
  }

  getPlugins(): readonly DebugPlugin[] {
    return this.plugins;
  }

  dispatchRequestStart(profile: RequestProfile): void {
    for (const plugin of this.plugins) {
      try {
        plugin.onRequestStart?.(profile);
      } catch (error) {
        this.logger.warn(`Plugin "${plugin.name}" onRequestStart failed: ${String(error)}`);
      }
    }
  }

  dispatchRequestEnd(profile: RequestProfile): void {
    for (const plugin of this.plugins) {
      try {
        plugin.onRequestEnd?.(profile);
      } catch (error) {
        this.logger.warn(`Plugin "${plugin.name}" onRequestEnd failed: ${String(error)}`);
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.onShutdown?.();
      } catch (error) {
        this.logger.warn(`Plugin "${plugin.name}" onShutdown failed: ${String(error)}`);
      }
    }
    this.plugins = [];
  }
}
