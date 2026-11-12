/**
 * "I noticed": once a day Fibb looks at how the author has used Fibb (only
 * activity inside Fibb) and offers at most one small, concrete suggestion with
 * a one-click action.
 *
 * Three layers:
 *  - summarizeUsage(): pure. Turns raw activity into aggregates and short
 *    normalized phrases. Never keeps full message text.
 *  - candidateNotices(): pure. Deterministic rules, in priority order.
 *  - NoticeService: persistence (workspace/notices.json), de-duplication,
 *    pacing and the actions.
 *
 * When no usage rule has anything to say, one idea from the playbook
 * (services/playbook.ts) is offered instead.
 *
 * Pacing, so Fibb is never a nag:
 *  - one `new` notice at a time;
 *  - at least 20 hours between notices, 3 days after 2 dismissals in a row,
 *    7 days after 3 or more in a row (accepting anything resets the count);
 *  - nothing new between 22:00 and 07:00 local time;
 *  - a `new` notice nobody answered in 5 days expires quietly (not a dismissal).
 *
 * The cheapest model may reword the chosen suggestion. It is sent only the
 * suggestion text (with anything taken from the author's own words masked out)
 * and the author's first name, never message contents.
 */
import { randomBytes } from 'crypto';
import { mkdir, readFile, writeFile, rename, copyFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';
import { computeStreaks } from './writing-stats.js';
import {
  PLAYS, PLAY_CATEGORIES, availability, renderPlay, pickPlay,
  type Play, type PlayContext, type PlayNeed, type PlayCategory,
} from './playbook.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const WINDOW_DAYS = 14;
export const MAX_NOTICE_CHARS = 220;
const MAX_POLISHED_CHARS = 240;
const MIN_GAP_MS = 20 * HOUR_MS;
const DISMISS_QUIET_DAYS = 30;
/** A play run on demand is not suggested again for this long. */
export const PLAY_RERUN_QUIET_DAYS = 14;
/** A `new` notice nobody answered expires after this long. */
export const EXPIRE_DAYS = 5;
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 7;
/** Rule e never states a day count above this. */
const MAX_STATED_DAYS = 14;

/** Minimum time between two notices, given how many were dismissed in a row. */
export function minGapMs(consecutiveDismissals: number): number {
  if (consecutiveDismissals >= 3) return 7 * DAY_MS;
  if (consecutiveDismissals === 2) return 3 * DAY_MS;
  return MIN_GAP_MS;
}

/** 22:00 to 07:00 local time. */
export function isQuietHour(now: Date): boolean {
  const h = now.getHours();
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}
const MAX_STORED = 200;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── Input ──

export interface UsageMessage { role: string; content: string; timestamp: Date | string }
export interface UsageTask {
  id?: string; title: string; kind: string; source: string; when: string; status: string;
  createdAt: string; finishedAt?: string;
}
export interface UsageSchedule { name: string; handler: string; schedule?: string; enabled?: boolean; payload?: Record<string, any> }
export interface UsageInput {
  /** Messages from the interactive channels. Only the author's are read. */
  messages: UsageMessage[];
  tasks: UsageTask[];
  /** Cron jobs. Only `queue-task` and `night-shift` handlers are read. */
  schedules: UsageSchedule[];
  /** date (YYYY-MM-DD) -> words written that day. */
  writingDays: Record<string, number>;
  facts: { name?: string; books?: Array<{ title: string; stage?: string; chapter?: number }> };
}

// ── Summary ──

export interface RepeatedRequest { phrase: string; count: number; days: number; hour: number; weekday: number }
export interface UsageSummary {
  windowDays: number;
  firstName?: string;
  bookTitle?: string;
  bookChapter?: number;
  /** Days in the window on which the author sent at least one message. */
  activeDays: number;
  messageCount: number;
  /** Busiest hours of the day (local time), most active first, at most 3. */
  topHours: Array<{ hour: number; count: number }>;
  /** Start of the 2-hour window holding 40%+ of activity over 5+ active days, else null. */
  usualHour: number | null;
  /** Share of activity between 22:00 and 04:00. */
  lateShare: number;
  /** Weekdays the author most often logged words on (at most 2). */
  writingWeekdays: string[];
  writingDaysInWindow: number;
  wordsInWindow: number;
  wordsTotal: number;
  currentStreakDays: number;
  /** null when no writing has ever been recorded. */
  daysSinceLastWriting: number | null;
  quickCaptures: { idea: number; tonight: number };
  ideasSaved: number;
  ideasDeveloped: number;
  newestIdea?: { id?: string; title: string };
  tasksQueued: number;
  tasksKept: number;
  tasksDiscarded: number;
  /** Tasks the author handed over for the night in the window. */
  nightTasksQueued: number;
  nightShiftUsed: boolean;
  repeatedRequests: RepeatedRequest[];
  /** Finished work waiting in review for more than 2 days. */
  reviewWaiting: number;
  /** True when the author has at least one schedule of their own (a `queue-task` job). */
  hasSchedule: boolean;
  scheduleTitles: string[];
}

/** Lowercase, digits and punctuation stripped, at most 60 characters. */
export function normalizePhrase(text: unknown): string {
  return String(typeof text === 'string' ? text : '')
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

// Same shape as parseQuickCapture in message-pipeline.ts (kept local so this
// module stays light).
const CAPTURE_RE = /^\s*(idea|tonight)\s*(?::|[-–—](?=\s))\s*(\S[\s\S]*)$/i;

const toTime = (v: unknown): number => {
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : NaN;
};
const utcKey = (t: number): string => new Date(t).toISOString().slice(0, 10);
const localKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const argMax = (xs: number[]): number => xs.reduce((best, v, i) => (v > xs[best] ? i : best), 0);
const isRequestPhrase = (p: string): boolean => p.length >= 10 && p.includes(' ');
const FINISHED_STAGE = /publish|released|finished|complete|done|abandon/i;

/** The book in progress (the last one that is not finished), if any. */
export function currentBook(facts: UsageInput['facts'] | null | undefined): { title: string; chapter?: number } | undefined {
  const books = (Array.isArray(facts?.books) ? facts.books : [])
    .filter(b => b && typeof b.title === 'string' && b.title.trim() && !FINISHED_STAGE.test(String(b.stage || '')));
  const book = books[books.length - 1];
  if (!book) return undefined;
  const out: { title: string; chapter?: number } = { title: book.title.replace(/\s+/g, ' ').trim().slice(0, 60) };
  if (Number.isFinite(book.chapter)) out.chapter = Number(book.chapter);
  return out;
}

export function summarizeUsage(input: UsageInput, now: Date): UsageSummary {
  const end = now.getTime();
  const start = end - WINDOW_DAYS * DAY_MS;
  const inWindow = (t: number) => Number.isFinite(t) && t >= start && t <= end;

  // ── The author's messages (timestamps, plus a normalized phrase) ──
  const hist = new Array<number>(24).fill(0);
  const activeDays = new Set<string>();
  const captures = { idea: 0, tonight: 0 };
  const capturedIdeas = new Set<string>();
  const phrases = new Map<string, { count: number; days: Set<string>; hours: number[]; weekdays: number[] }>();
  const bump = (phrase: string, t: number) => {
    if (!isRequestPhrase(phrase)) return;
    let e = phrases.get(phrase);
    if (!e) { e = { count: 0, days: new Set(), hours: new Array(24).fill(0), weekdays: new Array(7).fill(0) }; phrases.set(phrase, e); }
    const d = new Date(t);
    e.count++;
    e.days.add(localKey(d));
    e.hours[d.getHours()]++;
    e.weekdays[d.getDay()]++;
  };

  let messageCount = 0;
  for (const m of Array.isArray(input.messages) ? input.messages : []) {
    if (m?.role !== 'user' || typeof m.content !== 'string') continue;
    const t = toTime(m.timestamp);
    if (!inWindow(t)) continue;
    const d = new Date(t);
    messageCount++;
    hist[d.getHours()]++;
    activeDays.add(localKey(d));
    const capture = m.content.match(CAPTURE_RE);
    if (capture) {
      const kind = capture[1].toLowerCase() as 'idea' | 'tonight';
      captures[kind]++;
      if (kind === 'idea') capturedIdeas.add(normalizePhrase(capture[2].replace(/\s+/g, ' ').trim().slice(0, 80)));
      continue; // the task it created is counted below
    }
    if (m.content.length <= 300) bump(normalizePhrase(m.content), t);
  }

  const topHours = hist
    .map((count, hour) => ({ hour, count }))
    .filter(h => h.count > 0)
    .sort((a, b) => b.count - a.count || a.hour - b.hour)
    .slice(0, 3);

  let usualHour: number | null = null;
  if (messageCount > 0 && activeDays.size >= 5) {
    let best = 0;
    let bestHour = 0;
    for (let h = 0; h < 24; h++) {
      const w = hist[h] + hist[(h + 1) % 24];
      if (w > best) { best = w; bestHour = h; }
    }
    if (best / messageCount >= 0.4) usualHour = bestHour;
  }
  const late = hist[22] + hist[23] + hist[0] + hist[1] + hist[2] + hist[3];
  const lateShare = messageCount ? late / messageCount : 0;

  // ── Tasks and ideas ──
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).filter(t => t && typeof t.title === 'string');
  const created = (t: UsageTask) => toTime(t.createdAt);
  const settled = (t: UsageTask) => { const f = toTime(t.finishedAt); return Number.isFinite(f) ? f : created(t); };

  const savedIdeas = tasks.filter(t => t.kind === 'idea' && t.status === 'queued')
    .sort((a, b) => (created(b) || 0) - (created(a) || 0));
  let ideasDeveloped = tasks.filter(t => t.kind === 'idea' && (t.status === 'done' || t.status === 'review')).length;
  let tasksQueued = 0, tasksKept = 0, tasksDiscarded = 0, nightTasksQueued = 0, reviewWaiting = 0;
  let nightShiftUsed = false;
  for (const t of tasks) {
    if (t.kind !== 'task') continue;
    const c = created(t);
    if (inWindow(c)) {
      tasksQueued++;
      const p = normalizePhrase(t.title);
      if (t.source !== 'schedule') {
        bump(p, c);
        if (t.when === 'tonight') nightTasksQueued++;
      }
      if (p.startsWith('develop the idea') || (p && [...capturedIdeas].some(i => i && (i === p || p.includes(i))))) ideasDeveloped++;
    }
    const s = settled(t);
    if (t.status === 'done' && inWindow(s)) tasksKept++;
    if (t.status === 'discarded' && inWindow(s)) tasksDiscarded++;
    if ((t.status === 'done' || t.status === 'review') && t.when === 'tonight' && inWindow(s)) nightShiftUsed = true;
    if (t.status === 'review' && Number.isFinite(s) && end - s > 2 * DAY_MS) reviewWaiting++;
  }

  const repeatedRequests: RepeatedRequest[] = [...phrases.entries()]
    .filter(([, e]) => e.count >= 3)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([phrase, e]) => ({ phrase, count: e.count, days: e.days.size, hour: argMax(e.hours), weekday: argMax(e.weekdays) }));

  // ── Schedules ──
  const schedules = (Array.isArray(input.schedules) ? input.schedules : [])
    .filter(s => s && s.enabled !== false && (s.handler === 'queue-task' || s.handler === 'night-shift'));
  const own = schedules.filter(s => s.handler === 'queue-task');
  const scheduleTitles = [...new Set(own.flatMap(s => [normalizePhrase(s.name), normalizePhrase(s.payload?.title)]).filter(Boolean))];

  // ── Writing ──
  const days = input.writingDays && typeof input.writingDays === 'object' ? input.writingDays : {};
  const todayKey = utcKey(end);
  const windowStartKey = utcKey(end - (WINDOW_DAYS - 1) * DAY_MS);
  const weekdayCounts = new Array<number>(7).fill(0);
  let wordsInWindow = 0, wordsTotal = 0, writingDaysInWindow = 0;
  let lastKey: string | null = null;
  for (const [key, raw] of Object.entries(days)) {
    const words = Number(raw) || 0;
    if (words <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    wordsTotal += words;
    if (key > todayKey) continue;
    if (lastKey === null || key > lastKey) lastKey = key;
    if (key >= windowStartKey) {
      wordsInWindow += words;
      writingDaysInWindow++;
      weekdayCounts[new Date(`${key}T00:00:00.000Z`).getUTCDay()]++;
    }
  }
  const writingWeekdays = weekdayCounts
    .map((count, day) => ({ count, day }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count || a.day - b.day)
    .slice(0, 2)
    .map(x => WEEKDAYS[x.day]);
  const daysSinceLastWriting = lastKey === null ? null
    : Math.round((Date.parse(`${todayKey}T00:00:00.000Z`) - Date.parse(`${lastKey}T00:00:00.000Z`)) / DAY_MS);

  // ── Facts ──
  const firstName = (typeof input.facts?.name === 'string' ? input.facts.name : '')
    .trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, '').slice(0, 30) || undefined;
  const book = currentBook(input.facts);

  const summary: UsageSummary = {
    windowDays: WINDOW_DAYS,
    activeDays: activeDays.size,
    messageCount,
    topHours,
    usualHour,
    lateShare,
    writingWeekdays,
    writingDaysInWindow,
    wordsInWindow,
    wordsTotal,
    currentStreakDays: computeStreaks(days, now).currentStreakDays,
    daysSinceLastWriting,
    quickCaptures: captures,
    ideasSaved: savedIdeas.length,
    ideasDeveloped,
    tasksQueued,
    tasksKept,
    tasksDiscarded,
    nightTasksQueued,
    nightShiftUsed,
    repeatedRequests,
    reviewWaiting,
    hasSchedule: own.length > 0,
    scheduleTitles,
  };
  if (firstName) summary.firstName = firstName;
  if (book) {
    summary.bookTitle = book.title;
    if (book.chapter !== undefined) summary.bookChapter = book.chapter;
  }
  if (savedIdeas[0]) {
    summary.newestIdea = { id: savedIdeas[0].id, title: savedIdeas[0].title.replace(/\s+/g, ' ').trim().slice(0, 60) };
  }
  return summary;
}

// ── Candidates ──

export type NoticeAction =
  | { label: string; kind: 'schedule'; title: string; detail: string; cron: string }
  | { label: string; kind: 'task'; title: string; detail: string; refId?: string }
  | { label: string; kind: 'say'; say: string };

export interface NoticeCandidate {
  /** Stable id for de-duplication. */
  key: string;
  text: string;
  action?: NoticeAction;
  /** Parts of `text` taken from the author's own words. Masked before any model call. */
  sensitive?: string[];
}

export function hourLabel(hour: number, minute = 0): string {
  const h = ((Math.round(hour) % 24) + 24) % 24;
  const base = h % 12 === 0 ? 12 : h % 12;
  const mm = minute ? `:${String(minute).padStart(2, '0')}` : '';
  return `${base}${mm}${h < 12 ? 'am' : 'pm'}`;
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const similar = (a: string, b: string) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));

