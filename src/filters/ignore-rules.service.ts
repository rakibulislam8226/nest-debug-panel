import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DEBUG_OPTIONS, DEBUG_STORAGE } from '../constants';
import type { ResolvedDebugOptions } from '../config/debug-options';
import type { DebugStorage } from '../interfaces/storage.interface';
import type { IgnoreRule, IgnoreRuleInput } from '../interfaces/ignore-rule.interface';
import {
  compileIgnoreMatcher,
  normalizeIgnorePattern,
  validateIgnorePattern,
  type PathMatcher,
} from '../utils/ignore-match';

/** How often a shared store is re-read, so a rule added on one instance reaches the others. */
const REFRESH_INTERVAL_MS = 5000;

export interface IgnoreRuleResult {
  ok: boolean;
  /** Present when `ok` is false — safe to show in the UI. */
  error?: string;
  rule?: IgnoreRule;
}

/**
 * Owns the endpoint-ignore rules the dashboard manages at runtime.
 *
 * Matching has to be **synchronous and cheap** — it runs on the hot path of
 * every request — so the service keeps a compiled snapshot in memory and never
 * touches storage during a match. Writes go to storage; a background refresh
 * pulls other instances' changes in, which is what makes the feature work for a
 * clustered API sharing one Redis.
 *
 * Rules from `forRoot({ ignore })` are listed here too, marked `config`, so the
 * panel can show every reason a request might be missing — but they stay
 * read-only, since the code that declared them is the source of truth.
 */
