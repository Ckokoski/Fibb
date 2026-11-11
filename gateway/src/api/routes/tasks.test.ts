import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerTaskRoutes } from './tasks.js';
import { TaskStore } from '../../services/tasks.js';
import { NightShift } from '../../services/night-shift.js';
import { ConfirmationGateService } from '../../services/confirmation-gate.js';
import { registerApprovalExecutor, clearApprovalExecutors } from '../../services/approval-executors.js';

type Handler = (req: any, res: any) => any;

function harness(services: any) {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (path: string, h: Handler) => { routes.set(`${m} ${path}`, h); };
  const app: any = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE') };
  registerTaskRoutes({ app, gateway: {}, services, baseDir: '' });
  const call = async (key: string, opts: { params?: any; body?: any } = {}) => {
    const res: any = { code: 200, body: undefined };
    res.status = (c: number) => { res.code = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    await routes.get(key)!({ params: opts.params || {}, body: opts.body }, res);
    return res as { code: number; body: any };
  };
  return { call, routes };
}

let dir: string;
let tasks: TaskStore;
let gate: ConfirmationGateService;
let runs: string[];
let release: () => void;
let nightShift: any;
let h: ReturnType<typeof harness>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-task-routes-'));
  tasks = new TaskStore(dir);
  await tasks.initialize();
  gate = new ConfirmationGateService(dir);
  await gate.initialize();
  runs = [];
  let hold: Promise<void> = Promise.resolve();
  release = () => {};
  nightShift = new NightShift({
    tasks,
    run: async (prompt) => { runs.push(prompt); await hold; return 'result'; },
  });
  nightShift.holdNext = () => { hold = new Promise<void>(r => { release = r; }); };
  h = harness({ tasks, nightShift, confirmationGate: gate });
  clearApprovalExecutors();
});
afterEach(() => { release(); clearApprovalExecutors(); rmSync(dir, { recursive: true, force: true }); });

const settle = () => new Promise(r => setTimeout(r, 30));
const newApproval = (service = 'email') => gate.createRequest({
  service, action: 'send', platform: 'Gmail', description: 'Send the newsletter',
  payload: { to: 'reader@example.com', body: 'private text' }, riskLevel: 'medium', isReversible: false,
});

describe('task routes', () => {
  it('503 when the store is missing', async () => {
    const bare = harness({});
    expect((await bare.call('GET /api/tasks')).code).toBe(503);
    expect((await bare.call('GET /api/approvals')).code).toBe(503);
  });

  it('POST creates (201), validates (400), GET lists', async () => {
    const r = await h.call('POST /api/tasks', { body: { title: 'Outline ch 3', detail: 'd' } });
    expect(r.code).toBe(201);
    expect(r.body.task).toMatchObject({ title: 'Outline ch 3', detail: 'd', kind: 'task', status: 'queued', when: 'tonight', source: 'app' });
    expect((await h.call('POST /api/tasks', { body: {} })).code).toBe(400);
    expect((await h.call('POST /api/tasks', { body: { title: 'x', kind: 'bogus' } })).code).toBe(400);
    expect((await h.call('POST /api/tasks', { body: { title: 'x', when: 'later' } })).code).toBe(400);
    expect((await h.call('POST /api/tasks', { body: { title: 'x', detail: 5 } })).code).toBe(400);
    const list = await h.call('GET /api/tasks');
    expect(list.body.tasks).toHaveLength(1);
    expect(runs).toEqual([]);
  });

  it('when "now" starts the task without awaiting; ideas never start', async () => {
    await h.call('POST /api/tasks', { body: { title: 'A thought', kind: 'idea', when: 'now' } });
    await settle();
    expect(runs).toEqual([]);
    const r = await h.call('POST /api/tasks', { body: { title: 'Do it', when: 'now' } });
    await settle();
    expect(runs).toHaveLength(1);
    expect(tasks.get(r.body.task.id)?.status).toBe('review');
    const brief = await h.call('GET /api/brief');
    expect(brief.body.items.map((t: any) => t.id)).toEqual([r.body.task.id]);
  });

  it('PATCH: allowed statuses only, 404, idea to task conversion, re-queue clears the last run', async () => {
    const idea = (await h.call('POST /api/tasks', { body: { title: 'A thought', kind: 'idea' } })).body.task;
    expect((await h.call('PATCH /api/tasks/:id', { params: { id: 'nope' }, body: { status: 'done' } })).code).toBe(404);
    for (const status of ['running', 'review', 'failed', 'bogus']) {
      expect((await h.call('PATCH /api/tasks/:id', { params: { id: idea.id }, body: { status } })).code).toBe(400);
    }
    expect((await h.call('PATCH /api/tasks/:id', { params: { id: idea.id }, body: {} })).code).toBe(400);
    const conv = await h.call('PATCH /api/tasks/:id', { params: { id: idea.id }, body: { kind: 'task', status: 'queued', title: 'Now work' } });
    expect(conv.body.task).toMatchObject({ kind: 'task', status: 'queued', title: 'Now work' });
    expect(tasks.nextQueued()?.id).toBe(idea.id);

    await tasks.update(idea.id, { status: 'review', result: 'r', progress: 100, finishedAt: new Date().toISOString() });
    const done = await h.call('PATCH /api/tasks/:id', { params: { id: idea.id }, body: { status: 'done' } });
    expect(done.body.task).toMatchObject({ status: 'done', result: 'r' });
    const again = await h.call('PATCH /api/tasks/:id', { params: { id: idea.id }, body: { status: 'queued' } });
    expect(again.body.task).toMatchObject({ status: 'queued', progress: 0 });
    expect(again.body.task.result).toBeUndefined();

    await tasks.update(idea.id, { status: 'running' });
    expect((await h.call('PATCH /api/tasks/:id', { params: { id: idea.id }, body: { status: 'discarded' } })).code).toBe(409);
  });

  it('DELETE removes, 404 when unknown', async () => {
    const t = (await h.call('POST /api/tasks', { body: { title: 'x' } })).body.task;
    expect((await h.call('DELETE /api/tasks/:id', { params: { id: t.id } })).body).toEqual({ ok: true });
    expect((await h.call('DELETE /api/tasks/:id', { params: { id: t.id } })).code).toBe(404);
  });

  it('POST /api/tasks/run reports queued count and busy', async () => {
    expect((await h.call('POST /api/tasks/run')).body).toEqual({ started: 0, busy: false });
    await h.call('POST /api/tasks', { body: { title: 'one' } });
    await h.call('POST /api/tasks', { body: { title: 'two' } });
    await h.call('POST /api/tasks', { body: { title: 'thought', kind: 'idea' } });
    // Hold the model call so the second request sees a busy shift.
    nightShift.holdNext();
    expect((await h.call('POST /api/tasks/run')).body).toEqual({ started: 2, busy: false });
    await settle();
    expect((await h.call('POST /api/tasks/run')).body).toEqual({ started: 0, busy: true });
    release();
    await settle();
    await settle();
    expect(tasks.list().filter(t => t.status === 'review')).toHaveLength(2);
    const brief = await h.call('GET /api/brief');
    expect(brief.body.items).toHaveLength(2);
    expect(brief.body.items[0].finishedAt >= brief.body.items[1].finishedAt).toBe(true);
  });
});

