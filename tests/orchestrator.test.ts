import { describe, expect, it } from "vitest";
import type { AdapterContext, Observation, ProductRef, SiteAdapter } from "../src/shared/types.js";
import { AdapterQuotaError } from "../src/server/adapters/errors.js";
import { RatingsService } from "../src/server/orchestrator.js";
import { MemoryRepository } from "../src/server/repository.js";

const request = { sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit", month: "2026-07", region: "Москва", domains: ["example.com"], brands: ["Бренд"] };
class FakeAdapter implements SiteAdapter {
  id = "fake"; supportedDomains = ["example.com"];
  constructor(private readonly healthy = true) {}
  async healthCheck() { return { ok: this.healthy, checkedAt: new Date().toISOString(), message: this.healthy ? undefined : "changed" }; }
  async discover(brand: string, _context: AdapterContext): Promise<ProductRef[]> { return [{ domain: "example.com", platform: "fake", listingId: "1", brand, url: "https://example.com/p/1", metadata: {} }]; }
  async collect(ref: ProductRef): Promise<Observation> { return { domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand, canonicalUrl: ref.url, product: `${ref.brand} таблетки 100 мг №10`, reviews: 5, rating: 4.5, status: "ok", capturedAt: new Date().toISOString() }; }
}

describe("run orchestration and fail-closed QA", () => {
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
          brand: ref.brand, canonicalUrl: ref.url, product: ref.brand,
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

  it("canonicalizes the Yandex Reviews collection alias to the marketplace domain", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => new FakeAdapter());
    const run = await service.createRun({ ...request, domains: ["reviews.yandex.ru", "market.yandex.ru"] });

    expect(run.request.domains).toEqual(["market.yandex.ru"]);
    expect(run.progress.totalPartitions).toBe(1);
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
      discovered: 0,
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

  it("collects all partitions and only commits history after explicit publication step", async () => {
    const repository = new MemoryRepository(); const service = new RatingsService(repository, async () => new FakeAdapter());
    const created = await service.createRun(request); const run = await service.executeRun(created.id);
    expect(run.status).toBe("review"); expect(run.qa?.ok).toBe(true); expect(await repository.listProducts("test_sheet")).toHaveLength(0);
    await service.commitSuccessfulRun(run);
    expect(await repository.listProducts("test_sheet")).toHaveLength(1); expect(Object.keys((await repository.getSnapshots("test_sheet"))["2026-07"])).toEqual(["example.com:1"]);
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
      productIdentity: { granularity: "variant", confidence: "exact", label: "капсулы 100 мг №20" }
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

    const yandexRequest = { ...request, domains: ["market.yandex.ru"], brands: ["Даксабрис"] };
    const yandexService = new RatingsService(new MemoryRepository(), async () => ({
      id: "yandex-review-aggregate",
      supportedDomains: ["market.yandex.ru"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand: string) {
        return [{ domain: "market.yandex.ru", platform: "yandex", listingId: "900082876", brand, url: "https://reviews.yandex.ru/product/daksabris--900082876", metadata: {} }];
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
    await expect(yandexService.approveObservations(yandexRun.id, ["market.yandex.ru:900082876"]))
      .resolves.toMatchObject({ observations: [{ status: "ok", productIdentity: { granularity: "family" } }] });
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
    const domain = "market.yandex.ru";
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
});
