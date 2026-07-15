import { z } from "zod";
import type { OzonCompanionSessionState } from "./companion.js";
import { normalizeRatingToFive } from "./rating.js";

export const MAX_RUN_PARTITIONS = 600;

const httpsUrlSchema = z.string().trim().min(1).max(4096).url().refine((value) => {
  try { return new URL(value).protocol === "https:"; }
  catch { return false; }
}, "Разрешены только HTTPS-ссылки");

export const observationStatusSchema = z.enum([
  "ok",
  "no_reviews",
  "not_found",
  "blocked",
  "needs_review",
  "quota_exceeded",
  "parser_changed"
]);

export type ObservationStatus = z.infer<typeof observationStatusSchema>;

export const productEvidenceSchema = z.object({
  scope: z.enum(["listing", "product_family"]).default("listing"),
  signals: z.array(z.object({
    source: z.enum(["title", "json_ld", "description", "variant", "instruction", "image_alt", "url"]),
    text: z.string().trim().min(1).max(2000)
  })).max(40).default([]),
  variants: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
  identifiers: z.array(z.object({
    type: z.enum(["sku", "product_id", "model_id", "nm_id", "gtin", "registration_id"]),
    value: z.string().trim().min(1).max(256)
  })).max(20).default([]),
  imageUrls: z.array(httpsUrlSchema).max(3).default([]),
  instructionUrls: z.array(httpsUrlSchema).max(3).default([])
});

export type ProductEvidence = z.infer<typeof productEvidenceSchema>;

export const productIdentitySchema = z.object({
  label: z.string().trim().min(1).max(1000),
  granularity: z.enum(["variant", "family", "line", "unresolved", "not_product"]),
  confidence: z.enum(["exact", "partial", "ambiguous"]),
  missing: z.array(z.enum(["form", "strength_or_detail", "pack"])).max(3).default([]),
  reasons: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  variantCount: z.number().int().positive().optional()
});

export type ProductIdentity = z.infer<typeof productIdentitySchema>;

export const runRequestSchema = z.object({
  sheetUrl: httpsUrlSchema,
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  region: z.string().trim().min(2).max(100).default("Москва"),
  domains: z.array(z.string().trim().min(3).max(253)).min(1).max(30),
  brands: z.array(z.string().trim().min(2).max(160)).min(1).max(200)
}).superRefine((request, context) => {
  const partitions = request.domains.length * request.brands.length;
  if (partitions > MAX_RUN_PARTITIONS) {
    context.addIssue({
      code: "custom",
      path: ["domains"],
      message: `Слишком большой запуск: ${partitions} разделов при лимите ${MAX_RUN_PARTITIONS}`
    });
  }
});

export type RunRequest = z.infer<typeof runRequestSchema>;

export const observationSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  platform: z.string().trim().min(1).max(160),
  listingId: z.string().trim().min(1).max(256),
  brand: z.string().trim().min(1).max(160),
  canonicalUrl: httpsUrlSchema,
  product: z.string().trim().min(1).max(2000),
  reviews: z.number().int().nonnegative().nullable(),
  /** Raw written-review counter when `reviews` is promoted to unified feedback. */
  writtenReviewCount: z.number().int().nonnegative().nullable().optional(),
  rating: z.number().min(0).max(5).nullable().transform((value) =>
    value === null ? null : normalizeRatingToFive(value)
  ),
  rawRating: z.number().nonnegative().nullable().optional(),
  rawRatingScale: z.number().positive().optional(),
  /** The platform exposes reviews but has not calculated an aggregate rating. */
  ratingUnavailable: z.boolean().optional(),
  ratingCount: z.number().int().nonnegative().nullable().optional(),
  status: observationStatusSchema,
  capturedAt: z.string().datetime(),
  evidenceRef: z.string().optional(),
  groupId: z.string().optional(),
  /** Proven platform aggregate shared by several distinct product variants. */
  aggregateGroupId: z.string().optional(),
  source: z.string().optional(),
  productEvidence: productEvidenceSchema.optional(),
  productIdentity: productIdentitySchema.optional(),
  /** Human variant label confirmed during review; source title stays in `product`. */
  productOverride: z.string().trim().min(1).max(240).optional(),
  historical: z.boolean().optional(),
  profileVersion: z.number().int().positive().optional()
});

export type Observation = z.infer<typeof observationSchema>;

export const productRefSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  platform: z.string().trim().min(1).max(160),
  listingId: z.string().trim().min(1).max(256),
  brand: z.string().trim().min(1).max(160),
  url: httpsUrlSchema,
  title: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type ProductRef = z.infer<typeof productRefSchema>;

/** Optional fine-grained adapter signal for the live runtime trace. */
export type AdapterActivityEvent = {
  operationId: string;
  stage: "health_check" | "discovery" | "collection" | "parsing";
  status: "active" | "complete" | "warning";
  label: string;
  listingId?: string;
  channels?: RunActivityChannel[];
  parsers?: RunActivityParser[];
  detail?: string;
};

