import { z } from "zod";

const ozonUrlSchema = z.string().trim().min(1).max(4096).url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && ["ozon.ru", "www.ozon.ru"].includes(url.hostname.toLowerCase());
}, "Ожидалась HTTPS-ссылка на Ozon");

export const ozonCompanionObservationSchema = z.object({
  listingId: z.string().trim().regex(/^\d{5,20}$/),
  brand: z.string().trim().min(2).max(160),
  canonicalUrl: ozonUrlSchema,
  product: z.string().trim().min(2).max(2000),
  reviews: z.number().int().nonnegative().nullable(),
  rating: z.number().min(0).max(5).nullable(),
  status: z.enum(["ok", "no_reviews", "needs_review"]),
  capturedAt: z.string().datetime()
}).strict();

export const ozonCompanionPartitionSchema = z.object({
  brand: z.string().trim().min(2).max(160),
  status: z.enum(["complete", "no_results"]),
  discovered: z.number().int().nonnegative(),
  collected: z.number().int().nonnegative()
}).strict();

export const ozonCompanionResultSchema = z.object({
  version: z.literal(1),
  observations: z.array(ozonCompanionObservationSchema).max(1000),
  partitions: z.array(ozonCompanionPartitionSchema).min(1).max(200)
}).strict();

export const ozonCompanionImportSchema = ozonCompanionResultSchema.extend({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict();

export const ozonCompanionSessionStateSchema = z.object({
  nonceHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  eligibleBrands: z.array(z.string().trim().min(2).max(160)).min(1).max(200),
  usedAt: z.string().datetime().optional(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict();

export type OzonCompanionObservation = z.infer<typeof ozonCompanionObservationSchema>;
export type OzonCompanionPartition = z.infer<typeof ozonCompanionPartitionSchema>;
export type OzonCompanionResult = z.infer<typeof ozonCompanionResultSchema>;
export type OzonCompanionImport = z.infer<typeof ozonCompanionImportSchema>;
export type OzonCompanionSessionState = z.infer<typeof ozonCompanionSessionStateSchema>;

export type OzonCompanionSession = {
  version: 1;
  nonce: string;
  expiresAt: string;
  brands: string[];
};
