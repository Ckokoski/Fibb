import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  summarizeUsage, candidateNotices, normalizePhrase, hourLabel, maskSensitive, acceptPolished,
  NoticeService, MAX_NOTICE_CHARS, POLISH_SYSTEM_PROMPT,
  type UsageInput, type UsageSummary, type UsageTask, type NoticeDeps,
} from './notices.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Local noon, so hour-of-day maths is the same in every time zone.
const NOW = new Date(2026, 10, 12, 12, 0, 0);
/** A local time `daysAgo` days back, at `hour`. */
const at = (daysAgo: number, hour: number, minute = 0) => new Date(2026, 10, 12 - daysAgo, hour, minute, 0);
const dayKey = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString().slice(0, 10);
const said = (content: string, daysAgo: number, hour: number) => ({ role: 'user', content, timestamp: at(daysAgo, hour) });
const task = (over: Partial<UsageTask>): UsageTask => ({
  id: `t-${Math.random().toString(36).slice(2)}`, title: 'Outline the next chapter', kind: 'task', source: 'app', when: 'tonight',
  status: 'queued', createdAt: at(1, 9).toISOString(), ...over,
});
const empty = (): UsageInput => ({ messages: [], tasks: [], schedules: [], writingDays: {}, facts: {} });
const quiet = (): UsageSummary => summarizeUsage(empty(), NOW);
const keys = (s: UsageSummary) => candidateNotices(s).map(c => c.key);

describe('normalizePhrase / hourLabel', () => {
  it('lowercases, strips digits and punctuation, caps at 60 characters', () => {
    expect(normalizePhrase('  Summarize Chapter 12, please!! ')).toBe('summarize chapter please');
    expect(normalizePhrase('Résumé du chapitre 3')).toBe('résumé du chapitre');
    expect(normalizePhrase('x'.repeat(100)).length).toBe(60);
    expect(normalizePhrase(undefined)).toBe('');
    expect(normalizePhrase('12345 !!!')).toBe('');
  });
  it.each([[0, 0, '12am'], [9, 0, '9am'], [12, 0, '12pm'], [21, 0, '9pm'], [8, 30, '8:30am'], [23, 30, '11:30pm']])('hourLabel(%i, %i) = %s', (h, m, out) => {
    expect(hourLabel(h, m)).toBe(out);
  });
});

