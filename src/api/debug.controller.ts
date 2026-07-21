import { Controller, Delete, Get, Inject, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { DEBUG_OPTIONS, DEBUG_STORAGE, DEFAULT_ROUTE_PREFIX } from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';
import type { DebugStorage } from '../interfaces/storage.interface';
import type { RequestProfile, RequestSummary } from '../interfaces/profile.interface';
import { DebugAccessGuard } from '../guards/debug-access.guard';
import { DebugIgnore } from '../decorators/debug-ignore.decorator';
import { renderListPage } from '../ui/render-list';
import { renderDetailPage } from '../ui/render-detail';

interface NegotiableRequest {
  headers?: Record<string, unknown>;
}

/**
 * Minimal response surface shared by Express (`res`) and Fastify (`reply`),
 * with the raw Node response as a last resort.
 */
interface AdapterResponse {
  status?: (code: number) => unknown;
  header?: (name: string, value: string) => unknown;
  set?: (name: string, value: string) => unknown;
  send?: (payload: string) => unknown;
  setHeader?: (name: string, value: string) => void;
  statusCode?: number;
  end?: (payload?: string) => void;
  raw?: {
    statusCode?: number;
    setHeader?: (name: string, value: string) => void;
    end?: (payload?: string) => void;
  };
}

/**
 * Debug API + UI. Content-negotiated:
 *   GET    /__debug      → HTML dashboard (browser) or JSON summaries (Accept: application/json)
 *   GET    /__debug/:id  → HTML detail page or full JSON profile
 *   DELETE /__debug      → clear history
 *
 * Responses are written directly to the adapter's response object — never
 * returned through Nest's serialization pipeline. This keeps the panel immune
 * to host-app global interceptors that wrap every response in an envelope
 * (e.g. `{ hasErrors, data, errors }`), which would corrupt the HTML page and
 * the JSON API the dashboard polls.
 *
 * The path is re-prefixed at bootstrap from `routePrefix`; the controller
 * itself is excluded from profiling.
 */
@DebugIgnore()
@UseGuards(DebugAccessGuard)
@Controller(DEFAULT_ROUTE_PREFIX)
export class DebugController {
  constructor(
    @Inject(DEBUG_OPTIONS) private readonly options: ResolvedDebugOptions,
    @Inject(DEBUG_STORAGE) private readonly storage: DebugStorage,
  ) {}

  @Get()
  async index(
    @Req() request: NegotiableRequest,
    @Res() response: AdapterResponse,
    @Query('feed') feed?: string,
  ): Promise<void> {
    // Aggregate feed for the dashboard's Queries view: a flattened list of
    // every SQL query across all captured profiles. Lazily fetched by the UI,
    // never part of the fast summaries poll below.
    // Aggregate feeds for the dashboard's Queries / Logs views: flattened
    // events across all profiles. Lazily fetched by the UI, never part of the
    // fast summaries poll below.
    if (feed === 'queries') {
      const threshold = this.options.slowQueryThreshold;
      const queries = await this.collectFlattened(
        (summary) => summary.sqlCount > 0,
        (profile) => profile.sql,
        (query, requestId, requestLabel) => ({
          requestId,
          requestLabel,
          source: query.source,
          model: query.model,
          operation: query.operation,
          sql: query.sql,
          durationMs: query.durationMs,
          startedAt: query.startedAt,
          slow: query.durationMs >= threshold,
        }),
      );
      send(response, 200, JSON_TYPE, safeJson({ queries }));
      return;
    }
    if (feed === 'logs') {
      const logs = await this.collectFlattened(
        (summary) => summary.logCount > 0,
        (profile) => profile.logs,
        (log, requestId, requestLabel) => ({
          requestId,
          requestLabel,
          level: log.level,
          message: log.message,
          context: log.context,
          startedAt: log.startedAt,
        }),
      );
      send(response, 200, JSON_TYPE, safeJson({ logs }));
      return;
    }
    // The dashboard shell is data-less (it hydrates from the JSON feed), so the
    // HTML path skips the list() call entirely.
    if (wantsHtml(request)) {
      try {
        send(response, 200, HTML, renderListPage(this.options.routePrefix));
        return;
      } catch {
        /* rendering failed — fall back to JSON below */
      }
    }
    // HTTP requests and socket events share one list; the UI filters by kind.
    send(response, 200, JSON_TYPE, safeJson(await this.storage.list()));
  }

  /**
   * Walk every profile newest-first and flatten a per-profile array (SQL, logs,
   * …) into one list, tagging each item with its owning request and capping at
   * 1000. `has` skips profiles with nothing to contribute so we never fetch a
   * full profile we don't need.
   */
  private async collectFlattened<T>(
    has: (summary: RequestSummary) => boolean,
    pick: (profile: RequestProfile) => T[] | undefined,
    map: (item: T, requestId: string, requestLabel: string) => Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const summaries = await this.storage.list();
    const out: Record<string, unknown>[] = [];
    for (const summary of summaries) {
      if (!has(summary)) continue;
      const profile = await this.storage.find(summary.id);
      const items = profile && pick(profile);
      if (!profile || !items?.length) continue;
      const label =
        profile.kind === 'socket'
          ? (profile.socket?.event ?? 'socket')
          : `${profile.method} ${profile.url}`;
      for (const item of items) {
        out.push(map(item, profile.id, label));
        if (out.length >= 1000) return out;
      }
    }
    return out;
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Req() request: NegotiableRequest,
    @Res() response: AdapterResponse,
  ): Promise<void> {
    const profile = await this.storage.find(id);
    if (!profile) {
      send(
        response,
        404,
        JSON_TYPE,
        safeJson({ statusCode: 404, message: `No captured request with id "${id}"` }),
      );
      return;
    }
    if (wantsHtml(request)) {
      try {
        send(
          response,
          200,
          HTML,
          renderDetailPage(profile, this.options.routePrefix, this.options.slowQueryThreshold),
        );
        return;
      } catch {
        /* rendering failed — fall back to JSON below */
      }
    }
    send(response, 200, JSON_TYPE, safeJson(profile));
  }

  @Delete()
  async clear(@Res() response: AdapterResponse): Promise<void> {
    await this.storage.clear();
    send(response, 200, JSON_TYPE, safeJson({ cleared: true }));
  }
}

const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

function wantsHtml(request: NegotiableRequest): boolean {
  const accept = String(request?.headers?.['accept'] ?? '');
  return accept.includes('text/html');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '{"error":"unserializable profile"}';
  }
}

/** Write a response on Express, Fastify, or the raw Node response. */
function send(
  response: AdapterResponse,
  statusCode: number,
  contentType: string,
  payload: string,
): void {
  // Express res / Fastify reply: both expose status() and send().
  if (typeof response?.status === 'function' && typeof response?.send === 'function') {
    if (typeof response.header === 'function') response.header('content-type', contentType);
    else if (typeof response.set === 'function') response.set('content-type', contentType);
    else response.setHeader?.('content-type', contentType);
    response.status(statusCode);
    response.send(payload);
    return;
  }
  // Raw Node response (or reply.raw).
  const raw = response?.raw ?? response;
  if (raw) {
    raw.statusCode = statusCode;
    raw.setHeader?.('content-type', contentType);
    raw.end?.(payload);
  }
}
