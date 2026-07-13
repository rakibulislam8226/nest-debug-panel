import { MemoryStorage } from '../src/storage/memory.storage';
import type { RequestProfile } from '../src/interfaces/profile.interface';

function makeProfile(id: string): RequestProfile {
  return {
    id,
    method: 'GET',
    url: `/things/${id}`,
    queryParams: {},
    routeParams: {},
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    sql: [],
    redis: [],
    http: [],
    timeline: [],
    custom: {},
  };
}

describe('MemoryStorage', () => {
  it('saves and finds profiles', () => {
    const storage = new MemoryStorage(10);
    storage.save(makeProfile('a'));
    expect(storage.find('a')?.id).toBe('a');
    expect(storage.count()).toBe(1);
  });

  it('lists newest first', () => {
    const storage = new MemoryStorage(10);
    storage.save(makeProfile('a'));
    storage.save(makeProfile('b'));
    storage.save(makeProfile('c'));
    expect(storage.list().map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('evicts oldest beyond maxRequests', () => {
    const storage = new MemoryStorage(3);
    for (const id of ['a', 'b', 'c', 'd', 'e']) storage.save(makeProfile(id));
    expect(storage.count()).toBe(3);
    expect(storage.find('a')).toBeUndefined();
    expect(storage.find('b')).toBeUndefined();
    expect(storage.list().map((s) => s.id)).toEqual(['e', 'd', 'c']);
  });

  it('clears everything', () => {
    const storage = new MemoryStorage(10);
    storage.save(makeProfile('a'));
    storage.clear();
    expect(storage.count()).toBe(0);
    expect(storage.list()).toEqual([]);
  });
});
