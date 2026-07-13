import type { DebugPlugin } from '../interfaces/plugin.interface';
import type { DebugStorage } from '../interfaces/storage.interface';
import { DEFAULT_ROUTE_PREFIX } from '../constants';

/** Options accepted by `DebugModule.forRoot()`. */
export interface DebugModuleOptions {
  /** Master switch. Defaults to `NODE_ENV !== 'production'`. */
  enabled?: boolean;
  /** How many request profiles to keep. Oldest are evicted. Default 200. */
  maxRequests?: number;
  /** Capture request bodies. Default true. */
  captureRequestBody?: boolean;
  /** Capture handler return values. Default true. */
  captureResponseBody?: boolean;
  /** Capture request headers (redacted). Default true. */
  captureHeaders?: boolean;
  /** Capture heap/RSS snapshots + event-loop delay. Default true. */
  captureMemory?: boolean;
  /** Accept SQL events from database adapters. Default true. */
  captureSql?: boolean;
  /** Accept Redis events. Default true. */
  captureRedis?: boolean;
  /** Accept outgoing HTTP-call events. Default true. */
  captureHttp?: boolean;
  /** Queries at/above this (ms) are flagged slow. Default 100. */
  slowQueryThreshold?: number;
  /** Requests at/above this (ms) are flagged slow. Default 500. */
  slowRequestThreshold?: number;
  /** A duplicated SELECT repeated this many times is flagged as possible N+1. Default 5. */
  nPlusOneThreshold?: number;
  /** Where the debug API + UI are mounted. Default `/nest-debug-panel`. */
  routePrefix?: string;
  /**
   * Requests to skip. Strings match by path prefix (`/health`), support `*`
   * globs (`/static/*`), or pass RegExps. The debug routes are always skipped.
   */
  ignore?: (string | RegExp)[];
  /** Body/query keys to redact (case-insensitive substring match). */
  redactKeys?: string[];
  /** Header names to redact. Default: authorization, cookie, set-cookie. */
  redactHeaders?: string[];
  /** Max serialized length for captured bodies. Default 64 KiB. */
  maxBodyLength?: number;
  /** Extract the authenticated user from the request. Default: `req.user`. */
  getUser?: (request: unknown) => unknown;
  /** Gate access to the debug API/UI (e.g. only admins). */
  authorize?: (request: unknown) => boolean | Promise<boolean>;
  /** Storage driver. Default: in-memory ring buffer. */
  storage?: DebugStorage;
  /** Profiling plugins (Prisma, Redis, Axios, custom, ...). */
  plugins?: DebugPlugin[];
}

/** Options after defaults have been applied. */
export interface ResolvedDebugOptions {
  enabled: boolean;
  maxRequests: number;
  captureRequestBody: boolean;
  captureResponseBody: boolean;
  captureHeaders: boolean;
  captureMemory: boolean;
  captureSql: boolean;
  captureRedis: boolean;
  captureHttp: boolean;
  slowQueryThreshold: number;
  slowRequestThreshold: number;
  nPlusOneThreshold: number;
  /** Normalized: no leading/trailing slashes. */
  routePrefix: string;
  ignore: (string | RegExp)[];
  redactKeys: RegExp;
  redactHeaders: string[];
  maxBodyLength: number;
  getUser?: (request: unknown) => unknown;
  authorize?: (request: unknown) => boolean | Promise<boolean>;
  storage?: DebugStorage;
  plugins: DebugPlugin[];
}

const DEFAULT_REDACT_KEYS = ['password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'credential'];
const DEFAULT_REDACT_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];

export function normalizeRoutePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? DEFAULT_ROUTE_PREFIX).replace(/^\/+|\/+$/g, '');
  return trimmed.length > 0 ? trimmed : DEFAULT_ROUTE_PREFIX;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveDebugOptions(options: DebugModuleOptions = {}): ResolvedDebugOptions {
  const redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
  return {
    enabled: options.enabled ?? process.env.NODE_ENV !== 'production',
    maxRequests: options.maxRequests ?? 200,
    captureRequestBody: options.captureRequestBody ?? true,
    captureResponseBody: options.captureResponseBody ?? true,
    captureHeaders: options.captureHeaders ?? true,
    captureMemory: options.captureMemory ?? true,
    captureSql: options.captureSql ?? true,
    captureRedis: options.captureRedis ?? true,
    captureHttp: options.captureHttp ?? true,
    slowQueryThreshold: options.slowQueryThreshold ?? 100,
    slowRequestThreshold: options.slowRequestThreshold ?? 500,
    nPlusOneThreshold: options.nPlusOneThreshold ?? 5,
    routePrefix: normalizeRoutePrefix(options.routePrefix),
    ignore: options.ignore ?? [],
    redactKeys: new RegExp(redactKeys.map(escapeRegExp).join('|'), 'i'),
    redactHeaders: (options.redactHeaders ?? DEFAULT_REDACT_HEADERS).map((h) => h.toLowerCase()),
    maxBodyLength: options.maxBodyLength ?? 64 * 1024,
    getUser: options.getUser,
    authorize: options.authorize,
    storage: options.storage,
    plugins: options.plugins ?? [],
  };
}
