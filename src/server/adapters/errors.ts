export class AdapterBlockedError extends Error {
  readonly code = "blocked";
}

/**
 * A source-level proof shared by every discovered card failed before any
 * individual card could be verified. The orchestrator may stop this one
 * partition after recording the blocker once; already collected partitions
 * and cards remain durable.
 */
export class AdapterPartitionBlockedError extends AdapterBlockedError {}

export class AdapterQuotaError extends Error {
  readonly code = "quota_exceeded";
}

export class ParserChangedError extends Error {
  readonly code = "parser_changed";
}

