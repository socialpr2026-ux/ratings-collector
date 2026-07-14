const QUERY_SECRET = /([?&](?:access_token|api[_-]?key|token|key|auth|authorization|password|secret)=)[^&#\s"'<>]+/gi;
const JSON_SECRET = /(["'](?:X-Access-Token|Authorization|envdAccessToken|access_token|api[_-]?key|token|password|secret)["']\s*:\s*["'])[^"']+(["'])/gi;
const NAMED_SECRET = /((?:X-Access-Token|Authorization|envdAccessToken|access_token|api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"'<>]+/gi;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+\/-]+/gi;
const RECOGNIZABLE_SECRET = /\b(?:sk|apify_api)[-_][A-Za-z0-9._~-]{12,}\b/gi;

/**
 * Converts unknown errors to a bounded message that is safe to persist or
 * return from an API. Browser/HTTP errors often include credential-bearing
 * URLs, so redaction happens at the final trust boundary as well as at logs.
 */
export function safeErrorMessage(error: unknown, maxLength = 2_000): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(QUERY_SECRET, "$1[redacted]")
    .replace(JSON_SECRET, "$1[redacted]$2")
    .replace(NAMED_SECRET, "$1[redacted]")
    .replace(BEARER_SECRET, "Bearer [redacted]")
    .replace(RECOGNIZABLE_SECRET, "[redacted]")
    .slice(0, Math.max(0, maxLength));
}
