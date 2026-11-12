/**
 * The playbook fallback, the back-off rules, on-demand suggestions and plays,
 * and rules e (softened), h and i. The older behaviour is in notices.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  NoticeService, summarizeUsage, candidateNotices, minGapMs, isQuietHour, playCandidate, MAX_NOTICE_CHARS,
  type UsageInput, type UsageSummary, type NoticeDeps,
} from './notices.js';
import { PLAYS, PLAY_CATEGORIES, availability, type PlayContext } from './playbook.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Local noon, so hour-of-day maths is the same in every time zone.
const NOW = new Date(2026, 10, 12, 12, 0, 0);
const plus = (ms: number, from: Date = NOW) => new Date(from.getTime() + ms);
const atHour = (hour: number, minute = 0, dayOffset = 0) => new Date(2026, 10, 12 + dayOffset, hour, minute, 0);
const empty = (): UsageInput => ({ messages: [], tasks: [], schedules: [], writingDays: {}, facts: {} });
const quiet = (): UsageSummary => summarizeUsage(empty(), NOW);
const BOOK = { books: [{ title: 'The Salt Road', stage: 'drafting', chapter: 4 }] };
const playOf = (key: string) => PLAYS.find(p => `play:${p.id}` === key)!;

let dir: string;
let usage: UsageInput;
let caps: { hasGoogle: boolean; hasBrowser: boolean };
let added: any[];
let jobs: any[];
let loads: number;
let polishCalls: string[];
let polishReply: ((user: string) => Promise<string>) | null;
let failTasks: boolean;

const deps = (over: Partial<NoticeDeps> = {}): NoticeDeps => ({
  loadUsage: async () => { loads++; return usage; },
  loadFacts: () => usage.facts,
  capabilities: () => caps,
  tasks: { add: async (input) => { if (failTasks) throw new Error('disk full'); added.push(input); return { id: `task-${added.length}`, ...input }; } },
  cron: { createJob: async (input) => { jobs.push(input); return { id: `cron-${jobs.length}`, ...input }; }, list: () => jobs },
  polish: async (_system, user) => { polishCalls.push(user); if (!polishReply) throw new Error('offline'); return polishReply(user); },
  ...over,
});
const make = async (over: Partial<NoticeDeps> = {}) => {
  const s = new NoticeService(dir, deps(over));
  await s.initialize();
  return s;
};
const stored = () => JSON.parse(readFileSync(join(dir, 'notices.json'), 'utf-8'));
const seed = (state: Record<string, any>) => writeFileSync(join(dir, 'notices.json'), JSON.stringify({ enabled: true, notices: [], dismissedKeys: {}, ...state }));
const lastKey = (): string => { const n = stored().notices; return n[n.length - 1].key; };
/** The plays the current context can do. */
const availableIds = (ctx: PlayContext) => PLAYS.filter(p => availability(p, ctx).available).map(p => p.id);
const BARE: PlayContext = { hasGoogle: false, hasBrowser: false };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-notices-playbook-'));
  usage = empty();
  caps = { hasGoogle: false, hasBrowser: false };
  added = []; jobs = []; loads = 0; polishCalls = []; polishReply = null; failTasks = false;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('back-off helpers', () => {
  it.each([[0, 20 * HOUR], [1, 20 * HOUR], [2, 3 * DAY], [3, 7 * DAY], [4, 7 * DAY], [50, 7 * DAY]])(
    'after %i dismissals in a row the minimum gap is %i ms', (n, gap) => { expect(minGapMs(n)).toBe(gap); },
  );
  it.each([[22, 0, true], [23, 30, true], [0, 0, true], [3, 0, true], [6, 59, true], [7, 0, false], [12, 0, false], [21, 59, false]])(
    '%i:%i quiet = %s', (h, m, expected) => { expect(isQuietHour(atHour(h, m))).toBe(expected); },
  );
});

