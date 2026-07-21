import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { format } from 'node:util';
import { DEBUG_OPTIONS } from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';
import { DebugContextService } from '../context/debug-context.service';
import type { LogLevel } from '../interfaces/profile.interface';

type ConsoleFn = (...args: unknown[]) => void;

const METHODS: Array<{ name: 'log' | 'info' | 'warn' | 'error' | 'debug'; level: LogLevel }> = [
  { name: 'log', level: 'log' },
  { name: 'info', level: 'info' },
  { name: 'warn', level: 'warn' },
  { name: 'error', level: 'error' },
  { name: 'debug', level: 'debug' },
];

const MAX_MESSAGE_LENGTH = 8 * 1024;
/** Marks a wrapper we installed, so we never double-patch or wrap a wrapper. */
const PATCH_MARK = '__nestDebugPanelPatched__';

/**
 * Captures `console.*` output emitted while a request/socket event is executing
 * and attaches each line to that request's profile (surfaced in the Logs
 * monitor). The console is patched once at bootstrap and restored on shutdown;
 * original output is always forwarded, so the app's logs still print. Only
 * calls made inside an active request context are recorded — startup and idle
 * logs are ignored, matching how the rest of the panel is request-scoped.
 */
@Injectable()
export class LogCaptureService implements OnModuleInit, OnModuleDestroy {
  private readonly originals: Partial<Record<string, ConsoleFn>> = {};
  private patched = false;
  /** Re-entrancy guard: our own record path must not re-trigger capture. */
  private capturing = false;

  constructor(
    @Inject(DEBUG_OPTIONS) private readonly options: ResolvedDebugOptions,
    private readonly context: DebugContextService,
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled || !this.options.captureLogs || this.patched) return;
    this.patch();
  }

  onModuleDestroy(): void {
    this.restore();
  }

  private patch(): void {
    const target = globalThis.console as unknown as Record<string, ConsoleFn>;
    for (const { name, level } of METHODS) {
      const original = target[name];
      if (typeof original !== 'function') continue;
      // Another instance already patched it (e.g. leftover in tests) — leave it.
      if ((original as unknown as Record<string, unknown>)[PATCH_MARK]) continue;
      this.originals[name] = original;
      const wrapper: ConsoleFn = (...args: unknown[]): void => {
        original.apply(target, args);
        if (this.capturing) return;
        this.capturing = true;
        try {
          if (!this.context.isActive()) return;
          let message = args.length ? format(...args) : '';
          if (message.length > MAX_MESSAGE_LENGTH) {
            message = `${message.slice(0, MAX_MESSAGE_LENGTH)}…`;
          }
          this.context.recordLog({ level, message });
        } catch {
          /* never break the caller */
        } finally {
          this.capturing = false;
        }
      };
      (wrapper as unknown as Record<string, unknown>)[PATCH_MARK] = true;
      target[name] = wrapper;
    }
    this.patched = true;
  }

  private restore(): void {
    if (!this.patched) return;
    const target = globalThis.console as unknown as Record<string, ConsoleFn>;
    for (const { name } of METHODS) {
      const original = this.originals[name];
      if (original) target[name] = original;
      delete this.originals[name];
    }
    this.patched = false;
  }
}