@Injectable()
export class IgnoreRulesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('NestDebugPanel');
  private runtimeRules: IgnoreRule[] = [];
  /** Compiled matchers for the enabled runtime rules, rebuilt on every change. */
  private compiled: Array<{ id: string; matches: PathMatcher }> = [];
  private readonly hits = new Map<string, number>();
  private readonly configRules: IgnoreRule[];
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(DEBUG_OPTIONS) private readonly options: ResolvedDebugOptions,
    @Inject(DEBUG_STORAGE) private readonly storage: DebugStorage,
  ) {
    this.configRules = this.options.ignore.map((pattern, index) => ({
      id: `config:${index}`,
      pattern: pattern instanceof RegExp ? String(pattern) : pattern,
      enabled: true,
      createdAt: new Date(0).toISOString(),
      source: 'config' as const,
      note: pattern instanceof RegExp ? 'RegExp from forRoot({ ignore })' : undefined,
    }));
  }

  /** True when the panel is allowed to add/edit rules at all. */
  get editable(): boolean {
    return this.options.enabled && this.options.runtimeIgnore;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.editable) return;
    await this.reload();
    if (typeof this.storage.loadIgnoreRules !== 'function') return;
    // Only a shared store can change behind our back, and only that case needs
    // polling. unref() so a debug timer never keeps the process alive.
    this.refreshTimer = setInterval(() => void this.reload(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /**
   * The hot path: does any enabled runtime rule cover this path? Config rules
   * are matched by the interceptor's own compiled list, so they're skipped here
   * to avoid testing them twice.
   */
  matches(path: string): boolean {
    if (this.compiled.length === 0) return false;
    for (const rule of this.compiled) {
      if (!rule.matches(path)) continue;
      this.hits.set(rule.id, (this.hits.get(rule.id) ?? 0) + 1);
      return true;
    }
    return false;
  }

  /** Every rule the panel should show — runtime first, then config. */
  list(): IgnoreRule[] {
    const runtime = this.runtimeRules.map((rule) => ({ ...rule, hits: this.hits.get(rule.id) ?? 0 }));
    return [...runtime, ...this.configRules];
  }

  async add(input: IgnoreRuleInput): Promise<IgnoreRuleResult> {
    if (!this.editable) return { ok: false, error: 'Runtime ignore rules are disabled.' };
    const pattern = normalizeIgnorePattern(input.pattern);
    const invalid = validateIgnorePattern(pattern);
    if (invalid) return { ok: false, error: invalid };
    if (this.runtimeRules.some((rule) => rule.pattern === pattern)) {
      return { ok: false, error: `"${pattern}" is already in the list.` };
    }
    if (this.runtimeRules.length >= 100) {
      return { ok: false, error: 'Rule limit reached (100).' };
    }
    const rule: IgnoreRule = {
      id: randomUUID(),
      pattern,
      note: noteOf(input.note),
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      createdAt: new Date().toISOString(),
      source: 'runtime',
    };
    this.runtimeRules = [rule, ...this.runtimeRules];
    await this.commit();
    return { ok: true, rule };
  }

  async update(id: string, input: IgnoreRuleInput): Promise<IgnoreRuleResult> {
    if (!this.editable) return { ok: false, error: 'Runtime ignore rules are disabled.' };
    const index = this.runtimeRules.findIndex((rule) => rule.id === id);
    if (index < 0) return { ok: false, error: 'Rule not found.' };
    const current = this.runtimeRules[index]!;
    const next: IgnoreRule = { ...current };

    if (input.pattern !== undefined) {
      const pattern = normalizeIgnorePattern(input.pattern);
      const invalid = validateIgnorePattern(pattern);
      if (invalid) return { ok: false, error: invalid };
      if (this.runtimeRules.some((rule) => rule.id !== id && rule.pattern === pattern)) {
        return { ok: false, error: `"${pattern}" is already in the list.` };
      }
      next.pattern = pattern;
    }
    if (input.note !== undefined) next.note = noteOf(input.note);
    if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);

    this.runtimeRules = this.runtimeRules.map((rule, i) => (i === index ? next : rule));
    await this.commit();
    return { ok: true, rule: next };
  }

  async remove(id: string): Promise<IgnoreRuleResult> {
    if (!this.editable) return { ok: false, error: 'Runtime ignore rules are disabled.' };
    const rule = this.runtimeRules.find((item) => item.id === id);
    if (!rule) return { ok: false, error: 'Rule not found.' };
    this.runtimeRules = this.runtimeRules.filter((item) => item.id !== id);
    this.hits.delete(id);
    await this.commit();
    return { ok: true, rule };
  }

  /** Re-read the shared store and recompile. Never throws — a blip just keeps the current snapshot. */
  private async reload(): Promise<void> {
    if (typeof this.storage.loadIgnoreRules !== 'function') {
      this.recompile();
      return;
    }
    try {
      const stored = await this.storage.loadIgnoreRules();
      this.runtimeRules = sanitize(stored);
      this.recompile();
    } catch (error) {
      this.logger.warn(`Could not load ignore rules: ${String(error)}`);
    }
  }

  /** Apply a local change immediately, then persist it. */
  private async commit(): Promise<void> {
    this.recompile();
    if (typeof this.storage.saveIgnoreRules !== 'function') return;
    try {
      await this.storage.saveIgnoreRules(this.runtimeRules.map(stripHits));
    } catch (error) {
      this.logger.warn(`Could not persist ignore rules: ${String(error)}`);
    }
  }

  private recompile(): void {
    const next: Array<{ id: string; matches: PathMatcher }> = [];
    for (const rule of this.runtimeRules) {
      if (!rule.enabled) continue;
      try {
        next.push({ id: rule.id, matches: compileIgnoreMatcher(rule.pattern) });
      } catch {
        /* an uncompilable pattern is skipped rather than breaking every request */
      }
    }
    this.compiled = next;
  }
}

function noteOf(value: unknown): string | undefined {
  const note = String(value ?? '').trim().slice(0, 120);
  return note.length > 0 ? note : undefined;
}

function stripHits(rule: IgnoreRule): IgnoreRule {
  const { hits: _hits, ...rest } = rule;
  return rest;
}

/**
 * Rules come back from storage as untrusted JSON (another process, an older
 * version, a hand-edited key), so every field is re-checked before it can reach
 * the request path.
 */
function sanitize(input: unknown): IgnoreRule[] {
  if (!Array.isArray(input)) return [];
  const out: IgnoreRule[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const pattern = normalizeIgnorePattern(raw.pattern);
    if (validateIgnorePattern(pattern)) continue;
    out.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
      pattern,
      note: noteOf(raw.note),
      enabled: raw.enabled !== false,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      source: 'runtime',
    });
    if (out.length >= 100) break;
  }
  return out;
}
