import { describe, it, expect } from 'vitest';
import {
  PLAYS, PLAY_CATEGORIES, availability, renderPlay, pickPlay,
  type Play, type PlayContext, type PlayCategory,
} from './playbook.js';
import { validateCronExpression } from './cron-scheduler.js';

const bare: PlayContext = { hasGoogle: false, hasBrowser: false };
const full: PlayContext = { bookTitle: 'The Salt Road', chapter: 7, hasGoogle: true, hasBrowser: true };
const byId = (id: string): Play => {
  const p = PLAYS.find(x => x.id === id);
  if (!p) throw new Error(`no play ${id}`);
  return p;
};
const strings = (p: Play): string[] => [
  p.title, p.blurb, p.label,
  ...(p.action.kind === 'say' ? [p.action.say] : [p.action.title, p.action.detail]),
];

const REQUIRED: Record<PlayCategory, string[]> = {
  Story: ['consistency-check', 'plot-hole-pass', 'book-dashboard', 'character-sheets', 'chapter-summaries',
    'opening-line-workshop', 'title-brainstorm', 'scene-ideas', 'series-bible-start', 'pacing-check'],
  Research: ['comp-titles', 'setting-research', 'fact-check-chapter', 'name-ideas', 'genre-expectations'],
  Marketing: ['back-cover-blurb', 'newsletter-draft', 'social-week', 'query-letter', 'launch-checklist', 'reader-persona'],
  Routine: ['morning-recap', 'weekly-review', 'streak-nudge', 'read-last-scene'],
  'Email and calendar': ['inbox-triage', 'writing-time-this-week', 'follow-ups'],
};

