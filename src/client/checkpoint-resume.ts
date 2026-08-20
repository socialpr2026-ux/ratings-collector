import type { RunState } from "../shared/types.js";

export const MAX_AUTOMATIC_CONTINUATIONS = 1;
export const MAX_AUTOMATIC_COLLECTION_BUDGET_MS = 55 * 60 * 1000;
// One immediate read plus 36 normal 2.5 s poll intervals covers the observed
// delayed EdgeOne Agent start without extending the Agent execution itself.
export const AMBIGUOUS_TRIGGER_GRACE_POLLS = 37;
export const MAX_TRANSIENT_CHECKPOINT_READ_FAILURES = 3;

const timeoutFailure = /run_deadline_exceeded|the operation was aborted due to timeout/i;
const unsafeAutomaticRetry = /quota(?:_exceeded)?|\blease\b|reserveUsage|releaseUsage|acquireLease|releaseLease|publish(?:ing|ed)?|квот|аренд|публикац/iu;

export type ContinuationDecision = {
  eligible: boolean;
  reason: "eligible" | "not_timeout" | "no_progress" | "unsafe" | "limit" | "budget";
};

export type AutomaticContinuationNotice = {
  attempt: number;
  maxAttempts: number;
  completedPartitions: number;
  totalPartitions: number;
};

export type CollectionAttemptResult = { run: RunState; error?: unknown };

export type CollectionAttemptPollOptions = {
  checkpoint: RunState;
  readCheckpoint: () => Promise<RunState>;
  triggerError: () => Error | undefined;
  triggerFinished: () => boolean;
  onCheckpoint?: (run: RunState) => void;
  wait?: () => Promise<void>;
  unstartedFailurePollLimit?: number;
  transientReadFailureLimit?: number;
};

const pendingStatuses = new Set<RunState["status"]>(["queued", "running", "publishing"]);

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Observes the saved run after one collection POST. A rejected POST is
 * ambiguous: the Agent may already be running after the client connection was
 * closed. Give that transition a bounded read-only grace period, then keep
 * following a proven new checkpoint to terminal without ever issuing another
 * POST.
 */
export async function pollSavedCollectionAttempt({
  checkpoint,
  readCheckpoint,
  triggerError,
  triggerFinished,
  onCheckpoint,
  wait = () => new Promise((resolve) => setTimeout(resolve, 2500)),
  unstartedFailurePollLimit = AMBIGUOUS_TRIGGER_GRACE_POLLS,
  transientReadFailureLimit = MAX_TRANSIENT_CHECKPOINT_READ_FAILURES
}: CollectionAttemptPollOptions): Promise<RunState> {
  let lastUpdatedAt = checkpoint.updatedAt;
  let unchangedPollsAfterFailure = 0;
  let attemptStarted = false;
  let consecutiveReadFailures = 0;
  for (;;) {
    let next: RunState;
    try {
      next = await readCheckpoint();
      consecutiveReadFailures = 0;
    } catch (error) {
      consecutiveReadFailures += 1;
      if (consecutiveReadFailures > transientReadFailureLimit) throw error;
      await wait();
      continue;
    }
    onCheckpoint?.(next);
    attemptStarted ||= next.updatedAt !== checkpoint.updatedAt || next.status !== checkpoint.status;
    const failure = triggerError();
    if (!pendingStatuses.has(next.status) && (attemptStarted || (triggerFinished() && !failure))) return next;
    if (failure) {
      if (next.updatedAt === lastUpdatedAt) unchangedPollsAfterFailure += 1;
      else unchangedPollsAfterFailure = 0;
      lastUpdatedAt = next.updatedAt;
      if (!attemptStarted && unchangedPollsAfterFailure >= unstartedFailurePollLimit) return next;
    }
    await wait();
  }
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
  const collectionStartedAt = timestamp(current.collectionStartedAt ?? previous.collectionStartedAt ?? current.createdAt);
  if (timestamp(current.updatedAt) - collectionStartedAt >= MAX_AUTOMATIC_COLLECTION_BUDGET_MS) {
    return { eligible: false, reason: "budget" };
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
    const attempted = await executeAttempt(checkpoint);
    // The persisted terminal checkpoint is authoritative after an Agent
    // transition even when its long HTTP response is lost or returns a proxy
    // error. Preserve a transport error only when the checkpoint did not move,
    // which proves neither successful execution nor a saved failure.
    const terminalAdvanced = ["review", "published", "failed"].includes(attempted.run.status) &&
      timestamp(attempted.run.updatedAt) > timestamp(checkpoint.updatedAt);
    const result = attempted.error && terminalAdvanced
      ? { ...attempted, error: undefined }
      : attempted;
    if (["review", "published"].includes(result.run.status)) {
      return result.error
        ? { ...result, continuations }
        : { ...result, error: undefined, continuations };
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
