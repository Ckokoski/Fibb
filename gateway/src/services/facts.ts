/**
 * Facts memory (spec §3). Durable, user-visible facts about the author and
 * their work, extracted after each chat turn by a cheap model call and
 * injected at the top of every system prompt. Distinct from user-model
 * (behavioral stats) and preferences (regex-detected style rules).
 */
import { mkdir, readFile, writeFile, rename, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

export interface FactBook { title: string; stage?: string; chapter?: number; goal?: string }
export interface FactPerson { name: string; kind: string; book?: string; notes?: string }
export interface Facts {
  name?: string;
  books: FactBook[];
  people: FactPerson[];
  preferences: string[];
  recent: string[];
  updatedAt?: string;
}
export type PartialFacts = Partial<Omit<Facts, 'updatedAt'>>;

export const EXTRACT_SYSTEM_PROMPT =
  'You extract durable facts about an author from one chat exchange. ' +
  'Return ONLY compact JSON with optional keys: name (string), books (array of {title, stage, chapter, goal}), ' +
  'people (array of {name, kind, book, notes}; kind is "character", "agent", "editor", "friend", etc.), ' +
  'preferences (array of short strings about how they like to work or write), ' +
  'recent (array of short strings about what they are doing or feeling right now). ' +
  'Omit keys you have no evidence for. Never invent. If nothing durable was said, return {}.';

const empty = (): Facts => ({ books: [], people: [], preferences: [], recent: [] });
const norm = (s: string) => s.trim().toLowerCase();
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}: /;

/** Validate one book entry from untrusted input. Returns null when unusable. */
function cleanBook(b: unknown): FactBook | null {
  if (!isObj(b) || typeof b.title !== 'string' || !b.title.trim()) return null;
  const out: FactBook = { title: b.title.trim() };
  if (typeof b.stage === 'string' && b.stage.trim()) out.stage = b.stage.trim();
  if (typeof b.goal === 'string' && b.goal.trim()) out.goal = b.goal.trim();
  if (b.chapter !== undefined && b.chapter !== null && b.chapter !== '') {
    const ch = Number(b.chapter);
    if (Number.isFinite(ch)) out.chapter = ch;
  }
  return out;
}

/** Validate one person entry from untrusted input. Returns null when unusable. */
function cleanPerson(p: unknown): FactPerson | null {
  if (!isObj(p) || typeof p.name !== 'string' || !p.name.trim()) return null;
  const out: FactPerson = {
    name: p.name.trim(),
    kind: typeof p.kind === 'string' && p.kind.trim() ? p.kind.trim() : 'person',
  };
  if (typeof p.book === 'string' && p.book.trim()) out.book = p.book.trim();
  if (typeof p.notes === 'string' && p.notes.trim()) out.notes = p.notes.trim();
  return out;
}

export class FactsStore {
  private file: string;
  private facts: Facts = empty();

