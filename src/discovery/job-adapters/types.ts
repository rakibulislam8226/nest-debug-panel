import type { JobMeta } from '../../interfaces/profile.interface';

/** A constructor type, used for provider metatypes. */
export type Ctor = new (...args: never[]) => unknown;

/** The `track` primitive an adapter uses to route a handler through a profile. */
export type TrackFn = <T>(meta: JobMeta, handler: () => T, data?: unknown) => T;

export interface JobWrapContext {
  track: TrackFn;
  /** True when @DebugIgnore() is present on the class. */
  isIgnored: (target: Ctor) => boolean;
}

export interface JobAdapter {
  library: string;
  /**
   * Early pass (tracker constructor): patch a provider CLASS prototype before
   * any framework binds its handler. Return a label (queue name) when it wrapped
   * something, else null.
   */
  wrapClass?(metatype: Ctor, ctx: JobWrapContext): string | null;
  /**
   * Late pass (onApplicationBootstrap): patch a provider INSTANCE (for libraries
   * whose queue object only exists after instantiation). Return a label or null.
   */
  wrapInstance?(instance: object, ctx: JobWrapContext): string | null;
}

/** Marks an already-wrapped function so wrapping is idempotent. */
export const WRAPPED = Symbol('nest-debug-panel:wrapped');

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Replace `holder[key]` with a wrapper that routes the call through `track`.
 * `this` is preserved, so instance-bound calls (e.g. BullMQ's
 * `instance.process.bind(instance)`) still resolve the wrapped body. Fail-open
 * and idempotent. Returns true when it wrapped (or was already wrapped).
 */
export function wrapMethod(
  holder: Record<string, unknown>,
  key: string,
  track: TrackFn,
  metaFrom: (args: unknown[]) => JobMeta,
  dataFrom: (args: unknown[]) => unknown = (args) => args[0],
): boolean {
  const original = holder[key] as AnyFn | undefined;
  if (typeof original !== 'function') return false;
  if (isWrapped(original)) return true;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    let meta: JobMeta;
    try {
      meta = metaFrom(args);
    } catch {
      return original.apply(this, args);
    }
    return track(meta, () => original.apply(this, args), safeData(dataFrom, args));
  } as AnyFn;
  markWrapped(wrapped);
  holder[key] = wrapped;
  return true;
}

/** True when a function has already been wrapped by this package. */
export function isWrapped(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as unknown as Record<symbol, unknown>)[WRAPPED] === true;
}

/** Mark a function as wrapped so wrapping is idempotent. */
export function markWrapped(fn: unknown): void {
  if (typeof fn === 'function') (fn as unknown as Record<symbol, unknown>)[WRAPPED] = true;
}

function safeData(dataFrom: (args: unknown[]) => unknown, args: unknown[]): unknown {
  try {
    return dataFrom(args);
  } catch {
    return undefined;
  }
}

/** True when any constructor in the prototype chain has the given name. */
export function hasConstructorNamed(metatype: Ctor, name: string): boolean {
  let proto: unknown = metatype?.prototype;
  let guard = 0;
  while (proto && guard++ < 20) {
    const ctor = (proto as { constructor?: { name?: string } }).constructor;
    if (ctor?.name === name) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Own method names on a class prototype (excluding the constructor). Inspects
 * property descriptors rather than reading values, so getters on the provider's
 * prototype are never invoked during discovery (they could throw or have side
 * effects — the panel must never perturb the host app).
 */
export function prototypeMethodNames(metatype: Ctor): string[] {
  const proto = metatype?.prototype;
  if (!proto) return [];
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === 'constructor') return false;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    return typeof descriptor?.value === 'function';
  });
}
