import type { RunState } from "../shared/types.js";

export const MAX_AUTOMATIC_CONTINUATIONS = 3;

const timeoutFailure = /run_deadline_exceeded|the operation was aborted due to timeout/i;
const unsafeAutomaticRetry = /quota(?:_exceeded)?|\blease\b|reserveUsage|releaseUsage|acquireLease|releaseLease|publish(?:ing|ed)?|квот|аренд|публикац/iu;

export type ContinuationDecision = {
  eligible: boolean;
  reason: "eligible" | "not_timeout" | "no_progress" | "unsafe" | "limit";
};

export type AutomaticContinuationNotice = {
  attempt: number;
  maxAttempts: number;
  completedPartitions: number;
  totalPartitions: number;
};

export type CollectionAttemptResult = { run: RunState; error?: unknown };

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function checkpointContinuationDecision(
  previous: RunState,
  current: RunState,
  continuationsUsed: number,
  maxContinuations = MAX_AUTOMATIC_CONTINUATIONS
): ContinuationDecision {
  if (continuationsUsed >= maxContinuations) return { eligible: false, reason: "limit" };
  const messages = current.errors.map((item) => item.message);
  const timedOut = current.status === "failed" && current.errors.some((item) =>
    item.partition === "orchestrator" && timeoutFailure.test(item.message)
  );
  if (!timedOut) return { eligible: false, reason: "not_timeout" };
  if (messages.some((message) => unsafeAutomaticRetry.test(message))) {
    return { eligible: false, reason: "unsafe" };
  }
  const progressed = current.progress.completedPartitions > previous.progress.completedPartitions &&
    timestamp(current.updatedAt) > timestamp(previous.updatedAt);
  return progressed ? { eligible: true, reason: "eligible" } : { eligible: false, reason: "no_progress" };
}

/**
 * Re-enters only a checkpointed, idempotent collection run. The caller owns
 * the actual Agent request; this loop never invokes publishing, quota or lease
 * operations directly and stops before retrying a run that reports them.
 */
export async function collectWithCheckpointContinuation(
  initial: RunState,
  executeAttempt: (checkpoint: RunState) => Promise<CollectionAttemptResult>,
  onContinuation?: (notice: AutomaticContinuationNotice) => void,
  maxContinuations = MAX_AUTOMATIC_CONTINUATIONS
): Promise<CollectionAttemptResult & { continuations: number }> {
  let checkpoint = initial;
  let continuations = 0;
  for (;;) {
    const result = await executeAttempt(checkpoint);
    if (["review", "published"].includes(result.run.status)) {
      // A dropped HTTP response after a completed server transition is safe to
      // ignore. An unchanged terminal checkpoint means the Agent never
      // started (for example, lease rejection), so its error must remain.
      const terminalAdvanced = timestamp(result.run.updatedAt) > timestamp(checkpoint.updatedAt);
      return !result.error || terminalAdvanced
        ? { ...result, error: undefined, continuations }
        : { ...result, continuations };
    }
    if (result.run.status !== "failed") return { ...result, continuations };
    const decision = checkpointContinuationDecision(checkpoint, result.run, continuations, maxContinuations);
    if (!decision.eligible) return { ...result, continuations };
    continuations += 1;
    checkpoint = result.run;
    onContinuation?.({
      attempt: continuations,
      maxAttempts: maxContinuations,
      completedPartitions: checkpoint.progress.completedPartitions,
      totalPartitions: checkpoint.progress.totalPartitions
    });
  }
}
