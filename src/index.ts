// Module + configuration
export { DebugModule, DebugModuleAsyncOptions } from './debug.module';
export { DebugModuleOptions, ResolvedDebugOptions, resolveDebugOptions } from './config/debug-options';
export { DEBUG_OPTIONS, DEBUG_STORAGE, DEBUG_IGNORE_METADATA } from './constants';

// Core services
export { DebugContextService } from './context/debug-context.service';
export { DebugInterceptor } from './interceptor/debug.interceptor';
export { DebugAccessGuard } from './guards/debug-access.guard';
export { PluginManager } from './plugins/plugin-manager.service';

// Interfaces
export * from './interfaces/profile.interface';
export * from './interfaces/recorder.interface';
export * from './interfaces/storage.interface';
export * from './interfaces/plugin.interface';

// Storage drivers
export { MemoryStorage } from './storage/memory.storage';

// Analysis
export { analyzeSql, normalizeSql, SqlAnalyzerOptions } from './analysis/sql-analyzer';

// Decorators
export { DebugIgnore } from './decorators/debug-ignore.decorator';

// Plugins & adapters
export { MemoryPlugin } from './plugins/memory/memory.plugin';
export {
  PrismaPlugin,
  PrismaClientLike,
  PrismaQueryEventLike,
} from './plugins/prisma/prisma.plugin';
export { RedisPlugin, instrumentRedisClient } from './plugins/redis/redis.plugin';
export { AxiosPlugin, instrumentAxios, AxiosInstanceLike } from './plugins/http/axios.plugin';
export { FetchPlugin } from './plugins/http/fetch.plugin';