describe('playbook fallback', () => {
  it('offers one idea when no usage rule has anything to say', async () => {
    const s = await make();
    const n = await s.generate(NOW);
    expect(n).not.toBeNull();
    expect(n!.text).toMatch(/^An idea: I can .+\. Want me to\?$|^An idea: We can .+\. Want me to\?$/);
    expect(n!.text.length).toBeLessThanOrEqual(MAX_NOTICE_CHARS);
    expect(n!.text).not.toMatch(/[—–]/);
    expect(Object.keys(n!.action!).sort()).toEqual(['kind', 'label']);
    const saved = stored();
    expect(saved.notices[0].key).toMatch(/^play:[a-z-]+$/);
    expect(saved.playSeq).toBe(1);
    expect(saved.lastGeneratedAt).toBe(NOW.toISOString());
    const play = playOf(saved.notices[0].key);
    expect(availability(play, BARE).available).toBe(true);
    expect(n!.action).toEqual({ label: play.label, kind: play.action.kind });
  });

  it('a usage rule still wins over the playbook', async () => {
    usage = { ...empty(), tasks: [{ id: 't', title: 'Outline', kind: 'task', source: 'app', when: 'tonight', status: 'review', createdAt: plus(-6 * DAY).toISOString(), finishedAt: plus(-5 * DAY).toISOString() }] };
    const s = await make();
    await s.generate(NOW);
    expect(lastKey()).toBe('review:waiting');
    expect(stored().playSeq).toBe(0);
  });

  it('every play makes a short, plain notice with the action built from the play', () => {
    const ctx: PlayContext = { bookTitle: 'The Salt Road', hasGoogle: true, hasBrowser: true };
    for (const play of PLAYS) {
      const c = playCandidate(play, ctx);
      expect(c.key).toBe(`play:${play.id}`);
      expect(c.text.length, play.id).toBeLessThanOrEqual(MAX_NOTICE_CHARS);
      expect(c.text.startsWith('An idea: ')).toBe(true);
      expect(c.text.endsWith(' Want me to?')).toBe(true);
      expect(c.action).toMatchObject({ label: play.label, kind: play.action.kind });
      expect(JSON.stringify(c)).not.toContain('{book}');
      expect(c.sensitive).toEqual(c.text.includes('The Salt Road') ? ['The Salt Road'] : undefined);
    }
    const long = playCandidate(PLAYS[0], { ...ctx, bookTitle: 'A very long working title that just keeps going on and on and on and on and on and on and on and on and on and on and on and on and on and on' });
    expect(long.text.length).toBeLessThanOrEqual(MAX_NOTICE_CHARS);
    expect(long.text).toContain('your book');
  });

  it('accepting a task idea queues it for tonight; a routine idea becomes a schedule', async () => {
    seed({ dismissedKeys: Object.fromEntries(availableIds(BARE).filter(id => id !== 'title-brainstorm').map(id => [`play:${id}`, '2026-11-12'])) });
    const s = await make();
    const n = await s.generate(NOW);
    expect(lastKey()).toBe('play:title-brainstorm');
    expect(await s.accept(n!.id, NOW)).toEqual({ ok: true, message: 'Queued for tonight: "Title ideas for your book".' });
    expect(added).toEqual([{ title: 'Title ideas for your book', kind: 'task', when: 'tonight', source: 'app', detail: expect.stringContaining('Questions for you') }]);

    rmSync(join(dir, 'notices.json'));
    seed({ dismissedKeys: Object.fromEntries(availableIds(BARE).filter(id => id !== 'morning-recap').map(id => [`play:${id}`, '2026-11-12'])) });
    const again = await make();
    const m = await again.generate(NOW);
    expect(m!.action).toEqual({ label: 'Set it up', kind: 'schedule' });
    expect(await again.accept(m!.id, NOW)).toEqual({ ok: true, message: 'Scheduled "Morning recap".' });
    expect(jobs).toEqual([{ name: 'Morning recap', schedule: '30 7 * * *', handler: 'queue-task', payload: { title: 'Morning recap', detail: expect.any(String) } }]);
  });

  it('the model polishes playbook ideas too, with the book title masked', async () => {
    usage = { ...empty(), facts: { name: 'Sam Rivers', ...BOOK } };
    polishReply = async () => 'Sam, here is a thought: I could comb [[1]] for contradictions in names, ages, eye colors, dates and places. Shall I?';
    const s = await make();
    const n = await s.generate(NOW);
    expect(lastKey()).toBe('play:consistency-check');
    expect(polishCalls).toHaveLength(1);
    expect(polishCalls[0]).toContain('[[1]]');
    expect(polishCalls[0]).toContain("Author's first name: Sam");
    expect(polishCalls[0].toLowerCase()).not.toContain('salt road');
    expect(polishCalls[0].toLowerCase()).not.toContain('rivers');
    expect(n!.text).toBe('Sam, here is a thought: I could comb The Salt Road for contradictions in names, ages, eye colors, dates and places. Shall I?');
  });

  it('takes turns between categories from one idea to the next', async () => {
    usage = { ...empty(), facts: BOOK };
    caps = { hasGoogle: false, hasBrowser: true };
    const s = await make();
    const cats: string[] = [];
    let when = NOW;
    for (let i = 0; i < 8; i++) {
      const n = await s.suggestNow(when);
      cats.push(playOf(lastKey()).category);
      await s.dismiss(n!.id, when);
      when = plus(HOUR, when);
    }
    expect(cats.slice(0, 6)).toEqual(['Story', 'Research', 'Marketing', 'Routine', 'Tools', 'Story']);
    for (let i = 1; i < cats.length; i++) expect(cats[i]).not.toBe(cats[i - 1]);
    expect(new Set(stored().notices.map((n: any) => n.key)).size).toBe(8);
  });
});

