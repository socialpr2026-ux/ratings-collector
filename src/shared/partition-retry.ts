import type { PartitionResult } from "./types.js";

const SUCCESSFUL_PARTITION_STATUSES = new Set<PartitionResult["status"]>(["complete", "no_results"]);
const SOURCE_UNAVAILABLE = /\breview_(?:channel|aggregate)_unavailable\b/iu;
const TERMINAL_FAILURE = /(?:quota(?:_exceeded)?|квот|monthly[^.]{0,100}GB-s|лимит[^.]{0,100}(?:исчерпан|превышен)|parser_changed|CAPTCHA|HTTP\s+(?:401|403|498)\b|incomplete[^.]{0,120}(?:proof|sitemap|xml)|proof[^.]{0,120}(?:incomplete|unproven)|непол[^.]{0,120}(?:доказ|sitemap|xml)|не доказ)/iu;
const TRANSIENT_FAILURE = /(?:HTTP\s+(?:408|425|429|499|5\d\d)\b|fetch failed|network error|run_deadline_exceeded|timed?\s*out|exceeded (?:its )?deadline|econnreset|econnrefused|enotfound|eai_again)/iu;

/**
 * The exact product exists, but the source does not publish a product-bound
 * review aggregate. Re-running the same collector cannot change that fact and
 * must never manufacture a zero.
 */
export function isSourceUnavailableMessage(message: string | undefined): boolean {
  return SOURCE_UNAVAILABLE.test(message ?? "");
}

/**
 * Legacy partitions have no explicit policy bit and can contain several
 * semicolon-delimited card failures. They are terminal only when every
 * constituent failure proves the same source-unavailable condition. Any
 * mixed or unknown segment stays retryable so a recoverable card is not lost.
 */
export function isOnlySourceUnavailableMessage(message: string | undefined): boolean {
  const failures = (message ?? "").split(/;\s*/u).map((item) => item.trim()).filter(Boolean);
  return failures.length > 0 && failures.every((failure) => SOURCE_UNAVAILABLE.test(failure));
}

/**
 * Old runs predate the explicit retryable bit. Keep pure quota/parser/access
 * failures out of failed-only retry, but preserve mixed route failures (for
 * example a fixed HTTP 502 plus an exhausted browser fallback) so a newly
 * deployed free route can recover them once.
 */
export function isLegacyTerminalFailureMessage(message: string | undefined): boolean {
  const value = message?.trim() ?? "";
  return Boolean(value) && (isOnlySourceUnavailableMessage(value) ||
    TERMINAL_FAILURE.test(value) && !TRANSIENT_FAILURE.test(value));
}

/**
 * Shared server/client policy for failed-only retry. The message fallback
 * keeps runs saved before `retryable` was introduced backward compatible.
 */
export function isFailedOnlyRetryTarget(partition: PartitionResult | undefined): boolean {
  if (!partition) return true;
  if (SUCCESSFUL_PARTITION_STATUSES.has(partition.status)) return false;
  if (partition.retryable === true) return true;
  if (partition.retryable === false) return false;
  return !isLegacyTerminalFailureMessage(partition.message);
}

export function retryableFailedPartitionCount(partitions: readonly PartitionResult[]): number {
  return partitions.filter((partition) => isFailedOnlyRetryTarget(partition)).length;
}
