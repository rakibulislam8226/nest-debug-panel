import type { DuplicateQueryGroup, SqlAnalysis, SqlQueryEvent } from '../interfaces/profile.interface';
import { round2 } from '../utils/common';

export interface SqlAnalyzerOptions {
  slowQueryThreshold: number;
  nPlusOneThreshold: number;
}

/**
 * Strip literals/placeholders so identical query shapes group together:
 * `SELECT * FROM u WHERE id = 1` and `... id = 2` become the same key.
 */
export function normalizeSql(query: SqlQueryEvent): string {
  const base = query.sql ?? ([query.model, query.operation].filter(Boolean).join('.') || 'unknown');
  return base
    .replace(/'(?:[^'\\]|\\.)*'/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeRead(sample: SqlQueryEvent): boolean {
  if (sample.sql) return /^\s*select/i.test(sample.sql);
  return /^(find|count|aggregate|group)/i.test(sample.operation ?? '');
}

export function analyzeSql(queries: SqlQueryEvent[], options: SqlAnalyzerOptions): SqlAnalysis {
  let totalTimeMs = 0;
  let slowestIndex = -1;
  let slowestDuration = -1;
  let slowQueryCount = 0;

  const groups = new Map<string, { sample: SqlQueryEvent; count: number; totalTimeMs: number }>();

  queries.forEach((query, index) => {
    totalTimeMs += query.durationMs;
    if (query.durationMs > slowestDuration) {
      slowestDuration = query.durationMs;
      slowestIndex = index;
    }
    if (query.durationMs >= options.slowQueryThreshold) slowQueryCount += 1;

    const key = normalizeSql(query);
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.totalTimeMs += query.durationMs;
    } else {
      groups.set(key, { sample: query, count: 1, totalTimeMs: query.durationMs });
    }
  });

  const duplicates: DuplicateQueryGroup[] = [];
  const possibleNPlusOne: DuplicateQueryGroup[] = [];

  for (const [key, group] of groups) {
    if (group.count < 2) continue;
    const entry: DuplicateQueryGroup = {
      sql: group.sample.sql ?? key,
      count: group.count,
      totalTimeMs: round2(group.totalTimeMs),
    };
    duplicates.push(entry);
    if (group.count >= options.nPlusOneThreshold && looksLikeRead(group.sample)) {
      possibleNPlusOne.push(entry);
    }
  }

  duplicates.sort((a, b) => b.count - a.count);
  possibleNPlusOne.sort((a, b) => b.count - a.count);

  return {
    totalQueries: queries.length,
    totalTimeMs: round2(totalTimeMs),
    slowestIndex,
    slowQueryCount,
    duplicates,
    possibleNPlusOne,
  };
}
