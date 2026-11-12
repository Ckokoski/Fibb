/**
 * Approval executors (Fibb P4c). A tiny registry mapping a confirmation
 * request's `service` to the function that carries out the approved action.
 * The approve route runs the matching executor (if any) right after the
 * author approves. Nothing is registered yet; later changes add executors.
 */
import type { ConfirmationGateService, ConfirmationRequest } from './confirmation-gate.js';

export type ApprovalExecutor = (req: ConfirmationRequest) => Promise<string>;

const executors = new Map<string, ApprovalExecutor>();
/** Ids whose executor has been started. An approved action runs at most once per process. */
const started = new Set<string>();
const STARTED_MAX = 5000;

export function registerApprovalExecutor(service: string, fn: ApprovalExecutor): void {
  executors.set(service, fn);
}

export function hasApprovalExecutor(service: string): boolean {
  return executors.has(service);
}

/** Test helper. */
export function clearApprovalExecutors(): void {
  executors.clear();
  started.clear();
}

/**
 * Run the executor registered for req.service. Returns its outcome message,
 * or null when none is registered. When a gate is passed, the outcome is
 * recorded on the request (success -> 'completed', throw -> 'failed'). A
 * failing executor rethrows after recording.
 *
 * Refuses (throws, without calling the executor) any request that is not in
 * the 'approved' state or whose executor was already started.
 */
export async function runApprovalExecutor(
  req: ConfirmationRequest,
  gate?: Pick<ConfirmationGateService, 'recordOutcome'>,
): Promise<string | null> {
  const fn = executors.get(req.service);
  if (!fn) return null;
  // Only a request the author approved may run: never pending, rejected,
  // expired, or one that already ran (completed / failed).
  if (req?.status !== 'approved') {
    throw new Error(`This request cannot run: it is ${String(req?.status || 'unknown')}.`);
  }
  if (started.has(req.id)) throw new Error('This request has already been carried out.');
  if (started.size >= STARTED_MAX) started.clear();
  started.add(req.id);
  const record = async (success: boolean, message: string) => {
    if (!gate) return;
    try {
      await gate.recordOutcome(req.id, { success, message, executedAt: new Date().toISOString() });
    } catch { /* outcome bookkeeping must not mask the executor result */ }
  };
  try {
    const message = String((await fn(req)) ?? '');
    await record(true, message);
    return message;
  } catch (err) {
    await record(false, String((err as any)?.message || err).slice(0, 500));
    throw err;
  }
}
