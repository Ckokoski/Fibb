/**
 * ToolRunner: executes tool calls made by the model.
 *
 *  - read tools run immediately (30 s timeout); the result is scanned for
 *    injection patterns and wrapped as untrusted data.
 *  - write tools NEVER run here. They create a confirmation-gate request and
 *    only run from the approval executor after the author approves.
 *  - every call is audited with the tool name and arg KEYS only.
 */
import type { ConfirmationGateService, ConfirmationRequest } from '../confirmation-gate.js';
import { registerApprovalExecutor } from '../approval-executors.js';
import { ToolRegistry, isToolAvailable, wrapToolResult, type Tool, type ToolCall } from './registry.js';

export type ToolOutcome =
  | { kind: 'result'; text: string }
  | { kind: 'needs-approval'; id: string; description: string }
  | { kind: 'error'; text: string };

export interface ToolRunnerDeps {
  registry: ToolRegistry;
  gate: Pick<ConfirmationGateService, 'createRequest'>;
  injection: { detect: (input: string) => { detected: boolean } };
  audit: { log: (category: string, action: string, data: Record<string, any>) => unknown };
  /** Timeout for read tools and approved write tools. Default 30 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PENDING = 200;
const OUTCOME_MAX_CHARS = 400;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

function hasRedaction(v: unknown): boolean {
  if (typeof v === 'string') return v === '[REDACTED]';
  if (Array.isArray(v)) return v.some(hasRedaction);
  if (v && typeof v === 'object') return Object.values(v as object).some(hasRedaction);
  return false;
}

/** First paragraph of a tool result, shortened for the approval outcome. */
function shortOutcome(text: string): string {
  const first = String(text ?? '').trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  if (!first) return 'Done.';
  return first.length > OUTCOME_MAX_CHARS ? first.slice(0, OUTCOME_MAX_CHARS - 1) + '…' : first;
}

export class ToolRunner {
  readonly registry: ToolRegistry;
  /**
   * The exact args for pending approvals, kept in memory. The gate redacts
   * anything that looks like a secret before it persists a payload, which
   * would corrupt ordinary prose (a chapter that says "password"), so the
   * executor prefers this copy and refuses a redacted one after a restart.
   */
  private pending = new Map<string, Record<string, unknown>>();

  constructor(private deps: ToolRunnerDeps) {
    this.registry = deps.registry;
  }

  private audit(action: string, data: Record<string, any>): void {
    try {
      const r = this.deps.audit.log('tool', action, data);
      if (r && typeof (r as any).catch === 'function') (r as Promise<unknown>).catch(() => {});
    } catch { /* auditing must never break a tool call */ }
  }

  async execute(call: ToolCall, ctx: { channel: string }): Promise<ToolOutcome> {
    const name = String(call?.name ?? '');
    const args = call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
    // Arg KEYS only: values may be manuscript text, email bodies or secrets.
    const base = { tool: name.slice(0, 60), argKeys: Object.keys(args).slice(0, 20), channel: ctx.channel };

    const tool = this.registry.get(name);
    if (!tool) {
      this.audit('unknown', base);
      return { kind: 'error', text: `There is no tool named "${name.slice(0, 60)}". Use only the tools listed, or answer without one.` };
    }
    if (!(await isToolAvailable(tool))) {
      this.audit('unavailable', base);
      return { kind: 'error', text: `The tool "${tool.name}" is not available right now (it may not be set up or connected). Tell the author, or answer without it.` };
    }

    if (tool.risk === 'write') {
      return this.requestApproval(tool, args, base);
    }

    try {
      const raw = String((await withTimeout(tool.run(args), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)) ?? '');
      let flagged = false;
      try { flagged = this.deps.injection.detect(raw).detected === true; } catch { flagged = false; }
      this.audit('run', { ...base, risk: 'read', ok: true, flagged, resultLength: raw.length });
      return { kind: 'result', text: wrapToolResult(tool.name, raw, flagged) };
    } catch (err) {
      const msg = String((err as any)?.message || err).replace(/\s+/g, ' ').slice(0, 200);
      this.audit('run', { ...base, risk: 'read', ok: false });
      return { kind: 'error', text: `The tool "${tool.name}" failed: ${msg}` };
    }
  }

  private async requestApproval(
    tool: Tool,
    args: Record<string, unknown>,
    base: Record<string, any>,
  ): Promise<ToolOutcome> {
    let description: string;
    let stored: Record<string, unknown>;
    try {
      description = (tool.describe?.(args) || `Run ${tool.name}`).replace(/\s+/g, ' ').trim().slice(0, 300);
      stored = tool.bind ? tool.bind(args) : args;
    } catch (err) {
      const msg = String((err as any)?.message || err).replace(/\s+/g, ' ').slice(0, 200);
      this.audit('approval-refused', base);
      return { kind: 'error', text: `The tool "${tool.name}" could not be prepared: ${msg}` };
    }
    try {
      const req = await this.deps.gate.createRequest({
        service: 'tools',
        action: tool.name,
        platform: 'fibb',
        description,
        payload: { tool: tool.name, args: stored },
        riskLevel: 'medium',
        isReversible: false,
      });
      this.pending.set(req.id, stored);
      while (this.pending.size > MAX_PENDING) {
        const oldest = this.pending.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.pending.delete(oldest);
      }
      this.audit('approval-requested', { ...base, risk: 'write', approvalId: req.id });
      return { kind: 'needs-approval', id: req.id, description };
    } catch {
      // The gate refuses requests whose text claims to be pre-approved.
      this.audit('approval-refused', { ...base, risk: 'write' });
      return {
        kind: 'error',
        text: `The approval request for "${tool.name}" was refused. The author must approve every action themselves; nothing was done.`,
      };
    }
  }

  /**
   * Carry out an approved write tool. Called only by the approval executor,
   * i.e. after the author approved the request in the app.
   */
  async runApproved(req: ConfirmationRequest): Promise<string> {
    const name = String(req?.payload?.tool ?? req?.action ?? '');
    const base = { tool: name.slice(0, 60), approvalId: req.id };
    const tool = this.registry.get(name);
    if (!tool || tool.name !== req.action) {
      this.audit('approved-run', { ...base, ok: false, reason: 'unknown tool' });
      throw new Error('That tool no longer exists.');
    }
    if (!(await isToolAvailable(tool))) {
      this.audit('approved-run', { ...base, ok: false, reason: 'unavailable' });
      throw new Error(`"${tool.name}" is not available right now. Check Settings and ask Fibb again.`);
    }
    let args = this.pending.get(req.id);
    if (!args) {
      const fromPayload = req.payload?.args;
      if (!fromPayload || typeof fromPayload !== 'object' || Array.isArray(fromPayload) || hasRedaction(fromPayload)) {
        this.audit('approved-run', { ...base, ok: false, reason: 'args unavailable' });
        throw new Error('This request is too old to run safely. Ask Fibb to do it again.');
      }
      args = fromPayload as Record<string, unknown>;
    }
    this.pending.delete(req.id);
    try {
      const out = String((await withTimeout(tool.run(args), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)) ?? '');
      this.audit('approved-run', { ...base, argKeys: Object.keys(args).slice(0, 20), ok: true });
      return shortOutcome(out);
    } catch (err) {
      this.audit('approved-run', { ...base, argKeys: Object.keys(args).slice(0, 20), ok: false });
      throw new Error(String((err as any)?.message || err).replace(/\s+/g, ' ').slice(0, 200));
    }
  }

  /** Register the approval executor for service `tools`. */
  registerApprovalExecutor(): void {
    registerApprovalExecutor('tools', (req) => this.runApproved(req));
  }
}
