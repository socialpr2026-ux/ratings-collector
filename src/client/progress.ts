import type { RunState, RunSummaryV2 } from "../shared/types.js";

export const MIN_PROGRESS_POLL_MS = 2_500;
export const MAX_PROGRESS_POLL_MS = 10_000;

export function nextProgressPollDelay(current: number, changed: boolean): number {
  if (changed) return MIN_PROGRESS_POLL_MS;
  return Math.min(MAX_PROGRESS_POLL_MS, Math.max(MIN_PROGRESS_POLL_MS, current) * 2);
}

export function applyRunSummary(run: RunState, summary: RunSummaryV2): RunState {
  if (run.id !== summary.id) throw new Error("Progress summary belongs to another run");
  return {
    ...run,
    status: summary.status,
    updatedAt: summary.updatedAt,
    collectionStartedAt: summary.collectionStartedAt,
    collectionFinishedAt: summary.collectionFinishedAt,
    progress: summary.progress,
    activity: summary.activity
  };
}