describe('approval routes', () => {
  it('lists pending approvals without the payload', async () => {
    const a = await newApproval();
    const b = await newApproval();
    await gate.reject(b.id, 'user');
    const r = await h.call('GET /api/approvals');
    expect(r.body.approvals).toHaveLength(1);
    expect(Object.keys(r.body.approvals[0]).sort()).toEqual(['action', 'createdAt', 'description', 'id', 'riskLevel', 'service', 'status']);
    expect(r.body.approvals[0]).toMatchObject({ id: a.id, service: 'email', action: 'send', status: 'pending', riskLevel: 'medium' });
    expect(JSON.stringify(r.body)).not.toContain('private text');
  });

  it('approve with no executor: ok, request stays approved; second approve is 409', async () => {
    const a = await newApproval();
    expect((await h.call('POST /api/approvals/:id/approve', { params: { id: a.id } })).body).toEqual({ ok: true });
    expect(gate.get(a.id)?.status).toBe('approved');
    expect((await h.call('POST /api/approvals/:id/approve', { params: { id: a.id } })).code).toBe(409);
    expect((await h.call('POST /api/approvals/:id/reject', { params: { id: a.id } })).code).toBe(409);
  });

  it('approve runs a registered executor and records the outcome', async () => {
    const seen: string[] = [];
    registerApprovalExecutor('email', async (req) => { seen.push(req.id); return 'Sent to 1 reader'; });
    const a = await newApproval();
    const r = await h.call('POST /api/approvals/:id/approve', { params: { id: a.id } });
    expect(r.body).toEqual({ ok: true, outcome: 'Sent to 1 reader' });
    expect(seen).toEqual([a.id]);
    expect(gate.get(a.id)).toMatchObject({ status: 'completed', outcome: { success: true, message: 'Sent to 1 reader' } });
  });

  it('a failing executor returns 500 and records failure', async () => {
    registerApprovalExecutor('email', async () => { throw new Error('smtp down'); });
    const a = await newApproval();
    const r = await h.call('POST /api/approvals/:id/approve', { params: { id: a.id } });
    expect(r.code).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'smtp down' });
    expect(gate.get(a.id)).toMatchObject({ status: 'failed', outcome: { success: false, message: 'smtp down' } });
  });

  it('reject: ok, never runs the executor; unknown ids are 404', async () => {
    let ran = 0;
    registerApprovalExecutor('email', async () => { ran++; return 'x'; });
    const a = await newApproval();
    expect((await h.call('POST /api/approvals/:id/reject', { params: { id: a.id }, body: { reason: 'not now' } })).body).toEqual({ ok: true });
    expect(gate.get(a.id)?.status).toBe('rejected');
    expect(ran).toBe(0);
    expect((await h.call('POST /api/approvals/:id/approve', { params: { id: 'nope' } })).code).toBe(404);
    expect((await h.call('POST /api/approvals/:id/reject', { params: { id: 'nope' } })).code).toBe(404);
  });
});
