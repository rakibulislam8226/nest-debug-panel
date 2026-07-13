import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DEBUG_OPTIONS } from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';

/**
 * Protects the debug API/UI: 404 when profiling is disabled (the routes look
 * nonexistent in production), and delegates to the `authorize` callback when
 * one is configured.
 */
@Injectable()
export class DebugAccessGuard implements CanActivate {
  constructor(@Inject(DEBUG_OPTIONS) private readonly options: ResolvedDebugOptions) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.options.enabled) throw new NotFoundException();
    if (this.options.authorize) {
      const request = context.switchToHttp().getRequest();
      return (await this.options.authorize(request)) === true;
    }
    return true;
  }
}