describe('summarizeUsage', () => {
  it('an empty install produces an all-zero summary and no candidates', () => {
    const s = quiet();
    expect(s).toMatchObject({
      windowDays: 14, activeDays: 0, messageCount: 0, topHours: [], usualHour: null, lateShare: 0,
      wordsInWindow: 0, wordsTotal: 0, currentStreakDays: 0, daysSinceLastWriting: null,
      quickCaptures: { idea: 0, tonight: 0 }, ideasSaved: 0, ideasDeveloped: 0, tasksQueued: 0, tasksKept: 0,
      tasksDiscarded: 0, nightTasksQueued: 0, nightShiftUsed: false, repeatedRequests: [], reviewWaiting: 0,
      hasSchedule: false, scheduleTitles: [],
    });
    expect(candidateNotices(s)).toEqual([]);
  });

  it('tolerates malformed input', () => {
    const s = summarizeUsage({ messages: [null, { role: 'user', content: 5, timestamp: 'nope' }] as any, tasks: [null, {}] as any, schedules: null as any, writingDays: null as any, facts: null as any }, NOW);
    expect(s.messageCount).toBe(0);
    expect(s.tasksQueued).toBe(0);
  });

  it('counts only the author\'s messages from the last 14 days: active days, top hours', () => {
    const s = summarizeUsage({
      ...empty(),
      messages: [
        said('morning thoughts on the plot', 0, 9), said('more on the plot today', 0, 9), said('and another thing here', 1, 9),
        said('evening check in again', 1, 20), said('late one tonight friend', 2, 23),
        said('far too old to count', 15, 9),
        { role: 'assistant', content: 'a reply from Fibb', timestamp: at(0, 3) },
        { role: 'user', content: 'string timestamps work', timestamp: at(3, 20).toISOString() },
      ],
    }, NOW);
    expect(s.messageCount).toBe(6);
    expect(s.activeDays).toBe(4);
    expect(s.topHours).toEqual([{ hour: 9, count: 3 }, { hour: 20, count: 2 }, { hour: 23, count: 1 }]);
    expect(s.lateShare).toBeCloseTo(1 / 6);
    expect(s.usualHour).toBeNull(); // only 4 active days
  });

  it('finds a usual hour only with 40%+ of activity in a 2-hour window over 5+ active days', () => {
    const steady = [1, 2, 3, 4, 5].flatMap(d => [said(`writing session day ${d}`, d, 20), said(`still going day ${d}`, d, 21)]);
    expect(summarizeUsage({ ...empty(), messages: steady }, NOW).usualHour).toBe(20);
    const scattered = [1, 2, 3, 4, 5, 6].flatMap(d => [said('a', d, (d * 4) % 24), said('b', d, (d * 4 + 11) % 24)]);
    expect(summarizeUsage({ ...empty(), messages: scattered }, NOW).usualHour).toBeNull();
    expect(summarizeUsage({ ...empty(), messages: steady.slice(0, 8) }, NOW).usualHour).toBeNull(); // 4 days
  });

  it('repeated requests: normalized messages and task titles that occur 3+ times, top 5, with counts', () => {
    const messages = [
      said('Summarize chapter 3', 1, 9), said('summarize chapter 4!', 3, 9), said('SUMMARIZE CHAPTER 5', 5, 10),
      said('thanks', 1, 9), said('thanks', 2, 9), said('thanks', 3, 9), // too short to be a request
      said('check my commas please', 1, 8), said('check my commas please', 2, 8),
      said('tonight: tidy the timeline', 4, 22),
    ];
    const tasks = [
      task({ title: 'Tidy the timeline', source: 'chat', createdAt: at(4, 22).toISOString() }),
      task({ title: 'Tidy the timeline', createdAt: at(6, 22).toISOString() }),
      task({ title: 'Tidy the timeline 2', createdAt: at(8, 21).toISOString() }),
      task({ title: 'Check my commas please', source: 'schedule', createdAt: at(1, 2).toISOString() }), // already scheduled work
      task({ title: 'Summarize chapter 9', kind: 'idea', createdAt: at(1, 2).toISOString() }),
    ];
    const s = summarizeUsage({ ...empty(), messages, tasks }, NOW);
    expect(s.repeatedRequests.map(r => [r.phrase, r.count])).toEqual([['summarize chapter', 3], ['tidy the timeline', 3]]);
    expect(s.repeatedRequests[0]).toMatchObject({ days: 3, hour: 9 });
    expect(s.repeatedRequests[1].hour).toBe(22);
    expect(s.quickCaptures).toEqual({ idea: 0, tonight: 1 });
    const many = Array.from({ length: 7 }, (_, i) => 'abcdefg'[i]).flatMap(c => [1, 2, 3].map(d => said(`please do thing ${c.repeat(4)}`, d, 9)));
    expect(summarizeUsage({ ...empty(), messages: many }, NOW).repeatedRequests).toHaveLength(5);
  });

  it('never keeps full message text', () => {
    const secret = 'My sister Dolores drinks and I am writing about the winter she left, chapter by chapter, and nobody knows yet';
    const s = summarizeUsage({ ...empty(), messages: [said(secret, 1, 9), said(secret, 2, 9), said(secret, 3, 9)] }, NOW);
    const dump = JSON.stringify(s);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain('nobody knows');
    for (const r of s.repeatedRequests) expect(r.phrase.length).toBeLessThanOrEqual(60);
  });

  it('ideas, tasks, the night shift and review items', () => {
    const tasks = [
      task({ id: 'i1', title: 'A lighthouse that moves', kind: 'idea', createdAt: at(9, 9).toISOString() }),
      task({ id: 'i2', title: 'Twins swap diaries', kind: 'idea', createdAt: at(2, 9).toISOString() }),
      task({ id: 'i3', title: 'Old idea, done', kind: 'idea', status: 'done', createdAt: at(40, 9).toISOString() }),
      task({ status: 'done', createdAt: at(3, 9).toISOString(), finishedAt: at(2, 2).toISOString() }),
      task({ status: 'done', when: 'now', createdAt: at(30, 9).toISOString(), finishedAt: at(29, 2).toISOString() }), // outside the window
      task({ status: 'discarded', createdAt: at(4, 9).toISOString(), finishedAt: at(3, 2).toISOString() }),
      task({ status: 'review', createdAt: at(5, 9).toISOString(), finishedAt: at(3, 2).toISOString() }),
      task({ status: 'review', createdAt: at(1, 9).toISOString(), finishedAt: at(1, 2).toISOString() }), // fresh
      task({ source: 'schedule', when: 'now', createdAt: at(1, 3).toISOString() }),
    ];
    const s = summarizeUsage({ ...empty(), tasks, messages: [said('idea: twins swap diaries', 2, 9)] }, NOW);
    expect(s).toMatchObject({
      ideasSaved: 2, ideasDeveloped: 1, newestIdea: { id: 'i2', title: 'Twins swap diaries' },
      tasksQueued: 5, tasksKept: 1, tasksDiscarded: 1, nightTasksQueued: 4, nightShiftUsed: true, reviewWaiting: 1,
      quickCaptures: { idea: 1, tonight: 0 },
    });
  });

  it('an idea counts as developed once a task with its title exists', () => {
    const tasks = [task({ title: 'Twins swap diaries', source: 'chat', createdAt: at(1, 9).toISOString() })];
    const s = summarizeUsage({ ...empty(), tasks, messages: [said('idea: Twins swap diaries', 2, 9)] }, NOW);
    expect(s.ideasDeveloped).toBe(1);
    const viaNotice = summarizeUsage({ ...empty(), tasks: [task({ title: 'Develop the idea: A lighthouse that moves' })] }, NOW);
    expect(viaNotice.ideasDeveloped).toBe(1);
  });

  it('schedules: only the author\'s own queue-task jobs count; the seeded night shift does not', () => {
    const s = summarizeUsage({
      ...empty(),
      schedules: [
        { name: 'Night shift', handler: 'night-shift' },
        { name: 'Sleep-time memory consolidation', handler: 'sleep-consolidation' },
      ],
    }, NOW);
    expect(s.hasSchedule).toBe(false);
    const own = summarizeUsage({
      ...empty(),
      schedules: [
        { name: 'Morning recap!', handler: 'queue-task', payload: { title: 'Recap of chapter 4' } },
        { name: 'Paused one', handler: 'queue-task', enabled: false },
      ],
    }, NOW);
    expect(own.hasSchedule).toBe(true);
    expect(own.scheduleTitles).toEqual(['morning recap', 'recap of chapter']);
  });

  it('writing: totals, streak, typical days and days since the last session', () => {
    const writingDays = { [dayKey(0)]: 500, [dayKey(1)]: 700, [dayKey(2)]: 300, [dayKey(20)]: 1000, [dayKey(5)]: 0 };
    const s = summarizeUsage({ ...empty(), writingDays }, NOW);
    expect(s).toMatchObject({ wordsInWindow: 1500, wordsTotal: 2500, writingDaysInWindow: 3, currentStreakDays: 3, daysSinceLastWriting: 0 });
    expect(s.writingWeekdays.length).toBe(2);
    expect(summarizeUsage({ ...empty(), writingDays: { [dayKey(6)]: 900 } }, NOW).daysSinceLastWriting).toBe(6);
  });

  it('facts: first name and the book in progress only', () => {
    const s = summarizeUsage({
      ...empty(),
      facts: { name: 'Chris Kokoski', books: [{ title: 'Old One', stage: 'published' }, { title: 'The Salt Road', stage: 'drafting', chapter: 7 }] },
    }, NOW);
    expect(s).toMatchObject({ firstName: 'Chris', bookTitle: 'The Salt Road', bookChapter: 7 });
    expect(summarizeUsage({ ...empty(), facts: { books: [{ title: 'Old One', stage: 'Published' }] } }, NOW).bookTitle).toBeUndefined();
  });
});