describe('PLAYS', () => {
  it('has at least 24 plays with unique kebab-case ids, every required one in its category', () => {
    expect(PLAYS.length).toBeGreaterThanOrEqual(24);
    expect(new Set(PLAYS.map(p => p.id)).size).toBe(PLAYS.length);
    for (const p of PLAYS) expect(p.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    for (const [category, ids] of Object.entries(REQUIRED)) {
      for (const id of ids) expect(byId(id).category, id).toBe(category);
    }
    for (const p of PLAYS) expect(PLAY_CATEGORIES, p.id).toContain(p.category);
  });

  it.each(PLAYS.map(p => [p.id, p] as const))('%s: shape and length rules', (_id, p) => {
    expect(p.title.length).toBeGreaterThan(3);
    expect(p.title.length).toBeLessThan(48);
    expect(p.title).not.toMatch(/[.!]$/);
    expect(p.blurb.length).toBeGreaterThan(20);
    expect(p.blurb.length).toBeLessThan(110);
    // One sentence: a single full stop, at the end.
    expect(p.blurb).toMatch(/^[A-Z][^.!?]*\.$/);
    expect(p.label.length).toBeGreaterThan(1);
    expect(p.label.length).toBeLessThanOrEqual(20);
    expect(Array.isArray(p.needs)).toBe(true);
    for (const need of p.needs) expect(['book', 'google', 'browser']).toContain(need);
    expect(new Set(p.needs).size).toBe(p.needs.length);
    expect(['task', 'schedule', 'say']).toContain(p.action.kind);
    if (p.action.kind === 'say') {
      expect(p.action.say.trim().length).toBeGreaterThan(10);
      expect(p.action.say.length).toBeLessThan(200);
    } else {
      expect(p.action.title.trim().length).toBeGreaterThan(3);
      expect(p.action.title.length).toBeLessThan(60);
      expect(p.action.detail.length).toBeGreaterThan(150);
      expect(p.action.detail.length).toBeLessThan(4000);
      // Asks rather than guesses, and produces Markdown.
      expect(p.action.detail).toContain('Questions for you');
      expect(p.action.detail).toContain('Markdown');
    }
  });

  it('uses plain language: no em-dashes or en-dashes, no hype words, no other placeholders', () => {
    for (const p of PLAYS) {
      for (const text of strings(p)) {
        expect(text, p.id).not.toMatch(/[—–]/);
        expect(text.toLowerCase(), p.id).not.toMatch(/delve|unlock|supercharge|game-changer|game changer/);
        expect(text.replace(/\{book\}/g, ''), p.id).not.toMatch(/[{}]/);
      }
    }
  });

  it('work orders tell Fibb to use its tools', () => {
    for (const p of PLAYS) {
      if (p.action.kind !== 'task') continue;
      const d = p.action.detail;
      if (p.needs.includes('browser')) {
        expect(d, p.id).toContain('Use your browser to look things up and cite the page titles and addresses you used');
      }
      if (p.needs.includes('google')) expect(d, p.id).toMatch(/Gmail tools|Google Calendar tools|Search the author's Google Drive/);
      else if (d.includes('{book}')) expect(d, p.id).toContain("search the author's Google Drive for the manuscript and notes first");
    }
  });

  it('declares the needs the brief asks for', () => {
    expect(byId('comp-titles').needs).toEqual(['browser']);
    expect([...byId('setting-research').needs].sort()).toEqual(['book', 'browser']);
    expect(byId('fact-check-chapter').needs).toEqual(['browser']);
    for (const id of ['inbox-triage', 'writing-time-this-week', 'follow-ups']) expect(byId(id).needs).toContain('google');
    for (const p of PLAYS.filter(x => x.category === 'Email and calendar')) expect(p.needs).toContain('google');
  });

  it('the specific plays do what the brief says', () => {
    const detail = (id: string) => { const a = byId(id).action; return a.kind === 'say' ? '' : a.detail; };
    expect(detail('consistency-check')).toMatch(/names/);
    expect(detail('consistency-check')).toMatch(/ages/);
    expect(detail('consistency-check')).toMatch(/eye/);
    expect(detail('consistency-check')).toMatch(/timeline/);
    expect(detail('consistency-check')).toMatch(/places/);
    expect(detail('consistency-check')).toMatch(/who knows what/);
    expect(detail('consistency-check')).toMatch(/table of contradictions/);
    for (const part of ['Progress', 'Cast list', 'Open threads', 'Promises made to the reader', 'Next three steps']) {
      expect(detail('book-dashboard')).toContain(part);
    }
    expect(detail('comp-titles')).toMatch(/eight comparable titles/);
    expect(detail('comp-titles')).toMatch(/why it is comparable/);
    expect(detail('back-cover-blurb')).toMatch(/three versions/);
    expect(detail('newsletter-draft')).toMatch(/Gmail draft/);
    expect(detail('newsletter-draft')).toMatch(/approval/);
    expect(detail('social-week')).toMatch(/seven social posts/);
    expect(detail('inbox-triage')).toMatch(/last 3 days/);
    expect(detail('inbox-triage')).toMatch(/approval/);
    expect(detail('writing-time-this-week')).toMatch(/three writing sessions/);
    expect(detail('follow-ups')).toMatch(/more than 5 days/);
    expect(byId('morning-recap').action).toMatchObject({ kind: 'schedule', cron: '30 7 * * *' });
    expect(detail('morning-recap')).toMatch(/where they left off/);
    expect(detail('morning-recap')).toMatch(/one specific question/);
    expect(byId('weekly-review').action).toMatchObject({ kind: 'schedule', cron: '0 17 * * 5' });
    expect(byId('streak-nudge').action).toMatchObject({ kind: 'schedule', cron: '0 20 * * *' });
    expect(detail('streak-nudge')).toMatch(/Only a short encouragement plus one tiny next step/);
    expect(byId('read-last-scene').action).toEqual({ kind: 'say', say: 'Read me the last scene aloud.' });
    expect(byId('opening-line-workshop').action.kind).toBe('say');
    expect(byId('scene-ideas').action.kind).toBe('say');
  });

  it('every cron is a valid schedule and schedule names are unique', () => {
    const names: string[] = [];
    for (const p of PLAYS) {
      if (p.action.kind !== 'schedule') continue;
      expect(validateCronExpression(p.action.cron).valid, p.id).toBe(true);
      expect(p.action.title).not.toContain('{book}'); // the job name must not change with the book
      names.push(p.action.title);
    }
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('availability', () => {
  it('a play with no needs is always available', () => {
    expect(availability(byId('read-last-scene'), bare)).toEqual({ available: true });
  });
  it('reports the first missing need', () => {
    expect(availability(byId('consistency-check'), bare)).toEqual({ available: false, missing: 'book' });
    expect(availability(byId('consistency-check'), { ...bare, bookTitle: '   ' })).toEqual({ available: false, missing: 'book' });
    expect(availability(byId('consistency-check'), { ...bare, bookTitle: 'Tide' })).toEqual({ available: true });
    expect(availability(byId('inbox-triage'), bare)).toEqual({ available: false, missing: 'google' });
    expect(availability(byId('inbox-triage'), { ...bare, hasGoogle: true })).toEqual({ available: true });
    expect(availability(byId('comp-titles'), bare)).toEqual({ available: false, missing: 'browser' });
    expect(availability(byId('setting-research'), { ...bare, bookTitle: 'Tide' })).toEqual({ available: false, missing: 'browser' });
    expect(availability(byId('setting-research'), { ...bare, hasBrowser: true })).toEqual({ available: false, missing: 'book' });
    expect(availability(byId('setting-research'), full)).toEqual({ available: true });
  });
  it('everything is available with a book, Google and a browser', () => {
    for (const p of PLAYS) expect(availability(p, full), p.id).toEqual({ available: true });
  });
});

describe('renderPlay', () => {
  it('fills the book title in everywhere and leaves no placeholder', () => {
    for (const p of PLAYS) {
      const r = renderPlay(p, full);
      for (const text of strings(r)) expect(text, p.id).not.toContain('{book}');
      expect(r.id).toBe(p.id);
      expect(r.category).toBe(p.category);
      expect(r.needs).toEqual(p.needs);
    }
    const r = renderPlay(byId('consistency-check'), full);
    expect(r.blurb).toBe('I can comb The Salt Road for contradictions in names, ages, eye colors, dates and places.');
    expect(r.action).toMatchObject({ kind: 'task', title: 'Consistency check: The Salt Road' });
    expect((r.action as any).detail).toContain('Run a story consistency check on "The Salt Road".');
    expect((r.action as any).detail).toContain('The author is currently on chapter 7.');
    expect(renderPlay(byId('scene-ideas'), full).action).toEqual({ kind: 'say', say: 'Pitch me five ways the next scene of The Salt Road could go, from safe to surprising.' });
  });

  it('without a book it reads naturally for whoever is speaking', () => {
    for (const p of PLAYS) {
      for (const text of strings(renderPlay(p, bare))) expect(text, p.id).not.toContain('{book}');
    }
    const t = renderPlay(byId('title-brainstorm'), bare);
    expect(t.blurb).toBe('I can come up with thirty title ideas for your book and pick my five favorites with reasons.');
    expect(t.action).toMatchObject({ title: 'Title ideas for your book' });
    expect((t.action as any).detail).toContain('Brainstorm titles for their current book.');
    expect((t.action as any).detail).not.toContain('currently on chapter');
    expect(renderPlay(byId('scene-ideas'), bare).action).toEqual({ kind: 'say', say: 'Pitch me five ways the next scene of my book could go, from safe to surprising.' });
  });

  it('does not change the original and keeps schedules as they are', () => {
    const before = JSON.stringify(PLAYS);
    const r = renderPlay(byId('morning-recap'), full);
    expect(r.action).toMatchObject({ kind: 'schedule', title: 'Morning recap', cron: '30 7 * * *' });
    r.needs.push('google');
    expect(JSON.stringify(PLAYS)).toBe(before);
  });

  it('rendered blurbs stay short enough for a notice, even with a long title', () => {
    const long: PlayContext = { ...full, bookTitle: 'T'.repeat(60) };
    for (const p of PLAYS) expect(`An idea: ${renderPlay(p, long).blurb} Want me to?`.length, p.id).toBeLessThanOrEqual(220);
  });
});

describe('pickPlay', () => {
  const none = new Set<string>();

  it('only picks available plays that are not excluded', () => {
    for (let seed = 0; seed < 100; seed++) {
      const p = pickPlay(PLAYS, bare, { excludeIds: none, seed })!;
      expect(availability(p, bare).available).toBe(true);
    }
    const exclude = new Set(PLAYS.filter(p => p.id !== 'read-last-scene').map(p => p.id));
    for (let seed = 0; seed < 10; seed++) expect(pickPlay(PLAYS, full, { excludeIds: exclude, seed })!.id).toBe('read-last-scene');
    expect(pickPlay(PLAYS, full, { excludeIds: new Set(PLAYS.map(p => p.id)), seed: 3 })).toBeNull();
    expect(pickPlay([], full, { excludeIds: none, seed: 0 })).toBeNull();
    // Only Google plays left, and no Google.
    const onlyMail = new Set(PLAYS.filter(p => p.category !== 'Email and calendar').map(p => p.id));
    expect(pickPlay(PLAYS, bare, { excludeIds: onlyMail, seed: 0 })).toBeNull();
  });

  it('is deterministic for a given seed', () => {
    for (let seed = 0; seed < 40; seed++) {
      expect(pickPlay(PLAYS, full, { excludeIds: none, seed })).toBe(pickPlay(PLAYS, full, { excludeIds: none, seed }));
    }
    expect(pickPlay(PLAYS, full, { excludeIds: none, seed: 0 })!.id).toBe('consistency-check');
    expect(pickPlay(PLAYS, full, { excludeIds: none, seed: Number.NaN })!.id).toBe('consistency-check');
    expect(pickPlay(PLAYS, full, { excludeIds: none, seed: -1 })).toBe(pickPlay(PLAYS, full, { excludeIds: none, seed: 1 }));
  });

  it('rotates across categories: consecutive seeds never repeat a category when another is possible', () => {
    for (const ctx of [full, bare, { ...bare, bookTitle: 'Tide' }]) {
      let last: PlayCategory | undefined;
      const seen = new Set<string>();
      for (let seed = 0; seed < 120; seed++) {
        const p = pickPlay(PLAYS, ctx, { excludeIds: none, seed })!;
        expect(p.category).not.toBe(last);
        last = p.category;
        seen.add(p.id);
      }
      // Every available play gets its turn.
      expect(seen.size).toBe(PLAYS.filter(p => availability(p, ctx).available).length);
    }
  });

  it('visits the categories in order', () => {
    expect([0, 1, 2, 3, 4].map(seed => pickPlay(PLAYS, full, { excludeIds: none, seed })!.category)).toEqual(PLAY_CATEGORIES);
    // Without Google the mail plays drop out and four categories take turns.
    expect([0, 1, 2, 3, 4].map(seed => pickPlay(PLAYS, bare, { excludeIds: none, seed })!.category))
      .toEqual(['Story', 'Research', 'Marketing', 'Routine', 'Story']);
  });

  it('avoidCategory skips the previous category unless it is the only one left', () => {
    for (let seed = 0; seed < 30; seed++) {
      expect(pickPlay(PLAYS, full, { excludeIds: none, seed, avoidCategory: 'Story' })!.category).not.toBe('Story');
    }
    const onlyRoutine = new Set(PLAYS.filter(p => p.category !== 'Routine').map(p => p.id));
    expect(pickPlay(PLAYS, full, { excludeIds: onlyRoutine, seed: 0, avoidCategory: 'Routine' })!.category).toBe('Routine');
  });
});
