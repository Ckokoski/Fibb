import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskStore, MAX_TASKS } from './tasks.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fibb-tasks-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function fresh(): Promise<TaskStore> {
  const s = new TaskStore(dir);
  await s.initialize();
  return s;
}

describe('TaskStore', () => {
  it('adds with defaults, trims and caps fields', async () => {
    const s = await fresh();
    const t = await s.add({ title: '  Outline   chapter 3  ' });
    expect(t).toMatchObject({ title: 'Outline chapter 3', detail: '', kind: 'task', status: 'queued', when: 'tonight', source: 'app', progress: 0 });
    expect(t.id).toBeTruthy();
    const long = await s.add({ title: 'x'.repeat(300), detail: 'y'.repeat(9000) });
    expect(long.title.length).toBe(200);
    expect(long.detail.length).toBe(8000);
  });

  it('rejects a missing title and bad enums', async () => {
    const s = await fresh();
    await expect(s.add({ title: '   ' })).rejects.toThrow(/title/);
    await expect(s.add({ title: 'a', kind: 'nope' as any })).rejects.toThrow(/kind/);
    await expect(s.add({ title: 'a', when: 'later' as any })).rejects.toThrow(/when/);
    expect(s.list()).toEqual([]);
  });

  it('lists newest first, gets, updates and removes', async () => {
    const s = await fresh();
    const a = await s.add({ title: 'first' });
    const b = await s.add({ title: 'second' });
    expect(s.list().map(t => t.title)).toEqual(['second', 'first']);
    expect(s.get(a.id)?.title).toBe('first');
    expect(s.get('nope')).toBeUndefined();

    const u = await s.update(a.id, { status: 'review', result: 'done it', progress: 100 });
    expect(u).toMatchObject({ status: 'review', result: 'done it', progress: 100 });
    const cleared = await s.update(a.id, { status: 'queued', result: undefined });
    expect(cleared && 'result' in cleared).toBe(false);
    expect(await s.update('nope', { status: 'done' })).toBeNull();
    await expect(s.update(a.id, { title: '  ' })).rejects.toThrow(/title/);

    expect(await s.remove(b.id)).toBe(true);
    expect(await s.remove(b.id)).toBe(false);
    expect(s.list().map(t => t.id)).toEqual([a.id]);
  });

  it('returns copies, not live references', async () => {
    const s = await fresh();
    const a = await s.add({ title: 'first' });
    a.title = 'mutated';
    s.list()[0].title = 'mutated';
    expect(s.get(a.id)?.title).toBe('first');
  });

  it('persists across instances', async () => {
    const s = await fresh();
    const a = await s.add({ title: 'keep me', detail: 'd', kind: 'idea', source: 'chat' });
    await s.update(a.id, { title: 'kept' });
    const s2 = await fresh();
    expect(s2.list()).toHaveLength(1);
    expect(s2.get(a.id)).toMatchObject({ title: 'kept', detail: 'd', kind: 'idea', source: 'chat' });
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('nextQueued returns the oldest queued task and skips ideas', async () => {
    const s = await fresh();
    await s.add({ title: 'an idea', kind: 'idea' });
    expect(s.nextQueued()).toBeUndefined();
    const t1 = await s.add({ title: 'task one' });
    const t2 = await s.add({ title: 'task two' });
    expect(s.nextQueued()?.id).toBe(t1.id);
    await s.update(t1.id, { status: 'done' });
    expect(s.nextQueued()?.id).toBe(t2.id);
  });

  it('recoverInterrupted re-queues running tasks on initialize', async () => {
    const s = await fresh();
    const a = await s.add({ title: 'was running' });
    const b = await s.add({ title: 'in review' });
    await s.update(a.id, { status: 'running', progress: 40, startedAt: new Date().toISOString() });
    await s.update(b.id, { status: 'review', result: 'r' });
    const s2 = await fresh();
    expect(s2.get(a.id)).toMatchObject({ status: 'queued', progress: 0 });
    expect(s2.get(a.id)?.startedAt).toBeUndefined();
    expect(s2.get(b.id)?.status).toBe('review');
    expect(await s2.recoverInterrupted()).toBe(0);
  });

  it('caps at MAX_TASKS, dropping the oldest done/discarded first', async () => {
    const tasks = [];
    for (let i = 0; i < MAX_TASKS; i++) {
      tasks.push({
        id: `t${i}`, title: `t${i}`, detail: '', kind: 'task', when: 'tonight', source: 'app', progress: 0,
        status: i === 3 ? 'done' : i === 7 ? 'discarded' : 'queued',
        createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      });
    }
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ tasks }));
    const s = await fresh();
    expect(s.list()).toHaveLength(MAX_TASKS);
    await s.add({ title: 'new one' });
    expect(s.list()).toHaveLength(MAX_TASKS);
    expect(s.get('t3')).toBeUndefined();
    expect(s.get('t7')).toBeDefined();
    expect(s.get('t0')).toBeDefined();
    await s.add({ title: 'new two' });
    expect(s.get('t7')).toBeUndefined();
    expect(s.get('t0')).toBeDefined();
    expect(s.list()[0].title).toBe('new two');
  });

  it('quarantines a corrupt file and starts empty', async () => {
    writeFileSync(join(dir, 'tasks.json'), '{ not json');
    const s = await fresh();
    expect(s.list()).toEqual([]);
    expect(readdirSync(dir).some(f => f.startsWith('tasks.json.corrupt-'))).toBe(true);
    await s.add({ title: 'works again' });
    expect(JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf-8')).tasks).toHaveLength(1);
  });

  it('serializes concurrent writes', async () => {
    const s = await fresh();
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.add({ title: `t${i}` })));
    const s2 = await fresh();
    expect(s2.list()).toHaveLength(20);
  });
});
