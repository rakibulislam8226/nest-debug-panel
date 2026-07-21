import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, Subscription, throwError } from 'rxjs';
import { catchError, finalize, tap } from 'rxjs/operators';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  DEBUG_IGNORE_METADATA,
  DEBUG_OPTIONS,
  DEBUG_STORAGE,
  HTTP_CODE_METADATA,
  SOCKET_MESSAGE_METADATA,
} from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';
import type { DebugStorage } from '../interfaces/storage.interface';
import type { RequestProfile } from '../interfaces/profile.interface';
import { DebugContextService } from '../context/debug-context.service';
import { PluginManager } from '../plugins/plugin-manager.service';
import { analyzeSql } from '../analysis/sql-analyzer';
import { byteSize, round2, safeSerialize, sanitizeHeaders, sanitizeValue } from '../utils/common';

interface RequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  user?: unknown;
  ip?: string;
  route?: { path?: string };
  socket?: { remoteAddress?: string };
}

interface ResponseLike {
  statusCode?: number;
}

/** Structural view of a socket.io client — accessed defensively (no hard dep). */
interface SocketClientLike {
  id?: string;
  nsp?: { name?: string };
  rooms?: Set<string> | string[];
  handshake?: {
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
    auth?: Record<string, unknown>;
    address?: string;
  };
  data?: { user?: unknown };
}

/**
 * The core of nest-debug-panel. Registered as a global interceptor by
 * `DebugModule.forRoot()`. For every non-ignored HTTP request it:
 *
 *   1. builds a fresh {@link RequestProfile},
 *   2. runs the handler chain inside an AsyncLocalStorage context so plugins
 *      can attach SQL/Redis/HTTP/... events to the right request,
 *   3. captures response/exception details, and
 *   4. finalizes timings + SQL analysis and persists the profile.
 */
@Injectable()
export class DebugInterceptor implements NestInterceptor {
  private readonly logger = new Logger('NestDebugPanel');
  private readonly ignoreMatchers: Array<(path: string) => boolean>;

  constructor(
    @Inject(DEBUG_OPTIONS) private readonly options: ResolvedDebugOptions,
    @Inject(DEBUG_STORAGE) private readonly storage: DebugStorage,
    private readonly debugContext: DebugContextService,
    private readonly plugins: PluginManager,
    private readonly reflector: Reflector,
  ) {
    this.ignoreMatchers = compileIgnoreMatchers(this.options.ignore);
  }

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Fail-open: profiling must never break the application. Any internal
    // error here means we skip profiling for this request and pass through.
    let profile: RequestProfile;
    try {
      if (!this.options.enabled) return next.handle();
      const type = executionContext.getType();
      if (type === 'http') {
        const request = executionContext.switchToHttp().getRequest<RequestLike>();
        const url = request?.originalUrl ?? request?.url ?? '';
        if (this.shouldIgnore(url, executionContext)) return next.handle();
        profile = this.createProfile(request, url);
      } else if (type === 'ws') {
        // Global interceptors also fire for WebSocket gateways. Capture each
        // inbound @SubscribeMessage handler as its own profile so any SQL/etc.
        // it runs attaches via the same AsyncLocalStorage context as HTTP.
        if (!this.options.captureSockets || this.isDebugIgnored(executionContext)) {
          return next.handle();
        }
        profile = this.createSocketProfile(executionContext);
      } else {
        return next.handle();
      }
    } catch (error) {
      this.warnOnce(`profiling bypassed (setup failed): ${String(error)}`);
      return next.handle();
    }

    const startedHr = performance.now();

