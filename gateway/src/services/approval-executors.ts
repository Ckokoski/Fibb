/**
 * Approval executors (Fibb P4c). A tiny registry mapping a confirmation
 * request's `service` to the function that carries out the approved action.
 * The approve route runs the matching executor (if any) right after the
 * author approves. Nothing is registered yet; later changes add executors.
 */
import type { ConfirmationGateService, ConfirmationRequest } from './confirmation-gate.js';

export type ApprovalExecutor = (req: ConfirmationRequest) => Promise<string>;

const executors = new Map<string, ApprovalExecutor>();

export function registerApprovalExecutor(service: string, fn: ApprovalExecutor): void {
  executors.set(service, fn);
}

export function hasApprovalExecutor(service: string): boolean {
  return executors.has(service);
}

/** Test helper. */
export function clearApprovalExecutors(): void {
  executors.clear();
}

/**
 * Run the executor registered for req.service. Returns its outcome message,
 * or null when none is registered. When a gate is passed, the outcome is
 * recorded on the request (success -> 'completed', throw -> 'failed'). A
 * failing executor rethrows after recording.
 */
export async function runApprovalExecutor(
  req: ConfirmationRequest,
  gate?: Pick<ConfirmationGateService, 'recordOutcome'>,
): Promise<string | null> {
  const fn = executors.get(req.service);
  if (!fn) return null;
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