/** What the rules that offer a play (h, i) need to know. */
export interface PlayRuleInput {
  ctx: PlayContext;
  /** Ids of plays the author has ever run, on demand or by accepting a notice. */
  ranPlayIds: Set<string>;
}

export const playKey = (id: string): string => `play:${id}`;

/** Turn a play into a notice. `text` defaults to "An idea: <blurb> Want me to?". */
export function playCandidate(play: Play, ctx: PlayContext, text?: string): NoticeCandidate {
  const r = renderPlay(play, ctx);
  const wrap = (blurb: string) => `An idea: ${blurb} Want me to?`;
  let line = text ?? wrap(r.blurb);
  // A very long book title: fall back to the wording without it.
  if (line.length > MAX_NOTICE_CHARS) line = wrap(renderPlay(play, { ...ctx, bookTitle: undefined }).blurb);
  const a = r.action;
  const action: NoticeAction = a.kind === 'task'
    ? { label: r.label, kind: 'task', title: a.title, detail: a.detail }
    : a.kind === 'schedule'
      ? { label: r.label, kind: 'schedule', title: a.title, detail: a.detail, cron: a.cron }
      : { label: r.label, kind: 'say', say: a.say };
  const c: NoticeCandidate = { key: playKey(play.id), text: line, action };
  const title = ctx.bookTitle?.replace(/\s+/g, ' ').trim();
  if (title && line.includes(title)) c.sensitive = [title];
  return c;
}

