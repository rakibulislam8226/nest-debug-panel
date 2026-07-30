/**
 * Path-ignore matching, shared by the static `ignore` option and the runtime
 * rules managed from the dashboard, so both behave identically.
 *
 * Pattern forms:
 *   `/health`      — prefix match: `/health` and `/health/db`, but not `/healthz`
 *   `/static/*`    — glob: `*` matches any run of characters
 *   /^\/v\d+\/ping/ — RegExp (config only; the panel accepts strings)
 */
export type PathMatcher = (path: string) => boolean;

export function compileIgnoreMatcher(pattern: string | RegExp): PathMatcher {
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
}

export function compileIgnoreMatchers(patterns: (string | RegExp)[]): PathMatcher[] {
  return patterns.map(compileIgnoreMatcher);
}

/** Strip the query string so patterns always match against the path alone. */
export function pathOf(url: string): string {
  return url.split('?')[0] ?? '';
}

/**
 * Normalize a pattern typed by a human: trim it, drop a trailing slash, and
 * add the leading one so `health` and `/health` mean the same thing.
 */
export function normalizeIgnorePattern(raw: unknown): string {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

/**
 * Describe why a pattern can't be used, or `undefined` when it's fine. Kept
 * separate from normalization so the API can report the reason to the panel.
 */
export function validateIgnorePattern(pattern: string): string | undefined {
  if (!pattern) return 'Pattern is required.';
  if (pattern.length > 200) return 'Pattern is too long (max 200 characters).';
  if (pattern === '/' || pattern === '/*') return 'That pattern would ignore every request.';
  if (/\s/.test(pattern)) return 'Pattern cannot contain spaces.';
  return undefined;
}