describe('candidateNotices', () => {
  const repeat = { phrase: 'summarize the chapter', count: 4, days: 3, hour: 9, weekday: 1 };

  it('a. repeated request with no similar schedule: weekly, or daily when it happens most days', () => {
    const [weekly] = candidateNotices({ ...quiet(), repeatedRequests: [repeat] });
    expect(weekly.key).toBe('repeat:summarize the chapter');
    expect(weekly.text).toContain('"summarize the chapter" 4 times');
    expect(weekly.text).toContain('every Monday at 9am');
    expect(weekly.action).toEqual({
      label: 'Set it up', kind: 'schedule', title: 'Summarize the chapter', cron: '0 9 * * 1',
      detail: expect.stringContaining('summarize the chapter'),
    });
    expect(weekly.sensitive).toEqual(['summarize the chapter']);
    const [daily] = candidateNotices({ ...quiet(), repeatedRequests: [{ ...repeat, days: 6, hour: 21 }] });
    expect(daily.text).toContain('every day at 9pm');
    expect((daily.action as any).cron).toBe('0 21 * * *');
  });

  it('a. silent when a schedule of similar title exists, or the count is under 3', () => {
    expect(keys({ ...quiet(), repeatedRequests: [repeat], hasSchedule: true, scheduleTitles: ['summarize the chapter'] })).toEqual([]);
    expect(keys({ ...quiet(), repeatedRequests: [repeat], hasSchedule: true, scheduleTitles: ['daily summarize the chapter for me'] })).toEqual([]);
    expect(keys({ ...quiet(), repeatedRequests: [{ ...repeat, count: 2 }] })).toEqual([]);
    // An unrelated schedule does not silence it.
    expect(keys({ ...quiet(), repeatedRequests: [repeat], hasSchedule: true, scheduleTitles: ['morning recap'] })).toEqual(['repeat:summarize the chapter']);
  });

  it('b. 3+ saved ideas and none developed: develop the newest tonight', () => {
    const s = { ...quiet(), ideasSaved: 3, ideasDeveloped: 0, newestIdea: { id: 'i9', title: 'Twins swap diaries' } };
    const [c] = candidateNotices(s);
    expect(c.key).toBe('ideas:develop-newest');
    expect(c.text).toContain('3 ideas saved');
    expect(c.action).toMatchObject({ label: 'Develop it tonight', kind: 'task', title: 'Develop the idea: Twins swap diaries', refId: 'i9' });
    expect(keys({ ...s, ideasSaved: 2 })).toEqual([]);
    expect(keys({ ...s, ideasDeveloped: 1 })).toEqual([]);
  });

  it('c. review items waiting: points at Tasks, with no action', () => {
    const [one] = candidateNotices({ ...quiet(), reviewWaiting: 1 });
    expect(one.key).toBe('review:waiting');
    expect(one.action).toBeUndefined();
    expect(one.text).toContain('Tasks');
    expect(candidateNotices({ ...quiet(), reviewWaiting: 3 })[0].text).toContain('3 finished pieces');
    expect(keys({ ...quiet(), reviewWaiting: 0 })).toEqual([]);
  });

  it('d. a usual hour and no schedule: a recap 30 minutes before', () => {
    const [c] = candidateNotices({ ...quiet(), usualHour: 20 });
    expect(c.key).toBe('recap:before-writing');
    expect(c.text).toContain('around 8pm');
    expect(c.text).toContain('7:30pm');
    expect(c.action).toMatchObject({ kind: 'schedule', title: 'Where you left off', cron: '30 19 * * *' });
    expect((candidateNotices({ ...quiet(), usualHour: 0 })[0].action as any).cron).toBe('30 23 * * *');
    expect(keys({ ...quiet(), usualHour: 20, hasSchedule: true })).toEqual([]);
    expect(keys({ ...quiet(), usualHour: null })).toEqual([]);
  });

  it('e. no writing for 4+ days with a book in progress: a gentle warm-up', () => {
    const s = { ...quiet(), bookTitle: 'The Salt Road', daysSinceLastWriting: 5 };
    const [c] = candidateNotices(s);
    expect(c.key).toBe('writing:back-in');
    expect(c.action).toEqual({ label: 'Warm me up', kind: 'say', say: 'Help me get back into The Salt Road with a ten minute warm-up.' });
    expect(keys({ ...s, daysSinceLastWriting: 3 })).toEqual([]);
    expect(keys({ ...s, daysSinceLastWriting: null })).toEqual([]);
    expect(keys({ ...s, bookTitle: undefined })).toEqual([]);
  });

  it('f. 5+ kept, none discarded, night shift used: offer to take more', () => {
    const s = { ...quiet(), tasksKept: 5, tasksDiscarded: 0, nightShiftUsed: true, nightTasksQueued: 5 };
    const [c] = candidateNotices(s);
    expect(c.key).toBe('night:queue-more');
    expect(c.action).toEqual({ label: 'Ask Fibb', kind: 'say', say: 'What else could you take off my plate tonight?' });
    expect(keys({ ...s, tasksKept: 4 })).toEqual([]);
    expect(keys({ ...s, tasksDiscarded: 1 })).toEqual([]);
    expect(keys({ ...s, nightShiftUsed: false })).toEqual([]);
  });

  it('g. mostly late-night activity and no night tasks: hand over a task before bed', () => {
    const s = { ...quiet(), messageCount: 10, activeDays: 4, lateShare: 0.7, nightTasksQueued: 0 };
    const [c] = candidateNotices(s);
    expect(c.key).toBe('night:before-bed');
    expect(c.action?.kind).toBe('say');
    expect(keys({ ...s, lateShare: 0.5 })).toEqual([]);
    expect(keys({ ...s, nightTasksQueued: 1 })).toEqual([]);
    expect(keys({ ...s, messageCount: 3 })).toEqual([]);
  });

  it('rules come out in priority order, every text is short, warm and free of em-dashes', () => {
    const long = 'x'.repeat(60);
    const all = candidateNotices({
      ...quiet(),
      repeatedRequests: [{ ...repeat, phrase: long, count: 999 }],
      ideasSaved: 999, ideasDeveloped: 0, newestIdea: { title: long },
      reviewWaiting: 999, usualHour: 22, bookTitle: long, daysSinceLastWriting: 999,
      tasksKept: 999, tasksDiscarded: 0, nightShiftUsed: true,
      messageCount: 999, activeDays: 14, lateShare: 0.9, nightTasksQueued: 0,
    });
    expect(all.map(c => c.key)).toEqual([
      `repeat:${long}`, 'ideas:develop-newest', 'review:waiting', 'recap:before-writing', 'writing:back-in', 'night:queue-more', 'night:before-bed',
    ]);
    for (const c of all) {
      expect(c.text.length).toBeLessThanOrEqual(MAX_NOTICE_CHARS);
      expect(c.text).not.toMatch(/[—–]/);
      if (c.action) expect(c.action.label.length).toBeLessThanOrEqual(24);
    }
  });
});