const findPlay = (id: string): Play | undefined => PLAYS.find(p => p.id === id);

/**
 * The rules, in priority order. Every text is at most 220 characters.
 * Rules h and i offer a play and only run when `plays` is given.
 */
export function candidateNotices(s: UsageSummary, plays?: PlayRuleInput): NoticeCandidate[] {
  const out: NoticeCandidate[] = [];

  // a. Something the author keeps asking for, with no schedule for it yet.
  for (const r of s.repeatedRequests) {
    if (r.count < 3 || !r.phrase) continue;
    if (s.scheduleTitles.some(t => similar(t, r.phrase))) continue;
    const daily = r.days >= 5;
    const at = hourLabel(r.hour);
    const every = daily ? `every day at ${at}` : `every ${WEEKDAYS[r.weekday]} at ${at}`;
    out.push({
      key: `repeat:${r.phrase}`,
      text: `You have asked me for "${r.phrase}" ${r.count} times lately. Want me to do it ${every} so it is ready without you asking?`,
      sensitive: [r.phrase],
      action: {
        label: 'Set it up',
        kind: 'schedule',
        title: capitalize(r.phrase),
        detail: `The author regularly asks for this: "${r.phrase}". Do it for their current work and leave the result for review.`,
        cron: daily ? `0 ${r.hour} * * *` : `0 ${r.hour} * * ${r.weekday}`,
      },
    });
  }

  // b. Ideas piling up, none developed.
  if (s.ideasSaved >= 3 && s.ideasDeveloped === 0 && s.newestIdea?.title) {
    const title = s.newestIdea.title;
    out.push({
      key: 'ideas:develop-newest',
      text: `You have ${s.ideasSaved} ideas saved and none developed yet. Want me to flesh out the newest one, "${title}", tonight?`,
      sensitive: [title],
      action: {
        label: 'Develop it tonight',
        kind: 'task',
        title: `Develop the idea: ${title}`,
        detail: `Develop this saved idea into a one-page treatment: what it is, why it is interesting, three ways it could play out, and a suggested next step. Idea: "${title}".`,
        ...(s.newestIdea.id ? { refId: s.newestIdea.id } : {}),
      },
    });
  }

  // c. Finished work waiting for review. No action: it lives in Tasks.
  if (s.reviewWaiting > 0) {
    const n = s.reviewWaiting;
    out.push({
      key: 'review:waiting',
      text: n === 1
        ? 'One finished piece has been waiting for your review for a few days. It is in Tasks whenever you are ready.'
        : `${n} finished pieces have been waiting for your review for a few days. They are in Tasks whenever you are ready.`,
    });
  }

  // d. A clear usual hour and no schedule: a recap waiting 30 minutes before.
  if (s.usualHour !== null && !s.hasSchedule) {
    const before = (s.usualHour + 23) % 24;
    out.push({
      key: 'recap:before-writing',
      text: `You usually sit down with me around ${hourLabel(s.usualHour)}. Want a short "where you left off" recap waiting for you at ${hourLabel(before, 30)} each day?`,
      action: {
        label: 'Yes, set it up',
        kind: 'schedule',
        title: 'Where you left off',
        detail: 'Prepare a short recap of where the author left off in their current book: the last scene or chapter they worked on, the open threads, and one suggested next step. Keep it under 200 words.',
        cron: `30 ${before} * * *`,
      },
    });
  }

  // e. A book in progress and no writing for a while.
  if (s.bookTitle && s.daysSinceLastWriting !== null && s.daysSinceLastWriting >= 4) {
    const gap = s.daysSinceLastWriting <= MAX_STATED_DAYS
      ? `It has been ${s.daysSinceLastWriting} days since you last wrote in ${s.bookTitle}.`
      : `It has been a while since you wrote in ${s.bookTitle}.`;
    out.push({
      key: 'writing:back-in',
      text: `${gap} No pressure at all. Want a ten minute warm-up to ease back in?`,
      sensitive: [s.bookTitle],
      action: { label: 'Warm me up', kind: 'say', say: `Help me get back into ${s.bookTitle} with a ten minute warm-up.` },
    });
  }

  // f. The night shift is working well: offer to take more.
  if (s.tasksKept >= 5 && s.tasksDiscarded === 0 && s.nightShiftUsed) {
    out.push({
      key: 'night:queue-more',
      text: `You kept all ${s.tasksKept} things I finished for you in the last two weeks. I can take on more. Want to hand me something else for tonight?`,
      action: { label: 'Ask Fibb', kind: 'say', say: 'What else could you take off my plate tonight?' },
    });
  }

  // g. A night owl who has not tried handing work over before bed.
  if (s.messageCount >= 6 && s.activeDays >= 3 && s.lateShare > 0.5 && s.nightTasksQueued === 0) {
    out.push({
      key: 'night:before-bed',
      text: 'You often work late. Before you stop for the night you can hand me a task, and I will have it ready for you by morning.',
      action: { label: 'Show me how', kind: 'say', say: 'What could I hand you before bed tonight?' },
    });
  }

  if (plays) {
    const { ctx, ranPlayIds } = plays;

    // h. A book, plenty of conversation, and no overview of the book yet.
    const dashboard = findPlay('book-dashboard');
    if (dashboard && s.bookTitle && s.messageCount >= 10
      && !ranPlayIds.has('consistency-check') && !ranPlayIds.has('book-dashboard')
      && availability(dashboard, ctx).available) {
      out.push(playCandidate(dashboard, ctx,
        `We have been talking about ${s.bookTitle} a lot lately. Want a one-page dashboard with your progress, cast, open threads and next three steps?`));
    }

    // i. Google is connected and has never been put to work.
    const triage = findPlay('inbox-triage');
    if (triage && ctx.hasGoogle && availability(triage, ctx).available
      && !PLAYS.some(p => p.needs.includes('google') && ranPlayIds.has(p.id))) {
      out.push(playCandidate(triage, ctx,
        'Now that Google is connected, I can sum up your unread author mail from the last three days and draft replies for you to approve. Want me to?'));
    }
  }

  return out;
}

