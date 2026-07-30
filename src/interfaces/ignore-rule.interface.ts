/**
 * A single "don't capture this endpoint" rule.
 *
 * Load balancers and orchestrators hit `/health` every second or two, which in
 * a 200-profile buffer means the interesting requests are evicted before you
 * can look at them. Rules drop those requests at capture time — the buffer then
 * holds only traffic you care about.
 */
export interface IgnoreRule {
  /** Stable id. Config-derived rules use `config:<index>`. */
  id: string;
  /** Path prefix (`/health`) or glob (`/static/*`). */
  pattern: string;
  /** Optional human note — why this is ignored. */
  note?: string;
  /** false → kept in the list but not applied, so it can be toggled back on. */
  enabled: boolean;
  /** ISO timestamp of creation. */
  createdAt: string;
  /**
   * `config` — from `forRoot({ ignore })`; always on and not editable from the
   * panel. `runtime` — added from the dashboard and persisted in storage.
   */
  source: 'config' | 'runtime';
  /**
   * Requests this rule has skipped since the process started. Never persisted —
   * it's a liveness signal ("is my rule actually matching?"), not state.
   */
  hits?: number;
}

/** The shape accepted when creating or updating a runtime rule. */
export interface IgnoreRuleInput {
  pattern?: unknown;
  note?: unknown;
  enabled?: unknown;
}
