import type { RunState } from "../shared/types.js";
import { RunActivityTracker } from "./runtime-activity.js";

// Collection owns a 26-minute soft deadline and persists progress throughout
// long scans. Four extra minutes let the abort/final checkpoint settle while
// keeping an interrupted employee retry from being locked for an hour.
export const STALE_COLLECTION_CHECKPOINT_MS = 30 * 60 * 1000;
// One product may use several bounded collector routes, but none of those
// routes can legitimately keep the same collection/normalization activity
// open for five minutes. Recover that narrow dead execution promptly without
// treating a long, still-checkpointing sitemap discovery as abandoned.
export const STALE_PRODUCT_COLLECTION_CHECKPOINT_MS = 5 * 60 * 1000;
export const STALE_COLLECTION_CHECKPOINT_ERROR = "collection_checkpoint_stale";
// Sheet publication uses a five-minute lease. Reconcile only after that lease
// has certainly expired so an active writer is never mistaken for a dead one.
export const STALE_PUBLICATION_CHECKPOINT_MS = 6 * 60 * 1000;
export const STALE_PUBLICATION_CHECKPOINT_ERROR = "publication_checkpoint_stale";

export function reconcileStaleCollectionCheckpoint(
  run: RunState,
  now = new Date()
): boolean {
  if (run.status !== "queued" && run.status !== "running") return false;
  const updatedAt = Date.parse(run.updatedAt);
  const oldestActiveStartedAt = Math.min(...(run.activity?.active ?? [])
    .map((item) => Date.parse(item.startedAt))
    .filter(Number.isFinite));
  const oldestActiveProductStartedAt = Math.min(...(run.activity?.active ?? [])
    .filter((item) => item.stage === "collection" || item.stage === "normalization")
    .map((item) => Date.parse(item.startedAt))
    .filter(Number.isFinite));
  const staleByCheckpoint = Number.isFinite(updatedAt) &&
    now.getTime() - updatedAt >= STALE_COLLECTION_CHECKPOINT_MS;
  const staleByActiveAttempt = Number.isFinite(oldestActiveStartedAt) &&
    now.getTime() - oldestActiveStartedAt >= STALE_COLLECTION_CHECKPOINT_MS;
  const staleByActiveProduct = Number.isFinite(oldestActiveProductStartedAt) &&
    now.getTime() - oldestActiveProductStartedAt >= STALE_PRODUCT_COLLECTION_CHECKPOINT_MS;
  if (!staleByCheckpoint && !staleByActiveAttempt && !staleByActiveProduct) return false;

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
    message: `${STALE_COLLECTION_CHECKPOINT_ERROR}: collection attempt stopped before ${new Date(
      staleByActiveProduct
        ? oldestActiveProductStartedAt
        : staleByActiveAttempt
          ? oldestActiveStartedAt
          : updatedAt
    ).toISOString()}; retry starts a new Agent execution`
  });
  return true;
}

export function reconcileStalePublicationCheckpoint(
  run: RunState,
  now = new Date()
): boolean {
  if (run.status !== "publishing") return false;
  const updatedAt = Date.parse(run.updatedAt);
  if (!Number.isFinite(updatedAt) || now.getTime() - updatedAt < STALE_PUBLICATION_CHECKPOINT_MS) return false;

  const nowIso = now.toISOString();
  run.status = "review";
  run.updatedAt = nowIso;
  run.errors = run.errors.filter((item) => item.partition !== "google-sheets-apps-script");
  run.errors.push({
    partition: "google-sheets-apps-script",
    message: `${STALE_PUBLICATION_CHECKPOINT_ERROR}: no publication checkpoint since ${new Date(updatedAt).toISOString()}; retry writes the saved result without recollecting data`
  });
  return true;
}