// ── Polish ──

export const POLISH_SYSTEM_PROMPT =
  'You reword one short note that Fibb, a warm writing assistant, shows to the author. ' +
  'Reply with one friendlier sentence (two at most) under 220 characters, and nothing else. ' +
  'Keep every number and every fact exactly. Add no new facts. ' +
  'Keep any token like [[1]] exactly as written, once. ' +
  'No em-dashes, no links, no emojis, no quotation marks around the reply.';

const maskToken = (i: number) => `[[${i + 1}]]`;

/** Replace each sensitive part with a numbered token. */
export function maskSensitive(text: string, sensitive: string[] = []): string {
  let out = text;
  sensitive.forEach((part, i) => { if (part) out = out.split(part).join(maskToken(i)); });
  return out;
}

/**
 * Check the model's rewording and put the masked parts back. Returns null
 * (keep the original) when the reply is empty, too long, has a link or an
 * em-dash, or lost or duplicated a masked part.
 */
export function acceptPolished(reply: unknown, sensitive: string[] = []): string | null {
  if (typeof reply !== 'string') return null;
  let t = reply.replace(/\s+/g, ' ').trim();
  if (t.length >= 2 && /^["“]/.test(t) && /["”]$/.test(t)) t = t.slice(1, -1).trim();
  if (!t) return null;
  for (let i = 0; i < sensitive.length; i++) {
    const parts = t.split(maskToken(i));
    if (parts.length !== 2) return null;
    t = parts.join(sensitive[i]);
  }
  if (/\[\[\d+\]\]/.test(t)) return null;
  if (t.length > MAX_POLISHED_CHARS) return null;
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|app|ai)\b/i.test(t)) return null;
  if (/[—–]/.test(t)) return null;
  return t;
}