describe('playbook exclusions', () => {
  const others = (keep: string) => availableIds(BARE).filter(id => id !== keep);

  it('a play dismissed in the last 30 days is not offered; after that it may return', async () => {
    seed({ dismissedKeys: Object.fromEntries(others('social-week').map(id => [`play:${id}`, '2026-11-01'])) });
    const s = await make();
    await s.generate(NOW);
    expect(lastKey()).toBe('play:social-week');

    rmSync(join(dir, 'notices.json'));
    seed({ dismissedKeys: Object.fromEntries(availableIds(BARE).map(id => [`play:${id}`, '2026-11-01'])) });
    const all = await make();
    expect(await all.generate(NOW)).toBeNull();
    expect(await all.generate(plus(17 * DAY))).toBeNull(); // 28 days after the dismissals
    expect(await all.generate(plus(20 * DAY))).not.toBeNull(); // 31 days after
  });

  it('a play accepted through a notice is never offered again', async () => {
    const old = plus(-400 * DAY).toISOString();
    seed({ notices: others('reader-persona').map((id, i) => ({ id: `n${i}`, key: `play:${id}`, text: 'x', status: 'accepted', createdAt: old, decidedAt: old })) });
    const s = await make();
    await s.generate(NOW);
    expect(lastKey()).toBe('play:reader-persona');
    const n = s.list()[0];
    await s.accept(n.id, NOW);
    expect(await s.generate(plus(400 * DAY))).toBeNull();
  });

  it('a play run on demand is not offered for 14 days', async () => {
    const s = await make();
    for (const id of others('name-ideas')) expect((await s.runPlay(id, {}, NOW)).ok).toBe(true);
    await s.generate(NOW);
    expect(lastKey()).toBe('play:name-ideas');
    await s.dismiss(s.list()[0].id, NOW);
    expect(await s.generate(plus(13 * DAY))).toBeNull();
    // Schedules created on demand stay excluded (they exist); the rest return after 14 days.
    const back = await s.generate(plus(14 * DAY + HOUR));
    expect(back).not.toBeNull();
    expect(playOf(lastKey()).action.kind).not.toBe('schedule');
  });

  it('a routine that is already on the schedule is not offered', async () => {
    const dismissedKeys = Object.fromEntries(others('morning-recap').map(id => [`play:${id}`, '2026-11-12']));
    seed({ dismissedKeys });
    usage = { ...empty(), schedules: [{ name: 'Morning recap', handler: 'queue-task', schedule: '30 7 * * *' }] };
    expect(await (await make()).generate(NOW)).toBeNull();
    usage = empty();
    const s = await make();
    await s.generate(NOW);
    expect(lastKey()).toBe('play:morning-recap');
  });

  it('plays that need a book, Google or a browser wait until those exist', async () => {
    const s = await make();
    let when = NOW;
    const seen = new Set<string>();
    for (let i = 0; i < availableIds(BARE).length; i++) {
      const n = await s.suggestNow(when);
      seen.add(lastKey().slice(5));
      await s.dismiss(n!.id, when);
      when = plus(HOUR, when);
    }
    expect([...seen].sort()).toEqual(availableIds(BARE).sort());
    expect(await s.suggestNow(when)).toBeNull(); // nothing left that this author can use
    caps = { hasGoogle: true, hasBrowser: false };
    await s.suggestNow(when);
    expect(playOf(lastKey()).needs).toContain('google');
  });
});

