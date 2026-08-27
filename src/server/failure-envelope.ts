import { AdapterBlockedError, AdapterQuotaError, ParserChangedError } from "./adapters/errors.js";
import { safeErrorMessage } from "./utils/error-message.js";

export type FailureCategory =
  | "access_block"
  | "source_unavailable"
  | "quota"
  | "throttle"
  | "timeout"
  | "transport"
  | "parser_changed"
  | "proof_incomplete"
  | "unknown";

export type FailureEnvelope = {
  category: FailureCategory;
  retryable: boolean;
  scope: "request" | "host" | "account";
  message: string;
  provider?: string;
  route?: string;
  host?: string;
  upstreamStatus?: number;
  retryAfterMs?: number;
  attempt?: number;
};

export type FailureContext = Pick<FailureEnvelope, "provider" | "route" | "host" | "retryAfterMs" | "attempt">;

const QUOTA = /quota(?:_exceeded)?|квот|monthly[^.]{0,100}GB-s|лимит[^.]{0,100}(?:исчерпан|превышен)|limit[^.]{0,100}(?:exceeded|reached)/iu;
const CAPTCHA = /captcha|капч|proof[ -]?of[ -]?work|\bpow\b/iu;
const INCOMPLETE_PROOF = /incomplete[^.]{0,120}(?:proof|sitemap|xml)|proof[^.]{0,120}(?:incomplete|unproven)|непол[^.]{0,120}(?:доказ|sitemap|xml)|не доказ/iu;
const SOURCE_UNAVAILABLE = /\breview_(?:channel|aggregate)_unavailable\b/iu;

function statusFromMessage(message: string): number | undefined {
  const match = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isSafeInteger(status) ? status : undefined;
}
/**
 * Converts adapter/runtime failures into one retry policy contract. Quota and
 * deterministic proof/parser failures win over incidental HTTP text, so a
 * Sandbox quota wrapped by an HTTP 502 can never enter the transient loop.
 */
export function failureEnvelope(error: unknown, context: FailureContext = {}): FailureEnvelope {
  const message = safeErrorMessage(error);
  const upstreamStatus = statusFromMessage(message);
  const base = {
    message,
    ...(context.provider ? { provider: context.provider } : {}),
    ...(context.route ? { route: context.route } : {}),
    ...(context.host ? { host: context.host } : {}),
    ...(upstreamStatus ? { upstreamStatus } : {}),
    ...(context.retryAfterMs !== undefined ? { retryAfterMs: context.retryAfterMs } : {}),
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {})
  };

  if (error instanceof AdapterQuotaError || QUOTA.test(message)) {
    return { ...base, category: "quota", retryable: false, scope: "account" };
  }
  if (error instanceof ParserChangedError) {
    return { ...base, category: "parser_changed", retryable: false, scope: "host" };
  }
  if (INCOMPLETE_PROOF.test(message)) {
    return { ...base, category: "proof_incomplete", retryable: false, scope: "host" };
  }
  if (SOURCE_UNAVAILABLE.test(message)) {
    return { ...base, category: "source_unavailable", retryable: false, scope: "request" };
  }
  if (CAPTCHA.test(message) || upstreamStatus === 401 || upstreamStatus === 403 || upstreamStatus === 498) {
    return { ...base, category: "access_block", retryable: false, scope: "host" };
  }
  if (upstreamStatus === 429) {
    return { ...base, category: "throttle", retryable: true, scope: "host" };
  }
  if (/run_deadline_exceeded|aborted due to timeout|timed?\s*out/iu.test(message) || upstreamStatus === 408) {
    return { ...base, category: "timeout", retryable: true, scope: "request" };
  }
  if (upstreamStatus === 425 || upstreamStatus === 499 || (upstreamStatus !== undefined && upstreamStatus >= 500)) {
    return { ...base, category: "transport", retryable: true, scope: "request" };
  }
  if (error instanceof AdapterBlockedError || /blocked|access denied|forbidden|заблокирован/iu.test(message)) {
    return { ...base, category: "access_block", retryable: false, scope: "host" };
  }
  return { ...base, category: "unknown", retryable: false, scope: "request" };
}