// ── Service ──

export type NoticeStatus = 'new' | 'accepted' | 'dismissed' | 'expired';
export interface Notice {
  id: string;
  key: string;
  text: string;
  action?: NoticeAction;
  status: NoticeStatus;
  createdAt: string;
  decidedAt?: string;
}
export interface PublicNotice {
  id: string;
  text: string;
  action?: { label: string; kind: NoticeAction['kind'] };
  createdAt: string;
}
interface NoticeState {
  enabled: boolean;
  notices: Notice[];
  /** key -> date it was dismissed (or expired unanswered). Quiet for 30 days. */
  dismissedKeys: Record<string, string>;
  /** Dismissals in a row since the last accept. Drives the back-off. */
  consecutiveDismissals: number;
  /** When the last notice was created (ISO). */
  lastGeneratedAt?: string;
  /** play id -> when it was last run on demand (ISO). */
  playRuns: Record<string, string>;
  /** How many playbook ideas have been offered; rotates the categories. */
  playSeq: number;
}
const emptyState = (): NoticeState => ({ enabled: true, notices: [], dismissedKeys: {}, consecutiveDismissals: 0, playRuns: {}, playSeq: 0 });

/** One row of GET /api/playbook. Never carries the work order. */
export interface PlaybookEntry {
  id: string;
  category: PlayCategory;
  title: string;
  blurb: string;
  label: string;
  kind: Play['action']['kind'];
  available: boolean;
  missing?: PlayNeed;
}

export type RunPlayResult =
  | { ok: true; message?: string; say?: string; taskId?: string }
  | { ok: false; reason: 'not_found' | 'exists' | 'failed' }
  | { ok: false; reason: 'unavailable'; missing: PlayNeed };

export interface NoticeDeps {
  /** Gathers the raw activity. Called only when notices are enabled. */
  loadUsage: () => Promise<UsageInput>;
  tasks: {
    add: (input: { title: string; detail?: string; kind?: 'task' | 'idea'; when?: 'tonight' | 'now'; source?: 'chat' | 'app' | 'schedule' }) => Promise<any>;
    get?: (id: string) => { title: string; detail?: string } | undefined;
  };
  cron: {
    createJob: (input: { name: string; schedule: string; handler: string; payload?: Record<string, any> }) => Promise<any>;
    /** Existing jobs, to avoid scheduling the same thing twice. */
    list?: () => Array<{ name: string }>;
  };
  /** Which tools are ready right now. Omitted means neither. */
  capabilities?: () => { hasGoogle: boolean; hasBrowser: boolean } | Promise<{ hasGoogle: boolean; hasBrowser: boolean }>;
  /** Just the saved facts (name, books). Falls back to loadUsage().facts. */
  loadFacts?: () => UsageInput['facts'] | Promise<UsageInput['facts']>;
  /** Cheapest model: (system, user) -> text. Omit to skip rewording. */
  polish?: (system: string, user: string) => Promise<string>;
}

