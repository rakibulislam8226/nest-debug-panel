import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { DebugInterceptor } from '../interceptor/debug.interceptor';

/**
 * **Usually unnecessary.** Socket capture is automatic: `DebugModule.forRoot()`
 * attaches the debug interceptor to every gateway at startup (see
 * `SocketGatewayTracker`), so you don't normally add anything.
 *
 * This decorator is an explicit escape hatch for the rare cases where the
 * automatic attachment can't apply — e.g. tracking a single `@SubscribeMessage`
 * handler, or a gateway created outside the module scan. It simply applies the
 * debug interceptor via `@UseInterceptors()`; using it alongside the automatic
 * tracker is safe (the tracker de-duplicates).
 *
 * ```ts
 * @TrackSocketEvents()
 * @WebSocketGateway()
 * export class ChatGateway {}
 * ```
 */
export function TrackSocketEvents(): ClassDecorator & MethodDecorator {
  return applyDecorators(UseInterceptors(DebugInterceptor));
}
