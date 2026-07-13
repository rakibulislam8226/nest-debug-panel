import type { DebugStorage } from '../interfaces/storage.interface';
import { toRequestSummary } from '../interfaces/profile.interface';
import type { RequestProfile, RequestSummary } from '../interfaces/profile.interface';

/**
 * Default storage: an in-memory ring buffer. Keeps at most `maxRequests`
 * profiles; the oldest are evicted automatically. Relies on Map preserving
 * insertion order.
 */
export class MemoryStorage implements DebugStorage {
  private readonly profiles = new Map<string, RequestProfile>();

  constructor(private readonly maxRequests = 200) {}

  save(profile: RequestProfile): void {
    if (this.profiles.has(profile.id)) this.profiles.delete(profile.id);
    this.profiles.set(profile.id, profile);
    while (this.profiles.size > this.maxRequests) {
      const oldest = this.profiles.keys().next().value;
      if (oldest === undefined) break;
      this.profiles.delete(oldest);
    }
  }

  find(id: string): RequestProfile | undefined {
    return this.profiles.get(id);
  }

  list(): RequestSummary[] {
    return [...this.profiles.values()].reverse().map(toRequestSummary);
  }

  clear(): void {
    this.profiles.clear();
  }

  count(): number {
    return this.profiles.size;
  }
}
