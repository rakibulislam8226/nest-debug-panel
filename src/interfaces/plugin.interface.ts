import type { ResolvedDebugOptions } from '../config/debug-options';
import type { DebugRecorder } from './recorder.interface';
import type { DebugStorage } from './storage.interface';
import type { RequestProfile } from './profile.interface';

/** Everything a plugin gets access to when it is registered. */
export interface DebugPluginContext {
  recorder: DebugRecorder;
  options: ResolvedDebugOptions;
  storage: DebugStorage;
}

/**
 * The plugin contract. Implement this to profile any subsystem:
 *
 * ```ts
 * class MyPlugin implements DebugPlugin {
 *   readonly name = 'my-plugin';
 *   register(ctx: DebugPluginContext) { this.recorder = ctx.recorder; }
 *   onRequestEnd(profile: RequestProfile) { profile.custom['answer'] = 42; }
 * }
 * ```
 *
 * Lifecycle: `register` once at bootstrap → `onRequestStart`/`onRequestEnd`
 * per profiled request → `onShutdown` when the app stops.
 */
export interface DebugPlugin {
  readonly name: string;
  register?(context: DebugPluginContext): void | Promise<void>;
  onRequestStart?(profile: RequestProfile): void;
  onRequestEnd?(profile: RequestProfile): void;
  onShutdown?(): void | Promise<void>;
}
