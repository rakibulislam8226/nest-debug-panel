import { SetMetadata } from '@nestjs/common';
import { DEBUG_IGNORE_METADATA } from '../constants';

/**
 * Exclude a controller or a single route from profiling.
 *
 * ```ts
 * @DebugIgnore()
 * @Controller('health')
 * export class HealthController { ... }
 * ```
 */
export const DebugIgnore = (): ClassDecorator & MethodDecorator =>
  SetMetadata(DEBUG_IGNORE_METADATA, true);
