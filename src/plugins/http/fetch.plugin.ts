import { performance } from 'node:perf_hooks';
import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';

type FetchFn = typeof globalThis.fetch;
type FetchInput = Parameters<FetchFn>[0];

/**
 * Patches `globalThis.fetch` so outgoing fetch calls made during a request
 * are timed and recorded. The original fetch is restored on shutdown.
 * Calls made outside a request context pass straight through.
 */
export class FetchPlugin implements DebugPlugin {
  readonly name = 'fetch';
  private originalFetch?: FetchFn;

  register(context: DebugPluginContext): void {
    if (typeof globalThis.fetch !== 'function') return;
    const original: FetchFn = globalThis.fetch.bind(globalThis);
    this.originalFetch = globalThis.fetch;
    const { recorder } = context;

    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      if (!recorder.isActive()) return original(input, init);

      const url = resolveUrl(input);
      const method = resolveMethod(input, init);
      const start = performance.now();
      const startedAt = Date.now();
      const requestSize = resolveBodySize(init?.body);
      try {
        const response = await original(input, init);
        const contentLength = Number(response.headers.get('content-length'));
        recorder.recordHttp({
          source: 'fetch',
          method,
          url,
          statusCode: response.status,
          durationMs: performance.now() - start,
          startedAt,
          requestSize,
          responseSize: Number.isFinite(contentLength) ? contentLength : undefined,
        });
        return response;
      } catch (error) {
        recorder.recordHttp({
          source: 'fetch',
          method,
          url,
          durationMs: performance.now() - start,
          startedAt,
          requestSize,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }) as FetchFn;
  }

  onShutdown(): void {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
  }
}

function resolveUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url ?? String(input);
}

function resolveMethod(input: FetchInput, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === 'object' && input !== null && 'method' in input) {
    return String((input as Request).method || 'GET').toUpperCase();
  }
  return 'GET';
}

function resolveBodySize(body: unknown): number | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.length;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return undefined;
}