describe('back-off', () => {
  it('spacing grows with dismissals in a row: 20 hours, then 3 days, then 7 days', async () => {
    const s = await make();
    const n1 = await s.generate(NOW);
    expect(n1).not.toBeNull();
    await s.dismiss(n1!.id, NOW); // 1 in a row
    expect(stored().consecutiveDismissals).toBe(1);
    expect(await s.generate(plus(20 * HOUR - 1000))).toBeNull();
    const t2 = plus(20 * HOUR + 1000); // 08:00 the next day
    const n2 = await s.generate(t2);
    expect(n2).not.toBeNull();

    await s.dismiss(n2!.id, t2); // 2 in a row
    expect(await s.generate(plus(21 * HOUR, t2))).toBeNull();
    expect(await s.generate(plus(3 * DAY - 1000, t2))).toBeNull();
    const t3 = plus(3 * DAY + 1000, t2);
    const n3 = await s.generate(t3);
    expect(n3).not.toBeNull();

    await s.dismiss(n3!.id, t3); // 3 in a row
    expect(await s.generate(plus(3 * DAY + 1000, t3))).toBeNull();
    expect(await s.generate(plus(7 * DAY - 1000, t3))).toBeNull();
    const t4 = plus(7 * DAY + 1000, t3);
    const n4 = await s.generate(t4);
    expect(n4).not.toBeNull();

    await s.dismiss(n4!.id, t4); // 4 in a row: still 7 days
    expect(stored().consecutiveDismissals).toBe(4);
    expect(await s.generate(plus(7 * DAY - 1000, t4))).toBeNull();
    expect(await s.generate(plus(7 * DAY + 1000, t4))).not.toBeNull();
  });

  it('accepting anything resets the count, and the spacing goes back to 20 hours', async () => {
    seed({ consecutiveDismissals: 3, lastGeneratedAt: plus(-8 * DAY).toISOString() });
    const s = await make();
    const n = await s.generate(NOW);
    expect(n).not.toBeNull();
    expect(stored().consecutiveDismissals).toBe(3);
    expect(await s.accept(n!.id, NOW)).toMatchObject({ ok: true });
    expect(stored().consecutiveDismissals).toBe(0);
    expect(await s.generate(plus(19 * HOUR))).toBeNull();
    expect(await s.generate(plus(20 * HOUR + 1000))).not.toBeNull();
  });

  it('a failed accept does not reset the count', async () => {
    seed({ consecutiveDismissals: 2, dismissedKeys: Object.fromEntries(availableIds(BARE).filter(id => id !== 'title-brainstorm').map(id => [`play:${id}`, '2026-11-12'])) });
    failTasks = true;
    const s = await make();
    const n = await s.generate(NOW);
    expect(await s.accept(n!.id, NOW)).toEqual({ ok: false, reason: 'failed' });
    expect(stored().consecutiveDismissals).toBe(2);
  });

  it('never creates a notice during quiet hours, and does not even read activity', async () => {
    const s = await make();
    for (const when of [atHour(22, 0), atHour(23, 30), atHour(0, 0, 1), atHour(3, 0, 1), atHour(6, 59, 1)]) {
      expect(await s.generate(when)).toBeNull();
    }
    expect(loads).toBe(0);
    expect(s.list()).toEqual([]);
    expect(await s.generate(atHour(7, 0, 1))).not.toBeNull(); // it waited for the next run
  });

  it('just before quiet hours is fine', async () => {
    expect(await (await make()).generate(atHour(21, 59))).not.toBeNull();
  });

  it('still only one new notice at a time', async () => {
    const s = await make();
    const first = await s.generate(NOW);
    expect(await s.generate(plus(2 * DAY))).toBeNull();
    expect(await s.generate(plus(4 * DAY))).toBeNull();
    expect(s.list()).toEqual([first]);
  });

  it('a new notice older than 5 days expires quietly and is not counted as a dismissal', async () => {
    const s = await make();
    const first = await s.generate(NOW);
    const firstKey = lastKey();
    expect(await s.generate(plus(5 * DAY - HOUR))).toBeNull();
    expect(s.list()).toEqual([first]);

    const next = await s.generate(plus(5 * DAY + HOUR));
    const saved = stored();
    expect(saved.notices[0]).toMatchObject({ id: first!.id, status: 'expired', decidedAt: expect.any(String) });
    expect(saved.consecutiveDismissals).toBe(0);
    // The spacing was already satisfied, so the next idea arrives in the same run, and it is a different one.
    expect(next).not.toBeNull();
    expect(saved.notices[1].key).not.toBe(firstKey);
    expect(s.list()).toEqual([next]);
    // An expired notice can no longer be answered.
    expect(await s.accept(first!.id, plus(6 * DAY))).toEqual({ ok: false, reason: 'not_new' });
    expect(await s.dismiss(first!.id, plus(6 * DAY))).toEqual({ ok: false, reason: 'not_new' });
    // It survives a restart as expired.
    expect((await make()).list()).toEqual([next]);
  });

  it('expiry happens even when it is too early or too late to say something new', async () => {
    const s = await make();
    await s.generate(NOW);
    expect(await s.generate(atHour(23, 0, 6))).toBeNull(); // quiet hours
    expect(stored().notices[0].status).toBe('expired');
    expect(s.list()).toEqual([]);
  });

  it('the back-off state survives a restart; files from before it existed still load', async () => {
    const s = await make();
    const n = await s.generate(NOW);
    await s.dismiss(n!.id, NOW);
    await s.runPlay('read-last-scene', {}, NOW);
    expect(stored()).toMatchObject({ consecutiveDismissals: 1, lastGeneratedAt: NOW.toISOString(), playRuns: { 'read-last-scene': NOW.toISOString() }, playSeq: 1 });
    const again = await make();
    expect(await again.generate(plus(19 * HOUR))).toBeNull();

    rmSync(join(dir, 'notices.json'));
    writeFileSync(join(dir, 'notices.json'), JSON.stringify({
      enabled: true, dismissedKeys: {}, consecutiveDismissals: 'lots', lastGeneratedAt: 'nope', playRuns: ['x'], playSeq: -4,
      notices: [{ id: 'a', key: 'review:waiting', text: 'old', status: 'dismissed', createdAt: plus(-19 * HOUR).toISOString() }],
    }));
    const old = await make();
    expect(await old.generate(NOW)).toBeNull(); // spacing falls back to the newest notice
    expect(await old.generate(plus(2 * HOUR))).not.toBeNull();
    expect(stored()).toMatchObject({ consecutiveDismissals: 0, playSeq: 1 });
  });
});