export type AcceptResult =
  | { ok: true; message?: string; say?: string }
  | { ok: false; reason: 'not_found' | 'not_new' | 'failed' };
export type DismissResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_new' };

const KINDS = ['schedule', 'task', 'say'];
const STATUSES: NoticeStatus[] = ['new', 'accepted', 'dismissed', 'expired'];
const sameName = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function cleanAction(a: any): NoticeAction | undefined {
  if (typeof a !== 'object' || a === null || !KINDS.includes(a.kind) || !str(a.label)) return undefined;
  if (a.kind === 'schedule' && str(a.title) && typeof a.detail === 'string' && str(a.cron)) {
    return { label: a.label, kind: 'schedule', title: a.title, detail: a.detail, cron: a.cron };
  }
  if (a.kind === 'task' && str(a.title) && typeof a.detail === 'string') {
    return { label: a.label, kind: 'task', title: a.title, detail: a.detail, ...(str(a.refId) ? { refId: a.refId } : {}) };
  }
  if (a.kind === 'say' && str(a.say)) return { label: a.label, kind: 'say', say: a.say };
  return undefined;
}

function cleanNotice(v: any): Notice | null {
  if (typeof v !== 'object' || v === null) return null;
  if (!str(v.id) || !str(v.key) || !str(v.text) || !STATUSES.includes(v.status)) return null;
  if (!str(v.createdAt) || Number.isNaN(Date.parse(v.createdAt))) return null;
  const n: Notice = { id: v.id, key: v.key, text: v.text, status: v.status, createdAt: v.createdAt };
  const action = cleanAction(v.action);
  if (action) n.action = action;
  if (str(v.decidedAt)) n.decidedAt = v.decidedAt;
  return n;
}

export class NoticeService {
  private file: string;
  private state: NoticeState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();
  private generating = false;

  constructor(workspaceDir: string, private deps: NoticeDeps) {
    this.file = join(workspaceDir, 'notices.json');
  }

