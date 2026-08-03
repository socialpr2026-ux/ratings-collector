import type { RunHistoryItem } from "../shared/types.js";

export function formatCollectionDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} сек`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} ч ${String(remainder).padStart(2, "0")} мин` : `${hours} ч`;
}

export function historyBrandLabel(brands: readonly string[]): string {
  if (brands.length <= 2) return brands.join(", ");
  return `${brands.slice(0, 2).join(", ")} +${brands.length - 2}`;
}

export function completedCollectionHistory(items: readonly RunHistoryItem[]): RunHistoryItem[] {
  return items.filter((item) => item.durationMs !== null);
}