export type AdapterContext = {
  /** Stable execution scope used to coalesce run-wide work such as quota checks. */
  runId?: string;
  /** Complete normalized brand set for adapters that can batch discovery efficiently. */
  brands?: readonly string[];
  region: string;
  month?: string;
  signal?: AbortSignal;
  previousIds?: string[];
  previousRefs?: Array<{ listingId: string; url: string }>;
  fetch?: typeof globalThis.fetch;
  /** Collector-reported operations; absent for older adapters and callers. */
  activity?: (event: AdapterActivityEvent) => void | Promise<void>;
};

export type AdapterHealth = {
  ok: boolean;
  checkedAt: string;
  message?: string;
};

export const partitionResultSchema = z.object({
  domain: z.string(),
  brand: z.string(),
  status: z.enum(["pending", "complete", "no_results", "blocked", "error"]),
  discovered: z.number().int().nonnegative().default(0),
  collected: z.number().int().nonnegative().default(0),
  evidenceRef: z.string().optional(),
  message: z.string().optional()
});

export type PartitionResult = z.infer<typeof partitionResultSchema>;

export const siteProfileSchema = z.object({
  domain: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "approved", "blocked_free_mode", "parser_changed"]),
  searchUrlTemplate: httpsUrlSchema.optional(),
  sitemapUrls: z.array(httpsUrlSchema).default([]),
  productUrlPattern: z.string().optional(),
  productLinkSelector: z.string().max(500).optional(),
  nextPageSelector: z.string().max(500).optional(),
  infiniteScroll: z.boolean().optional(),
  listingIdPattern: z.string().optional(),
  titleSelector: z.string().optional(),
  reviewCountSelector: z.string().optional(),
  ratingSelector: z.string().optional(),
  ratingScale: z.number().positive().default(5),
  reviewCountMeaning: z.enum(["reviews", "ratings", "feedback", "unknown"]).default("unknown"),
  rateLimitMs: z.number().int().nonnegative().default(1200),
  canaryUrls: z.array(httpsUrlSchema).max(10).default([]),
  testExamples: z.array(z.object({ url: httpsUrlSchema, title: z.string().max(2000).optional() })).max(3).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  approvedAt: z.string().datetime().optional(),
  notes: z.array(z.string()).default([])
});

export type SiteProfile = z.infer<typeof siteProfileSchema>;

export type ProductRecord = {
  key: string;
  domain: string;
  listingId: string;
  brand: string;
  canonicalUrl: string;
  product: string;
  platform: string;
  groupId?: string;
  aggregateGroupId?: string;
  productIdentity?: ProductIdentity;
  firstSeenMonth: string;
  lastSeenMonth: string;
};

export type PublicationRecord = {
  runId: string;
  spreadsheetId: string;
  month: string;
  payloadHash: string;
  publishedAt: string;
  updatedRange: string;
  evidenceRef?: string;
  verification?: {
    method: "anonymous-browser-readback" | "apps-script-readback";
    attempts: number;
    limitations: string[];
  };
};

export interface SiteAdapter {
  readonly id: string;
  readonly supportedDomains: readonly string[];
  healthCheck(context: AdapterContext): Promise<AdapterHealth>;
  discover(brand: string, context: AdapterContext): Promise<ProductRef[]>;
  collect(ref: ProductRef, context: AdapterContext): Promise<Observation>;
}

export type RunProgress = {
  totalPartitions: number;
  completedPartitions: number;
  current?: string;
};

/**
 * A bounded, evidence-backed trace of work that is really happening during a
 * run.  Stored runs created before this contract simply omit `activity`.
 */
export type RunActivityStage =
  | "prepare"
  | "health_check"
  | "discovery"
  | "collection"
  | "parsing"
  | "normalization"
  | "qa";

export type RunActivityStatus = "active" | "complete" | "warning";

export type RunActivityChannel =
  | "direct"
  | "first_party_api"
  | "google_translate"
  | "reader_proxy"
  | "gateway"
  | "browser"
  | "sandbox"
  | "registry";

export type RunActivityParser = "json_ld" | "dom" | "api_json" | "embedded_state";

export type RunActivity = {
  id: string;
  sequence: number;
  stage: RunActivityStage;
  status: RunActivityStatus;
  label: string;
  startedAt: string;
  finishedAt?: string;
  domain?: string;
  brand?: string;
  listingId?: string;
  /** Actual transport evidence reported by returned refs/observations. */
  channels?: RunActivityChannel[];
  /** Actual parser evidence reported by the observation source. */
  parsers?: RunActivityParser[];
  detail?: string;
};

export type RunActivityTrace = {
  sequence: number;
  active: RunActivity[];
  recent: RunActivity[];
};

export type RunState = {
  id: string;
  ownerEmail?: string;
  request: RunRequest;
  status: "queued" | "running" | "review" | "publishing" | "published" | "failed";
  createdAt: string;
  updatedAt: string;
  progress: RunProgress;
  observations: Observation[];
  partitions: PartitionResult[];
  errors: Array<{ partition: string; message: string }>;
  payloadHash?: string;
  qa?: { ok: boolean; blockers: string[]; warnings: string[] };
  publication?: PublicationRecord;
  /** Ratings sheet resolved during preflight; legacy Russian tabs remain supported. */
  sheetTabName?: string;
  /** Recent runtime work for the live process map. Backward-compatible. */
  activity?: RunActivityTrace;
  /** One-time browser-companion sessions. Existing stored runs omit this field. */
  companionSessions?: { ozon?: OzonCompanionSessionState };
};
