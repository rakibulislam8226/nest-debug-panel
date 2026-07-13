import { analyzeSql, normalizeSql } from '../src/analysis/sql-analyzer';
import type { SqlQueryEvent } from '../src/interfaces/profile.interface';

let counter = 0;
function query(sql: string, durationMs: number): SqlQueryEvent {
  return { id: `q${counter++}`, source: 'prisma', sql, durationMs, startedAt: Date.now() };
}

const OPTIONS = { slowQueryThreshold: 100, nPlusOneThreshold: 3 };

describe('normalizeSql', () => {
  it('groups queries that differ only by literals/placeholders', () => {
    const a = normalizeSql(query("SELECT * FROM users WHERE id = 1 AND name = 'x'", 1));
    const b = normalizeSql(query("SELECT * FROM users WHERE id = 42 AND name = 'y'", 1));
    const c = normalizeSql(query('SELECT * FROM users WHERE id = $1 AND name = $2', 1));
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('falls back to model.operation when no SQL', () => {
    const event: SqlQueryEvent = {
      id: 'x',
      source: 'prisma',
      model: 'User',
      operation: 'findMany',
      durationMs: 1,
      startedAt: Date.now(),
    };
    expect(normalizeSql(event)).toBe('User.findMany');
  });
});

describe('analyzeSql', () => {
  it('computes totals and slowest', () => {
    const queries = [query('SELECT 1', 5), query('SELECT 2', 150), query('SELECT 3', 20)];
    const analysis = analyzeSql(queries, OPTIONS);
    expect(analysis.totalQueries).toBe(3);
    expect(analysis.totalTimeMs).toBe(175);
    expect(analysis.slowestIndex).toBe(1);
    expect(analysis.slowQueryCount).toBe(1);
  });

  it('detects duplicates', () => {
    const queries = [
      query('SELECT * FROM users WHERE id = 1', 2),
      query('SELECT * FROM users WHERE id = 2', 2),
      query('UPDATE users SET name = ? WHERE id = 3', 2),
    ];
    const analysis = analyzeSql(queries, OPTIONS);
    expect(analysis.duplicates).toHaveLength(1);
    expect(analysis.duplicates[0].count).toBe(2);
  });

  it('flags possible N+1 for repeated SELECTs at threshold', () => {
    const queries = Array.from({ length: 4 }, (_, i) =>
      query(`SELECT * FROM posts WHERE user_id = ${i}`, 3),
    );
    const analysis = analyzeSql(queries, OPTIONS);
    expect(analysis.possibleNPlusOne).toHaveLength(1);
    expect(analysis.possibleNPlusOne[0].count).toBe(4);
  });

  it('does not flag repeated writes as N+1', () => {
    const queries = Array.from({ length: 4 }, (_, i) =>
      query(`UPDATE posts SET views = views + 1 WHERE id = ${i}`, 3),
    );
    const analysis = analyzeSql(queries, OPTIONS);
    expect(analysis.duplicates).toHaveLength(1);
    expect(analysis.possibleNPlusOne).toHaveLength(0);
  });

  it('handles empty input', () => {
    const analysis = analyzeSql([], OPTIONS);
    expect(analysis.totalQueries).toBe(0);
    expect(analysis.slowestIndex).toBe(-1);
  });
});
