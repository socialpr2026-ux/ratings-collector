import { describe, expect, it } from "vitest";
import type { AdapterContext, Observation, ProductRef, SiteAdapter } from "../src/shared/types.js";
import { AdapterBlockedError, AdapterQuotaError } from "../src/server/adapters/errors.js";
import { DEFAULT_DOMAIN_CONCURRENCY, RatingsService } from "../src/server/orchestrator.js";
import { MemoryRepository } from "../src/server/repository.js";
import { hasDeterministicAggregateProof, isKnownReviewAggregateDomain } from "../src/shared/review-aggregates.js";

const request = { sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit", month: "2026-07", region: "Москва", domains: ["example.com"], brands: ["Бренд"] };
class FakeAdapter implements SiteAdapter {
  id = "fake"; supportedDomains = ["example.com"];
  constructor(private readonly healthy = true) {}
  async healthCheck() { return { ok: this.healthy, checkedAt: new Date().toISOString(), message: this.healthy ? undefined : "changed" }; }
  async discover(brand: string, _context: AdapterContext): Promise<ProductRef[]> { return [{ domain: "example.com", platform: "fake", listingId: "1", brand, url: "https://example.com/p/1", metadata: {} }]; }
  async collect(ref: ProductRef): Promise<Observation> { return { domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand, canonicalUrl: ref.url, product: `${ref.brand} таблетки 100 мг №10`, reviews: 5, rating: 4.5, status: "ok", capturedAt: new Date().toISOString() }; }
}

describe("run orchestration and fail-closed QA", () => {
  it("propagates the run deadline instead of publishing it as an ordinary partition failure", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => ({
      id: "deadline",
      supportedDomains: ["example.com"],
      async healthCheck(adapterContext) {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(adapterContext.signal?.reason ?? new Error("aborted"));
          if (adapterContext.signal?.aborted) abort();
          else adapterContext.signal?.addEventListener("abort", abort, { once: true });
        });
        return { ok: true, checkedAt: new Date().toISOString() };
      },
      async discover() { throw new Error("deadline must stop before discovery"); },
      async collect() { throw new Error("deadline must stop before collection"); }
    }), { runDeadlineMs: 5 });
    const created = await service.createRun(request);

    await expect(service.executeRun(created.id)).rejects.toThrow("run_deadline_exceeded");
    const checkpoint = await repository.getRun(created.id);
    expect(checkpoint?.status).toBe("running");
    expect(checkpoint?.partitions).toEqual([]);
  });

  it("drains an already-started sibling brand before propagating the deadline", async () => {
    const repository = new MemoryRepository();
    let releaseSibling!: () => void;
    const siblingReleased = new Promise<void>((resolve) => { releaseSibling = resolve; });
    let markSiblingStarted!: () => void;
    const siblingStarted = new Promise<void>((resolve) => { markSiblingStarted = resolve; });
    const service = new RatingsService(repository, async () => ({
      id: "drain",
      supportedDomains: ["wildberries.ru"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand, adapterContext) {
        if (brand === "Бренд Б") {
          markSiblingStarted();
          await siblingReleased;
          return [];
        }
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(adapterContext.signal?.reason ?? new Error("aborted"));
          if (adapterContext.signal?.aborted) abort();
          else adapterContext.signal?.addEventListener("abort", abort, { once: true });
        });
        return [];
      },
      async collect() { throw new Error("not reached"); }
    }), { runDeadlineMs: 5 });
    const created = await service.createRun({
      ...request,
      domains: ["wildberries.ru"],
      brands: ["Бренд А", "Бренд Б"]
    });
    const execution = service.executeRun(created.id);
    let settled = false;
    void execution.then(() => { settled = true; }, () => { settled = true; });

    await siblingStarted;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(settled).toBe(false);

    releaseSibling();
    await expect(execution).rejects.toThrow("run_deadline_exceeded");
  });

  it("isolates a busy Ozon lane without delaying the other requested domains", async () => {
    const repository = new MemoryRepository();
    const adapterCalls: string[] = [];
    const service = new RatingsService(repository, async (domain) => ({
      id: domain,
      supportedDomains: [domain],
      async healthCheck() {
        adapterCalls.push(`${domain}:health`);
        return { ok: true, checkedAt: new Date().toISOString() };
      },
      async discover(brand) {
        adapterCalls.push(`${domain}:discover`);
        return [{ domain, platform: domain, listingId: "1", brand, url: `https://${domain}/product/1`, metadata: {} }];
      },
      async collect(ref) {
        adapterCalls.push(`${domain}:collect`);
        return {
          domain, platform: domain, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: `${ref.brand} таблетки 100 мг №10`,
          reviews: 5, rating: 4.5, status: "ok", capturedAt: new Date().toISOString()
        };
      }
    }), {
      domainExclusive: async (domain, operation) => {
        if (domain === "ozon.ru") throw new AdapterBlockedError("Ozon collection is busy (HTTP 429)");
        return operation();
      }
    });
    const created = await service.createRun({ ...request, domains: ["ozon.ru", "example.com"] });

    const run = await service.executeRun(created.id);

    expect(run.partitions).toMatchObject([
      { domain: "ozon.ru", status: "blocked", message: expect.stringContaining("HTTP 429") },
      { domain: "example.com", status: "complete" }
    ]);
    expect(run.observations).toHaveLength(1);
    expect(run.observations[0]?.domain).toBe("example.com");
    expect(adapterCalls).toEqual(["example.com:health", "example.com:discover", "example.com:collect"]);
  });

  it("bounds domain fan-out instead of bursting every requested host at once", async () => {
    const repository = new MemoryRepository();
    const domains = Array.from({ length: DEFAULT_DOMAIN_CONCURRENCY + 8 }, (_, index) => `d${index}.example.com`);
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let releaseFirstWave!: () => void;
    const firstWaveGate = new Promise<void>((resolve) => { releaseFirstWave = resolve; });
    let markFirstWaveStarted!: () => void;
    const firstWaveStarted = new Promise<void>((resolve) => { markFirstWaveStarted = resolve; });
    const service = new RatingsService(repository, async (domain) => ({
      id: domain,
      supportedDomains: [domain],
      async healthCheck() {
        active += 1;
        started += 1;
        maximumActive = Math.max(maximumActive, active);
        if (started === DEFAULT_DOMAIN_CONCURRENCY) markFirstWaveStarted();
        if (started <= DEFAULT_DOMAIN_CONCURRENCY) await firstWaveGate;
        active -= 1;
        return { ok: true, checkedAt: new Date().toISOString() };
      },
      async discover() { return []; },
      async collect() { throw new Error("no cards expected"); }
    }));
    const id = (await service.createRun({ ...request, domains })).id;
    const execution = service.executeRun(id);

    await firstWaveStarted;
    expect(started).toBe(DEFAULT_DOMAIN_CONCURRENCY);
    expect(maximumActive).toBe(DEFAULT_DOMAIN_CONCURRENCY);

    releaseFirstWave();
    const run = await execution;
    expect(run.partitions).toHaveLength(domains.length);
    expect(run.partitions.every((partition) => partition.status === "no_results")).toBe(true);
    expect(maximumActive).toBeLessThanOrEqual(DEFAULT_DOMAIN_CONCURRENCY);
  });

  it("accepts Ozerki as a deterministic source-bound family aggregate", () => {
    const observation: Observation = {
      domain: "ozerki.ru", platform: "ozerki.ru", listingId: "family-akvaoptik", brand: "АкваОптик",
      canonicalUrl: "https://ozerki.ru/alphabet/a/akvaoptik/", product: "АкваОптик — раствор для линз",
      reviews: 2, rating: 5, status: "ok", capturedAt: new Date().toISOString(),
      evidenceRef: "blob:ratings-state:ozerki-proof", source: "ozerki-family-aggregate-microdata",
      productEvidence: { scope: "product_family", signals: [{ source: "url", text: "https://ozerki.ru/alphabet/a/akvaoptik/" }], variants: [], identifiers: [], imageUrls: [], instructionUrls: [] },
      productIdentity: { label: "АкваОптик — раствор для линз", granularity: "family", confidence: "exact", missing: [], reasons: [] }
    };
    expect(isKnownReviewAggregateDomain("ozerki.ru")).toBe(true);
    expect(hasDeterministicAggregateProof(observation)).toBe(true);
  });

  it("accepts 009.рф as one deterministic source-bound family aggregate", () => {
    const observation: Observation = {
      domain: "009.xn--p1ai", platform: "009.xn--p1ai", listingId: "family-lirika", brand: "Лирика",
      canonicalUrl: "https://009.xn--p1ai/kupit-lirika/otzyvy", product: "ЛИРИКА",
      reviews: 19, rating: 4.4, status: "ok", capturedAt: "2026-08-06T00:00:00.000Z",
      evidenceRef: "evidence:009", source: "009-family-review-jsonld",
      productEvidence: {
        scope: "product_family", signals: [{ source: "url", text: "https://009.xn--p1ai/kupit-lirika/otzyvy" }],
        variants: [], identifiers: [{ type: "product_id", value: "family-lirika" }], imageUrls: [], instructionUrls: []
      },
      productIdentity: { label: "ЛИРИКА", granularity: "family", confidence: "exact", missing: [], reasons: [] }
    };
    expect(isKnownReviewAggregateDomain("009.xn--p1ai")).toBe(true);
    expect(hasDeterministicAggregateProof(observation)).toBe(true);
  });

  it("keeps an explicit transient health-check access failure blocked instead of parser_changed", async () => {
    const service = new RatingsService(new MemoryRepository(), async () => ({
      id: "transient-health",
      supportedDomains: ["example.com"],
      async healthCheck() {
        return {
          ok: false,
          checkedAt: new Date().toISOString(),
          message: "blocked: both verified egress paths returned HTTP 502"
        };
      },
      async discover() { throw new Error("discovery must not run after a failed health check"); },
      async collect() { throw new Error("collection must not run after a failed health check"); }
    }));

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.partitions).toMatchObject([{
      status: "blocked",
      message: expect.stringMatching(/^blocked: blocked: .*HTTP 502$/)
    }]);
    expect(run.partitions[0]!.message).not.toContain("parser_changed");
  });

  it("retries only failed partitions and preserves successful observations", async () => {
    const repository = new MemoryRepository();
    const calls = new Map<string, number>();
    let flakyAttempts = 0;
    const service = new RatingsService(repository, async (domain) => ({
      id: domain,
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        calls.set(domain, (calls.get(domain) ?? 0) + 1);
        if (domain === "example.org" && flakyAttempts++ === 0) {
          throw new AdapterQuotaError("temporary quota gate");
        }
        return [{
          domain, platform: domain, listingId: "1", brand,
          url: `https://${domain}/p/1`, metadata: {}
        }];
      },
      async collect(ref) {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId,
          brand: ref.brand, canonicalUrl: ref.url, product: `${ref.brand} таблетки 100 мг №10`,
          reviews: 5, rating: 4.5, status: "ok", capturedAt: new Date().toISOString()
        };
      }
    }));
    const created = await service.createRun({ ...request, domains: ["example.com", "example.org"] });
    const first = await service.executeRun(created.id);
    const preserved = first.observations.find((item) => item.domain === "example.com")!;
    const firstHash = first.payloadHash;

    expect(first.partitions.map((item) => [item.domain, item.status])).toEqual([
      ["example.com", "complete"],
      ["example.org", "blocked"]
    ]);
    expect(first.qa?.ok).toBe(false);

    const retried = await service.executeRun(created.id);

    expect(calls).toEqual(new Map([["example.com", 1], ["example.org", 2]]));
    expect(retried.progress).toMatchObject({ totalPartitions: 2, completedPartitions: 2 });
    expect(retried.progress.current).toBeUndefined();
    expect(retried.partitions.map((item) => [item.domain, item.status])).toEqual([
      ["example.com", "complete"],
      ["example.org", "complete"]
    ]);
    expect(retried.observations).toHaveLength(2);
    expect(retried.observations.find((item) => item.domain === "example.com")).toEqual(preserved);
    expect(retried.errors).toEqual([]);
    expect(retried.qa).toMatchObject({ ok: true, blockers: [] });
    expect(retried.payloadHash).not.toBe(firstHash);
  });

  it("does not retry a technically complete partition solely because product identity needs review", async () => {
    const repository = new MemoryRepository();
    let attempts = 0;
    const service = new RatingsService(repository, async () => ({
      id: "review-recovery",
      supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        attempts += 1;
        return [{
          domain: "example.com", platform: "review-recovery", listingId: "1", brand,
          url: "https://example.com/p/1", metadata: {}
        }];
      },
      async collect(ref) {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId,
          brand: ref.brand, canonicalUrl: ref.url,
          product: attempts === 1 ? ref.brand : `${ref.brand} таблетки 100 мг №10`,
          reviews: 5, rating: 4.5, status: attempts === 1 ? "needs_review" as const : "ok" as const,
          capturedAt: new Date().toISOString()
        };
      }
    }));
    const id = (await service.createRun(request)).id;

    const first = await service.executeRun(id);
    expect(first.partitions).toMatchObject([{ status: "complete" }]);
    expect(first.observations).toMatchObject([{ status: "needs_review" }]);
    expect(first.qa?.ok).toBe(false);

    const repeated = await service.executeRun(id);

    expect(attempts).toBe(1);
    expect(repeated.partitions).toMatchObject([{ status: "complete" }]);
    expect(repeated.observations).toMatchObject([{ status: "needs_review" }]);
    expect(repeated.qa).toMatchObject({ ok: false });
  });

  it("preserves a successful needs-review partition while retrying only the failed partition", async () => {
    const repository = new MemoryRepository();
    const calls = new Map<string, number>();
    const service = new RatingsService(repository, async (domain) => ({
      id: domain,
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        calls.set(domain, (calls.get(domain) ?? 0) + 1);
        if (domain === "example.org" && calls.get(domain) === 1) {
          throw new AdapterBlockedError("temporary exact-proof failure");
        }
        return [{
          domain, platform: domain, listingId: "1", brand,
          url: `https://${domain}/p/1`, metadata: {}
        }];
      },
      async collect(ref) {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId,
          brand: ref.brand, canonicalUrl: ref.url,
          product: ref.domain === "example.com" ? ref.brand : `${ref.brand} таблетки 100 мг №10`,
          reviews: 5, rating: 4.5,
          status: ref.domain === "example.com" ? "needs_review" as const : "ok" as const,
          capturedAt: new Date().toISOString()
        };
      }
    }));
    const id = (await service.createRun({ ...request, domains: ["example.com", "example.org"] })).id;

    const first = await service.executeRun(id);
    const preserved = first.observations.find((item) => item.domain === "example.com");
    expect(first.partitions.map((item) => [item.domain, item.status])).toEqual([
      ["example.com", "complete"],
      ["example.org", "blocked"]
    ]);

    const retried = await service.executeRun(id);

    expect(calls).toEqual(new Map([["example.com", 1], ["example.org", 2]]));
    expect(retried.observations.find((item) => item.domain === "example.com")).toEqual(preserved);
    expect(retried.partitions.map((item) => [item.domain, item.status])).toEqual([
      ["example.com", "complete"],
      ["example.org", "complete"]
    ]);
  });

  it("keeps successful partitions intact when a selective retry fails again", async () => {
    const repository = new MemoryRepository();
    const calls = new Map<string, number>();
    const service = new RatingsService(repository, async (domain) => ({
      id: domain,
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        calls.set(domain, (calls.get(domain) ?? 0) + 1);
        if (domain === "example.org") throw new AdapterQuotaError("still unavailable");
        return [{ domain, platform: domain, listingId: "1", brand, url: `https://${domain}/p/1`, metadata: {} }];
      },
      async collect(ref) {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId,
          brand: ref.brand, canonicalUrl: ref.url, product: `${ref.brand} таблетки 100 мг №10`,
          reviews: 1, rating: 5, status: "ok", capturedAt: new Date().toISOString()
        };
      }
    }));
    const id = (await service.createRun({ ...request, domains: ["example.com", "example.org"] })).id;
    const first = await service.executeRun(id);
    const successfulSnapshot = first.observations[0];

    const second = await service.executeRun(id);

    expect(calls).toEqual(new Map([["example.com", 1], ["example.org", 2]]));
    expect(second.observations).toEqual([successfulSnapshot]);
    expect(second.partitions.map((item) => [item.domain, item.status])).toEqual([
      ["example.com", "complete"],
      ["example.org", "blocked"]
    ]);
    expect(second.progress.completedPartitions).toBe(2);
    expect(second.errors).toHaveLength(1);
    expect(second.qa?.ok).toBe(false);
  });

  it("checkpoints good cards when one product fails and retries only the blocked partition", async () => {
    const repository = new MemoryRepository();
    let collectionAttempt = 0;
    const service = new RatingsService(repository, async () => ({
      id: "per-card-recovery",
      supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        collectionAttempt += 1;
        return ["1", "2", "3"].map((listingId) => ({
          domain: "example.com", platform: "example.com", listingId, brand,
          url: `https://example.com/p/${listingId}`, metadata: {}
        }));
      },
      async collect(ref) {
        if (collectionAttempt === 1 && ref.listingId === "2") {
          throw new AdapterBlockedError("точная карточка временно вернула HTTP 502");
        }
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId,
          brand: ref.brand, canonicalUrl: ref.url,
          product: `${ref.brand} таблетки 100 мг №10 SKU ${ref.listingId}`,
          reviews: Number(ref.listingId), rating: 5, status: "ok" as const,
          capturedAt: new Date().toISOString()
        };
      }
    }));
    const id = (await service.createRun(request)).id;

    const first = await service.executeRun(id);

    expect(first.observations.map((item) => item.listingId)).toEqual(["1", "3"]);
    expect(first.partitions).toMatchObject([{
      status: "blocked", discovered: 3, collected: 2,
      message: expect.stringContaining("2: blocked: точная карточка временно вернула HTTP 502")
    }]);

    const recovered = await service.executeRun(id);

    expect(recovered.partitions).toMatchObject([{ status: "complete", discovered: 3, collected: 3 }]);
    expect(recovered.observations.map((item) => item.listingId)).toEqual(["1", "2", "3"]);
    expect(new Set(recovered.observations.map((item) => item.listingId)).size).toBe(3);
  });

  it("checkpoints proven cards from a partial discovery and merges a failed-only retry", async () => {
    const repository = new MemoryRepository();
    let attempt = 0;
    const service = new RatingsService(repository, async () => ({
      id: "partial",
      supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand): Promise<ProductRef[]> {
        attempt += 1;
        if (attempt === 2) throw new AdapterQuotaError("quota still unavailable");
        const refs = ["1", ...(attempt >= 3 ? ["2"] : [])].map((listingId) => ({
          domain: "example.com",
          platform: "partial",
          listingId,
          brand,
          url: `https://example.com/p/${listingId}`,
          metadata: attempt === 1 ? {
            partialDiscoveryStatus: "quota_exceeded",
            partialDiscoveryMessage: "quota interrupted exact proof",
            partialDiscoveryTotal: 2
          } : {}
        }));
        return refs;
      },
      async collect(ref): Promise<Observation> {
        return {
          domain: ref.domain,
          platform: ref.platform,
          listingId: ref.listingId,
          brand: ref.brand,
          canonicalUrl: ref.url,
          product: `${ref.brand} таблетки 100 мг №10 SKU ${ref.listingId}`,
          reviews: attempt,
          rating: 5,
          status: "ok",
          capturedAt: new Date().toISOString()
        };
      }
    }));
    const id = (await service.createRun(request)).id;

    const partial = await service.executeRun(id);
    expect(partial.partitions).toMatchObject([{
      status: "blocked", discovered: 2, collected: 1,
      message: expect.stringContaining("quota_exceeded")
    }]);
    expect(partial.observations).toHaveLength(1);
    const checkpoint = partial.observations[0];

    const failedAgain = await service.executeRun(id);
    expect(failedAgain.partitions).toMatchObject([{ status: "blocked", discovered: 1, collected: 1 }]);
    expect(failedAgain.observations).toEqual([checkpoint]);

    const recovered = await service.executeRun(id);
    expect(recovered.partitions).toMatchObject([{ status: "complete", discovered: 2, collected: 2 }]);
    expect(recovered.observations.map(({ listingId, reviews }) => ({ listingId, reviews }))).toEqual([
      { listingId: "1", reviews: 3 },
      { listingId: "2", reviews: 3 }
    ]);
    expect(recovered.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("treats a repeated execution after all partitions succeeded as an idempotent no-op", async () => {
    const repository = new MemoryRepository();
    let resolutions = 0;
    const service = new RatingsService(repository, async () => {
      resolutions += 1;
      return new FakeAdapter();
    });
    const first = await service.executeRun((await service.createRun(request)).id);

    const repeated = await service.executeRun(first.id);

    expect(resolutions).toBe(1);
    expect(repeated).toEqual(first);
  });

  it("rejects a concurrent duplicate before the first repository read completes", async () => {
    let releaseDiscovery!: () => void;
    let discoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { discoveryStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    class SlowAdapter extends FakeAdapter {
      override async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
        discoveryStarted();
        await release;
        return super.discover(brand, context);
      }
    }
    const service = new RatingsService(new MemoryRepository(), async () => new SlowAdapter());
    const id = (await service.createRun(request)).id;
    const first = service.executeRun(id);
    await started;

    await expect(service.executeRun(id)).rejects.toThrow("Запуск уже выполняется");
    releaseDiscovery();
    await expect(first).resolves.toMatchObject({ status: "review" });
  });

  it("keeps Yandex Reviews and Yandex Market as separate collection domains", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => new FakeAdapter());
    const run = await service.createRun({ ...request, domains: ["reviews.yandex.ru", "market.yandex.ru"] });

    expect(run.request.domains).toEqual(["reviews.yandex.ru", "market.yandex.ru"]);
    expect(run.progress.totalPartitions).toBe(2);
  });

  it("revalidates a stored legacy Market no-result that came from Yandex Reviews", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => new FakeAdapter());
    const run = await service.createRun({ ...request, domains: ["market.yandex.ru"], brands: ["Даксабрис"] });
    run.status = "review";
    run.progress.completedPartitions = 1;
    run.partitions = [{
      domain: "market.yandex.ru",
      brand: "Даксабрис",
      status: "no_results",
      discovered: 0,
      collected: 0,
      message: "Поиск исчерпан, карточек нет"
    }];
    run.qa = { ok: true, blockers: [], warnings: [] };
    run.activity = {
      sequence: 1,
      active: [],
      recent: [{
        id: `${run.id}:1`, sequence: 1, stage: "discovery", status: "warning",
        label: "Yandex: резервный полный индекс", domain: "market.yandex.ru", brand: "Даксабрис",
        detail: "Market proof недоступен; проверяем полный Reviews index",
        startedAt: run.createdAt, finishedAt: run.createdAt
      }]
    };
    await repository.saveRun(run);

    const refreshed = await service.getRun(run.id);

    expect(refreshed?.qa).toMatchObject({
      ok: false,
      blockers: [expect.stringContaining("старого fallback Яндекс Отзывов")]
    });
    expect((await repository.getRun(run.id))?.qa?.ok).toBe(false);
  });

  it("deduplicates equivalent brand spellings before creating partitions", async () => {
    const service = new RatingsService(new MemoryRepository(), async () => new FakeAdapter());

    const run = await service.createRun({
      ...request,
      brands: ["Цитовир-3", " цитовир 3 ", "ЦИТОВИР—3", "Кагоцел"]
    });

    expect(run.request.brands).toEqual(["Цитовир-3", "Кагоцел"]);
    expect(run.progress.totalPartitions).toBe(2);
  });

  it("collects a repeated listing from search only once", async () => {
    let collections = 0;
    class DuplicateSearchAdapter extends FakeAdapter {
      override async discover(brand: string): Promise<ProductRef[]> {
        const ref = {
          domain: "example.com", platform: "fake", listingId: "1", brand,
          url: "https://example.com/p/1", metadata: {}
        };
        return [ref, { ...ref, url: "https://example.com/p/1?from=sponsored" }];
      }
      override async collect(ref: ProductRef): Promise<Observation> {
        collections += 1;
        return super.collect(ref);
      }
    }
    const service = new RatingsService(new MemoryRepository(), async () => new DuplicateSearchAdapter());

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(collections).toBe(1);
    expect(run.partitions).toMatchObject([{ status: "complete", discovered: 1, collected: 1 }]);
    expect(run.observations).toHaveLength(1);
    expect(run.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("fails a partition clearly when collect returns another stable ID", async () => {
    class MismatchedCardAdapter extends FakeAdapter {
      override async collect(ref: ProductRef): Promise<Observation> {
        return { ...await super.collect(ref), listingId: "another-id" };
      }
    }
    const service = new RatingsService(new MemoryRepository(), async () => new MismatchedCardAdapter());

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.observations).toEqual([]);
    expect(run.partitions).toMatchObject([{
      status: "blocked",
      discovered: 1,
      collected: 0,
      message: expect.stringContaining("parser_changed")
    }]);
    expect(run.qa?.blockers).toHaveLength(1);
    expect(run.qa?.blockers[0]).toContain("сборщик вернул другую карточку или бренд");
  });

  it("persists a self-contained partition checkpoint and retries only unfinished work after interruption", async () => {
    class CheckpointCrashRepository extends MemoryRepository {
      private crashOnce = true;
      override async saveRun(run: import("../src/shared/types.js").RunState): Promise<void> {
        await super.saveRun(run);
        if (this.crashOnce && run.status === "running" && run.progress.completedPartitions === 1) {
          this.crashOnce = false;
          throw new Error("simulated worker interruption");
        }
      }
    }
    const repository = new CheckpointCrashRepository();
    const calls = new Map<string, number>();
    const adapter: SiteAdapter = {
      id: "checkpoint",
      supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        calls.set(brand, (calls.get(brand) ?? 0) + 1);
        return [{
          domain: "example.com", platform: "fake", listingId: brand, brand,
          url: `https://example.com/p/${encodeURIComponent(brand)}`, metadata: {}
        }];
      },
      async collect(ref) { return new FakeAdapter().collect(ref); }
    };
    const service = new RatingsService(repository, async () => adapter);
    const created = await service.createRun({ ...request, brands: ["Бренд А", "Бренд Б"] });

    await expect(service.executeRun(created.id)).rejects.toThrow("simulated worker interruption");
    const checkpoint = (await repository.getRun(created.id))!;
    expect(checkpoint.partitions).toHaveLength(1);
    expect(checkpoint.observations).toHaveLength(1);
    checkpoint.status = "failed";
    checkpoint.errors.push({ partition: "orchestrator", message: "simulated worker interruption" });
    await repository.saveRun(checkpoint);

    const recovered = await service.executeRun(created.id);

    expect(calls).toEqual(new Map([["Бренд А", 1], ["Бренд Б", 1]]));
    expect(recovered.partitions).toHaveLength(2);
    expect(recovered.observations).toHaveLength(2);
    expect(recovered.errors).toEqual([]);
    expect(recovered.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("finalizes an interrupted run without recollecting when every partition is checkpointed", async () => {
    const repository = new MemoryRepository();
    let resolutions = 0;
    const service = new RatingsService(repository, async () => {
      resolutions += 1;
      return new FakeAdapter();
    });
    const completed = await service.executeRun((await service.createRun(request)).id);
    completed.status = "failed";
    completed.payloadHash = undefined;
    completed.qa = undefined;
    completed.errors = [{ partition: "orchestrator", message: "final state write failed" }];
    await repository.saveRun(completed);

    const recovered = await service.executeRun(completed.id);

    expect(resolutions).toBe(1);
    expect(recovered.status).toBe("review");
    expect(recovered.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(recovered.errors).toEqual([]);
    expect(recovered.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("finalizes a fully checkpointed running retry when no collection operation remains active", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => new FakeAdapter());
    const completed = await service.executeRun((await service.createRun(request)).id);
    completed.status = "running";
    completed.payloadHash = undefined;
    completed.qa = undefined;
    completed.collectionFinishedAt = undefined;
    completed.activity = { sequence: 1, active: [], recent: [] };
    await repository.saveRun(completed);

    const recovered = await service.reconcileInterruptedRun(completed);

    expect(recovered.status).toBe("review");
    expect(recovered.collectionFinishedAt).toBeTruthy();
    expect(recovered.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(recovered.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("restores partial publication and failed-only retry after a checkpoint RPC interruption", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => new FakeAdapter());
    const created = await service.createRun({
      ...request,
      domains: ["ozon.ru", "market.yandex.ru"],
      brands: ["Brand"]
    });
    created.status = "failed";
    created.progress = {
      totalPartitions: 2,
      completedPartitions: 1,
      current: "market.yandex.ru / Brand"
    };
    created.partitions = [{
      domain: "ozon.ru", brand: "Brand", status: "complete", discovered: 1, collected: 1
    }];
    created.observations = [{
      domain: "ozon.ru", platform: "ozon", listingId: "1", brand: "Brand",
      canonicalUrl: "https://ozon.ru/product/1", product: "Brand tablets 100 mg 10",
      reviews: 12, rating: 4.8, status: "ok", capturedAt: "2026-07-31T14:53:04.804Z"
    }];
    created.errors = [{ partition: "orchestrator", message: "Repository RPC HTTP 500: non-JSON response" }];
    await repository.saveRun(created);

    const recovered = await service.reconcileInterruptedRun(created);

    expect(recovered).toMatchObject({
      status: "review",
      progress: { totalPartitions: 2, completedPartitions: 2 },
      partitions: [
        { domain: "ozon.ru", status: "complete" },
        {
          domain: "market.yandex.ru",
          status: "blocked",
          message: expect.stringContaining("Repository RPC HTTP 500")
        }
      ]
    });
    expect(recovered.progress.current).toBeUndefined();
    expect(recovered.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(recovered.qa?.blockers).toEqual([
      expect.stringContaining("market.yandex.ru / Brand")
    ]);
    expect(recovered.errors).toEqual([{
      partition: "market.yandex.ru/Brand",
      message: expect.stringContaining("Repository RPC HTTP 500")
    }]);

    const partial = await service.excludeFailedPartitionsFromPublication(recovered.id);
    expect(partial.qa).toMatchObject({ ok: true, blockers: [] });
    expect(partial.publicationExclusions).toMatchObject([{
      domain: "market.yandex.ru", brand: "Brand"
    }]);
  });

  it("reopens a legacy published partial result before excluding its failed partitions", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => new FakeAdapter());
    const created = await service.createRun({
      ...request,
      domains: ["example.com", "blocked.example"]
    });
    created.status = "published";
    created.progress = { totalPartitions: 2, completedPartitions: 2 };
    created.partitions = [
      { domain: "example.com", brand: "Бренд", status: "complete", discovered: 1, collected: 1 },
      { domain: "blocked.example", brand: "Бренд", status: "blocked", discovered: 0, collected: 0, message: "HTTP 502" }
    ];
    created.observations = [{
      domain: "example.com", platform: "example", listingId: "1", brand: "Бренд",
      canonicalUrl: "https://example.com/product/1", product: "Бренд таблетки 100 мг №10",
      reviews: 12, rating: 4.8, status: "ok", capturedAt: "2026-07-31T14:53:04.804Z"
    }];
    await repository.saveRun(created);

    const scoped = await service.excludeFailedPartitionsFromPublication(created.id);

    expect(scoped.status).toBe("review");
    expect(scoped.publicationExclusions).toMatchObject([{ domain: "blocked.example", brand: "Бренд" }]);
    expect(scoped.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("collects all partitions and only commits history after explicit publication step", async () => {
    const repository = new MemoryRepository(); const service = new RatingsService(repository, async () => new FakeAdapter());
    const created = await service.createRun(request); const run = await service.executeRun(created.id);
    expect(run.status).toBe("review"); expect(run.qa?.ok).toBe(true); expect(await repository.listProducts("test_sheet")).toHaveLength(0);
    await service.commitSuccessfulRun(run);
    expect(await repository.listProducts("test_sheet")).toHaveLength(1); expect(Object.keys((await repository.getSnapshots("test_sheet"))["2026-07"])).toEqual(["example.com:1"]);
  });

  it("reuses an exact published identity only for the same unchanged partial card", async () => {
    const repository = new MemoryRepository();
    await repository.saveProducts("test_sheet", [{
      key: "example.com:1", domain: "example.com", listingId: "1", brand: "БРЕНД",
      canonicalUrl: "https://example.com/p/1", product: "БРЕНД   таблетки", platform: "fake",
      productIdentity: {
        label: "таблетки 100 мг №10", granularity: "variant", confidence: "exact", missing: [], reasons: []
      },
      firstSeenMonth: "2026-06", lastSeenMonth: "2026-06"
    }]);
    const service = new RatingsService(repository, async () => ({
      id: "published-identity", supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        return [{ domain: "example.com", platform: "fake", listingId: "1", brand, url: "https://example.com/p/1", metadata: {} }];
      },
      async collect(ref) {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: "Бренд таблетки", reviews: 5, rating: 4.8,
          status: "ok" as const, capturedAt: new Date().toISOString()
        };
      }
    }));

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.qa).toMatchObject({ ok: true, blockers: [] });
    expect(run.observations[0]).toMatchObject({
      status: "ok",
      productIdentity: {
        label: "таблетки 100 мг №10",
        granularity: "variant",
        confidence: "exact",
        reasons: [expect.stringContaining("переиспользовано из опубликованной карточки")]
      }
    });
  });

  it.each([
    ["changed URL", "Бренд таблетки", "https://example.com/p/changed", "Бренд", "ok"],
    ["changed raw title", "Бренд капсулы", "https://example.com/p/1", "Бренд", "ok"],
    ["changed brand", "Бренд таблетки", "https://example.com/p/1", "Другой бренд", "ok"],
    ["adapter review status", "Бренд таблетки", "https://example.com/p/1", "Бренд", "needs_review"]
  ])("does not reuse a published identity for %s", async (_case, product, canonicalUrl, previousBrand, status) => {
    const repository = new MemoryRepository();
    await repository.saveProducts("test_sheet", [{
      key: "example.com:1", domain: "example.com", listingId: "1", brand: previousBrand,
      canonicalUrl: "https://example.com/p/1", product: "Бренд таблетки", platform: "fake",
      productIdentity: {
        label: "таблетки 100 мг №10", granularity: "variant", confidence: "exact", missing: [], reasons: []
      },
      firstSeenMonth: "2026-06", lastSeenMonth: "2026-06"
    }]);
    const service = new RatingsService(repository, async () => ({
      id: "published-identity-negative", supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        return [{ domain: "example.com", platform: "fake", listingId: "1", brand, url: canonicalUrl, metadata: {} }];
      },
      async collect(ref): Promise<Observation> {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product, reviews: 5, rating: 4.8,
          status: status as Observation["status"], capturedAt: new Date().toISOString()
        };
      }
    }));

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.observations[0]?.status).toBe("needs_review");
    expect(run.observations[0]?.productIdentity?.reasons.join(" ")).not.toContain("переиспользовано");
  });

  it("does not hide ambiguous current evidence behind a published identity", async () => {
    const repository = new MemoryRepository();
    const product = "Бренд таблетки 100 мг №10";
    await repository.saveProducts("test_sheet", [{
      key: "example.com:1", domain: "example.com", listingId: "1", brand: "Бренд",
      canonicalUrl: "https://example.com/p/1", product, platform: "fake",
      productIdentity: {
        label: "таблетки 100 мг №10", granularity: "variant", confidence: "exact", missing: [], reasons: []
      },
      firstSeenMonth: "2026-06", lastSeenMonth: "2026-06"
    }]);
    const service = new RatingsService(repository, async () => ({
      id: "published-identity-conflict", supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        return [{ domain: "example.com", platform: "fake", listingId: "1", brand, url: "https://example.com/p/1", metadata: {} }];
      },
      async collect(ref): Promise<Observation> {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product, reviews: 5, rating: 4.8, status: "ok",
          capturedAt: new Date().toISOString(),
          productEvidence: {
            scope: "listing",
            signals: [
              { source: "title", text: product },
              { source: "variant", text: "Бренд таблетки 200 мг №10" }
            ],
            variants: ["Бренд таблетки 200 мг №10"], identifiers: [], imageUrls: [], instructionUrls: []
          }
        };
      }
    }));

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.observations[0]).toMatchObject({
      status: "needs_review",
      productIdentity: { granularity: "unresolved", confidence: "ambiguous" }
    });
  });

  it("keeps correct first and last seen bounds when an older month is published later", async () => {
    const repository = new MemoryRepository();
    await repository.saveProducts("test_sheet", [{
      key: "example.com:1", domain: "example.com", listingId: "1", brand: "Бренд",
      canonicalUrl: "https://example.com/p/1", product: "Бренд таблетки 100 мг №10", platform: "fake",
      firstSeenMonth: "2026-08", lastSeenMonth: "2026-09"
    }]);
    const service = new RatingsService(repository, async () => new FakeAdapter());
    const run = await service.executeRun((await service.createRun(request)).id);

    await service.commitSuccessfulRun(run);

    expect((await repository.listProducts("test_sheet"))[0]).toMatchObject({
      firstSeenMonth: "2026-07",
      lastSeenMonth: "2026-09"
    });
  });

  it("blocks publication if a canary health check fails", async () => {
    const service = new RatingsService(new MemoryRepository(), async () => new FakeAdapter(false));
    const run = await service.executeRun((await service.createRun(request)).id);
    expect(run.qa?.ok).toBe(false); expect(run.partitions[0].status).toBe("blocked");
    await expect(service.commitSuccessfulRun(run)).rejects.toThrow("Публикация заблокирована");
  });

  it("keeps access blocks and exhausted quotas distinct from a changed parser", async () => {
    const profile = {
      domain: "example.com", version: 1, status: "approved" as const,
      sitemapUrls: [], ratingScale: 5, reviewCountMeaning: "reviews" as const,
      rateLimitMs: 0, canaryUrls: [], testExamples: [],
      createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z", notes: []
    };
    class UnhealthyAdapter extends FakeAdapter {
      constructor(private readonly failureMessage: string) { super(); }
      override async healthCheck() {
        return { ok: false, checkedAt: new Date().toISOString(), message: this.failureMessage };
      }
    }
    const blockedRepository = new MemoryRepository();
    await blockedRepository.saveProfile(profile);
    const blockedService = new RatingsService(
      blockedRepository,
      async () => new UnhealthyAdapter("blocked_free_mode: origin HTTP 403")
    );

    const blockedRun = await blockedService.executeRun((await blockedService.createRun(request)).id);

    expect(blockedRun.partitions[0].message).toContain("blocked: blocked_free_mode");
    expect((await blockedRepository.getProfile("example.com"))?.status).toBe("approved");

    const transientRepository = new MemoryRepository();
    await transientRepository.saveProfile(profile);
    const transientService = new RatingsService(
      transientRepository,
      async () => new UnhealthyAdapter("HTTP 502")
    );
    const transientRun = await transientService.executeRun((await transientService.createRun(request)).id);
    expect(transientRun.partitions[0].message).toBe("blocked: HTTP 502");
    expect((await transientRepository.getProfile("example.com"))?.status).toBe("approved");

    const nonApifyService = new RatingsService(
      new MemoryRepository(),
      async () => new UnhealthyAdapter("blocked_free_mode: origin HTTP 403; Apify не используется")
    );
    const nonApifyRun = await nonApifyService.executeRun((await nonApifyService.createRun(request)).id);
    expect(nonApifyRun.partitions[0].message).toContain("blocked: blocked_free_mode");
    expect(nonApifyRun.partitions[0].message).not.toContain("quota_exceeded");

    const quotaService = new RatingsService(
      new MemoryRepository(),
      async () => new UnhealthyAdapter("Monthly sandbox quota exceeded")
    );
    const quotaRun = await quotaService.executeRun((await quotaService.createRun(request)).id);
    expect(quotaRun.partitions[0].message).toContain("quota_exceeded: Monthly sandbox quota exceeded");
  });

  it("does not allow review mutations after publication has started", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => new FakeAdapter());
    const run = await service.executeRun((await service.createRun(request)).id);
    run.status = "publishing";
    await repository.saveRun(run);

    await expect(service.approveObservations(run.id, ["example.com:1"]))
      .rejects.toThrow("Нельзя подтверждать карточки из статуса publishing");
  });

  it("accepts selected review cards and explicitly discards rejected findings without writing zeros", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => ({
      id: "review-resolution",
      supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string) {
        return ["1", "2", "3"].map((listingId) => ({
          domain: "example.com", platform: "review-resolution", listingId, brand,
          url: `https://example.com/product/${listingId}`, metadata: {}
        }));
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: `${ref.brand} таблетки 100 мг №${ref.listingId}0`,
          reviews: Number(ref.listingId), rating: 4.8, status: "needs_review",
          capturedAt: new Date().toISOString()
        };
      }
    }));
    const run = await service.executeRun((await service.createRun(request)).id);

    const resolved = await service.approveObservations(
      run.id,
      ["example.com:1"],
      {},
      ["example.com:2", "example.com:3"]
    );

    expect(resolved.observations).toMatchObject([{
      listingId: "1", reviews: 1, rating: 4.8, status: "ok"
    }]);
    expect(resolved.observations).toHaveLength(1);
    expect(resolved.qa).toEqual({ ok: true, blockers: [], warnings: [] });
    expect(resolved.observations.some((item) => item.reviews === 0)).toBe(false);
  });

  it("ignores a stale draft profile for a known adapter but guards versioned generic observations", async () => {
    const makeService = async (versioned: boolean) => {
      const repository = new MemoryRepository();
      await repository.saveProfile({
        domain: "example.com", version: 1, status: "draft",
        sitemapUrls: [], ratingScale: 5, reviewCountMeaning: "unknown",
        rateLimitMs: 0, canaryUrls: [], testExamples: [],
        createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z", notes: []
      });
      const service = new RatingsService(repository, async () => ({
        id: versioned ? "generated-profile" : "known-adapter",
        supportedDomains: ["example.com"],
        async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
        async discover(brand: string) {
          return [{ domain: "example.com", platform: "review-site", listingId: "1", brand, url: "https://example.com/p/1", metadata: {} }];
        },
        async collect(ref: ProductRef): Promise<Observation> {
          return {
            domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
            canonicalUrl: ref.url, product: `${ref.brand} таблетки 100 мг №10`, reviews: 5, rating: 4.8,
            status: "needs_review", capturedAt: new Date().toISOString(),
            ...(versioned ? { profileVersion: 1 } : {})
          };
        }
      }));
      return { service, run: await service.executeRun((await service.createRun(request)).id) };
    };

    const known = await makeService(false);
    const acceptedKnown = await known.service.approveObservations(known.run.id, ["example.com:1"]);
    expect(acceptedKnown.observations[0]).toMatchObject({ status: "ok" });
    expect(acceptedKnown.observations[0].profileVersion).toBeUndefined();

    const generated = await makeService(true);
    await expect(generated.service.approveObservations(generated.run.id, ["example.com:1"]))
      .rejects.toThrow("Сначала подтвердите профиль площадки example.com по трём контрольным карточкам");
  });

  it("accepts a proven product or aggregate but never a bare pharmaceutical form", async () => {
    const makeService = (product: string, productEvidence?: Observation["productEvidence"]) => new RatingsService(
      new MemoryRepository(),
      async () => ({
        id: "identity-review",
        supportedDomains: ["example.com"],
        async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
        async discover(brand: string) {
          return [{ domain: "example.com", platform: "identity-review", listingId: "1", brand, url: "https://example.com/p/1", metadata: {} }];
        },
        async collect(ref: ProductRef): Promise<Observation> {
          return {
            domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
            canonicalUrl: ref.url, product, reviews: 5, rating: 4.8, status: "needs_review",
            capturedAt: new Date().toISOString(), productEvidence
          };
        }
      })
    );

    const productService = makeService("Бренд таблетки №20");
    const productRun = await productService.executeRun((await productService.createRun(request)).id);
    await expect(productService.approveObservations(productRun.id, ["example.com:1"]))
      .resolves.toMatchObject({ observations: [{ status: "ok", productIdentity: { label: "таблетки №20" } }] });

    const bareFormService = makeService("Бренд капсулы");
    const bareFormRun = await bareFormService.executeRun((await bareFormService.createRun(request)).id);
    await expect(bareFormService.approveObservations(bareFormRun.id, ["example.com:1"]))
      .rejects.toThrow("не содержит доказанного товарного варианта");
    await expect(bareFormService.approveObservations(
      bareFormRun.id,
      ["example.com:1"],
      { "example.com:1": "капсулы" }
    )).rejects.toThrow("Уточните форму, дозировку или упаковку");
    const manuallyResolved = await bareFormService.approveObservations(
      bareFormRun.id,
      ["example.com:1"],
      { "example.com:1": "капсулы 100 мг №20" }
    );
    expect(manuallyResolved.observations[0]).toMatchObject({
      status: "ok",
      product: "Бренд капсулы",
      productOverride: "капсулы 100 мг №20",
      productIdentity: {
        granularity: "variant",
        confidence: "exact",
        label: "капсулы 100 мг №20",
        canonicalVariantId: expect.stringMatching(/^variant:v1:/),
        resolutionMethod: "operator_override"
      }
    });

    const aggregateService = makeService("Бренд отзывы", {
      scope: "product_family", signals: [{ source: "title", text: "Бренд отзывы" }],
      variants: [], identifiers: [], imageUrls: [], instructionUrls: []
    });
    const aggregateRun = await aggregateService.executeRun((await aggregateService.createRun(request)).id);
    await expect(aggregateService.approveObservations(aggregateRun.id, ["example.com:1"]))
      .resolves.toMatchObject({ observations: [{ status: "ok", productIdentity: { granularity: "family" } }] });

    const legacyReviewRequest = { ...request, domains: ["irecommend.ru"] };
    const legacyReviewService = new RatingsService(new MemoryRepository(), async () => ({
      id: "legacy-review-aggregate",
      supportedDomains: ["irecommend.ru"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string) {
        return [{ domain: "irecommend.ru", platform: "irecommend.ru", listingId: "11557796", brand, url: "https://irecommend.ru/content/brand", metadata: {} }];
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: `${ref.brand} отзывы`, reviews: 12, rating: 4.8,
          status: "needs_review", capturedAt: new Date().toISOString(),
          productEvidence: { scope: "listing", signals: [{ source: "title", text: `${ref.brand} отзывы` }], variants: [], identifiers: [], imageUrls: [], instructionUrls: [] }
        };
      }
    }));
    const legacyReviewRun = await legacyReviewService.executeRun((await legacyReviewService.createRun(legacyReviewRequest)).id);
    await expect(legacyReviewService.approveObservations(legacyReviewRun.id, ["irecommend.ru:11557796"]))
      .resolves.toMatchObject({ observations: [{ status: "ok", productIdentity: { granularity: "family" } }] });

    const yandexRequest = { ...request, domains: ["reviews.yandex.ru"], brands: ["Даксабрис"] };
    const yandexService = new RatingsService(new MemoryRepository(), async () => ({
      id: "yandex-review-aggregate",
      supportedDomains: ["reviews.yandex.ru"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string) {
        return [{ domain: "reviews.yandex.ru", platform: "yandex", listingId: "900082876", brand, url: "https://reviews.yandex.ru/product/daksabris--900082876", metadata: {} }];
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: ref.brand, reviews: 3, rating: 4.9,
          status: "needs_review", capturedAt: new Date().toISOString(),
          productEvidence: { scope: "listing", signals: [{ source: "title", text: ref.brand }], variants: [], identifiers: [], imageUrls: [], instructionUrls: [] }
        };
      }
    }));
    const yandexRun = await yandexService.executeRun((await yandexService.createRun(yandexRequest)).id);
    await expect(yandexService.approveObservations(yandexRun.id, ["reviews.yandex.ru:900082876"]))
      .resolves.toMatchObject({ observations: [{ status: "ok", productIdentity: { granularity: "family" } }] });
  });

  it("normalizes a human-confirmed exact Yandex family without inventing a variant", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => ({
      id: "yandex-family-normalization",
      supportedDomains: ["reviews.yandex.ru"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string) {
        return [{
          domain: "reviews.yandex.ru", platform: "yandex", listingId: "704207830", brand,
          url: "https://reviews.yandex.ru/product/semavik--704207830", metadata: {}
        }];
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: "Сeмавик", reviews: 41, rating: 4.8,
          status: "needs_review", capturedAt: new Date().toISOString(), source: "yandex_reviews_json_ld",
          productEvidence: {
            scope: "listing", signals: [{ source: "title", text: "Сeмавик" }], variants: [],
            identifiers: [{ type: "model_id", value: ref.listingId }], imageUrls: [], instructionUrls: []
          }
        };
      }
    }));
    const run = await service.executeRun((await service.createRun({
      ...request,
      domains: ["reviews.yandex.ru"],
      brands: ["Семавик"]
    })).id);

    const approved = await service.approveObservations(
      run.id,
      ["reviews.yandex.ru:704207830"],
      { "reviews.yandex.ru:704207830": "Семавик" }
    );

    expect(approved.observations[0]).toMatchObject({
      product: "Сeмавик",
      productOverride: "Семавик",
      status: "ok",
      productIdentity: { label: "Семавик", granularity: "family", confidence: "exact" }
    });
  });

  it("does not reuse an operator-confirmed generic alias across domains", async () => {
    const repository = new MemoryRepository();
    await repository.saveProducts("test_sheet", [{
      key: "old.example:old", domain: "old.example", listingId: "old", brand: "Бренд",
      canonicalUrl: "https://old.example/p/old", product: "Бренд таблетки", platform: "old",
      productIdentity: {
        label: "таблетки 100 мг №10", granularity: "variant", confidence: "exact",
        missing: [], reasons: [], canonicalVariantId: "variant:v1:confirmed",
        variantKeyVersion: 1, resolutionMethod: "operator_override"
      },
      productOverride: "таблетки 100 мг №10",
      firstSeenMonth: "2026-06", lastSeenMonth: "2026-06"
    }]);
    const service = new RatingsService(repository, async () => ({
      id: "catalog-alias", supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        return [{ domain: "example.com", platform: "new", listingId: "new", brand, url: "https://example.com/p/new", metadata: {} }];
      },
      async collect(ref) {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: "Бренд таблетки", reviews: 8, rating: 4.9,
          status: "ok" as const, capturedAt: new Date().toISOString()
        };
      }
    }));

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.observations[0]).toMatchObject({
      status: "needs_review",
      product: "Бренд таблетки",
      productIdentity: {
        label: "Общая карточка формы «таблетки»"
      }
    });
    expect(run.observations[0]?.productIdentity?.canonicalVariantId).toBeUndefined();
    expect(run.observations[0]?.productIdentity?.resolutionMethod).not.toBe("catalog_alias");
  });

  it("does not gate a dedicated review-site observation on a stale generic profile", async () => {
    const repository = new MemoryRepository();
    await repository.saveProfile({
      domain: "irecommend.ru", version: 7, status: "parser_changed",
      sitemapUrls: [], ratingScale: 5, reviewCountMeaning: "unknown",
      rateLimitMs: 0, canaryUrls: [], testExamples: [],
      createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z", notes: []
    });
    const dedicatedRequest = { ...request, domains: ["irecommend.ru"], brands: ["Тикализис"] };
    const service = new RatingsService(repository, async () => ({
      id: "dedicated-irecommend",
      supportedDomains: ["irecommend.ru"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string) {
        return [{ domain: "irecommend.ru", platform: "irecommend.ru", listingId: "live", brand, url: "https://irecommend.ru/content/tikalizis", metadata: {} }];
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: `${ref.brand} отзывы`, reviews: 2, rating: 5,
          status: "needs_review", capturedAt: new Date().toISOString(),
          productEvidence: { scope: "product_family", signals: [{ source: "title", text: `${ref.brand} отзывы` }], variants: [], identifiers: [], imageUrls: [], instructionUrls: [] }
        };
      }
    }));

    const run = await service.executeRun((await service.createRun(dedicatedRequest)).id);
    const approved = await service.approveObservations(run.id, ["irecommend.ru:live"]);

    expect(approved.observations[0]).toMatchObject({ status: "ok" });
    expect(approved.observations[0].profileVersion).toBeUndefined();
    await expect(service.commitSuccessfulRun(approved)).resolves.toBeUndefined();
  });

  it("keeps a fully proved dedicated aggregate ready without manual review", async () => {
    const domain = "irecommend.ru";
    const aggregateRequest = { ...request, domains: [domain] };
    const makeService = (profileVersion?: number) => new RatingsService(new MemoryRepository(), async () => ({
      id: profileVersion === undefined ? "dedicated-aggregate" : "generic-aggregate",
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string) {
        return [{ domain, platform: domain, listingId: "proved", brand, url: `https://${domain}/content/brand`, metadata: {} }];
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain, platform: domain, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: `${ref.brand} отзывы`, reviews: 12, rating: 4.8,
          status: "ok", capturedAt: new Date().toISOString(), evidenceRef: "memory://aggregate-proof",
          source: "json-ld", ...(profileVersion === undefined ? {} : { profileVersion }),
          productEvidence: {
            scope: "product_family", signals: [{ source: "title", text: `${ref.brand} отзывы` }],
            variants: [], identifiers: [], imageUrls: [], instructionUrls: []
          }
        };
      }
    }));

    const dedicated = makeService();
    const ready = await dedicated.executeRun((await dedicated.createRun(aggregateRequest)).id);
    expect(ready).toMatchObject({ qa: { ok: true, blockers: [] }, observations: [{ status: "ok" }] });

    const generic = makeService(1);
    const review = await generic.executeRun((await generic.createRun(aggregateRequest)).id);
    expect(review.observations[0].status).toBe("needs_review");
    expect(review.qa?.ok).toBe(false);
  });

  it("auto-accepts separate source-bound review pages even when a family label looks like a collapsed line", async () => {
    const domain = "vseotzyvy.ru";
    const brand = "Kagocel";
    const service = new RatingsService(new MemoryRepository(), async () => ({
      id: "vseotzyvy-dedicated",
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(): Promise<ProductRef[]> {
        return [
          { domain, platform: domain, listingId: "49555", brand, url: `https://${domain}/item/49555/reviews-kagocel/`, title: brand, metadata: {} },
          { domain, platform: domain, listingId: "59343", brand, url: `https://${domain}/item/59343/reviews-kagocel-forte/`, title: `${brand} Forte`, metadata: {} }
        ];
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain, platform: domain, listingId: ref.listingId, brand,
          canonicalUrl: ref.url, product: ref.title!, reviews: ref.listingId === "59343" ? 13 : 72,
          rating: ref.listingId === "59343" ? 4.9 : 5, status: "ok", capturedAt: new Date().toISOString(),
          evidenceRef: `${ref.url}#aggregate-rating`, source: "vseotzyvy-product-aggregate",
          productEvidence: {
            scope: "product_family", signals: [{ source: "title", text: ref.title! }], variants: [],
            identifiers: [{ type: "product_id", value: ref.listingId }], imageUrls: [], instructionUrls: []
          }
        };
      }
    }));

    const run = await service.executeRun((await service.createRun({ ...request, domains: [domain], brands: [brand] })).id);

    expect(run.observations).toHaveLength(2);
    expect(run.observations.map((item) => [item.listingId, item.status])).toEqual([
      ["49555", "ok"], ["59343", "ok"]
    ]);
    expect(run.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it.each([
    ["generic profile", { profileVersion: 1 }],
    ["listing evidence", { evidenceScope: "listing" }],
    ["historical result", { historical: true }],
    ["manual override", { productOverride: "tablets 10 mg no. 20" }],
    ["unmatched product title", { product: "Another medicine Forte" }]
  ] as const)("does not auto-accept a dedicated aggregate with %s", async (_label, options) => {
    const domain = "vseotzyvy.ru";
    const brand = "Kagocel";
    const service = new RatingsService(new MemoryRepository(), async () => ({
      id: "unsafe-review-aggregate",
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover() {
        return [{ domain, platform: domain, listingId: "59343", brand, url: `https://${domain}/item/59343/reviews-kagocel-forte/`, metadata: {} }];
      },
      async collect(ref: ProductRef): Promise<Observation> {
        const product = "product" in options ? options.product : `${brand} Forte`;
        return {
          domain, platform: domain, listingId: ref.listingId, brand, canonicalUrl: ref.url,
          product, reviews: 13, rating: 4.9, status: "ok", capturedAt: new Date().toISOString(),
          evidenceRef: `${ref.url}#aggregate-rating`, source: "vseotzyvy-product-aggregate",
          ...( "profileVersion" in options ? { profileVersion: options.profileVersion } : {}),
          ...( "historical" in options ? { historical: options.historical } : {}),
          ...( "productOverride" in options ? { productOverride: options.productOverride } : {}),
          productEvidence: {
            scope: "evidenceScope" in options ? options.evidenceScope : "product_family",
            signals: [{ source: "title", text: product }], variants: [],
            identifiers: [{ type: "product_id", value: ref.listingId }], imageUrls: [], instructionUrls: []
          }
        };
      }
    }));

    const run = await service.executeRun((await service.createRun({ ...request, domains: [domain], brands: [brand] })).id);

    expect(run.observations).toHaveLength(1);
    expect(run.observations[0].status).toBe("needs_review");
    expect(run.qa?.ok).toBe(false);
  });

  it("keeps several source-bound consumer product pages as separate exact variants", async () => {
    const domain = "uteka.ru";
    const service = new RatingsService(new MemoryRepository(), async () => ({
      id: "uteka-distinct-products",
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string): Promise<ProductRef[]> {
        return [
          { listingId: "rattle", product: `${brand} погремушка` },
          { listingId: "pacifier", product: `${brand} пустышка` }
        ].map(({ listingId, product }) => ({
          domain, platform: domain, listingId, brand,
          url: `https://${domain}/catalog/${listingId}/reviews/`, title: product, metadata: {}
        }));
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain, platform: domain, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: ref.title!, reviews: 5, rating: 4.8,
          status: "ok", capturedAt: new Date().toISOString(), evidenceRef: `${ref.url}#aggregate`,
          source: "product-aggregate",
          productEvidence: {
            scope: "product_family", signals: [{ source: "title", text: ref.title! }], variants: [],
            identifiers: [{ type: "product_id", value: ref.listingId }], imageUrls: [], instructionUrls: []
          }
        };
      }
    }));

    const run = await service.executeRun((await service.createRun({
      ...request, domains: [domain], brands: ["Canpol Babies"]
    })).id);

    expect(run.observations).toHaveLength(2);
    expect(run.observations.map((item) => item.productIdentity?.label).sort()).toEqual(["погремушка", "пустышка"]);
    expect(run.observations.every((item) => item.status === "ok" &&
      item.productIdentity?.granularity === "variant" && item.productIdentity.confidence === "exact")).toBe(true);
    expect(run.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("auto-accepts a dedicated Yandex model aggregate with a stable model id", async () => {
    const domain = "reviews.yandex.ru";
    const service = new RatingsService(new MemoryRepository(), async () => ({
      id: "yandex-model-aggregate",
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string) {
        return [{
          domain, platform: "yandex", listingId: "265149860", brand,
          url: "https://reviews.yandex.ru/product/kagotsel--265149860", metadata: {}
        }];
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: ref.brand, reviews: 711, rating: 4.7,
          status: "ok", capturedAt: new Date().toISOString(),
          evidenceRef: `${ref.url}#json-ld`, source: "yandex_reviews_direct",
          productEvidence: {
            scope: "listing", signals: [{ source: "json_ld", text: ref.brand }], variants: [],
            identifiers: [{ type: "model_id", value: ref.listingId }], imageUrls: [], instructionUrls: []
          }
        };
      }
    }));

    const run = await service.executeRun((await service.createRun({ ...request, domains: [domain], brands: ["Кагоцел"] })).id);
    expect(run).toMatchObject({ qa: { ok: true, blockers: [] }, observations: [{ status: "ok" }] });
  });

  it("keeps a disappeared registry card as a verified empty month without losing history", async () => {
    const repository = new MemoryRepository();
    await repository.saveProducts("test_sheet", [{
      key: "example.com:old",
      domain: "example.com",
      listingId: "old",
      brand: "Бренд",
      canonicalUrl: "https://example.com/p/old",
      product: "Бренд — старая упаковка",
      platform: "fake",
      firstSeenMonth: "2026-05",
      lastSeenMonth: "2026-06"
    }]);
    const missingAdapter: SiteAdapter = {
      id: "missing",
      supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand, context) {
        return [{
          domain: "example.com", platform: "fake", listingId: context.previousIds![0], brand,
          url: "https://example.com/changed/old", metadata: {}
        }];
      },
      async collect(ref) {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: "Бренд", reviews: null, rating: null,
          status: "not_found", capturedAt: new Date().toISOString()
        };
      }
    };
    const service = new RatingsService(repository, async () => missingAdapter);

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.qa?.ok).toBe(true);
    expect(run.observations[0]).toMatchObject({
      status: "not_found",
      historical: true,
      canonicalUrl: "https://example.com/p/old",
      product: "Бренд — старая упаковка",
      reviews: null,
      rating: null
    });
    await service.commitSuccessfulRun(run);
    expect((await repository.listProducts("test_sheet"))[0]).toMatchObject({
      firstSeenMonth: "2026-05",
      lastSeenMonth: "2026-06"
    });
    expect((await repository.getSnapshots("test_sheet"))["2026-07"]["example.com:old"])
      .toMatchObject({ historical: true, reviews: null, rating: null });
  });

  it("does not treat a new 404 as a successful historical result", async () => {
    class NewMissingAdapter extends FakeAdapter {
      override async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: ref.brand, reviews: null, rating: null,
          status: "not_found", capturedAt: new Date().toISOString()
        };
      }
    }
    const service = new RatingsService(new MemoryRepository(), async () => new NewMissingAdapter());

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.observations[0]).toMatchObject({ status: "needs_review", historical: false });
    expect(run.qa?.ok).toBe(false);
  });

  it("excludes a new Yandex candidate only after the adapter proves its Reviews page missing", async () => {
    class MissingYandexCandidateAdapter extends FakeAdapter {
      override supportedDomains = ["market.yandex.ru"];
      override async discover(brand: string): Promise<ProductRef[]> {
        return [{
          domain: "market.yandex.ru", platform: "yandex", listingId: "1", brand,
          url: "https://reviews.yandex.ru/product/model--1", metadata: {}
        }];
      }
      override async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain,
          platform: "yandex",
          listingId: ref.listingId,
          brand: ref.brand,
          canonicalUrl: ref.url,
          product: ref.brand,
          reviews: null,
          rating: null,
          status: "not_found",
          source: "yandex_reviews_missing_candidate",
          capturedAt: new Date().toISOString()
        };
      }
    }
    const service = new RatingsService(
      new MemoryRepository(),
      async () => new MissingYandexCandidateAdapter()
    );

    const run = await service.executeRun((await service.createRun({
      ...request,
      domains: ["market.yandex.ru"]
    })).id);

    expect(run.observations).toEqual([]);
    expect(run.partitions).toMatchObject([{
      domain: "market.yandex.ru",
      status: "no_results",
      discovered: 0,
      collected: 0
    }]);
    expect(run.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("completes Otzovik with two valid aggregates and omits one explicitly retired search card", async () => {
    const domain = "otzovik.com";
    const aggregateRequest = { ...request, domains: [domain], brands: ["Оциллококцинум"] };
    const service = new RatingsService(new MemoryRepository(), async () => ({
      id: "otzovik-retired-search-card",
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string): Promise<ProductRef[]> {
        return ["4948", "retired", "2620333"].map((listingId) => ({
          domain, platform: domain, listingId, brand,
          url: `https://${domain}/reviews/${listingId}/`, metadata: {}
        }));
      },
      async collect(ref: ProductRef): Promise<Observation> {
        if (ref.listingId === "retired") {
          return {
            domain, platform: domain, listingId: ref.listingId, brand: ref.brand,
            canonicalUrl: ref.url, product: ref.brand, reviews: null, rating: null,
            status: "not_found", source: "otzovik_missing_candidate", capturedAt: new Date().toISOString()
          };
        }
        return {
          domain, platform: domain, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: `${ref.brand} отзывы`, reviews: ref.listingId === "4948" ? 394 : 1,
          rating: ref.listingId === "4948" ? 4 : 5, status: "ok", capturedAt: new Date().toISOString(),
          evidenceRef: `${ref.url}#aggregate`, source: "microdata",
          productEvidence: {
            scope: "product_family", signals: [{ source: "title", text: ref.brand }], variants: [],
            identifiers: [{ type: "product_id", value: ref.listingId }], imageUrls: [], instructionUrls: []
          }
        };
      }
    }));

    const run = await service.executeRun((await service.createRun(aggregateRequest)).id);

    expect(run.observations).toHaveLength(2);
    expect(run.observations.map((item) => item.listingId).sort()).toEqual(["2620333", "4948"]);
    expect(run.observations.every((item) => item.status === "ok")).toBe(true);
    expect(run.partitions).toMatchObject([{ status: "complete", discovered: 2, collected: 2 }]);
    expect(run.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("clears a marketplace default rating when written reviewCount is zero", async () => {
    class DefaultRatingWithoutReviewsAdapter extends FakeAdapter {
      override async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain,
          platform: ref.platform,
          listingId: ref.listingId,
          brand: ref.brand,
          canonicalUrl: ref.url,
          product: `${ref.brand} таблетки 100 мг №10`,
          reviews: 0,
          rating: 5,
          rawRating: 5,
          rawRatingScale: 5,
          status: "no_reviews",
          capturedAt: new Date().toISOString()
        };
      }
    }
    const service = new RatingsService(
      new MemoryRepository(),
      async () => new DefaultRatingWithoutReviewsAdapter()
    );

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.observations[0]).toMatchObject({
      reviews: 0,
      rating: null,
      rawRating: 5,
      status: "no_reviews"
    });
    expect(run.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("normalizes an adapter's ok status to no_reviews when reviewCount is zero", async () => {
    class InconsistentZeroReviewAdapter extends FakeAdapter {
      override async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain,
          platform: ref.platform,
          listingId: ref.listingId,
          brand: ref.brand,
          canonicalUrl: ref.url,
          product: `${ref.brand} таблетки 100 мг №10`,
          reviews: 0,
          rating: 4.9,
          ratingUnavailable: true,
          status: "ok",
          capturedAt: new Date().toISOString()
        };
      }
    }
    const service = new RatingsService(
      new MemoryRepository(),
      async () => new InconsistentZeroReviewAdapter()
    );

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.observations[0]).toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
    expect(run.observations[0]).not.toHaveProperty("ratingUnavailable");
    expect(run.qa?.ok).toBe(true);
  });

  it("publishes a proven review aggregate when the platform explicitly has no rating", async () => {
    const domain = "med-otzyv.ru";
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => ({
      id: "med-otzyv-explicit-rating-unavailable",
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string): Promise<ProductRef[]> {
        return [{
          domain,
          platform: domain,
          listingId: "751",
          brand,
          url: "https://med-otzyv.ru/lekarstva/143-kh/751-khondrofen",
          metadata: {}
        }];
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain,
          platform: domain,
          listingId: ref.listingId,
          brand: ref.brand,
          canonicalUrl: ref.url,
          product: `${ref.brand} мазь для наружного применения 30 г`,
          reviews: 1,
          rating: null,
          rawRating: null,
          ratingUnavailable: true,
          status: "ok",
          capturedAt: new Date().toISOString(),
          evidenceRef: "blob://med-otzyv/751",
          source: "med-otzyv-exact-index",
          productEvidence: {
            scope: "product_family",
            signals: [{ source: "title", text: `${ref.brand} мазь для наружного применения 30 г` }],
            variants: [],
            identifiers: [{ type: "product_id", value: ref.listingId }],
            imageUrls: [],
            instructionUrls: []
          }
        };
      }
    }));

    const run = await service.executeRun((await service.createRun({
      ...request,
      domains: [domain],
      brands: ["Хондрофен"]
    })).id);

    expect(run.observations).toMatchObject([{
      listingId: "751",
      reviews: 1,
      rating: null,
      rawRating: null,
      ratingUnavailable: true,
      status: "ok"
    }]);
    expect(run.qa).toMatchObject({
      ok: true,
      blockers: [],
      warnings: [expect.stringContaining("не рассчитала общий рейтинг")]
    });

    await expect(service.commitSuccessfulRun(run)).resolves.toBeUndefined();
    expect((await repository.getSnapshots("test_sheet"))["2026-07"][`${domain}:751`]).toMatchObject({
      reviews: 1,
      rating: null,
      rawRating: null,
      ratingUnavailable: true,
      status: "ok"
    });
  });

  it("normalizes ratings and reviews into one feedback count before QA", async () => {
    class SplitFeedbackAdapter extends FakeAdapter {
      override async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain,
          platform: ref.platform,
          listingId: ref.listingId,
          brand: ref.brand,
          canonicalUrl: ref.url,
          product: `${ref.brand} таблетки 100 мг №10`,
          reviews: 0,
          ratingCount: 1,
          rating: 5,
          status: "no_reviews",
          capturedAt: new Date().toISOString(),
          evidenceRef: "blob://split-feedback"
        };
      }
    }
    const service = new RatingsService(new MemoryRepository(), async () => new SplitFeedbackAdapter());

    const run = await service.executeRun((await service.createRun(request)).id);

    expect(run.observations[0]).toMatchObject({
      reviews: 1,
      writtenReviewCount: 0,
      ratingCount: 1,
      rating: 5,
      status: "ok",
      evidenceRef: "blob://split-feedback"
    });
    expect(run.qa).toMatchObject({ ok: true, blockers: [] });
  });

  it("serializes brand partitions for a generated generic domain", async () => {
    let active = 0;
    let maximumActive = 0;
    const adapter: SiteAdapter = {
      id: "generic:example.com:v1",
      supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [{
          domain: "example.com", platform: "example.com", listingId: brand, brand,
          url: `https://example.com/p/${encodeURIComponent(brand)}`, metadata: {}
        }];
      },
      async collect(ref) {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: `${ref.brand} таблетки 100 мг №10`, reviews: 1, rating: 5,
          status: "ok", capturedAt: new Date().toISOString()
        };
      }
    };
    const service = new RatingsService(new MemoryRepository(), async () => adapter);

    const run = await service.executeRun((await service.createRun({ ...request, brands: ["Бренд А", "Бренд Б"] })).id);

    expect(run.qa?.ok).toBe(true);
    expect(maximumActive).toBe(1);
  });

  it("serializes Yandex brand partitions to protect the shared Translate fallback", async () => {
    let active = 0;
    let maximumActive = 0;
    const adapter: SiteAdapter = {
      id: "market.yandex.ru:test",
      supportedDomains: ["market.yandex.ru"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [{
          domain: "market.yandex.ru", platform: "yandex", listingId: brand, brand,
          url: `https://market.yandex.ru/product/${encodeURIComponent(brand)}`, metadata: {}
        }];
      },
      async collect(ref) {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: `${ref.brand} таблетки 100 мг №10`, reviews: 1, rating: 5,
          status: "ok", capturedAt: new Date().toISOString()
        };
      }
    };
    const service = new RatingsService(new MemoryRepository(), async () => adapter);

    await service.executeRun((await service.createRun({
      ...request,
      domains: ["market.yandex.ru"],
      brands: ["Бренд А", "Бренд Б"]
    })).id);

    expect(maximumActive).toBe(1);
  });

  it("retains collected Yandex model IDs before publication and reuses them on the next brand run", async () => {
    const repository = new MemoryRepository();
    const discoveryContexts: AdapterContext[] = [];
    const healthContexts: AdapterContext[] = [];
    const adapter: SiteAdapter = {
      id: "market.yandex.ru:saved-models",
      supportedDomains: ["market.yandex.ru"],
      async healthCheck(context) {
        healthContexts.push(context);
        return { ok: true, checkedAt: new Date().toISOString() };
      },
      async discover(brand, context) {
        discoveryContexts.push(context);
        return [{
          domain: "market.yandex.ru", platform: "yandex", listingId: "1746647533", brand,
          url: "https://reviews.yandex.ru/product/baktoblis--1746647533", metadata: {}
        }];
      },
      async collect(ref) {
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: `${ref.brand} таблетки 100 мг №10`, reviews: 12, rating: 4.8,
          status: "ok", capturedAt: new Date().toISOString(), source: "yandex_reviews_direct"
        };
      }
    };
    const service = new RatingsService(repository, async () => adapter);
    const yandexRequest = { ...request, domains: ["market.yandex.ru"], brands: ["Бактоблис"] };

    const first = await service.executeRun((await service.createRun(yandexRequest)).id);
    expect(first.collectionStartedAt).toBeTruthy();
    expect(first.collectionFinishedAt).toBeTruthy();
    expect(await repository.listSourceCards("test_sheet")).toMatchObject([{
      listingId: "1746647533",
      brand: "Бактоблис",
      canonicalUrl: "https://reviews.yandex.ru/product/baktoblis--1746647533"
    }]);

    await service.executeRun((await service.createRun(yandexRequest)).id);
    expect(healthContexts[1]?.previousIds).toEqual(["1746647533"]);
    expect(discoveryContexts[1]?.previousIds).toEqual(["1746647533"]);
    expect(discoveryContexts[1]?.refreshDiscovery).toBe(false);

    await service.executeRun((await service.createRun({ ...yandexRequest, discoveryMode: "refresh" })).id);
    expect(discoveryContexts[2]?.previousIds).toEqual(["1746647533"]);
    expect(discoveryContexts[2]?.refreshDiscovery).toBe(true);
    expect((await service.listRecentRuns())[0]).toMatchObject({
      brands: ["Бактоблис"],
      durationMs: expect.any(Number)
    });
  });

  it("checkpoints every exact Yandex discovery before a later product collection fails", async () => {
    const repository = new MemoryRepository();
    const discoveryContexts: AdapterContext[] = [];
    let firstAttempt = true;
    const adapter: SiteAdapter = {
      id: "market.yandex.ru:discovery-checkpoint",
      supportedDomains: ["market.yandex.ru"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand, context) {
        discoveryContexts.push(context);
        return ["1426906540", "1441119989"].map((listingId) => ({
          domain: "market.yandex.ru", platform: "yandex", listingId, brand,
          url: `https://reviews.yandex.ru/product/${listingId}`, metadata: {}
        }));
      },
      async collect(ref) {
        if (firstAttempt && ref.listingId === "1441119989") {
          throw new AdapterBlockedError("product request exceeded its deadline");
        }
        return {
          domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand,
          canonicalUrl: ref.url, product: `${ref.brand} раствор 1 мг 0,5 мл №4`, reviews: 12, rating: 4.8,
          status: "ok", capturedAt: new Date().toISOString(), source: "yandex_reviews_direct"
        };
      }
    };
    const service = new RatingsService(repository, async () => adapter);
    const created = await service.createRun({
      ...request,
      domains: ["market.yandex.ru"],
      brands: ["Велгия Эко"]
    });

    const failed = await service.executeRun(created.id);
    expect(failed.partitions).toMatchObject([{ status: "blocked", discovered: 2, collected: 1 }]);
    expect((await repository.listSourceCards("test_sheet")).map((item) => item.listingId).sort()).toEqual([
      "1426906540",
      "1441119989"
    ]);

    firstAttempt = false;
    const retried = await service.executeRun(created.id);
    expect(discoveryContexts[1]?.previousIds?.sort()).toEqual(["1426906540", "1441119989"]);
    expect(retried.partitions).toMatchObject([{ status: "complete", discovered: 2, collected: 2 }]);
  });
});
