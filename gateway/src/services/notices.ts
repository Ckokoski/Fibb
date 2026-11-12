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
 *    pacing (one `new` notice at a time, one per 20 hours) and the actions.
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

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const WINDOW_DAYS = 14;
export const MAX_NOTICE_CHARS = 220;
const MAX_POLISHED_CHARS = 240;
const MIN_GAP_MS = 20 * HOUR_MS;
const DISMISS_QUIET_DAYS = 30;
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
  const books = (Array.isArray(input.facts?.books) ? input.facts.books : [])
    .filter(b => b && typeof b.title === 'string' && b.title.trim() && !FINISHED_STAGE.test(String(b.stage || '')));
  const book = books[books.length - 1];

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
    summary.bookTitle = book.title.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (Number.isFinite(book.chapter)) summary.bookChapter = Number(book.chapter);
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

/** The rules, in priority order. Every text is at most 220 characters. */
export function candidateNotices(s: UsageSummary): NoticeCandidate[] {
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
    out.push({
      key: 'writing:back-in',
      text: `It has been ${s.daysSinceLastWriting} days since you last wrote in ${s.bookTitle}. No pressure at all. Want a ten minute warm-up to ease back in?`,
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

export type NoticeStatus = 'new' | 'accepted' | 'dismissed';
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
  dismissedKeys: Record<string, string>;
}

export interface NoticeDeps {
  /** Gathers the raw activity. Called only when notices are enabled. */
  loadUsage: () => Promise<UsageInput>;
  tasks: {
    add: (input: { title: string; detail?: string; kind?: 'task' | 'idea'; when?: 'tonight' | 'now'; source?: 'chat' | 'app' | 'schedule' }) => Promise<any>;
    get?: (id: string) => { title: string; detail?: string } | undefined;
  };
  cron: { createJob: (input: { name: string; schedule: string; handler: string; payload?: Record<string, any> }) => Promise<any> };
  /** Cheapest model: (system, user) -> text. Omit to skip rewording. */
  polish?: (system: string, user: string) => Promise<string>;
}

export type AcceptResult =
  | { ok: true; message?: string; say?: string }
  | { ok: false; reason: 'not_found' | 'not_new' | 'failed' };
export type DismissResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_new' };

const KINDS = ['schedule', 'task', 'say'];
const STATUSES: NoticeStatus[] = ['new', 'accepted', 'dismissed'];
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
  private state: NoticeState = { enabled: true, notices: [], dismissedKeys: {} };
  private writeChain: Promise<void> = Promise.resolve();
  private generating = false;

  constructor(workspaceDir: string, private deps: NoticeDeps) {
    this.file = join(workspaceDir, 'notices.json');
  }

  async initialize(): Promise<void> {
    this.state = { enabled: true, notices: [], dismissedKeys: {} };
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
    } catch (err) {
      logger.warn(`notices.json is corrupt, starting empty: ${(err as any)?.message || err}`);
      try { await copyFile(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      this.state = { enabled: true, notices: [], dismissedKeys: {} };
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
   * is nothing to say. Never throws.
   */
  async generate(now: Date = new Date()): Promise<PublicNotice | null> {
    if (!this.state.enabled || this.generating) return null;
    this.generating = true;
    try {
      if (this.state.notices.some(n => n.status === 'new')) return null;
      const t = now.getTime();
      const latest = Math.max(0, ...this.state.notices.map(n => Date.parse(n.createdAt) || 0));
      if (latest && t - latest < MIN_GAP_MS) return null;

      const summary = summarizeUsage(await this.deps.loadUsage(), now);
      const accepted = new Set(this.state.notices.filter(n => n.status === 'accepted').map(n => n.key));
      const quiet = (key: string) => {
        const at = Date.parse(this.state.dismissedKeys[key] || '');
        return Number.isFinite(at) && t - at < DISMISS_QUIET_DAYS * DAY_MS;
      };
      const pick = candidateNotices(summary).find(c => !accepted.has(c.key) && !quiet(c.key));
      if (!pick) return null;
      // Settings may have changed while the activity was being read.
      if (!this.state.enabled || this.state.notices.some(n => n.status === 'new')) return null;

      const text = await this.polish(pick, summary.firstName);
      if (!this.state.enabled) return null;
      const notice: Notice = {
        id: randomBytes(12).toString('hex'),
        key: pick.key,
        text,
        status: 'new',
        createdAt: now.toISOString(),
      };
      if (pick.action) notice.action = pick.action;
      this.state.notices.push(notice);
      this.prune(t);
      await this.persist();
      return toPublic(notice);
    } catch (err) {
      logger.debug('notice generation failed', err);
      return null;
    } finally {
      this.generating = false;
    }
  }

  async accept(id: string): Promise<AcceptResult> {
    const n = this.state.notices.find(x => x.id === id);
    if (!n) return { ok: false, reason: 'not_found' };
    if (n.status !== 'new') return { ok: false, reason: 'not_new' };
    // Claim it before the first await so a double click cannot run the action twice.
    n.status = 'accepted';
    n.decidedAt = new Date().toISOString();
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
    await this.persist();
    return out;
  }

  async dismiss(id: string): Promise<DismissResult> {
    const n = this.state.notices.find(x => x.id === id);
    if (!n) return { ok: false, reason: 'not_found' };
    if (n.status !== 'new') return { ok: false, reason: 'not_new' };
    const today = new Date().toISOString();
    n.status = 'dismissed';
    n.decidedAt = today;
    this.state.dismissedKeys[n.key] = today.slice(0, 10);
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
      const i = this.state.notices.findIndex(n => n.status === 'dismissed');
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