describe('suggestNow', () => {
  it('ignores spacing and quiet hours', async () => {
    const s = await make();
    const first = await s.generate(NOW);
    await s.dismiss(first!.id, NOW);
    expect(await s.generate(plus(HOUR))).toBeNull();
    const asked = await s.suggestNow(plus(HOUR));
    expect(asked).not.toBeNull();
    expect(asked!.id).not.toBe(first!.id);
    await s.dismiss(asked!.id, plus(HOUR));
    const night = await s.suggestNow(atHour(3, 0, 1));
    expect(night).not.toBeNull();
    expect(Object.keys(night!).sort()).toEqual(['action', 'createdAt', 'id', 'text']);
  });

  it('returns the waiting notice when there already is one, and makes no second one', async () => {
    const s = await make();
    const first = await s.generate(NOW);
    const before = loads;
    expect(await s.suggestNow(plus(HOUR))).toEqual(first);
    expect(await s.suggestNow(plus(2 * HOUR))).toEqual(first);
    expect(s.list()).toEqual([first]);
    expect(loads).toBe(before);
  });

  it('does not change the dismissal count, and the daily look spaces itself from it', async () => {
    seed({ consecutiveDismissals: 2, lastGeneratedAt: plus(-HOUR).toISOString() });
    const s = await make();
    const n = await s.suggestNow(NOW);
    expect(n).not.toBeNull();
    expect(stored().consecutiveDismissals).toBe(2);
    expect(stored().lastGeneratedAt).toBe(NOW.toISOString());
  });

  it('respects the exclusions and prefers a usage rule', async () => {
    seed({ dismissedKeys: Object.fromEntries(availableIds(BARE).map(id => [`play:${id}`, '2026-11-12'])) });
    const s = await make();
    expect(await s.suggestNow(NOW)).toBeNull();
    usage = { ...empty(), tasks: [{ id: 't', title: 'Outline', kind: 'task', source: 'app', when: 'tonight', status: 'review', createdAt: plus(-6 * DAY).toISOString(), finishedAt: plus(-5 * DAY).toISOString() }] };
    expect((await s.suggestNow(NOW))!.text).toContain('Tasks');
  });

  it('expires a stale notice first, and never throws', async () => {
    const s = await make();
    const first = await s.generate(NOW);
    const later = await s.suggestNow(plus(6 * DAY));
    expect(later!.id).not.toBe(first!.id);
    const broken = await make({ loadUsage: async () => { throw new Error('disk gone'); } });
    await expect(broken.suggestNow(plus(7 * DAY))).resolves.toEqual(later);
    rmSync(join(dir, 'notices.json'));
    await expect((await make({ loadUsage: async () => { throw new Error('disk gone'); } })).suggestNow(NOW)).resolves.toBeNull();
  });
});