describe('polish guard', () => {
  it('masks the author\'s own words before the model sees them and restores them after', () => {
    const masked = maskSensitive('You asked for "tidy the timeline" 4 times.', ['tidy the timeline']);
    expect(masked).toBe('You asked for "[[1]]" 4 times.');
    expect(acceptPolished('Looks like "[[1]]" comes up a lot, 4 times lately!', ['tidy the timeline'])).toBe('Looks like "tidy the timeline" comes up a lot, 4 times lately!');
  });
  it.each([
    ['empty', ''], ['whitespace', '   '], ['not a string', 42 as any],
    ['too long', 'a'.repeat(241)],
    ['a URL', 'Nice work, see https://example.com for more.'],
    ['a bare domain', 'Nice work, visit fibb-tips.com today.'],
    ['an em-dash', 'Nice work — keep going.'],
    ['a lost mask', 'You ask for that a lot.'],
    ['a duplicated mask', '[[1]] and again [[1]].'],
    ['an invented mask', 'You like [[1]] and [[2]].'],
  ])('rejects %s', (_name, reply) => {
    expect(acceptPolished(reply, ['tidy the timeline'])).toBeNull();
  });
  it('accepts a clean reply, trimming wrapping quotes and whitespace', () => {
    expect(acceptPolished('  "A friendlier line."  ')).toBe('A friendlier line.');
    expect(acceptPolished('a'.repeat(240))).toBe('a'.repeat(240));
  });
});

