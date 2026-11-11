/**
 * Night shift (Fibb P4c). Runs queued work orders from the TaskStore without
 * the author present and leaves each result in 'review' for the morning brief.
 * The actual model call is injected (`run`) so this stays unit-testable; the
 * gateway wires it to the message pipeline on the 'night-shift' channel.
 */
import type { Task, TaskStore } from './tasks.js';
import { logger } from './logger.js';

export interface NightShiftDeps {
  tasks: TaskStore;
  run: (prompt: string, onChunk: (c: string) => void) => Promise<string>;
  notify?: (text: string) => void;
  onUpdate?: (t: Task) => void;
  now?: () => Date;
}

export interface RunQueuedResult {
  started: number;
  finished: number;
  failed: number;
  busy?: boolean;
}

const PROGRESS_WRITE_MS = 500;

export function buildWorkOrderPrompt(title: string, detail: string): string {
  return (
    'Work order from the author, to be done without them present.\n' +
    `Task: ${title}\n` +
    `${detail}\n\n` +
    'Do the work now and return the finished result in Markdown. Start with a one-line summary. ' +
    'If you need something only the author can provide, list it under "Questions for you" at the end instead of guessing.'
  );
}

export function buildMorningMessage(titles: string[], failed = 0): string {
  const n = titles.length;
  let msg =
    `Morning. I finished ${n} ${n === 1 ? 'thing' : 'things'} while you were away: ${titles.join('; ')}. ` +
    (n === 1 ? "It's waiting for your review." : "They're waiting for your review.");
  if (failed > 0) msg += ` ${failed} ${failed === 1 ? 'task' : 'tasks'} did not finish and ${failed === 1 ? 'is' : 'are'} marked failed.`;
  return msg;
}

export class NightShift {
  private queueRunning = false;
  private active = new Set<string>();

  constructor(private deps: NightShiftDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** True while a queue run or any single task is in flight. */
  isBusy(): boolean {
    return this.queueRunning || this.active.size > 0;
  }

  private async patch(id: string, patch: Parameters<TaskStore['update']>[1]): Promise<Task | null> {
    try {
      const t = await this.deps.tasks.update(id, patch);
      if (t) {
        try { this.deps.onUpdate?.(t); } catch (err) { logger.debug('night-shift onUpdate failed', err); }
      }
      return t;
    } catch (err) {
      logger.warn(`night-shift could not update task ${id}: ${(err as any)?.message || err}`);
      return null;
    }
  }

  /**
   * Run one task to completion. Never throws. Returns the final task, or null
   * when the id is unknown, is an idea, or is already running.
   */
  async runTask(id: string): Promise<Task | null> {
    try {
      const task = this.deps.tasks.get(id);
      if (!task || task.kind !== 'task' || task.status === 'running' || this.active.has(id)) return null;
      this.active.add(id);
      try {
        await this.patch(id, {
          status: 'running', progress: 5, startedAt: this.now().toISOString(),
          result: undefined, error: undefined, finishedAt: undefined,
        });
        let chars = 0;
        let lastWrite = this.now().getTime();
        let lastProgress = 5;
        const onChunk = (c: string) => {
          chars += typeof c === 'string' ? c.length : 0;
          const progress = 5 + Math.min(85, Math.floor(chars / 40));
          const at = this.now().getTime();
          if (progress === lastProgress || at - lastWrite < PROGRESS_WRITE_MS) return;
          lastWrite = at;
          lastProgress = progress;
          void this.patch(id, { progress });
        };
        let result = '';
        let error = '';
        try {
          result = String((await this.deps.run(buildWorkOrderPrompt(task.title, task.detail), onChunk)) ?? '').trim();
          if (!result) error = 'The model returned an empty result.';
        } catch (err) {
          error = String((err as any)?.message || err || 'Unknown error').slice(0, 300);
        }
        const finishedAt = this.now().toISOString();
        return error
          ? await this.patch(id, { status: 'failed', error, finishedAt })
          : await this.patch(id, { status: 'review', result, progress: 100, finishedAt });
      } finally {
        this.active.delete(id);
      }
    } catch (err) {
      logger.warn(`night-shift runTask(${id}) failed: ${(err as any)?.message || err}`);
      return null;
    }
  }

  /** Run queued tasks one at a time. A second call while one is in flight returns busy. */
  async runQueued({ max = 5 }: { max?: number } = {}): Promise<RunQueuedResult> {
    if (this.queueRunning) return { started: 0, finished: 0, failed: 0, busy: true };
    this.queueRunning = true;
    const out: RunQueuedResult = { started: 0, finished: 0, failed: 0 };
    const finishedTitles: string[] = [];
    try {
      const seen = new Set<string>();
      while (out.started < max) {
        const next = this.deps.tasks.nextQueued();
        if (!next || seen.has(next.id)) break;
        seen.add(next.id);
        out.started++;
        const done = await this.runTask(next.id);
        if (done?.status === 'review') {
          out.finished++;
          finishedTitles.push(done.title);
        } else {
          out.failed++;
        }
      }
    } catch (err) {
      logger.warn(`night-shift runQueued failed: ${(err as any)?.message || err}`);
    } finally {
      this.queueRunning = false;
    }
    if (out.finished > 0 && this.deps.notify) {
      try { this.deps.notify(buildMorningMessage(finishedTitles, out.failed)); } catch (err) { logger.debug('night-shift notify failed', err); }
    }
    return out;
  }
}
