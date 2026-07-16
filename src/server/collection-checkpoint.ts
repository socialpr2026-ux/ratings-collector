import type { RunState } from "../shared/types.js";
import { RunActivityTracker } from "./runtime-activity.js";

// The Agent lease is 3,700,000 ms. Reconcile only after it has certainly
// expired, so a slow but live worker can never be mistaken for a dead one.
export const STALE_COLLECTION_CHECKPOINT_MS = 65 * 60 * 1000;
export const STALE_COLLECTION_CHECKPOINT_ERROR = "collection_checkpoint_stale";

export function reconcileStaleCollectionCheckpoint(
  run: RunState,
  now = new Date()
): boolean {
  if (run.status !== "queued" && run.status !== "running") return false;
  const updatedAt = Date.parse(run.updatedAt);
  if (!Number.isFinite(updatedAt) || now.getTime() - updatedAt < STALE_COLLECTION_CHECKPOINT_MS) return false;

  const nowIso = now.toISOString();
  const activeIds = new Set(run.activity?.active.map((item) => item.id) ?? []);
  new RunActivityTracker(run, () => nowIso);
  if (run.activity && activeIds.size > 0) {
    run.activity.recent = run.activity.recent.map((item) => activeIds.has(item.id)
      ? { ...item, detail: "Collection checkpoint stopped advancing; retry required" }
      : item);
  }
  run.status = "failed";
  run.updatedAt = nowIso;
  delete run.progress.current;
  run.errors = run.errors.filter((item) =>
    !(item.partition === "orchestrator" && item.message.startsWith(STALE_COLLECTION_CHECKPOINT_ERROR))
  );
  run.errors.push({
    partition: "orchestrator",
    message: `${STALE_COLLECTION_CHECKPOINT_ERROR}: no progress since ${new Date(updatedAt).toISOString()}; retry starts a new Agent execution`
  });
  return true;
}