describe('NoticeService', () => {
  let dir: string;
  let usage: UsageInput;
  let added: any[];
  let jobs: any[];
  let polishCalls: Array<{ system: string; user: string }>;
  let loads: number;
  let polishReply: (system: string, user: string) => Promise<string>;

  const deps = (over: Partial<NoticeDeps> = {}): NoticeDeps => ({
    loadUsage: async () => { loads++; return usage; },
    tasks: {
      add: async (input) => { added.push(input); return { id: 'new', ...input }; },
      get: (id) => (id === 'i2' ? { title: 'Twins swap diaries', detail: 'Twins swap diaries for a year and one of them lies.' } : undefined),
    },
    cron: { createJob: async (input) => { jobs.push(input); return { id: 'cron-1', ...input }; } },
    polish: (system, user) => { polishCalls.push({ system, user }); return polishReply(system, user); },
    ...over,
  });
  const make = async (over: Partial<NoticeDeps> = {}) => {
    const s = new NoticeService(dir, deps(over));
    await s.initialize();
    return s;
  };
  const stored = () => JSON.parse(readFileSync(join(dir, 'notices.json'), 'utf-8'));

  // What the author typed. None of it may ever reach the model.
  const MESSAGES = [
    'Tidy the timeline for chapter 3', 'tidy the timeline for chapter 4', 'Tidy the timeline for chapter 5!',
    'My editor Marguerite hated the ending and I cried in the car',
    'idea: a lighthouse keeper who forges tide tables',
  ];
  const reviewUsage = (): UsageInput => ({
    ...empty(),
    tasks: [task({ status: 'review', createdAt: at(6, 9).toISOString(), finishedAt: at(5, 2).toISOString() })],
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fibb-notices-'));
    added = []; jobs = []; polishCalls = []; loads = 0;
    polishReply = async () => { throw new Error('offline'); };
    usage = {
      ...empty(),
      messages: MESSAGES.map((m, i) => said(m, i + 1, 9)),
      facts: { name: 'Chris Kokoski', books: [{ title: 'The Salt Road', stage: 'drafting' }] },
    };
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('generates one notice from the first matching rule and lists it without internals', async () => {
    const s = await make();
    const n = await s.generate(NOW);
    expect(n).toMatchObject({ text: expect.stringContaining('tidy the timeline for chapter'), action: { label: 'Set it up', kind: 'schedule' } });
    expect(n!.id).toMatch(/^[0-9a-f]{24}$/);
    expect(s.list()).toEqual([n]);
    expect(Object.keys(s.list()[0]).sort()).toEqual(['action', 'createdAt', 'id', 'text']);
    expect(Object.keys(s.list()[0].action!).sort()).toEqual(['kind', 'label']);
    expect(stored().notices[0]).toMatchObject({ key: 'repeat:tidy the timeline for chapter', status: 'new', createdAt: NOW.toISOString() });
  });

  it('nothing to say means no notice and no model call', async () => {
    usage = empty();
    const s = await make();
    expect(await s.generate(NOW)).toBeNull();
    expect(s.list()).toEqual([]);
    expect(polishCalls).toEqual([]);
  });

  it('the model sees only the masked suggestion and the first name, never the author\'s words', async () => {
    polishReply = async () => 'Chris, "[[1]]" keeps coming up (3 times lately). Shall I do it every week so it is simply ready?';
    const s = await make();
    const n = await s.generate(NOW);
    expect(polishCalls).toHaveLength(1);
    const sent = `${polishCalls[0].system}\n${polishCalls[0].user}`;
    expect(polishCalls[0].system).toBe(POLISH_SYSTEM_PROMPT);
    expect(polishCalls[0].user).toContain("Author's first name: Chris");
    expect(polishCalls[0].user).toContain('[[1]]');
    for (const m of MESSAGES) {
      expect(sent.toLowerCase()).not.toContain(m.toLowerCase());
      expect(sent.toLowerCase()).not.toContain(normalizePhrase(m));
    }
    for (const word of ['tidy', 'timeline', 'marguerite', 'lighthouse', 'kokoski', 'salt road']) {
      expect(sent.toLowerCase()).not.toContain(word);
    }
    // The author still reads their own phrase, restored locally.
    expect(n!.text).toBe('Chris, "tidy the timeline for chapter" keeps coming up (3 times lately). Shall I do it every week so it is simply ready?');
  });

  it.each([
    ['fails', async () => { throw new Error('rate limited'); }],
    ['is empty', async () => '  '],
    ['is too long', async () => `[[1]] ${'so very '.repeat(40)}`],
    ['contains a URL', async () => 'Try "[[1]]" weekly, details at https://example.com/x'],
    ['drops the masked phrase', async () => 'You ask for the same thing a lot. Want it weekly?'],
  ])('keeps the original wording when the model %s', async (_name, reply) => {
    polishReply = reply as any;
    const s = await make();
    const n = await s.generate(NOW);
    expect(polishCalls).toHaveLength(1);
    expect(n!.text).toBe(candidateNotices(summarizeUsage(usage, NOW))[0].text);
  });

  it('works with no model at all', async () => {
    const s = await make({ polish: undefined });
    expect((await s.generate(NOW))!.text).toContain('3 times lately');
  });

  it('disabled: no generation, no activity read, no model call; persists across instances', async () => {
    const s = await make();
    expect(s.isEnabled()).toBe(true);
    expect(await s.setEnabled(false)).toBe(false);
    expect(await s.generate(NOW)).toBeNull();
    expect(loads).toBe(0);
    expect(polishCalls).toEqual([]);
    const again = await make();
    expect(again.isEnabled()).toBe(false);
    expect(await again.generate(NOW)).toBeNull();
    expect(loads).toBe(0);
    await again.setEnabled(true);
    expect(await again.generate(NOW)).not.toBeNull();
  });

  it('only one new notice at a time', async () => {
    const s = await make();
    const first = await s.generate(NOW);
    expect(await s.generate(new Date(NOW.getTime() + 3 * DAY))).toBeNull();
    expect(s.list()).toEqual([first]);
  });

  it('at most one notice per 20 hours', async () => {
    usage = { ...usage, ...reviewUsage(), messages: usage.messages };
    const s = await make();
    const first = await s.generate(NOW);
    await s.dismiss(first!.id);
    expect(await s.generate(new Date(NOW.getTime() + 19 * HOUR))).toBeNull();
    const second = await s.generate(new Date(NOW.getTime() + 20 * HOUR + 1000));
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
  });

  it('a dismissed key stays quiet for 30 days, then may return', async () => {
    usage = reviewUsage();
    const s = await make();
    const first = await s.generate(NOW);
    expect(first!.text).toContain('Tasks');
    expect(await s.dismiss(first!.id)).toEqual({ ok: true });
    expect(s.list()).toEqual([]);
    expect(stored().dismissedKeys['review:waiting']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The key is recorded with the real clock; move it to the fixture's "now".
    const file = stored();
    file.dismissedKeys['review:waiting'] = NOW.toISOString().slice(0, 10);
    writeFileSync(join(dir, 'notices.json'), JSON.stringify(file));
    const later = await make();
    expect(await later.generate(new Date(NOW.getTime() + 29 * DAY))).toBeNull();
    expect(await later.generate(new Date(NOW.getTime() + 31 * DAY))).not.toBeNull();
  });

  it('the next rule gets its turn when the first is dismissed', async () => {
    usage = { ...usage, tasks: reviewUsage().tasks };
    const s = await make();
    const first = await s.generate(NOW);
    expect(first!.action?.kind).toBe('schedule');
    await s.dismiss(first!.id);
    const second = await s.generate(new Date(NOW.getTime() + 21 * HOUR));
    expect(second!.text).toContain('Tasks');
    expect(second!.action).toBeUndefined();
  });

  it('an accepted key never comes back', async () => {
    usage = reviewUsage();
    const s = await make();
    const first = await s.generate(NOW);
    expect(await s.accept(first!.id)).toEqual({ ok: true });
    expect(await s.generate(new Date(NOW.getTime() + 400 * DAY))).toBeNull();
    const again = await make();
    expect(await again.generate(new Date(NOW.getTime() + 800 * DAY))).toBeNull();
  });

  it('accept: schedule creates a queue-task cron job', async () => {
    const s = await make();
    const n = await s.generate(NOW);
    const r = await s.accept(n!.id);
    expect(r).toEqual({ ok: true, message: 'Scheduled "Tidy the timeline for chapter".' });
    expect(jobs).toEqual([{
      name: 'Tidy the timeline for chapter', schedule: expect.stringMatching(/^0 9 \* \* [0-6]$/), handler: 'queue-task',
      payload: { title: 'Tidy the timeline for chapter', detail: expect.any(String) },
    }]);
    expect(s.list()).toEqual([]);
    expect(stored().notices[0]).toMatchObject({ status: 'accepted', decidedAt: expect.any(String) });
  });

  it('accept: task queues work for tonight, with the saved idea attached', async () => {
    usage = {
      ...empty(),
      tasks: [
        task({ id: 'i1', title: 'One', kind: 'idea', createdAt: at(5, 9).toISOString() }),
        task({ id: 'i2', title: 'Twins swap diaries', kind: 'idea', createdAt: at(1, 9).toISOString() }),
        task({ id: 'i3', title: 'Three', kind: 'idea', createdAt: at(3, 9).toISOString() }),
      ],
    };
    const s = await make();
    const n = await s.generate(NOW);
    expect(n!.action).toEqual({ label: 'Develop it tonight', kind: 'task' });
    const r = await s.accept(n!.id);
    expect(r).toEqual({ ok: true, message: 'Queued for tonight: "Develop the idea: Twins swap diaries".' });
    expect(added).toEqual([{
      title: 'Develop the idea: Twins swap diaries', kind: 'task', when: 'tonight', source: 'app',
      detail: expect.stringContaining('one of them lies'),
    }]);
    expect(jobs).toEqual([]);
  });

  it('accept: say returns the text for the app to send and touches nothing else', async () => {
    usage = { ...empty(), writingDays: { [dayKey(6)]: 900 }, facts: { books: [{ title: 'The Salt Road' }] } };
    const s = await make();
    const n = await s.generate(NOW);
    expect(await s.accept(n!.id)).toEqual({ ok: true, say: 'Help me get back into The Salt Road with a ten minute warm-up.' });
    expect(added).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it('accept and dismiss: unknown id, already answered, and a failed action stays open', async () => {
    const s = await make({ cron: { createJob: async () => { throw new Error('Invalid cron expression'); } } });
    expect(await s.accept('nope')).toEqual({ ok: false, reason: 'not_found' });
    expect(await s.dismiss('nope')).toEqual({ ok: false, reason: 'not_found' });
    const n = await s.generate(NOW);
    expect(await s.accept(n!.id)).toEqual({ ok: false, reason: 'failed' });
    expect(s.list()).toHaveLength(1);
    expect(await s.dismiss(n!.id)).toEqual({ ok: true });
    expect(await s.dismiss(n!.id)).toEqual({ ok: false, reason: 'not_new' });
    expect(await s.accept(n!.id)).toEqual({ ok: false, reason: 'not_new' });
  });

  it('a double click runs the action once', async () => {
    const s = await make();
    const n = await s.generate(NOW);
    const [a, b] = await Promise.all([s.accept(n!.id), s.accept(n!.id)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(jobs).toHaveLength(1);
  });

  it('generate never throws, even when reading activity fails', async () => {
    const s = await make({ loadUsage: async () => { throw new Error('disk gone'); } });
    await expect(s.generate(NOW)).resolves.toBeNull();
  });

  it('persists across instances; a corrupt file is set aside, never fatal', async () => {
    const s = await make();
    const n = await s.generate(NOW);
    const again = await make();
    expect(again.list()).toEqual([n]);
    expect(await again.accept(n!.id)).toMatchObject({ ok: true });
    expect((await make()).list()).toEqual([]);

    writeFileSync(join(dir, 'notices.json'), '{not json');
    const fresh = await make();
    expect(fresh.list()).toEqual([]);
    expect(fresh.isEnabled()).toBe(true);
    expect(readdirSync(dir).some(f => f.startsWith('notices.json.corrupt-'))).toBe(true);
  });
});
