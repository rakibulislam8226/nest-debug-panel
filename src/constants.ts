/** DI token for the resolved debug options. */
export const DEBUG_OPTIONS = 'NEST_LENS_OPTIONS';

/** DI token for the active storage driver. */
export const DEBUG_STORAGE = 'NEST_LENS_STORAGE';

/** Metadata key used by the @DebugIgnore() decorator. */
export const DEBUG_IGNORE_METADATA = 'nest-lens:ignore';

/** Nest's own metadata key for @HttpCode(). */
export const HTTP_CODE_METADATA = '__httpCode__';

/** Nest's own metadata key for controller paths (used to re-prefix the debug controller). */
export const PATH_METADATA = 'path';

/** Default route prefix for the debug API + UI. */
export const DEFAULT_ROUTE_PREFIX = '__debug';
