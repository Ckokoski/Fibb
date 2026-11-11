// app/src/lib/tasks.ts — tasks, ideas, the morning brief, approvals and schedules.
import { useCallback, useEffect, useRef, useState } from 'react';

export type TaskKind = 'task' | 'idea';
export type TaskStatus = 'queued' | 'running' | 'review' | 'done' | 'discarded' | 'failed';
export interface Task {
  id: string; title: string; detail: string; kind: TaskKind; status: TaskStatus; when: 'tonight' | 'now';
  source: 'chat' | 'app' | 'schedule'; progress: number; result?: string; error?: string;
  createdAt: string; startedAt?: string; finishedAt?: string;
}
export interface Approval { id: string; service: string; action: string; description: string; riskLevel: string; createdAt: string; status: string }
export interface Schedule { id: string; name: string; schedule: string; handler: string; enabled: boolean; payload?: { title?: string; detail?: string }; lastRunAt?: string | null; nextRunAt?: string | null }

async function j<T>(url: string, init?: RequestInit, fallback?: T): Promise<T> {
  try {
    const r = await fetch(url, init);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { if (fallback !== undefined) return fallback; throw new Error(body.error || `HTTP ${r.status}`); }
    return body as T;
  } catch (e) { if (fallback !== undefined) return fallback; throw e; }
}
const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const getTasks = () => j<{ tasks: Task[] }>('/api/tasks', undefined, { tasks: [] }).then(r => r.tasks || []);
export const addTask = (t: { title: string; detail?: string; kind?: TaskKind; when?: 'tonight' | 'now' }) => j<{ task: Task }>('/api/tasks', post(t)).then(r => r.task);
export const patchTask = (id: string, patch: Partial<Pick<Task, 'status' | 'title' | 'detail' | 'kind'>>) =>
  j<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}`, { ...post(patch), method: 'PATCH' }).then(r => r.task);
export const deleteTask = (id: string) => j<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }, { ok: false });
export const runQueued = () => j<{ started: number; busy?: boolean }>('/api/tasks/run', post(), { started: 0 });
export const getApprovals = () => j<{ approvals: Approval[] }>('/api/approvals', undefined, { approvals: [] }).then(r => r.approvals || []);
export const approve = (id: string) => j<{ ok: boolean; outcome?: string; error?: string }>(`/api/approvals/${encodeURIComponent(id)}/approve`, post(), { ok: false, error: 'Could not approve' });
export const reject = (id: string) => j<{ ok: boolean }>(`/api/approvals/${encodeURIComponent(id)}/reject`, post(), { ok: false });

export const getSchedules = () => j<{ jobs: Schedule[] }>('/api/cron', undefined, { jobs: [] })
  .then(r => (r.jobs || []).filter(s => s.handler === 'queue-task' || s.handler === 'night-shift'));
export const addSchedule = (title: string, detail: string, schedule: string) =>
  j<{ job: Schedule }>('/api/cron', post({ name: title, schedule, handler: 'queue-task', payload: { title, detail } })).then(r => r.job);
export const deleteSchedule = (id: string) => j<{ ok?: boolean }>(`/api/cron/${encodeURIComponent(id)}`, { method: 'DELETE' }, {});

export const SCHEDULE_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every morning at 7', cron: '0 7 * * *' },
  { label: 'Weekdays at 7 in the morning', cron: '0 7 * * 1-5' },
  { label: 'Every evening at 9', cron: '0 21 * * *' },
  { label: 'Every Monday at 8', cron: '0 8 * * 1' },
  { label: 'First of the month at 8', cron: '0 8 1 * *' },
];
export function describeCron(cron: string): string {
  return SCHEDULE_PRESETS.find(p => p.cron === cron)?.label ?? (cron === '0 2 * * *' ? 'Every night at 2' : cron);
}

/** Splits tasks into the groups every screen needs. */
export function groupTasks(tasks: Task[]) {
  const work = tasks.filter(t => t.kind === 'task');
  return {
    running: work.filter(t => t.status === 'running'),
    queued: work.filter(t => t.status === 'queued'),
    review: work.filter(t => t.status === 'review'),
    failed: work.filter(t => t.status === 'failed'),
    done: work.filter(t => t.status === 'done'),
    ideas: tasks.filter(t => t.kind === 'idea' && t.status !== 'discarded'),
  };
}

/** Live tasks and approvals. Polls quickly while something is running, slowly otherwise. */
export function useWork(refreshKey = 0) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const busy = useRef(false);
  const reload = useCallback(async () => {
    const [t, a] = await Promise.all([getTasks(), getApprovals()]);
    busy.current = t.some(x => x.status === 'running');
    setTasks(t); setApprovals(a);
  }, []);
  useEffect(() => {
    let alive = true; let id = 0;
    const loop = async () => { await reload(); if (alive) id = window.setTimeout(loop, busy.current ? 2500 : 15000); };
    void loop();
    return () => { alive = false; window.clearTimeout(id); };
  }, [reload, refreshKey]);
  return { tasks, approvals, reload };
}
