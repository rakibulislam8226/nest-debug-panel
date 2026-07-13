import { performance } from 'node:perf_hooks';
import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';
import type { DebugRecorder } from '../../interfaces/recorder.interface';
import { formatArgs } from '../../utils/common';

const INSTRUMENTED = Symbol('nest-lens:redis-instrumented');

interface RedisClientLike {
  sendCommand: (...args: unknown[]) => unknown;
  [INSTRUMENTED]?: boolean;
}

/**
 * Wrap a Redis client's `sendCommand` so every command is timed and recorded.
 * Supports ioredis (Command objects with `name`/`args`) and node-redis v4+
 * (plain string arrays). The patch runs in the caller's async context, so
 * events land on the right request automatically.
 */
export function instrumentRedisClient(client: unknown, recorder: DebugRecorder): void {
  const target = client as RedisClientLike | undefined;
  if (!target || typeof target.sendCommand !== 'function' || target[INSTRUMENTED]) return;
  target[INSTRUMENTED] = true;

  const original = target.sendCommand.bind(target);
  target.sendCommand = function instrumentedSendCommand(...callArgs: unknown[]): unknown {
    if (!recorder.isActive()) return original(...callArgs);

    const { command, args } = parseCommand(callArgs[0]);
    const start = performance.now();
    const startedAt = Date.now();
    const record = (error?: string): void =>
      recorder.recordRedis({
        command,
        args,
        durationMs: performance.now() - start,
        startedAt,
        error,
      });

    let result: unknown;
    try {
      result = original(...callArgs);
    } catch (error) {
      record(errorMessage(error));
      throw error;
    }
    if (isPromiseLike(result)) {
      // Observing the promise without replacing it — the caller still gets
      // the original, so rejection handling is untouched.
      result.then(
        () => record(),
        (error: unknown) => record(errorMessage(error)),
      );
    } else {
      record();
    }
    return result;
  };
}

function parseCommand(input: unknown): { command: string; args: string[] } {
  if (Array.isArray(input)) {
    // node-redis: sendCommand(['GET', 'key'])
    return { command: String(input[0] ?? 'UNKNOWN').toUpperCase(), args: formatArgs(input.slice(1)) };
  }
  if (input && typeof input === 'object') {
    // ioredis: sendCommand(new Command('get', ['key']))
    const cmd = input as { name?: unknown; args?: unknown };
    return {
      command: String(cmd.name ?? 'UNKNOWN').toUpperCase(),
      args: Array.isArray(cmd.args) ? formatArgs(cmd.args) : [],
    };
  }
  return { command: 'UNKNOWN', args: [] };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as Promise<unknown>).then === 'function';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Redis adapter plugin.
 *
 * ```ts
 * const redisPlugin = new RedisPlugin();
 * // DebugModule.forRoot({ plugins: [redisPlugin] })
 * redisPlugin.attach(ioredisClient); // in your Redis provider
 * ```
 */
export class RedisPlugin implements DebugPlugin {
  readonly name = 'redis';
  private context?: DebugPluginContext;
  private readonly pendingClients: unknown[] = [];

  constructor(private readonly pluginOptions: { clients?: unknown[] } = {}) {}

  register(context: DebugPluginContext): void {
    this.context = context;
    for (const client of [...(this.pluginOptions.clients ?? []), ...this.pendingClients.splice(0)]) {
      instrumentRedisClient(client, context.recorder);
    }
  }

  /** Instrument a client. Safe to call before or after bootstrap. */
  attach(client: unknown): void {
    if (this.context) instrumentRedisClient(client, this.context.recorder);
    else this.pendingClients.push(client);
  }
}