  async initialize(): Promise<void> {
    this.state = emptyState();
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf-8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      this.state.enabled = parsed.enabled !== false;
      if (Array.isArray(parsed.notices)) {
        this.state.notices = parsed.notices.map(cleanNotice).filter((n: Notice | null): n is Notice => n !== null);
      }
      if (typeof parsed.dismissedKeys === 'object' && parsed.dismissedKeys !== null) {
        for (const [k, v] of Object.entries(parsed.dismissedKeys)) {
          if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) this.state.dismissedKeys[k] = v;
        }
      }
      const count = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : 0);
      this.state.consecutiveDismissals = count(parsed.consecutiveDismissals);
      this.state.playSeq = count(parsed.playSeq);
      if (str(parsed.lastGeneratedAt) && !Number.isNaN(Date.parse(parsed.lastGeneratedAt))) this.state.lastGeneratedAt = parsed.lastGeneratedAt;
      if (typeof parsed.playRuns === 'object' && parsed.playRuns !== null && !Array.isArray(parsed.playRuns)) {
        for (const [k, v] of Object.entries(parsed.playRuns)) {
          if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) this.state.playRuns[k] = v;
        }
      }
    } catch (err) {
      logger.warn(`notices.json is corrupt, starting empty: ${(err as any)?.message || err}`);
      try { await copyFile(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      this.state = emptyState();
    }
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    this.state.enabled = enabled === true;
    await this.persist();
    return this.state.enabled;
  }

  /** Notices waiting for the author. Never exposes the rule key or the action's contents. */
  list(): PublicNotice[] {
    return this.state.notices.filter(n => n.status === 'new').map(toPublic);
  }

  /**
   * The daily look. Creates at most one notice; returns it, or null when there
   * is nothing to say or it is too soon. Never throws.
   */
  async generate(now: Date = new Date()): Promise<PublicNotice | null> {
    if (!this.state.enabled || this.generating) return null;
    this.generating = true;
    try {
      const t = now.getTime();
      await this.expireOld(t);
      if (this.state.notices.some(n => n.status === 'new')) return null;
      if (isQuietHour(now)) return null; // waits for the next run
      const last = this.lastGeneratedMs();
      if (last && t - last < minGapMs(this.state.consecutiveDismissals)) return null;
      return await this.create(now, false);
    } catch (err) {
      logger.debug('notice generation failed', err);
      return null;
    } finally {
      this.generating = false;
    }
  }

  /**
   * The author asked for an idea. Ignores spacing and quiet hours (and the
   * daily switch), but there is still only one `new` notice at a time: if one
   * is waiting, that one is returned. Never throws.
   */
  async suggestNow(now: Date = new Date()): Promise<PublicNotice | null> {
    const waiting = () => this.state.notices.find(n => n.status === 'new');
    if (this.generating) { const n = waiting(); return n ? toPublic(n) : null; }
    this.generating = true;
    try {
      await this.expireOld(now.getTime());
      const existing = waiting();
      if (existing) return toPublic(existing);
      return await this.create(now, true);
    } catch (err) {
      logger.debug('notice suggestion failed', err);
      return null;
    } finally {
      this.generating = false;
    }
  }

  /** The playbook, rendered for the author's current book and tools, grouped by category. */
  async playbook(): Promise<PlaybookEntry[]> {
    const ctx = await this.playContext();
    const out: PlaybookEntry[] = [];
    for (const category of PLAY_CATEGORIES) {
      for (const play of PLAYS) {
        if (play.category !== category) continue;
        const r = renderPlay(play, ctx);
        const a = availability(play, ctx);
        const entry: PlaybookEntry = { id: r.id, category: r.category, title: r.title, blurb: r.blurb, label: r.label, kind: r.action.kind, available: a.available };
        if (a.missing) entry.missing = a.missing;
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Do a play because the author asked. Remembers the run so the daily look
   * does not suggest the same play for 14 days.
   */
  async runPlay(id: string, opts: { when?: 'tonight' | 'now' } = {}, now: Date = new Date()): Promise<RunPlayResult> {
    const play = findPlay(id);
    if (!play) return { ok: false, reason: 'not_found' };
    try {
      const ctx = await this.playContext();
      const a = availability(play, ctx);
      if (!a.available) return { ok: false, reason: 'unavailable', missing: a.missing! };
      const action = renderPlay(play, ctx).action;
      const out: { ok: true; message?: string; say?: string; taskId?: string } = { ok: true };
      if (action.kind === 'task') {
        const when = opts.when === 'tonight' ? 'tonight' : 'now';
        const task = await this.deps.tasks.add({ title: action.title, detail: action.detail, kind: 'task', when, source: 'app' });
        if (str(task?.id)) out.taskId = task.id;
        out.message = when === 'tonight'
          ? `Queued for tonight: "${action.title}".`
          : `On it: "${action.title}". It will be in Tasks when it is ready.`;
      } else if (action.kind === 'schedule') {
        if ((await this.scheduleNames()).some(name => sameName(name, action.title))) return { ok: false, reason: 'exists' };
        await this.deps.cron.createJob({ name: action.title, schedule: action.cron, handler: 'queue-task', payload: { title: action.title, detail: action.detail } });
        out.message = `Scheduled "${action.title}".`;
      } else {
        out.say = action.say;
      }
      this.state.playRuns[play.id] = now.toISOString();
      await this.persist();
      return out;
    } catch (err) {
      logger.debug('play failed', err);
      return { ok: false, reason: 'failed' };
    }
  }

  // ── Choosing ──

  /** Pick a suggestion, reword it, store it. The caller holds `generating`. */
  private async create(now: Date, onDemand: boolean): Promise<PublicNotice | null> {
    const t = now.getTime();
    const usage = await this.deps.loadUsage();
    const summary = summarizeUsage(usage, now);
    const ctx: PlayContext = { ...(await this.capabilities()) };
    if (summary.bookTitle) ctx.bookTitle = summary.bookTitle;
    if (summary.bookChapter !== undefined) ctx.chapter = summary.bookChapter;

    const accepted = new Set(this.state.notices.filter(n => n.status === 'accepted').map(n => n.key));
    const quiet = (key: string) => {
      const at = Date.parse(this.state.dismissedKeys[key] || '');
      return Number.isFinite(at) && t - at < DISMISS_QUIET_DAYS * DAY_MS;
    };
    const ranPlayIds = new Set(Object.keys(this.state.playRuns));
    for (const key of accepted) if (key.startsWith('play:')) ranPlayIds.add(key.slice(5));

    // Plays that must not be suggested: answered before, run lately, or already on the schedule.
    const names = (Array.isArray(usage?.schedules) ? usage.schedules : []).map(j => j?.name);
    const excludeIds = new Set<string>();
    for (const play of PLAYS) {
      const key = playKey(play.id);
      const ranAt = Date.parse(this.state.playRuns[play.id] || '');
      const a = renderPlay(play, ctx).action;
      if (accepted.has(key) || quiet(key)
        || (Number.isFinite(ranAt) && t - ranAt < PLAY_RERUN_QUIET_DAYS * DAY_MS)
        || (a.kind === 'schedule' && names.some(n => sameName(n, a.title)))) {
        excludeIds.add(play.id);
      }
    }

    let pick = candidateNotices(summary, { ctx, ranPlayIds })
      .find(c => !accepted.has(c.key) && !quiet(c.key) && !(c.key.startsWith('play:') && excludeIds.has(c.key.slice(5))));
    let fromPlaybook = false;
    if (!pick) {
      const lastPlay = [...this.state.notices].reverse().find(n => n.key.startsWith('play:'));
      const avoidCategory = lastPlay ? findPlay(lastPlay.key.slice(5))?.category : undefined;
      const play = pickPlay(PLAYS, ctx, { excludeIds, seed: this.state.playSeq, avoidCategory });
      if (play) { pick = playCandidate(play, ctx); fromPlaybook = true; }
    }
    if (!pick) return null;
    // Things may have changed while the activity was being read.
    if (!onDemand && !this.state.enabled) return null;
    if (this.state.notices.some(n => n.status === 'new')) return null;

    const text = await this.polish(pick, summary.firstName);
    if (!onDemand && !this.state.enabled) return null;
    const notice: Notice = {
      id: randomBytes(12).toString('hex'),
      key: pick.key,
      text,
      status: 'new',
      createdAt: now.toISOString(),
    };
    if (pick.action) notice.action = pick.action;
    this.state.notices.push(notice);
    this.state.lastGeneratedAt = notice.createdAt;
    if (fromPlaybook) this.state.playSeq++;
    this.prune(t);
    await this.persist();
    return toPublic(notice);
  }

  private lastGeneratedMs(): number {
    const stored = Date.parse(this.state.lastGeneratedAt || '') || 0;
    return Math.max(stored, ...this.state.notices.map(n => Date.parse(n.createdAt) || 0));
  }

  /** A notice nobody answered in 5 days steps aside. It is not a dismissal, but its key rests for 30 days. */
  private async expireOld(nowMs: number): Promise<void> {
    let changed = false;
    for (const n of this.state.notices) {
      if (n.status !== 'new' || nowMs - Date.parse(n.createdAt) <= EXPIRE_DAYS * DAY_MS) continue;
      n.status = 'expired';
      n.decidedAt = new Date(nowMs).toISOString();
      this.state.dismissedKeys[n.key] = n.decidedAt.slice(0, 10);
      changed = true;
    }
    if (changed) await this.persist();
  }

  private async capabilities(): Promise<{ hasGoogle: boolean; hasBrowser: boolean }> {
    try {
      const c = await this.deps.capabilities?.();
      return { hasGoogle: c?.hasGoogle === true, hasBrowser: c?.hasBrowser === true };
    } catch (err) {
      logger.debug('notice capabilities failed', err);
      return { hasGoogle: false, hasBrowser: false };
    }
  }

  private async playContext(): Promise<PlayContext> {
    const ctx: PlayContext = { ...(await this.capabilities()) };
    try {
      const facts = this.deps.loadFacts ? await this.deps.loadFacts() : (await this.deps.loadUsage()).facts;
      const book = currentBook(facts);
      if (book) {
        ctx.bookTitle = book.title;
        if (book.chapter !== undefined) ctx.chapter = book.chapter;
      }
    } catch (err) {
      logger.debug('play context failed', err);
    }
    return ctx;
  }

  private async scheduleNames(): Promise<string[]> {
    const jobs = this.deps.cron.list ? this.deps.cron.list() : (await this.deps.loadUsage()).schedules;
    return (Array.isArray(jobs) ? jobs : []).map(j => j?.name).filter((n): n is string => typeof n === 'string');
  }

  async accept(id: string, now: Date = new Date()): Promise<AcceptResult> {
    const n = this.state.notices.find(x => x.id === id);
    if (!n) return { ok: false, reason: 'not_found' };
    if (n.status !== 'new') return { ok: false, reason: 'not_new' };
    // Claim it before the first await so a double click cannot run the action twice.
    n.status = 'accepted';
    n.decidedAt = now.toISOString();
    const out: { ok: true; message?: string; say?: string } = { ok: true };
    try {
      const a = n.action;
      if (a?.kind === 'schedule') {
        await this.deps.cron.createJob({ name: a.title, schedule: a.cron, handler: 'queue-task', payload: { title: a.title, detail: a.detail } });
        out.message = `Scheduled "${a.title}".`;
      } else if (a?.kind === 'task') {
        let detail = a.detail;
        const ref = a.refId ? this.deps.tasks.get?.(a.refId) : undefined;
        if (ref) detail += `\n\nThe idea as the author saved it:\n${ref.detail || ref.title}`;
        await this.deps.tasks.add({ title: a.title, detail, kind: 'task', when: 'tonight', source: 'app' });
        out.message = `Queued for tonight: "${a.title}".`;
      } else if (a?.kind === 'say') {
        out.say = a.say;
      }
    } catch (err) {
      logger.debug('notice action failed', err);
      n.status = 'new';
      delete n.decidedAt;
      return { ok: false, reason: 'failed' };
    }
    this.state.consecutiveDismissals = 0;
    await this.persist();
    return out;
  }

  async dismiss(id: string, now: Date = new Date()): Promise<DismissResult> {
    const n = this.state.notices.find(x => x.id === id);
    if (!n) return { ok: false, reason: 'not_found' };
    if (n.status !== 'new') return { ok: false, reason: 'not_new' };
    const today = now.toISOString();
    n.status = 'dismissed';
    n.decidedAt = today;
    this.state.dismissedKeys[n.key] = today.slice(0, 10);
    this.state.consecutiveDismissals++;
    await this.persist();
    return { ok: true };
  }

  /** Reword with the cheapest model. Any problem keeps the original wording. */
  private async polish(c: NoticeCandidate, firstName?: string): Promise<string> {
    if (!this.deps.polish) return c.text;
    try {
      const user = `Author's first name: ${firstName || 'unknown'}\nNote: ${maskSensitive(c.text, c.sensitive)}`;
      return acceptPolished(await this.deps.polish(POLISH_SYSTEM_PROMPT, user), c.sensitive) ?? c.text;
    } catch (err) {
      logger.debug('notice polish failed', err);
      return c.text;
    }
  }

  /** Keep the file small: old dismissed notices go first; accepted ones are kept (they silence a key for good). */
  private prune(nowMs: number): void {
    for (const [k, v] of Object.entries(this.state.dismissedKeys)) {
      if (nowMs - Date.parse(v) > DISMISS_QUIET_DAYS * 2 * DAY_MS) delete this.state.dismissedKeys[k];
    }
    while (this.state.notices.length > MAX_STORED) {
      const i = this.state.notices.findIndex(n => n.status === 'dismissed' || n.status === 'expired');
      if (i < 0) break;
      this.state.notices.splice(i, 1);
    }
  }

  private persist(): Promise<void> {
    const data = JSON.stringify(this.state, null, 2);
    const next = this.writeChain.then(async () => {
      await mkdir(join(this.file, '..'), { recursive: true });
      await writeAtomic(this.file, data);
    });
    this.writeChain = next.catch(() => {});
    return next;
  }
}

function toPublic(n: Notice): PublicNotice {
  const out: PublicNotice = { id: n.id, text: n.text, createdAt: n.createdAt };
  if (n.action) out.action = { label: n.action.label, kind: n.action.kind };
  return out;
}

let writeSeq = 0;

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