  constructor(memoryDir: string) {
    this.file = join(memoryDir, 'facts.json');
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf-8'));
    } catch (err) {
      logger.warn('facts.json unreadable, starting empty', err);
      await quarantine(this.file);
      this.facts = empty();
      return;
    }
    const r: Record<string, any> = isObj(raw) ? raw : {};
    const f: Facts = {
      books: arr(r.books).map(cleanBook).filter((x): x is FactBook => x !== null),
      people: arr(r.people).map(cleanPerson).filter((x): x is FactPerson => x !== null),
      preferences: arr(r.preferences).filter((s): s is string => typeof s === 'string'),
      recent: arr(r.recent).filter((s): s is string => typeof s === 'string'),
    };
    if (typeof r.name === 'string' && r.name.trim()) f.name = r.name.trim();
    if (typeof r.updatedAt === 'string') f.updatedAt = r.updatedAt;
    this.facts = f;
  }

  get(): Facts {
    return JSON.parse(JSON.stringify(this.facts));
  }

  async merge(p: PartialFacts): Promise<void> {
    const f = this.facts;
    if (typeof p?.name === 'string' && p.name.trim()) f.name = p.name.trim();

    for (const raw of arr(p?.books)) {
      const b = cleanBook(raw);
      if (!b) continue;
      const hit = f.books.find(x => norm(x.title) === norm(b.title));
      if (hit) Object.assign(hit, stripUndefined({ stage: b.stage, chapter: b.chapter, goal: b.goal }));
      else f.books.push({ title: b.title, ...stripUndefined({ stage: b.stage, chapter: b.chapter, goal: b.goal }) });
    }

    for (const raw of arr(p?.people)) {
      const person = cleanPerson(raw);
      if (!person) continue;
      const hit = f.people.find(x => norm(x.name) === norm(person.name));
      if (hit) Object.assign(hit, stripUndefined({ kind: person.kind, book: person.book, notes: person.notes }));
      else f.people.push({ name: person.name, kind: person.kind, ...stripUndefined({ book: person.book, notes: person.notes }) });
    }

    for (const pref of arr(p?.preferences)) {
      if (typeof pref !== 'string') continue;
      const s = pref.trim();
      if (s && !f.preferences.some(x => norm(x) === norm(s))) f.preferences.push(s);
    }
    f.preferences = f.preferences.slice(-20);

    const today = new Date().toISOString().slice(0, 10);
    for (const r of arr(p?.recent)) {
      if (typeof r !== 'string') continue;
      const s = r.trim();
      if (!s) continue;
      if (f.recent.some(x => norm(x.replace(DATE_PREFIX, '')) === norm(s))) continue;
      f.recent.push(`${today}: ${s}`);
    }
    f.recent = f.recent.slice(-10);

    f.updatedAt = new Date().toISOString();
    await this.persist();
  }

  /** Remove every fact whose text contains the phrase. Returns the count removed. */
  async forget(phrase: string): Promise<number> {
    const q = norm(phrase);
    if (q.length < 3) return 0;
    const f = this.facts;
    let n = 0;
    const keep = <T>(arr: T[], text: (t: T) => string): T[] =>
      arr.filter(t => { const hit = norm(text(t)).includes(q); if (hit) n++; return !hit; });
    f.books = keep(f.books, b => `${b.title} ${b.stage || ''} ${b.goal || ''}`);
    f.people = keep(f.people, p => `${p.name} ${p.kind} ${p.book || ''} ${p.notes || ''}`);
    f.preferences = keep(f.preferences, s => s);
    f.recent = keep(f.recent, s => s);
    if (f.name && norm(f.name).includes(q)) { delete f.name; n++; }
    if (n) await this.persist();
    return n;
  }

  /** Prompt block, capped at `budget` characters. */
  render(budget = 1500): string {
    const f = this.facts;
    const lines: string[] = ['# About the author'];
    if (!f.name) {
      lines.push("You don't know the author's name yet. In your next reply, warmly ask their name and what they're working on.");
    } else {
      lines.push(`Name: ${f.name}. Use it naturally.`);
    }
    if (f.books.length) {
      lines.push('Books: ' + f.books.map(b =>
        [b.title, b.stage, b.chapter ? `ch. ${b.chapter}` : '', b.goal ? `goal: ${b.goal}` : ''].filter(Boolean).join(' · ')).join('; '));
    }
    if (f.people.length) {
      lines.push('People: ' + f.people.map(p =>
        [p.name, p.kind, p.book, p.notes].filter(Boolean).join(', ')).join('; '));
    }
    if (f.preferences.length) lines.push('Preferences: ' + f.preferences.join('; '));
    if (f.recent.length) lines.push('Recently: ' + f.recent.slice(-5).join('; '));
    let out = lines.join('\n');
    if (out.length > budget) out = out.slice(0, budget - 1) + '…';
    return out;
  }

  /**
   * Run the extractor over one exchange. `complete` is any function that takes
   * (system, user) and returns the model's text; the pipeline passes a thin
   * wrapper around aiRouter.complete on the cheapest provider.
   */
  async extractFromTurn(
    userMessage: string,
    assistantReply: string,
    complete: (system: string, user: string) => Promise<string>,
  ): Promise<void> {
    const user = `USER SAID:\n${userMessage.slice(0, 3000)}\n\nASSISTANT REPLIED:\n${assistantReply.slice(0, 1500)}`;
    let text: string;
    try { text = await complete(EXTRACT_SYSTEM_PROMPT, user); } catch (err) { logger.debug('facts extract failed', err); return; }
    const parsed = parseJsonLoose(text);
    if (!isObj(parsed)) return;
    try {
      await this.merge(parsed as PartialFacts);
    } catch (err) {
      logger.debug('facts merge failed', err);
    }
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.facts, null, 2));
    await rename(tmp, this.file);
  }
}

/** Copy an unreadable file aside so it is never silently overwritten. */
async function quarantine(file: string): Promise<void> {
  const dest = `${file}.corrupt-${Date.now()}`;
  try {
    await copyFile(file, dest);
  } catch (err) {
    logger.warn(`could not quarantine ${file}`, err);
  }
}

function stripUndefined<T extends Record<string, any>>(o: T): Partial<T> {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

/** Accepts raw JSON, a ```json fence, or JSON embedded in prose. Returns null on failure. */
export function parseJsonLoose(text: string): any | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  return null;
}
