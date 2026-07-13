import {
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
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

interface TypedResponse {
  type?: (mime: string) => void;
  header?: (name: string, value: string) => void;
}

/**
 * Debug API + UI. Content-negotiated:
 *   GET    /__debug      → HTML dashboard (browser) or JSON summaries (Accept: application/json)
 *   GET    /__debug/:id  → HTML detail page or full JSON profile
 *   DELETE /__debug      → clear history
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
    @Res({ passthrough: true }) response: TypedResponse,
  ): Promise<string | RequestSummary[]> {
    const summaries = await this.storage.list();
    if (wantsHtml(request)) {
      setHtml(response);
      return renderListPage(summaries, this.options.routePrefix);
    }
    return summaries;
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Req() request: NegotiableRequest,
    @Res({ passthrough: true }) response: TypedResponse,
  ): Promise<string | RequestProfile> {
    const profile = await this.storage.find(id);
    if (!profile) throw new NotFoundException(`No captured request with id "${id}"`);
    if (wantsHtml(request)) {
      setHtml(response);
      return renderDetailPage(profile, this.options.routePrefix, this.options.slowQueryThreshold);
    }
    return profile;
  }

  @Delete()
  async clear(): Promise<{ cleared: boolean }> {
    await this.storage.clear();
    return { cleared: true };
  }
}

function wantsHtml(request: NegotiableRequest): boolean {
  const accept = String(request?.headers?.['accept'] ?? '');
  return accept.includes('text/html');
}

function setHtml(response: TypedResponse): void {
  if (typeof response?.type === 'function') response.type('text/html');
  else response?.header?.('content-type', 'text/html; charset=utf-8');
}