    // Subscribe inside als.run() so the whole handler chain — pipes, the
    // handler, downstream services — shares this request's context.
    return new Observable<unknown>((subscriber) => {
      let subscription: Subscription | undefined;
      try {
        this.debugContext.run(profile, () => {
          this.plugins.dispatchRequestStart(profile);
          subscription = next
            .handle()
            .pipe(
              tap((data) => this.trySafely(() => this.captureSuccess(profile, data, executionContext))),
              catchError((error) => {
                this.trySafely(() => this.captureFailure(profile, error));
                return throwError(() => error);
              }),
              finalize(() => this.trySafely(() => this.finish(profile, startedHr))),
            )
            .subscribe(subscriber);
        });
      } catch (error) {
        // Context setup failed mid-flight — run the handler without profiling.
        this.warnOnce(`profiling bypassed (context failed): ${String(error)}`);
        subscription = next.handle().subscribe(subscriber);
      }
      return () => subscription?.unsubscribe();
    });
  }

  /** Run a capture step; on failure, log once and keep the request alive. */
  private trySafely(step: () => void): void {
    try {
      step();
    } catch (error) {
      this.warnOnce(`capture step failed (request unaffected): ${String(error)}`);
    }
  }

  private warned = new Set<string>();

  /** Avoid flooding logs when the same internal failure repeats per request. */
  private warnOnce(message: string): void {
    const key = message.slice(0, 120);
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (this.warned.size > 50) this.warned.clear();
    this.logger.warn(message);
  }

  private createProfile(request: RequestLike, url: string): RequestProfile {
    const { redactKeys } = this.options;
    const method = String(request?.method ?? 'GET').toUpperCase();
    const profile: RequestProfile = {
      id: randomUUID(),
      method,
      url,
      route: request?.route?.path,
      queryParams: (sanitizeValue(request?.query ?? {}, redactKeys) ?? {}) as Record<string, unknown>,
      routeParams: (sanitizeValue(request?.params ?? {}, redactKeys) ?? {}) as Record<string, unknown>,
      headers: this.options.captureHeaders
        ? sanitizeHeaders(request?.headers, this.options.redactHeaders)
        : undefined,
      body: this.serializeBody(request?.body),
      user: this.resolveUser(request),
      ip: request?.ip ?? request?.socket?.remoteAddress,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      sql: [],
      redis: [],
      http: [],
      timeline: [{ at: 0, label: `Request started — ${method} ${url}`, kind: 'request' }],
      custom: {},
    };
    return profile;
  }

  private resolveUser(request: RequestLike): unknown {
    return this.resolveUserFrom(request, request?.user);
  }

  /** Shared user resolution for HTTP and socket: prefer getUser(), else fallback. */
  private resolveUserFrom(source: unknown, fallback: unknown): unknown {
    try {
      const user = this.options.getUser ? this.options.getUser(source) : fallback;
      return user === undefined ? undefined : sanitizeValue(user, this.options.redactKeys);
    } catch {
      return undefined;
    }
  }

  private createSocketProfile(executionContext: ExecutionContext): RequestProfile {
    const ws = executionContext.switchToWs();
    const client = ws.getClient<SocketClientLike>();
    const data = ws.getData<unknown>();
    const event = this.resolveEventName(executionContext);
    const namespace = client?.nsp?.name;
    const profile: RequestProfile = {
      id: randomUUID(),
      kind: 'socket',
      method: 'WS',
      url: `${namespace ?? ''}#${event}`,
      queryParams: {},
      routeParams: {},
      body: this.serializeBody(data),
      user: this.resolveSocketUser(client),
      ip: client?.handshake?.address,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      sql: [],
      redis: [],
      http: [],
      timeline: [
        {
          at: 0,
          label: `Socket event — ${event}${namespace ? ` on ${namespace}` : ''}`,
          kind: 'request',
        },
      ],
      socket: {
        event,
        namespace,
        socketId: client?.id,
        rooms: this.resolveRooms(client),
        handshake: this.options.captureHeaders ? this.buildHandshake(client) : undefined,
      },
      custom: {},
    };
    return profile;
  }

  /** Sanitize + size-limit a request/event body, respecting captureRequestBody. */
  private serializeBody(value: unknown): unknown {
    if (!this.options.captureRequestBody) return undefined;
    return safeSerialize(sanitizeValue(value, this.options.redactKeys), this.options.maxBodyLength).value;
  }

  private resolveEventName(executionContext: ExecutionContext): string {
    const event = this.reflector.get<string | undefined>(
      SOCKET_MESSAGE_METADATA,
      executionContext.getHandler(),
    );
    return event ?? 'unknown';
  }

  private resolveRooms(client: SocketClientLike | undefined): string[] | undefined {
    try {
      const rooms = client?.rooms;
      if (!rooms) return undefined;
      const list = Array.isArray(rooms) ? rooms : Array.from(rooms);
      return list.length > 0 ? list.map(String) : undefined;
    } catch {
      return undefined;
    }
  }

  private buildHandshake(client: SocketClientLike | undefined): Record<string, unknown> | undefined {
    const handshake = client?.handshake;
    if (!handshake) return undefined;
    const out: Record<string, unknown> = {};
    if (handshake.headers) out.headers = sanitizeHeaders(handshake.headers, this.options.redactHeaders);
    if (handshake.query) out.query = sanitizeValue(handshake.query, this.options.redactKeys);
    if (handshake.auth) out.auth = sanitizeValue(handshake.auth, this.options.redactKeys);
    if (handshake.address) out.address = handshake.address;
    return out;
  }

  private resolveSocketUser(client: SocketClientLike | undefined): unknown {
    return this.resolveUserFrom(client, client?.data?.user);
  }

  private captureSuccess(profile: RequestProfile, data: unknown, executionContext: ExecutionContext): void {
    if (profile.kind === 'socket') {
      this.captureSocketSuccess(profile, data);
      return;
    }
    const response = executionContext.switchToHttp().getResponse<ResponseLike>();
    profile.statusCode = this.resolveStatusCode(profile.method, response, executionContext);
    if (data !== undefined) {
      if (this.options.captureResponseBody) {
        const serialized = safeSerialize(
          sanitizeValue(data, this.options.redactKeys),
          this.options.maxBodyLength,
        );
        profile.responseBody = serialized.value;
        profile.responseSize = serialized.size;
      } else {
        profile.responseSize = byteSize(data);
      }
    }
    // Guards/handlers may attach the user after profile creation.
    if (profile.user === undefined) {
      profile.user = this.resolveUser(executionContext.switchToHttp().getRequest<RequestLike>());
    }
  }

  private captureSocketSuccess(profile: RequestProfile, data: unknown): void {
    if (data === undefined || !profile.socket) return;
    if (this.options.captureResponseBody) {
      const serialized = safeSerialize(
        sanitizeValue(data, this.options.redactKeys),
        this.options.maxBodyLength,
      );
      profile.socket.ack = serialized.value;
      profile.responseSize = serialized.size;
    } else {
      profile.responseSize = byteSize(data);
    }
  }

  private resolveStatusCode(
    method: string,
    response: ResponseLike | undefined,
    executionContext: ExecutionContext,
  ): number {
    const explicit = this.reflector.get<number | undefined>(
      HTTP_CODE_METADATA,
      executionContext.getHandler(),
    );
    if (explicit !== undefined) return explicit;
    const current = response?.statusCode;
    // Express defaults to 200 until the response is sent; Nest sends 201 for POST.
    if (current !== undefined && current !== 200) return current;
    return method === 'POST' ? 201 : (current ?? 200);
  }

  private captureFailure(profile: RequestProfile, error: unknown): void {
    // Status codes are an HTTP concept; leave socket profiles without one.
    if (profile.kind !== 'socket') {
      profile.statusCode = error instanceof HttpException ? error.getStatus() : 500;
    }
    this.debugContext.recordException(error, profile);
    if (this.options.captureResponseBody && error instanceof HttpException) {
      profile.responseBody = safeSerialize(error.getResponse(), this.options.maxBodyLength).value;
    }
  }

  private finish(profile: RequestProfile, startedHr: number): void {
    const durationMs = round2(performance.now() - startedHr);
    profile.durationMs = durationMs;
    profile.endedAtMs = Date.now();
    profile.slow = durationMs >= this.options.slowRequestThreshold;
    profile.timeline.push({
      at: durationMs,
      label:
        profile.kind === 'socket'
          ? 'Completed'
          : `Response${profile.statusCode !== undefined ? ` ${profile.statusCode}` : ''}`,
      kind: 'response',
    });
    profile.sqlAnalysis = analyzeSql(profile.sql, this.options);
    this.plugins.dispatchRequestEnd(profile);
    Promise.resolve(this.storage.save(profile)).catch((error) =>
      this.logger.warn(`Failed to persist request profile: ${String(error)}`),
    );
  }

  private shouldIgnore(url: string, executionContext: ExecutionContext): boolean {
    const path = url.split('?')[0] ?? '';
    const prefix = `/${this.options.routePrefix}`;
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
    if (this.ignoreMatchers.some((matches) => matches(path))) return true;
    return this.isDebugIgnored(executionContext);
  }

  /** True when @DebugIgnore() is present on the handler or its class. */
  private isDebugIgnored(executionContext: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(DEBUG_IGNORE_METADATA, [
        executionContext.getHandler(),
        executionContext.getClass(),
      ]) === true
    );
  }
}

function compileIgnoreMatchers(patterns: (string | RegExp)[]): Array<(path: string) => boolean> {
  return patterns.map((pattern) => {
    if (pattern instanceof RegExp) return (path: string) => pattern.test(path);
    if (pattern.includes('*')) {
      const source = pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const regex = new RegExp(`^${source}$`);
      return (path: string) => regex.test(path);
    }
    const normalized = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    return (path: string) => path === normalized || path.startsWith(`${normalized}/`);
  });
}
