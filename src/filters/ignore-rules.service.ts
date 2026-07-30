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

/**
 * How often a *shared* store is re-read, so a rule added on one instance reaches
 * the others. Rules change by hand, once in a while — polling faster than this
 * buys nothing and costs a Redis round trip per tick, per process, forever.
 */
const REFRESH_INTERVAL_MS = 15_000;

export interface IgnoreRuleResult {
  ok: boolean;
  /** Present when `ok` is false — safe to show in the UI. */
  error?: string;
  rule?: IgnoreRule;
}

/**
 * Owns the endpoint-ignore rules the dashboard manages at runtime.
 *
 * Matching runs on the hot path of every request, so it does exactly one thing:
 * walk a pre-compiled array of matchers and return on the first hit. No
 * counters, no bookkeeping, nothing written anywhere — an ignored request costs
 * a few string comparisons and is gone.
 *
 * Everything else is arranged to stay idle. Writes go to storage, and a
 * background refresh pulls other instances' changes in — but only when the store
 * is actually shared, so the default in-memory setup does no periodic work at
 * all. When a refresh finds the rules unchanged (the normal case) it returns
 * without rebuilding anything, so identical patterns aren't recompiled into new
 * RegExps every tick for the life of the process.
 *
 * Rules from `forRoot({ ignore })` are listed here too, marked `config`, so the
 * panel can show every reason a request might be missing — but they stay
 * read-only, since the code that declared them is the source of truth.
 */
@Injectable()
export class IgnoreRulesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('NestDebugPanel');
  private runtimeRules: IgnoreRule[] = [];
  /** Compiled matchers for the enabled runtime rules, rebuilt only when they change. */
  private compiled: PathMatcher[] = [];
  /** Fingerprint of the loaded rules, so an unchanged refresh can bail out early. */
  private signature = '';
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
    // Only a shared store can change behind our back, so only that case is worth
    // polling — with the default in-memory driver this service goes quiet after
    // bootstrap. unref() so a debug timer never keeps the process alive.
    if (typeof this.storage.loadIgnoreRules !== 'function' || !this.storage.sharedIgnoreRules) return;
    this.refreshTimer = setInterval(() => void this.reload(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /**
   * The hot path: does any enabled runtime rule cover this path? Config rules are
   * matched by the interceptor's own compiled list, so they're skipped here to
   * avoid testing them twice.
   */
  matches(path: string): boolean {
    for (const matches of this.compiled) {
      if (matches(path)) return true;
    }
    return false;
  }

  /** Every rule the panel should show — runtime first, then config. */
  list(): IgnoreRule[] {
    return [...this.runtimeRules, ...this.configRules];
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
      const rules = sanitize(await this.storage.loadIgnoreRules());
      const signature = signatureOf(rules);
      if (signature === this.signature) return; // nothing changed — keep the compiled snapshot
      this.runtimeRules = rules;
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
      await this.storage.saveIgnoreRules(this.runtimeRules);
    } catch (error) {
      this.logger.warn(`Could not persist ignore rules: ${String(error)}`);
    }
  }

  private recompile(): void {
    const next: PathMatcher[] = [];
    for (const rule of this.runtimeRules) {
      if (!rule.enabled) continue;
      try {
        next.push(compileIgnoreMatcher(rule.pattern));
      } catch {
        /* an uncompilable pattern is skipped rather than breaking every request */
      }
    }
    this.compiled = next;
    this.signature = signatureOf(this.runtimeRules);
  }
}

/**
 * Cheap fingerprint of the rule set — everything a refresh could meaningfully
 * change. Comparing this is what lets an unchanged poll cost one string build
 * instead of a full sanitize-and-recompile.
 */
function signatureOf(rules: IgnoreRule[]): string {
  let out = '';
  for (const rule of rules) out += `${rule.id}\u0000${rule.pattern}\u0000${rule.enabled}\u0000${rule.note ?? ''}\u0001`;
  return out;
}

function noteOf(value: unknown): string | undefined {
  const note = String(value ?? '').trim().slice(0, 120);
  return note.length > 0 ? note : undefined;
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
