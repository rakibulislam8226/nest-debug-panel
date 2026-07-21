let eventCounter = 0;

/** Short, process-unique id for captured events. */
export function eventId(): string {
  eventCounter = (eventCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `e${eventCounter.toString(36)}`;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const TRUE_TOKENS = new Set(['true', '1', 'yes', 'on']);
const FALSE_TOKENS = new Set(['false', '0', 'no', 'off']);

/**
 * Parse a boolean from an environment variable, tolerantly.
 *
 * Returns `true`/`false` for recognized tokens (`true|1|yes|on` /
 * `false|0|no|off`, case-insensitive), and `undefined` for anything else —
 * unset, empty, or unrecognized — so callers can fall through to a default.
 * Deliberately not `Boolean(value)`, which would treat the string `"false"`
 * as `true`.
 */
export function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const token = value.trim().toLowerCase();
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  return undefined;
}

export interface SerializedValue {
  value: unknown;
  /** Byte size of the full serialized form (before truncation). */
  size: number;
  truncated: boolean;
}

/** JSON-serialize any value without throwing on circular refs; truncate large payloads. */
export function safeSerialize(value: unknown, maxLength: number): SerializedValue {
  if (value === undefined) return { value: undefined, size: 0, truncated: false };
  let json: string;
  try {
    const seen = new WeakSet<object>();
    json = JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'bigint') return val.toString();
      return val;
    }) ?? 'null';
  } catch {
    return { value: '[Unserializable]', size: 0, truncated: false };
  }
  const size = Buffer.byteLength(json);
  if (json.length > maxLength) {
    return { value: `${json.slice(0, maxLength)}… [truncated, ${size} bytes total]`, size, truncated: true };
  }
  return { value, size, truncated: false };
}

export function byteSize(value: unknown): number {
  return safeSerialize(value, Number.MAX_SAFE_INTEGER).size;
}

const MAX_DEPTH = 6;
const MAX_KEYS = 100;

/** Deep-copy a value while redacting sensitive keys and bounding depth/width. */
export function sanitizeValue(value: unknown, redactKeys: RegExp, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (type === 'function' || type === 'symbol') return `[${type}]`;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';
  if (Array.isArray(value)) {
    const copy = value.slice(0, MAX_KEYS).map((item) => sanitizeValue(item, redactKeys, depth + 1));
    if (value.length > MAX_KEYS) copy.push(`… ${value.length - MAX_KEYS} more items`);
    return copy;
  }
  try {
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (++count > MAX_KEYS) {
        result['…'] = 'truncated';
        break;
      }
      result[key] = redactKeys.test(key) ? '[REDACTED]' : sanitizeValue(val, redactKeys, depth + 1);
    }
    return result;
  } catch {
    return '[Unserializable]';
  }
}

/** Lowercase header names and redact sensitive ones. */
export function sanitizeHeaders(
  headers: Record<string, unknown> | undefined,
  redactHeaders: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!headers) return result;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    result[lower] = redactHeaders.includes(lower) ? '[REDACTED]' : value;
  }
  return result;
}

/** Stringify + cap an argument list (used for Redis command args). */
export function formatArgs(args: unknown[], maxArgs = 12, maxArgLength = 200): string[] {
  const formatted = args.slice(0, maxArgs).map((arg) => {
    const str = typeof arg === 'string' ? arg : String(arg);
    return str.length > maxArgLength ? `${str.slice(0, maxArgLength)}…` : str;
  });
  if (args.length > maxArgs) formatted.push(`… ${args.length - maxArgs} more`);
  return formatted;
}
