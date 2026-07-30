/**
 * Make a controller invisible to `@nestjs/throttler`'s global guard.
 *
 * The dashboard polls its own API every two seconds by design. In an app that
 * registers `ThrottlerGuard` as an `APP_GUARD` — the documented way to rate-limit
 * everything — those polls count against the limit like user traffic, and the
 * panel eventually answers `ThrottlerException: Too Many Requests` instead of
 * data. That is the package's problem to solve, not something every user should
 * have to discover and patch around.
 *
 * `ThrottlerGuard` decides per named throttler:
 *
 * ```ts
 * this.reflector.getAllAndOverride(THROTTLER_SKIP + namedThrottler.name, [handler, classRef])
 * ```
 *
 * so the skip flag is one metadata key **per throttler name**, read off the
 * handler or its class. Writing those keys directly is what keeps
 * `@nestjs/throttler` an optional peer rather than a real dependency — the
 * decorator is inert in an app that doesn't use it.
 *
 * There is no wildcard name, so we cover `default` (what an unnamed throttler
 * becomes) plus the names Nest's own multiple-throttler example uses. An app with
 * custom names needs `skipIf` in `ThrottlerModule` for those — see the README.
 */
const THROTTLER_SKIP = 'THROTTLER:SKIP';
const COVERED_THROTTLER_NAMES = ['default', 'short', 'medium', 'long'] as const;

export function SkipThrottling(): ClassDecorator {
  return (target) => {
    for (const name of COVERED_THROTTLER_NAMES) {
      Reflect.defineMetadata(`${THROTTLER_SKIP}${name}`, true, target);
    }
    return target;
  };
}
