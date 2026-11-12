import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskStore, type Task } from './tasks.js';
import { NightShift, buildWorkOrderPrompt, buildMorningMessage } from './night-shift.js';

let dir: string;
let tasks: TaskStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-night-'));
  tasks = new TaskStore(dir);
  await tasks.initialize();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('NightShift.runTask', () => {
  it('success: review with result, progress 100 and timestamps', async () => {
    const t = await tasks.add({ title: 'Blurb', detail: 'Write three blurbs' });
    const prompts: string[] = [];
    const updates: Task[] = [];
    let clock = 1_000_000;
    const ns = new NightShift({
      tasks,
      now: () => new Date(clock),
      onUpdate: u => updates.push(u),
      run: async (prompt, onChunk) => {
        prompts.push(prompt);
        onChunk('x'.repeat(400)); // within 500 ms of start: throttled
        clock += 600;
        onChunk('x'.repeat(400)); // 800 chars -> 5 + 20
        clock += 100;
        onChunk('x'.repeat(4000)); // throttled again
        return '  Summary line\n\nBody  ';
      },
    });
    const done = await ns.runTask(t.id);
    expect(done).toMatchObject({ status: 'review', result: 'Summary line\n\nBody', progress: 100 });
    expect(done?.startedAt).toBeTruthy();
    expect(done?.finishedAt).toBeTruthy();
    expect(done?.error).toBeUndefined();
    expect(prompts[0]).toBe(buildWorkOrderPrompt('Blurb', 'Write three blurbs'));
    expect(prompts[0]).toContain('Task: Blurb\nWrite three blurbs\n\nDo the work now');
    expect(updates.map(u => u.progress)).toEqual([5, 25, 100]);
    expect(updates[0].status).toBe('running');
    expect(ns.isBusy()).toBe(false);
    expect(tasks.get(t.id)?.status).toBe('review');
  });

  it('a throw marks the task failed with a short error and never throws', async () => {
    const t = await tasks.add({ title: 'Boom' });
    const ns = new NightShift({ tasks, run: async () => { throw new Error('provider down ' + 'z'.repeat(1000)); } });
    const done = await ns.runTask(t.id);
    expect(done?.status).toBe('failed');
    expect(done?.error).toContain('provider down');
    expect(done!.error!.length).toBeLessThanOrEqual(300);
    expect(done?.finishedAt).toBeTruthy();
    expect(done?.result).toBeUndefined();
  });

  it('an empty result marks the task failed', async () => {
    const t = await tasks.add({ title: 'Nothing' });
    const done = await new NightShift({ tasks, run: async () => '   ' }).runTask(t.id);
    expect(done?.status).toBe('failed');
    expect(done?.error).toMatch(/empty/);
  });

  it('never runs ideas or unknown ids', async () => {
    const idea = await tasks.add({ title: 'A thought', kind: 'idea' });
    let calls = 0;
    const ns = new NightShift({ tasks, run: async () => { calls++; return 'x'; } });
    expect(await ns.runTask(idea.id)).toBeNull();
    expect(await ns.runTask('nope')).toBeNull();
    expect(calls).toBe(0);
    expect(tasks.get(idea.id)?.status).toBe('queued');
  });
});

describe('NightShift.runQueued', () => {
  it('runs queued tasks oldest first, skips ideas, and notifies once', async () => {
    await tasks.add({ title: 'An idea', kind: 'idea' });
    const a = await tasks.add({ title: 'Alpha' });
    const b = await tasks.add({ title: 'Beta' });
    const c = await tasks.add({ title: 'Gamma' });
    const order: string[] = [];
    const notes: string[] = [];
    const ns = new NightShift({
      tasks,
      notify: m => notes.push(m),
      run: async (prompt) => {
        const title = prompt.match(/Task: (.+)/)![1];
        order.push(title);
        if (title === 'Beta') throw new Error('nope');
        return `result for ${title}`;
      },
    });
    const r = await ns.runQueued();
    expect(r).toEqual({ started: 3, finished: 2, failed: 1 });
    expect(order).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(tasks.get(a.id)?.status).toBe('review');
    expect(tasks.get(b.id)?.status).toBe('failed');
    expect(tasks.get(c.id)?.status).toBe('review');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Morning. I finished 2 things while you were away: Alpha; Gamma. They're waiting for your review.");
    expect(notes[0]).not.toMatch(/[–—]/);
    expect(tasks.list().find(t => t.kind === 'idea')?.status).toBe('queued');
  });

  it('respects max and does not notify when nothing finished', async () => {
    await tasks.add({ title: 'One' });
    await tasks.add({ title: 'Two' });
    const notes: string[] = [];
    const ns = new NightShift({ tasks, notify: m => notes.push(m), run: async () => { throw new Error('x'); } });
    expect(await ns.runQueued({ max: 1 })).toEqual({ started: 1, finished: 0, failed: 1 });
    expect(notes).toEqual([]);
    expect(tasks.nextQueued()?.title).toBe('Two');
    const empty = new NightShift({ tasks: tasks, run: async () => 'ok' });
    await tasks.update(tasks.nextQueued()!.id, { status: 'discarded' });
    expect(await empty.runQueued()).toEqual({ started: 0, finished: 0, failed: 0 });
  });

  it('a second call while running returns busy', async () => {
    await tasks.add({ title: 'Slow' });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const ns = new NightShift({ tasks, run: async () => { await gate; return 'done'; } });
    const first = ns.runQueued();
    expect(ns.isBusy()).toBe(true);
    expect(await ns.runQueued()).toEqual({ started: 0, finished: 0, failed: 0, busy: true });
    release();
    expect(await first).toEqual({ started: 1, finished: 1, failed: 0 });
    expect(ns.isBusy()).toBe(false);
  });

  it('a throwing notify does not break the run', async () => {
    await tasks.add({ title: 'One' });
    const ns = new NightShift({ tasks, notify: () => { throw new Error('telegram down'); }, run: async () => 'ok' });
    expect(await ns.runQueued()).toEqual({ started: 1, finished: 1, failed: 0 });
  });
});

describe('buildMorningMessage', () => {
  it('uses singular wording for one item', () => {
    expect(buildMorningMessage(['Blurb'])).toBe("Morning. I finished 1 thing while you were away: Blurb. It's waiting for your review.");
  });
});
