import { z } from "zod";
import type {
  ProductIdentityModelInput,
  ProductIdentityModelProvider,
  ProductIdentityModelResult
} from "./product-master.js";
import { readTextBounded, safeFetch } from "./utils/safe-fetch.js";

const MAX_MODEL_RESPONSE_BYTES = 256 * 1024;

const responseSchema = z.object({
  results: z.array(z.object({
    candidateVariantId: z.string().uuid(),
    probability: z.number().min(0).max(1),
    positiveEvidence: z.array(z.string().max(500)).max(20),
    negativeEvidence: z.array(z.string().max(500)).max(20),
    modelVersion: z.string().min(1).max(200)
  })).max(20)
});

export type HttpProductIdentityModelOptions = {
  endpoint: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** Optional unresolved-case ranker. The wire payload deliberately drops
 * source refs, review text, Sheet identifiers and every credential-bearing
 * field. Deterministic hard-negative policy remains the caller's authority. */
export class HttpProductIdentityModelProvider implements ProductIdentityModelProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpProductIdentityModelOptions) {
    if (!options.token.trim()) throw new Error("Product identity model token is required");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async rank(input: ProductIdentityModelInput): Promise<ProductIdentityModelResult[]> {
    if (!input.normalizedTitle.trim() || input.normalizedTitle.length > 2_000) {
      throw new Error("Invalid normalized product title for model ranking");
    }
    const candidateVariantIds = [...new Set(input.candidateVariantIds)].slice(0, 20);
    if (candidateVariantIds.length === 0) return [];
    const response = await safeFetch(this.options.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        schemaVersion: 1,
        title: input.normalizedTitle,
        facts: input.facts.slice(0, 50).map(({ field, normalizedValue, unit }) => ({
          field,
          value: normalizedValue,
          ...(unit ? { unit } : {})
        })),
        candidateVariantIds
      })
    }, this.fetchImpl, 0, this.timeoutMs);
    if (!response.ok) throw new Error(`Product identity model returned HTTP ${response.status}`);
    const body = await readTextBounded(response, MAX_MODEL_RESPONSE_BYTES, this.timeoutMs);
    const parsed = responseSchema.parse(JSON.parse(body) as unknown);
    const allowed = new Set(candidateVariantIds);
    if (parsed.results.some((result) => !allowed.has(result.candidateVariantId))) {
      throw new Error("Product identity model returned an unknown candidate ID");
    }
    return parsed.results.sort((left, right) => right.probability - left.probability);
  }
}
