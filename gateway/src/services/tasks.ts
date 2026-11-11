/**
 * Task store (Fibb P4c, night shift). A small durable list of work orders and
 * ideas, persisted to workspace/tasks.json. Tasks are run by NightShift; ideas
 * are only ever stored (nextQueued() never returns one) until the author
 * converts one into a task.
 */
import { mkdir, readFile, writeFile, rename, copyFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

export type TaskKind = 'task' | 'idea';
export type TaskStatus = 'queued' | 'running' | 'review' | 'done' | 'discarded' | 'failed';
export type TaskWhen = 'tonight' | 'now';
export type TaskSource = 'chat' | 'app' | 'schedule';

export interface Task {
  id: string;
  title: string;
  detail: string;
  kind: TaskKind;
  status: TaskStatus;
  when: TaskWhen;
  source: TaskSource;
  progress: number;
  result?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AddTaskInput {
  title: string;
  detail?: string;
  kind?: TaskKind;
  when?: TaskWhen;
  source?: TaskSource;
}

/** Patch for update(). A key explicitly set to undefined is removed. */
export type TaskPatch = Partial<Omit<Task, 'id' | 'createdAt'>>;

export const MAX_TASKS = 500;
export const MAX_TITLE = 200;
export const MAX_DETAIL = 8000;

const KINDS: TaskKind[] = ['task', 'idea'];
const STATUSES: TaskStatus[] = ['queued', 'running', 'review', 'done', 'discarded', 'failed'];
const WHENS: TaskWhen[] = ['tonight', 'now'];
const SOURCES: TaskSource[] = ['chat', 'app', 'schedule'];

const cleanTitle = (v: unknown): string =>
  (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
const cleanDetail = (v: unknown): string => (typeof v === 'string' ? v : '').trim().slice(0, MAX_DETAIL);

/** Validate one persisted entry. Returns null when unusable. */
function cleanTask(v: any): Task | null {
  if (typeof v !== 'object' || v === null) return null;
  const title = cleanTitle(v.title);
  if (typeof v.id !== 'string' || !v.id || !title) return null;
  const t: Task = {
    id: v.id,
    title,
    detail: cleanDetail(v.detail),
    kind: KINDS.includes(v.kind) ? v.kind : 'task',
    status: STATUSES.includes(v.status) ? v.status : 'queued',
    when: WHENS.includes(v.when) ? v.when : 'tonight',
    source: SOURCES.includes(v.source) ? v.source : 'app',
    progress: Number.isFinite(v.progress) ? Math.max(0, Math.min(100, Number(v.progress))) : 0,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString(),
  };
  for (const k of ['result', 'error', 'startedAt', 'finishedAt'] as const) {
    if (typeof v[k] === 'string') t[k] = v[k];
  }
  return t;
}

export class TaskStore {
  private file: string;
  /** Insertion order = creation order (oldest first). */
  private tasks: Task[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(workspaceDir: string) {
    this.file = join(workspaceDir, 'tasks.json');
  }

  async initialize(): Promise<void> {
    this.tasks = [];
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(await readFile(this.file, 'utf-8'));
        if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.tasks)) {
          throw new Error('tasks.json has no tasks array');
        }
        this.tasks = parsed.tasks.map(cleanTask).filter((t: Task | null): t is Task => t !== null);
      } catch (err) {
        logger.warn(`tasks.json is corrupt, starting empty: ${(err as any)?.message || err}`);
        await quarantine(this.file);
        this.tasks = [];
      }
    }
    await this.recoverInterrupted();
  }

  /** All entries, newest first. */
  list(): Task[] {
    return this.tasks.map(t => ({ ...t })).reverse();
  }

  get(id: string): Task | undefined {
    const t = this.tasks.find(x => x.id === id);
    return t ? { ...t } : undefined;
  }

  async add(input: AddTaskInput): Promise<Task> {
    const title = cleanTitle(input?.title);
    if (!title) throw new Error('title is required');
    if (input.kind !== undefined && !KINDS.includes(input.kind)) throw new Error('kind must be "task" or "idea"');
    if (input.when !== undefined && !WHENS.includes(input.when)) throw new Error('when must be "tonight" or "now"');
    if (input.source !== undefined && !SOURCES.includes(input.source)) throw new Error('invalid source');
    const task: Task = {
      id: `task-${Date.now().toString(36)}-${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title,
      detail: cleanDetail(input.detail),
      kind: input.kind ?? 'task',
      status: 'queued',
      when: input.when ?? 'tonight',
      source: input.source ?? 'app',
      progress: 0,
      createdAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    this.enforceCap();
    await this.persist();
    return { ...task };
  }

  /** Apply a patch. Returns the updated task, or null when the id is unknown. */
  async update(id: string, patch: TaskPatch): Promise<Task | null> {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return null;
    const p: Record<string, any> = { ...patch };
    delete p.id;
    delete p.createdAt;
    if ('title' in p) {
      const title = cleanTitle(p.title);
      if (!title) throw new Error('title is required');
      p.title = title;
    }
    if ('detail' in p) p.detail = cleanDetail(p.detail);
    if ('kind' in p && !KINDS.includes(p.kind)) throw new Error('kind must be "task" or "idea"');
    if ('status' in p && !STATUSES.includes(p.status)) throw new Error('invalid status');
    if ('progress' in p) p.progress = Math.max(0, Math.min(100, Math.round(Number(p.progress) || 0)));
    // Mutate synchronously (before the first await) so concurrent updates
    // apply in call order.
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) delete (t as any)[k];
      else (t as any)[k] = v;
    }
    const snapshot = { ...t };
    await this.persist();
    return snapshot;
  }

  async remove(id: string): Promise<boolean> {
    const i = this.tasks.findIndex(x => x.id === id);
    if (i < 0) return false;
    this.tasks.splice(i, 1);
    await this.persist();
    return true;
  }

  /** Oldest queued entry of kind 'task'. Ideas are never returned. */
  nextQueued(): Task | undefined {
    const t = this.tasks.find(x => x.kind === 'task' && x.status === 'queued');
    return t ? { ...t } : undefined;
  }

  /** Any task left 'running' by a previous process goes back to 'queued'. */
  async recoverInterrupted(): Promise<number> {
    let n = 0;
    for (const t of this.tasks) {
      if (t.status !== 'running') continue;
      t.status = 'queued';
      t.progress = 0;
      delete t.startedAt;
      n++;
    }
    if (n) await this.persist();
    return n;
  }

  /** Keep at most MAX_TASKS: drop oldest done/discarded, then failed, then oldest non-running. */
  private enforceCap(): void {
    const dropOldest = (pred: (t: Task) => boolean): boolean => {
      const i = this.tasks.findIndex(pred);
      if (i < 0) return false;
      this.tasks.splice(i, 1);
      return true;
    };
    while (this.tasks.length > MAX_TASKS) {
      if (dropOldest(t => t.status === 'done' || t.status === 'discarded')) continue;
      if (dropOldest(t => t.status === 'failed')) continue;
      if (dropOldest(t => t.status !== 'running')) continue;
      break;
    }
  }

  private persist(): Promise<void> {
    const data = JSON.stringify({ tasks: this.tasks }, null, 2);
    const next = this.writeChain.then(async () => {
      await mkdir(join(this.file, '..'), { recursive: true });
      await writeAtomic(this.file, data);
    });
    this.writeChain = next.catch(() => {});
    return next;
  }
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

async function quarantine(file: string): Promise<void> {
  const dest = `${file}.corrupt-${Date.now()}`;
  try {
    await copyFile(file, dest);
  } catch (err) {
    logger.warn(`could not quarantine ${file}`, err);
  }
}
