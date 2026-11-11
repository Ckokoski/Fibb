import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { runApprovalExecutor } from '../../services/approval-executors.js';

const CLIENT_STATUSES = ['done', 'discarded', 'queued'];
const KINDS = ['task', 'idea'];
const WHENS = ['tonight', 'now'];
const RUN_MAX = 5;

/** Tasks + ideas, the morning brief, and approvals (confirmation gate). */
export function registerTaskRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;
  const noTasks = (res: Response) => res.status(503).json({ error: 'Task store not initialized' });
  const noGate = (res: Response) => res.status(503).json({ error: 'Confirmation gate not initialized' });

  app.get('/api/tasks', (_req: Request, res: Response) => {
    if (!services.tasks) return noTasks(res);
    res.json({ tasks: services.tasks.list() });
  });

  app.post('/api/tasks', async (req: Request, res: Response) => {
    if (!services.tasks) return noTasks(res);
    const { title, detail, kind, when } = req.body || {};
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title is required' });
    if (detail !== undefined && typeof detail !== 'string') return res.status(400).json({ error: 'detail must be a string' });
    if (kind !== undefined && !KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be "task" or "idea"' });
    if (when !== undefined && !WHENS.includes(when)) return res.status(400).json({ error: 'when must be "tonight" or "now"' });
    try {
      const task = await services.tasks.add({ title, detail, kind, when, source: 'app' });
      if (task.when === 'now' && task.kind === 'task' && services.nightShift) {
        void services.nightShift.runTask(task.id);
      }
      res.status(201).json({ task });
    } catch (err: any) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  // Registered before /api/tasks/:id routes; distinct method+path, but keep static first.
  app.post('/api/tasks/run', (_req: Request, res: Response) => {
    if (!services.tasks || !services.nightShift) return noTasks(res);
    const busy = services.nightShift.isBusy();
    const queued = services.tasks.list().filter((t: any) => t.kind === 'task' && t.status === 'queued').length;
    const started = busy ? 0 : Math.min(queued, RUN_MAX);
    if (!busy && started > 0) void services.nightShift.runQueued({ max: RUN_MAX });
    res.json({ started, busy });
  });

  app.patch('/api/tasks/:id', async (req: Request, res: Response) => {
    if (!services.tasks) return noTasks(res);
    const current = services.tasks.get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Task not found' });
    const { status, title, detail, kind } = req.body || {};
    const patch: Record<string, any> = {};
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title must be a non-empty string' });
      patch.title = title;
    }
    if (detail !== undefined) {
      if (typeof detail !== 'string') return res.status(400).json({ error: 'detail must be a string' });
      patch.detail = detail;
    }
    if (kind !== undefined) {
      if (!KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be "task" or "idea"' });
      patch.kind = kind;
    }
    if (status !== undefined) {
      if (!CLIENT_STATUSES.includes(status)) return res.status(400).json({ error: 'status must be "done", "discarded" or "queued"' });
      patch.status = status;
      if (status === 'queued') {
        // Re-queue: clear the previous run.
        Object.assign(patch, { progress: 0, result: undefined, error: undefined, startedAt: undefined, finishedAt: undefined });
      }
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' });
    if (current.status === 'running' && (patch.status !== undefined || patch.kind !== undefined)) {
      return res.status(409).json({ error: 'Task is running' });
    }
    try {
      const task = await services.tasks.update(req.params.id, patch);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({ task });
    } catch (err: any) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  app.delete('/api/tasks/:id', async (req: Request, res: Response) => {
    if (!services.tasks) return noTasks(res);
    const ok = await services.tasks.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true });
  });

  app.get('/api/brief', (_req: Request, res: Response) => {
    if (!services.tasks) return noTasks(res);
    const items = services.tasks.list()
      .filter((t: any) => t.status === 'review')
      .sort((a: any, b: any) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
    res.json({ items });
  });

  // ── Approvals (confirmation gate). The payload is never sent to the client. ──
  app.get('/api/approvals', (_req: Request, res: Response) => {
    if (!services.confirmationGate) return noGate(res);
    const approvals = services.confirmationGate.list({ status: 'pending' }).map((r: any) => ({
      id: r.id, service: r.service, action: r.action, description: r.description,
      riskLevel: r.riskLevel, createdAt: r.createdAt, status: r.status,
    }));
    res.json({ approvals });
  });

  app.post('/api/approvals/:id/approve', async (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return noGate(res);
    const existing = gate.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Approval not found' });
    if (existing.status !== 'pending') return res.status(409).json({ error: `Approval is ${existing.status}` });
    let approved: any;
    try {
      approved = await gate.approve(req.params.id, 'user');
    } catch (err: any) {
      return res.status(409).json({ error: String(err?.message || err) });
    }
    if (!approved) return res.status(404).json({ error: 'Approval not found' });
    try {
      const outcome = await runApprovalExecutor(approved, gate);
      res.json(outcome === null ? { ok: true } : { ok: true, outcome });
    } catch (err: any) {
      // Approved, but the executor failed; the gate has recorded it as 'failed'.
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.post('/api/approvals/:id/reject', async (req: Request, res: Response) => {
    const gate = services.confirmationGate;
    if (!gate) return noGate(res);
    const existing = gate.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Approval not found' });
    if (existing.status !== 'pending') return res.status(409).json({ error: `Approval is ${existing.status}` });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : undefined;
    try {
      await gate.reject(req.params.id, 'user', reason);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(409).json({ error: String(err?.message || err) });
    }
  });
}
