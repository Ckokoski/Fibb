import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rename } from 'fs/promises';
import { FactsStore } from './facts.js';

// Wrap rename so one test can make it fail; everything else passes through.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let dir: string;
let store: FactsStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-facts-'));
  store = new FactsStore(dir);
  await store.initialize();
});
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('FactsStore.merge', () => {
  it('sets the name and merges books by title (case-insensitive)', async () => {
    await store.merge({ name: 'Chris', books: [{ title: 'The Iron Throne', stage: 'drafting' }] });
    await store.merge({ books: [{ title: 'the iron throne', chapter: 10 }] });
    const f = store.get();
    expect(f.name).toBe('Chris');
    expect(f.books).toHaveLength(1);
    expect(f.books[0]).toMatchObject({ title: 'The Iron Throne', stage: 'drafting', chapter: 10 });
  });

  it('merges people by name, dedupes preferences, keeps the last 10 recents', async () => {
    await store.merge({ people: [{ name: 'Mara', kind: 'character', notes: "can't swim" }], preferences: ['hates adverbs'] });
    await store.merge({ people: [{ name: 'mara', kind: 'character', book: 'The Iron Throne' }], preferences: ['hates adverbs', 'morning briefs at 7'] });
    for (let i = 0; i < 12; i++) await store.merge({ recent: [`event ${i}`] });
    const f = store.get();
    expect(f.people).toHaveLength(1);
    expect(f.people[0]).toMatchObject({ name: 'Mara', book: 'The Iron Throne', notes: "can't swim" });
    expect(f.preferences).toEqual(['hates adverbs', 'morning briefs at 7']);
    expect(f.recent).toHaveLength(10);
    expect(f.recent[9]).toMatch(/event 11$/);
  });

  it('persists across instances', async () => {
    await store.merge({ name: 'Chris' });
    const again = new FactsStore(dir);
    await again.initialize();
    expect(again.get().name).toBe('Chris');
  });

  it('writes atomically: no .tmp file is left behind', async () => {
    await store.merge({ name: 'Chris' });
    expect(existsSync(join(dir, 'facts.json.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'facts.json'))).toBe(true);
  });

  it('tolerates malformed input without throwing', async () => {
    await expect(store.merge({
      books: 'nope',
      people: [{ name: 42 }, { name: 'Dev', kind: 'character' }],
      preferences: ['x', 7],
      recent: { a: 1 },
    } as any)).resolves.toBeUndefined();
    const f = store.get();
    expect(f.people.map(p => p.name)).toEqual(['Dev']);
    expect(f.preferences).toEqual(['x']);
    expect(f.recent).toEqual([]);
    expect(f.books).toEqual([]);
  });

  it('drops a non-finite chapter instead of storing NaN', async () => {
    await store.merge({ books: [{ title: 'Dagger Song', chapter: 'soon' as any }] });
    expect(store.get().books[0]).not.toHaveProperty('chapter');
  });

  it('dedupes recent entries by text, ignoring the date prefix', async () => {
    await store.merge({ recent: ['stuck on ferry scene'] });
    await store.merge({ recent: ['stuck on ferry scene'] });
    expect(store.get().recent).toHaveLength(1);
  });
});

describe('FactsStore.initialize corruption handling', () => {
  it('quarantines an unreadable facts.json and starts empty', async () => {
    writeFileSync(join(dir, 'facts.json'), '<<garbage>>');
    const fresh = new FactsStore(dir);
    await fresh.initialize();
    expect(fresh.get().books).toEqual([]);
    expect(readdirSync(dir).some(f => /^facts\.json\.corrupt-/.test(f))).toBe(true);
  });

  it('normalizes loaded data whose array fields are the wrong shape', async () => {
    writeFileSync(join(dir, 'facts.json'), JSON.stringify({ name: 'Chris', books: 'bad', people: [{ kind: 'x' }], preferences: [1, 'ok'], recent: null }));
    const fresh = new FactsStore(dir);
    await fresh.initialize();
    const f = fresh.get();
    expect(f.name).toBe('Chris');
    expect(f.books).toEqual([]);
    expect(f.people).toEqual([]);
    expect(f.preferences).toEqual(['ok']);
    expect(f.recent).toEqual([]);
  });
});

describe('FactsStore.render', () => {
  it('asks for the name when unknown', () => {
    expect(store.render()).toMatch(/don't know the author's name yet/i);
  });

  it('renders known facts under budget', async () => {
    await store.merge({
      name: 'Chris',
      books: [{ title: 'The Iron Throne', stage: 'drafting', chapter: 10, goal: 'finish by Dec 1' }],
      people: [{ name: 'Mara', kind: 'character', notes: "can't swim" }],
      preferences: ['hates adverbs'],
      recent: ['stuck on ferry scene'],
    });
    const out = store.render(1500);
    expect(out).toContain('Chris');
    expect(out).toContain('The Iron Throne');
    expect(out).toContain('Mara');
    expect(out.length).toBeLessThanOrEqual(1500);
  });
});

describe('FactsStore.forget', () => {
  it('removes any fact containing the phrase', async () => {
    await store.merge({ preferences: ['hates adverbs', 'likes tea'], people: [{ name: 'Dev', kind: 'character' }] });
    const removed = await store.forget('adverbs');
    expect(removed).toBe(1);
    expect(store.get().preferences).toEqual(['likes tea']);
    expect(await store.forget('Dev')).toBe(1);
    expect(store.get().people).toEqual([]);
  });

  it('ignores phrases shorter than 3 characters', async () => {
    await store.merge({ preferences: ['hates adverbs'] });
    expect(await store.forget('a')).toBe(0);
    expect(store.get().preferences).toEqual(['hates adverbs']);
  });
});

describe('FactsStore write safety', () => {
  it('rejects and leaves no temp file when rename fails', async () => {
    vi.mocked(rename).mockRejectedValueOnce(new Error('disk full'));
    await expect(store.merge({ name: 'Chris' })).rejects.toThrow('disk full');
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('serializes overlapping merges so every write lands on disk', async () => {
    await Promise.all([1, 2, 3, 4, 5].map(i => store.merge({ preferences: [`pref ${i}`] })));
    const fresh = new FactsStore(dir);
    await fresh.initialize();
    const prefs = fresh.get().preferences;
    expect(prefs).toHaveLength(5);
    for (let i = 1; i <= 5; i++) expect(prefs).toContain(`pref ${i}`);
  });
});

describe('FactsStore.extractFromTurn', () => {
  it('parses the model JSON (even wrapped in a code fence) and merges it', async () => {
    const fakeComplete = async () => '```json\n{"name":"Chris","books":[{"title":"Dagger Song","stage":"outlining"}]}\n```';
    await store.extractFromTurn("I'm Chris, outlining Dagger Song", 'Nice to meet you', fakeComplete);
    expect(store.get().name).toBe('Chris');
    expect(store.get().books[0].title).toBe('Dagger Song');
  });

  it('ignores garbage output', async () => {
    await store.extractFromTurn('hi', 'hello', async () => 'no json here');
    expect(store.get().name).toBeUndefined();
  });

  it('rejects an array result without throwing or changing facts', async () => {
    await store.merge({ name: 'Chris' });
    const before = store.get();
    await expect(store.extractFromTurn('hi', 'yo', async () => '[1,2]')).resolves.toBeUndefined();
    expect(store.get()).toEqual(before);
  });
});
