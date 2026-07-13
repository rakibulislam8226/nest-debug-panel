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
import { DEBUG_IGNORE_METADATA, DEBUG_OPTIONS, DEBUG_STORAGE, HTTP_CODE_METADATA } from '../constants';
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
      if (!this.options.enabled || executionContext.getType() !== 'http') {
        return next.handle();
      }
      const request = executionContext.switchToHttp().getRequest<RequestLike>();
      const url = request?.originalUrl ?? request?.url ?? '';
      if (this.shouldIgnore(url, executionContext)) return next.handle();
      profile = this.createProfile(request, url);
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
      body: this.options.captureRequestBody
        ? safeSerialize(sanitizeValue(request?.body, redactKeys), this.options.maxBodyLength).value
        : undefined,
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
    try {
      const user = this.options.getUser ? this.options.getUser(request) : request?.user;
      return user === undefined ? undefined : sanitizeValue(user, this.options.redactKeys);
    } catch {
      return undefined;
    }
  }

  private captureSuccess(profile: RequestProfile, data: unknown, executionContext: ExecutionContext): void {
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
    profile.statusCode = error instanceof HttpException ? error.getStatus() : 500;
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
      label: `Response${profile.statusCode !== undefined ? ` ${profile.statusCode}` : ''}`,
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
