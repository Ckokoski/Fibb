/**
 * Facts memory (spec §3). Durable, user-visible facts about the author and
 * their work, extracted after each chat turn by a cheap model call and
 * injected at the top of every system prompt. Distinct from user-model
 * (behavioral stats) and preferences (regex-detected style rules).
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
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

export class FactsStore {
  private file: string;
  private facts: Facts = empty();

  constructor(memoryDir: string) {
    this.file = join(memoryDir, 'facts.json');
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf-8'));
      this.facts = { ...empty(), ...raw };
    } catch (err) {
      logger.warn('facts.json unreadable, starting empty', err);
      this.facts = empty();
    }
  }

  get(): Facts {
    return JSON.parse(JSON.stringify(this.facts));
  }

  async merge(p: PartialFacts): Promise<void> {
    const f = this.facts;
    if (typeof p.name === 'string' && p.name.trim()) f.name = p.name.trim();

    for (const b of p.books || []) {
      if (!b?.title) continue;
      const hit = f.books.find(x => norm(x.title) === norm(b.title));
      if (hit) Object.assign(hit, stripUndefined({ stage: b.stage, chapter: b.chapter, goal: b.goal }));
      else f.books.push({ title: b.title.trim(), ...stripUndefined({ stage: b.stage, chapter: b.chapter, goal: b.goal }) });
    }

    for (const person of p.people || []) {
      if (!person?.name) continue;
      const hit = f.people.find(x => norm(x.name) === norm(person.name));
      if (hit) Object.assign(hit, stripUndefined({ kind: person.kind, book: person.book, notes: person.notes }));
      else f.people.push({ name: person.name.trim(), kind: person.kind || 'person', ...stripUndefined({ book: person.book, notes: person.notes }) });
    }

    for (const pref of p.preferences || []) {
      const s = String(pref).trim();
      if (s && !f.preferences.some(x => norm(x) === norm(s))) f.preferences.push(s);
    }
    f.preferences = f.preferences.slice(-20);

    const today = new Date().toISOString().slice(0, 10);
    for (const r of p.recent || []) {
      const s = String(r).trim();
      if (s) f.recent.push(`${today}: ${s}`);
    }
    f.recent = f.recent.slice(-10);

    f.updatedAt = new Date().toISOString();
    await this.persist();
  }

  /** Remove every fact whose text contains the phrase. Returns the count removed. */
  async forget(phrase: string): Promise<number> {
    const q = norm(phrase);
    if (!q) return 0;
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
    if (!parsed || typeof parsed !== 'object') return;
    await this.merge(parsed as PartialFacts);
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.facts, null, 2));
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