describe('rule e wording', () => {
  it('never states a day count above 14, and stays kind', () => {
    for (let days = 4; days <= 400; days++) {
      const [c] = candidateNotices({ ...quiet(), bookTitle: 'Road', daysSinceLastWriting: days });
      expect(c.key).toBe('writing:back-in');
      const numbers = (c.text.match(/\d+/g) || []).map(Number);
      for (const n of numbers) expect(n).toBeLessThanOrEqual(14);
      expect(c.text).toContain('No pressure at all.');
      expect(c.text.length).toBeLessThanOrEqual(MAX_NOTICE_CHARS);
    }
    const text = (days: number) => candidateNotices({ ...quiet(), bookTitle: 'The Salt Road', daysSinceLastWriting: days })[0].text;
    expect(text(14)).toBe('It has been 14 days since you last wrote in The Salt Road. No pressure at all. Want a ten minute warm-up to ease back in?');
    expect(text(15)).toBe('It has been a while since you wrote in The Salt Road. No pressure at all. Want a ten minute warm-up to ease back in?');
    expect(text(212)).toBe(text(15));
  });
});

describe('rules h and i', () => {
  const ctx = (over: Partial<PlayContext> = {}): PlayContext => ({ bookTitle: 'The Salt Road', hasGoogle: false, hasBrowser: false, ...over });
  const busy = (): UsageSummary => ({ ...quiet(), bookTitle: 'The Salt Road', messageCount: 10 });
  const keysOf = (s: UsageSummary, c: PlayContext, ran: string[] = []) => candidateNotices(s, { ctx: c, ranPlayIds: new Set(ran) }).map(x => x.key);

  it('h. a book, 10+ messages, and no dashboard or consistency check yet: offer the dashboard', () => {
    const [c] = candidateNotices(busy(), { ctx: ctx(), ranPlayIds: new Set() });
    expect(c.key).toBe('play:book-dashboard');
    expect(c.text).toBe('We have been talking about The Salt Road a lot lately. Want a one-page dashboard with your progress, cast, open threads and next three steps?');
    expect(c.sensitive).toEqual(['The Salt Road']);
    expect(c.action).toMatchObject({ label: 'Build it', kind: 'task', title: 'Book dashboard: The Salt Road', detail: expect.stringContaining('Promises made to the reader') });
    expect(keysOf({ ...busy(), messageCount: 9 }, ctx())).toEqual([]);
    expect(keysOf({ ...busy(), bookTitle: undefined }, ctx({ bookTitle: undefined }))).toEqual([]);
    expect(keysOf(busy(), ctx(), ['book-dashboard'])).toEqual([]);
    expect(keysOf(busy(), ctx(), ['consistency-check'])).toEqual([]);
    expect(keysOf(busy(), ctx(), ['pacing-check'])).toEqual(['play:book-dashboard']);
    // Without the play input the older rules behave exactly as before.
    expect(candidateNotices(busy())).toEqual([]);
  });

  it('i. Google connected and never put to work: offer inbox triage', () => {
    const [c] = candidateNotices(quiet(), { ctx: ctx({ bookTitle: undefined, hasGoogle: true }), ranPlayIds: new Set() });
    expect(c.key).toBe('play:inbox-triage');
    expect(c.text.length).toBeLessThanOrEqual(MAX_NOTICE_CHARS);
    expect(c.text).toContain('for you to approve');
    expect(c.action).toMatchObject({ label: 'Sort it', kind: 'task', title: 'Inbox triage' });
    expect(keysOf(quiet(), ctx({ hasGoogle: false }))).toEqual([]);
    for (const id of PLAYS.filter(p => p.needs.includes('google')).map(p => p.id)) {
      expect(keysOf(quiet(), ctx({ hasGoogle: true }), [id])).toEqual([]);
    }
    expect(keysOf(quiet(), ctx({ hasGoogle: true }), ['book-dashboard'])).toEqual(['play:inbox-triage']);
  });

  it('they come after the older rules, h before i', () => {
    const s: UsageSummary = { ...busy(), reviewWaiting: 1, daysSinceLastWriting: 6 };
    expect(keysOf(s, ctx({ hasGoogle: true }))).toEqual(['review:waiting', 'writing:back-in', 'play:book-dashboard', 'play:inbox-triage']);
  });

  it('in the service: h fires before the playbook, and stops once the dashboard or check has been run', async () => {
    usage = {
      ...empty(),
      facts: BOOK,
      messages: Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `a different thought number ${'abcdefghij'[i]} about the middle`, timestamp: atHour(9 + i, 0, -1 - (i % 2)) })),
    };
    const s = await make();
    const n = await s.generate(NOW);
    expect(lastKey()).toBe('play:book-dashboard');
    expect(n!.text).toContain('one-page dashboard');
    expect(stored().playSeq).toBe(0);
    await s.dismiss(n!.id, NOW);

    rmSync(join(dir, 'notices.json'));
    const ran = await make();
    expect(await ran.runPlay('consistency-check', { when: 'tonight' }, NOW)).toMatchObject({ ok: true });
    await ran.generate(NOW);
    expect(lastKey()).not.toBe('play:book-dashboard');
    expect(lastKey()).not.toBe('play:consistency-check');
  });

  it('in the service: i fires when Google is connected, and not after a Google play was run', async () => {
    caps = { hasGoogle: true, hasBrowser: false };
    const s = await make();
    const n = await s.generate(NOW);
    expect(lastKey()).toBe('play:inbox-triage');
    expect(n!.action).toEqual({ label: 'Sort it', kind: 'task' });
    expect(await s.accept(n!.id, NOW)).toEqual({ ok: true, message: 'Queued for tonight: "Inbox triage".' });
    // Accepted through a notice counts as run: neither the rule nor the fallback offers it again.
    for (let i = 1; i <= 6; i++) {
      const next = await s.generate(plus(i * DAY));
      expect(lastKey()).not.toBe('play:inbox-triage');
      if (next) await s.accept(next.id, plus(i * DAY));
    }
    expect(stored().notices.filter((x: any) => x.key === 'play:inbox-triage')).toHaveLength(1);

    rmSync(join(dir, 'notices.json'));
    const ran = await make();
    await ran.runPlay('follow-ups', {}, NOW);
    await ran.generate(NOW);
    expect(lastKey()).not.toBe('play:inbox-triage');
  });
});

