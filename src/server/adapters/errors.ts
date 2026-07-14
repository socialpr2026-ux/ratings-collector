export class AdapterBlockedError extends Error {
  readonly code = "blocked";
}

export class AdapterQuotaError extends Error {
  readonly code = "quota_exceeded";
}

export class ParserChangedError extends Error {
  readonly code = "parser_changed";
}

