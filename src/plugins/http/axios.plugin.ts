import { performance } from 'node:perf_hooks';
import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';
import type { DebugRecorder } from '../../interfaces/recorder.interface';
import { byteSize } from '../../utils/common';

const MARKER = '__nestLensTiming';

interface AxiosConfigLike {
  url?: string;
  baseURL?: string;
  method?: string;
  data?: unknown;
  [MARKER]?: { start: number; startedAt: number };
}

interface AxiosResponseLike {
  status?: number;
  data?: unknown;
  headers?: Record<string, unknown>;
  config?: AxiosConfigLike;
}

/** Minimal structural type — works for the axios default export, instances, and `HttpService.axiosRef`. */
export interface AxiosInstanceLike {
  interceptors: {
    request: { use: (onFulfilled: (config: never) => unknown) => unknown };
    response: {
      use: (onFulfilled: (response: never) => unknown, onRejected: (error: never) => unknown) => unknown;
    };
  };
}

const INSTRUMENTED = Symbol('nest-lens:axios-instrumented');

/**
 * Time every request going through an Axios instance. For Nest's HttpService,
 * pass `httpService.axiosRef`.
 */
export function instrumentAxios(instance: AxiosInstanceLike, recorder: DebugRecorder): void {
  const target = instance as AxiosInstanceLike & { [INSTRUMENTED]?: boolean };
  if (!target?.interceptors || target[INSTRUMENTED]) return;
  target[INSTRUMENTED] = true;

  target.interceptors.request.use(((config: AxiosConfigLike) => {
    config[MARKER] = { start: performance.now(), startedAt: Date.now() };
    return config;
  }) as (config: never) => unknown);

  target.interceptors.response.use(
    ((response: AxiosResponseLike) => {
      record(recorder, response.config, response);
      return response;
    }) as (response: never) => unknown,
    ((error: { config?: AxiosConfigLike; response?: AxiosResponseLike; message?: string }) => {
      record(recorder, error?.config, error?.response, error?.message ?? 'Request failed');
      return Promise.reject(error);
    }) as (error: never) => unknown,
  );
}

function record(
  recorder: DebugRecorder,
  config: AxiosConfigLike | undefined,
  response: AxiosResponseLike | undefined,
  error?: string,
): void {
  if (!config || !recorder.isActive()) return;
  const timing = config[MARKER];
  const contentLength = Number(response?.headers?.['content-length']);
  recorder.recordHttp({
    source: 'axios',
    method: (config.method ?? 'get').toUpperCase(),
    url: `${config.baseURL ?? ''}${config.url ?? ''}`,
    statusCode: response?.status,
    durationMs: timing ? performance.now() - timing.start : 0,
    startedAt: timing?.startedAt,
    requestSize: config.data !== undefined ? byteSize(config.data) : undefined,
    responseSize: Number.isFinite(contentLength)
      ? contentLength
      : response?.data !== undefined
        ? byteSize(response.data)
        : undefined,
    error,
  });
}

/**
 * Axios adapter plugin.
 *
 * ```ts
 * const axiosPlugin = new AxiosPlugin();
 * // DebugModule.forRoot({ plugins: [axiosPlugin] })
 * axiosPlugin.attach(httpService.axiosRef); // or any axios instance
 * ```
 */
export class AxiosPlugin implements DebugPlugin {
  readonly name = 'axios';
  private context?: DebugPluginContext;
  private readonly pendingInstances: AxiosInstanceLike[] = [];

  constructor(private readonly pluginOptions: { instances?: AxiosInstanceLike[] } = {}) {}

  register(context: DebugPluginContext): void {
    this.context = context;
    for (const instance of [
      ...(this.pluginOptions.instances ?? []),
      ...this.pendingInstances.splice(0),
    ]) {
      instrumentAxios(instance, context.recorder);
    }
  }

  /** Instrument an axios instance. Safe to call before or after bootstrap. */
  attach(instance: AxiosInstanceLike): void {
    if (this.context) instrumentAxios(instance, this.context.recorder);
    else this.pendingInstances.push(instance);
  }
}