describe('playbook() and runPlay()', () => {
  it('lists every play for the current context, grouped by category, without work orders', async () => {
    const s = await make();
    const list = await s.playbook();
    expect(list.map(p => p.id)).toEqual(PLAY_CATEGORIES.flatMap(c => PLAYS.filter(p => p.category === c).map(p => p.id)));
    for (const p of list) {
      expect(Object.keys(p).filter(k => k !== 'missing').sort()).toEqual(['available', 'blurb', 'category', 'id', 'kind', 'label', 'title']);
      expect(p.available).toBe(p.missing === undefined);
    }
    expect(JSON.stringify(list)).not.toMatch(/Questions for you|\{book\}|"detail"|"cron"|"say":|"action"/);
    expect(list.find(p => p.id === 'consistency-check')).toMatchObject({ available: false, missing: 'book', kind: 'task', blurb: expect.stringContaining('your book') });
    expect(list.find(p => p.id === 'inbox-triage')).toMatchObject({ available: false, missing: 'google' });
    expect(list.find(p => p.id === 'comp-titles')).toMatchObject({ available: false, missing: 'browser' });
    expect(list.find(p => p.id === 'morning-recap')).toMatchObject({ available: true, kind: 'schedule' });
    expect(list.find(p => p.id === 'read-last-scene')).toMatchObject({ available: true, kind: 'say' });
    expect(loads).toBe(0); // only the saved facts are read

    usage = { ...empty(), facts: BOOK };
    caps = { hasGoogle: true, hasBrowser: true };
    const full = await s.playbook();
    expect(full.every(p => p.available && p.missing === undefined)).toBe(true);
    expect(full.find(p => p.id === 'consistency-check')!.blurb).toContain('The Salt Road');
  });

  it('falls back to loadUsage for the facts, and survives a failing capabilities check', async () => {
    usage = { ...empty(), facts: BOOK };
    const s = await make({ loadFacts: undefined, capabilities: () => { throw new Error('boom'); } });
    const list = await s.playbook();
    expect(loads).toBe(1);
    expect(list.find(p => p.id === 'consistency-check')!.available).toBe(true);
    expect(list.find(p => p.id === 'inbox-triage')!.available).toBe(false);
  });

  it('task: queued to start now by default, or for tonight', async () => {
    usage = { ...empty(), facts: BOOK };
    const s = await make();
    expect(await s.runPlay('consistency-check', {}, NOW)).toEqual({
      ok: true, taskId: 'task-1', message: 'On it: "Consistency check: The Salt Road". It will be in Tasks when it is ready.',
    });
    expect(added[0]).toMatchObject({ title: 'Consistency check: The Salt Road', kind: 'task', when: 'now', source: 'app' });
    expect(added[0].detail).toContain('"The Salt Road"');
    expect(added[0].detail).toContain('The author is currently on chapter 4.');
    expect(added[0].detail).toContain('Questions for you');
    expect(await s.runPlay('book-dashboard', { when: 'tonight' }, NOW)).toEqual({
      ok: true, taskId: 'task-2', message: 'Queued for tonight: "Book dashboard: The Salt Road".',
    });
    expect(added[1].when).toBe('tonight');
    expect(stored().playRuns).toEqual({ 'consistency-check': NOW.toISOString(), 'book-dashboard': NOW.toISOString() });
    expect(stored().consecutiveDismissals).toBe(0);
    expect(s.list()).toEqual([]);
  });

  it('schedule: creates the job once; a second time it already exists', async () => {
    const s = await make();
    expect(await s.runPlay('weekly-review', {}, NOW)).toEqual({ ok: true, message: 'Scheduled "Weekly review".' });
    expect(jobs).toEqual([{ name: 'Weekly review', schedule: '0 17 * * 5', handler: 'queue-task', payload: { title: 'Weekly review', detail: expect.any(String) } }]);
    expect(await s.runPlay('weekly-review', {}, plus(DAY))).toEqual({ ok: false, reason: 'exists' });
    expect(jobs).toHaveLength(1);
    expect(stored().playRuns['weekly-review']).toBe(NOW.toISOString());
    // Without cron.list the existing schedules come from loadUsage.
    usage = { ...empty(), schedules: [{ name: ' evening NUDGE ', handler: 'queue-task' }] };
    const other = await make({ cron: { createJob: async (i) => { jobs.push(i); return i; } } });
    expect(await other.runPlay('streak-nudge', {}, NOW)).toEqual({ ok: false, reason: 'exists' });
    expect(jobs).toHaveLength(1);
  });

  it('say: returns the words for the app to send and touches nothing else', async () => {
    const s = await make();
    expect(await s.runPlay('read-last-scene', {}, NOW)).toEqual({ ok: true, say: 'Read me the last scene aloud.' });
    expect(await s.runPlay('scene-ideas', { when: 'tonight' }, NOW)).toEqual({ ok: true, say: 'Pitch me five ways the next scene of my book could go, from safe to surprising.' });
    expect(added).toEqual([]);
    expect(jobs).toEqual([]);
    expect(Object.keys(stored().playRuns).sort()).toEqual(['read-last-scene', 'scene-ideas']);
  });

  it('unknown, unavailable and failed plays record nothing', async () => {
    const s = await make();
    expect(await s.runPlay('nope', {}, NOW)).toEqual({ ok: false, reason: 'not_found' });
    expect(await s.runPlay('__proto__', {}, NOW)).toEqual({ ok: false, reason: 'not_found' });
    expect(await s.runPlay('consistency-check', {}, NOW)).toEqual({ ok: false, reason: 'unavailable', missing: 'book' });
    expect(await s.runPlay('inbox-triage', {}, NOW)).toEqual({ ok: false, reason: 'unavailable', missing: 'google' });
    expect(await s.runPlay('comp-titles', {}, NOW)).toEqual({ ok: false, reason: 'unavailable', missing: 'browser' });
    failTasks = true;
    expect(await s.runPlay('title-brainstorm', {}, NOW)).toEqual({ ok: false, reason: 'failed' });
    expect(added).toEqual([]);
    expect(jobs).toEqual([]);
    expect(() => stored()).toThrow(); // nothing was ever written
  });

  it('works while the daily notices are switched off', async () => {
    const s = await make();
    await s.setEnabled(false);
    expect(await s.generate(NOW)).toBeNull();
    expect((await s.runPlay('read-last-scene', {}, NOW)).ok).toBe(true);
    expect((await s.playbook()).length).toBe(PLAYS.length);
    expect(await s.suggestNow(NOW)).not.toBeNull(); // the author asked
  });
});
