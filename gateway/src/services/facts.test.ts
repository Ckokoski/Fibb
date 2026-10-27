import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FactsStore } from './facts.js';

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
});
