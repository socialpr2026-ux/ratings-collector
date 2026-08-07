import { describe, expect, it } from "vitest";
import type { RunState } from "../src/shared/types.js";
import { RatingsService } from "../src/server/orchestrator.js";
import { MemoryRepository } from "../src/server/repository.js";
import { AdapterQuotaError } from "../src/server/adapters/errors.js";
import {
  completeBrowserPublication,
  failBrowserPublication,
  prepareBrowserPublication,
  reconcileBrowserPublication,
  shouldScopeFailedPublication
} from "../src/server/sheets/publication-state.js";

function run(): RunState {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    request: {
      sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
      month: "2026-07",
      region: "Moscow",
      domains: ["example.com"],
      brands: ["Brand"]
    },
    status: "review",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    progress: { totalPartitions: 1, completedPartitions: 1 },
    partitions: [{ domain: "example.com", brand: "Brand", status: "complete", discovered: 1, collected: 1 }],
    observations: [{
      domain: "example.com", platform: "example", listingId: "1", brand: "Brand",
      canonicalUrl: "https://example.com/products/1", product: "Brand tablets",
      reviews: 12, rating: 4.8, status: "ok", capturedAt: "2026-07-13T00:00:00.000Z"
    }],
    errors: [],
    payloadHash: "payload-1"
  };
}

function service(repository: MemoryRepository) {
  return new RatingsService(repository, async () => { throw new Error("unused"); });
}

describe("anonymous browser publication state", () => {
  it("recovers a legacy published partial write when the optional scope flag is unavailable", () => {
    const partial = run();
    partial.status = "published";
    partial.partitions.push({
      domain: "blocked.example",
      brand: "Brand",
      status: "blocked",
      discovered: 0,
      collected: 0,
      message: "external access block"
    });

    expect(shouldScopeFailedPublication(partial, false)).toBe(true);
    expect(shouldScopeFailedPublication(run(), false)).toBe(false);
    expect(shouldScopeFailedPublication(run(), true)).toBe(true);
  });

  it("publishes successful partitions while preserving failed-partition cards for recovery", async () => {
    const repository = new MemoryRepository();
    const ratings = service(repository);
    const current = run();
    current.request.domains = ["example.com", "blocked.example"];
    current.progress = { totalPartitions: 2, completedPartitions: 2 };
    current.partitions.push({ domain: "blocked.example", brand: "Brand", status: "blocked", discovered: 1, collected: 0, message: "HTTP 502" });
    current.observations.push({ ...current.observations[0], domain: "blocked.example", platform: "blocked", listingId: "bad", canonicalUrl: "https://blocked.example/products/bad" });
    current.payloadHash = "incomplete";
    await repository.saveRun(current);

    const scoped = await ratings.excludeFailedPartitionsFromPublication(current.id);

    expect(scoped.observations.map((item) => item.domain)).toEqual(["example.com", "blocked.example"]);
    expect(scoped.publicationExclusions).toMatchObject([{ domain: "blocked.example", brand: "Brand" }]);
    expect(scoped.qa).toMatchObject({ ok: true, blockers: [] });
    const intent = await prepareBrowserPublication(repository, ratings, scoped);
    const completed = await completeBrowserPublication(repository, ratings, intent, {
      range: "A1:F8",
      verifiedAt: "2026-07-31T07:00:00.000Z",
      attempts: 1,
      limitations: [],
      tabs: [{ tabName: "Ratings Brand", range: "A1:F8" }]
    });
    expect(completed.observations.map((item) => item.domain)).toEqual(["example.com", "blocked.example"]);
    expect(Object.keys((await repository.getSnapshots("test_sheet"))["2026-07"])).toEqual(["example.com:1"]);
    expect(await repository.listProducts("test_sheet")).toHaveLength(1);
  });

  it("keeps a partial write retryable, recollects only failures and republishes without duplicate records", async () => {
    const repository = new MemoryRepository();
    const calls = new Map<string, number>();
    let blockedAttempts = 0;
    const ratings = new RatingsService(repository, async (domain) => ({
      id: domain,
      supportedDomains: [domain],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover(brand) {
        calls.set(domain, (calls.get(domain) ?? 0) + 1);
        if (domain === "blocked.example" && blockedAttempts++ === 0) {
          throw new AdapterQuotaError("temporary quota gate");
        }
        return [{
          domain,
          platform: domain,
          listingId: "1",
          brand,
          url: `https://${domain}/products/1`,
          metadata: {}
        }];
      },
      async collect(ref) {
        return {
          domain: ref.domain,
          platform: ref.platform,
          listingId: ref.listingId,
          brand: ref.brand,
          canonicalUrl: ref.url,
          product: `${ref.brand} таблетки 100 мг №10`,
          reviews: 12,
          rating: 4.8,
          status: "ok" as const,
          capturedAt: new Date().toISOString()
        };
      }
    }));
    const created = await ratings.createRun({
      ...run().request,
      domains: ["example.com", "blocked.example"]
    });
    const collected = await ratings.executeRun(created.id);
    expect(collected.partitions.map((item) => [item.domain, item.status])).toEqual([
      ["example.com", "complete"],
      ["blocked.example", "blocked"]
    ]);

    const scoped = await ratings.excludeFailedPartitionsFromPublication(created.id);
    const partialIntent = await prepareBrowserPublication(repository, ratings, scoped);
    const partial = await completeBrowserPublication(repository, ratings, partialIntent, {
      range: "A1:F8",
      verifiedAt: "2026-07-31T08:00:00.000Z",
      attempts: 1,
      limitations: [],
      tabs: [{ tabName: "Ratings Brand", range: "A1:F8" }],
      verificationMethod: "apps-script-readback"
    });

    expect(partial.status).toBe("review");
    expect(partial.publicationExclusions).toHaveLength(1);
    expect(partial.publication?.payloadHash).toBe(partial.payloadHash);
    expect(Object.keys((await repository.getSnapshots("test_sheet"))["2026-07"])).toEqual(["example.com:1"]);

    const repeatedPartial = await prepareBrowserPublication(repository, ratings, partial);
    expect(repeatedPartial).toMatchObject({ shouldPublish: false, run: { status: "review" } });
    expect((await reconcileBrowserPublication(repository, repeatedPartial.run)).status).toBe("review");
    const legacyPartial = { ...repeatedPartial.run, status: "published" as const };
    await repository.saveRun(legacyPartial);
    expect((await reconcileBrowserPublication(repository, legacyPartial)).status).toBe("review");

    const retried = await ratings.executeRun(created.id);
    expect(calls).toEqual(new Map([["example.com", 1], ["blocked.example", 2]]));
    expect(retried.partitions.map((item) => [item.domain, item.status])).toEqual([
      ["example.com", "complete"],
      ["blocked.example", "complete"]
    ]);
    expect(retried.observations).toHaveLength(2);
    expect(retried.publicationExclusions).toBeUndefined();

    const fullIntent = await prepareBrowserPublication(repository, ratings, retried);
    expect(fullIntent.shouldPublish).toBe(true);
    const completed = await completeBrowserPublication(repository, ratings, fullIntent, {
      range: "A1:F9",
      verifiedAt: "2026-07-31T08:05:00.000Z",
      attempts: 1,
      limitations: [],
      tabs: [{ tabName: "Ratings Brand", range: "A1:F9" }],
      verificationMethod: "apps-script-readback"
    });

    expect(completed.status).toBe("published");
    expect(await repository.listProducts("test_sheet")).toHaveLength(2);
    expect(Object.keys((await repository.getSnapshots("test_sheet"))["2026-07"]).sort()).toEqual([
      "blocked.example:1",
      "example.com:1"
    ]);
  });

  it("reserves, commits and deduplicates the same month payload", async () => {
    const repository = new MemoryRepository();
    const ratings = service(repository);
    const current = run();
    await repository.saveRun(current);

    const intent = await prepareBrowserPublication(repository, ratings, current);
    expect(intent.shouldPublish).toBe(true);
    expect(intent.run.status).toBe("publishing");

    const completed = await completeBrowserPublication(repository, ratings, intent, {
      range: "A1:E12",
      verifiedAt: "2026-07-13T01:00:00.000Z",
      attempts: 1,
      limitations: ["UI publication"],
      tabs: [{ tabName: "Ratings Brand", range: "A1:E12" }]
    });
    expect(completed.status).toBe("published");
    expect(completed.publication?.verification?.method).toBe("anonymous-browser-readback");
    expect(completed.publication?.updatedRange).toBe("'Ratings Brand'!A1:E12");
    expect(await repository.listProducts("test_sheet")).toHaveLength(1);
    expect(Object.keys((await repository.getSnapshots("test_sheet"))["2026-07"])).toEqual(["example.com:1"]);
    expect((await repository.getRun(current.id))?.status).toBe("published");
    expect((await reconcileBrowserPublication(repository, (await repository.getRun(current.id))!)).status).toBe("published");

    const repeated = run();
    await repository.saveRun(repeated);
    const duplicate = await prepareBrowserPublication(repository, ratings, repeated);
    expect(duplicate.shouldPublish).toBe(false);
    expect(duplicate.run.status).toBe("published");
  });

  it("keeps a completed run published when a later payload replaces the month marker", async () => {
    const repository = new MemoryRepository();
    const ratings = service(repository);
    const first = run();
    await repository.saveRun(first);
    const firstIntent = await prepareBrowserPublication(repository, ratings, first);
    await completeBrowserPublication(repository, ratings, firstIntent, {
      range: "A1:E12",
      verifiedAt: "2026-07-13T01:00:00.000Z",
      attempts: 1,
      limitations: [],
      tabs: [{ tabName: "Ratings Brand", range: "A1:E12" }]
    });

    const second = run();
    second.id = "00000000-0000-4000-8000-000000000002";
    second.payloadHash = "payload-2";
    second.observations[0] = { ...second.observations[0], reviews: 13 };
    await repository.saveRun(second);
    const secondIntent = await prepareBrowserPublication(repository, ratings, second);
    await completeBrowserPublication(repository, ratings, secondIntent, {
      range: "A1:E12",
      verifiedAt: "2026-07-13T02:00:00.000Z",
      attempts: 1,
      limitations: [],
      tabs: [{ tabName: "Ratings Brand", range: "A1:E12" }]
    });

    expect((await repository.getRun(first.id))?.status).toBe("published");
    expect((await repository.getRun(second.id))?.status).toBe("published");
  });

  it("does not replay a publication marker from a different ratings tab", async () => {
    const repository = new MemoryRepository();
    const ratings = service(repository);
    const legacy = run();
    legacy.sheetTabName = "Рейтинги";
    await repository.saveRun(legacy);
    const legacyIntent = await prepareBrowserPublication(repository, ratings, legacy);
    await completeBrowserPublication(repository, ratings, legacyIntent, {
      range: "A1:E12",
      verifiedAt: "2026-07-13T01:00:00.000Z",
      attempts: 1,
      limitations: [],
      tabName: "Рейтинги"
    });

    const canonical = run();
    canonical.status = "review";
    canonical.sheetTabName = "Ratings";
    await repository.saveRun(canonical);
    const canonicalIntent = await prepareBrowserPublication(repository, ratings, canonical);

    expect(canonicalIntent.shouldPublish).toBe(true);
  });

  it("records Apps Script readback without changing the idempotency contract", async () => {
    const repository = new MemoryRepository();
    const ratings = service(repository);
    const current = run();
    await repository.saveRun(current);
    const intent = await prepareBrowserPublication(repository, ratings, current);

    const completed = await completeBrowserPublication(repository, ratings, intent, {
      range: "A1:E12",
      verifiedAt: "2026-07-13T01:00:00.000Z",
      attempts: 1,
      limitations: [],
      tabs: [{ tabName: "Ratings Brand", range: "A1:E12" }],
      verificationMethod: "apps-script-readback"
    });

    expect(completed.publication?.verification?.method).toBe("apps-script-readback");
    expect(completed.publication?.updatedRange).toBe("'Ratings Brand'!A1:E12");
    expect((await repository.getPublication("test_sheet:2026-07"))?.payloadHash).toBe("payload-1");
  });

  it("clears a resolved sheet preflight error before reserving publication", async () => {
    const repository = new MemoryRepository();
    const current = run();
    current.errors.push({ partition: "sheet-preflight", message: "temporary clipboard outage" });
    await repository.saveRun(current);

    const intent = await prepareBrowserPublication(repository, service(repository), current);
    expect(intent.shouldPublish).toBe(true);
    expect(intent.run.errors).toEqual([]);
    expect(intent.run.status).toBe("publishing");
  });

  it("returns a transient browser failure to a retryable review state", async () => {
    const repository = new MemoryRepository();
    const current = run();
    current.status = "publishing";
    await repository.saveRun(current);
    await failBrowserPublication(repository, current.id, new Error("clipboard unavailable"));
    const failed = await repository.getRun(current.id);
    expect(failed?.status).toBe("review");
    expect(failed?.qa?.ok).toBe(true);
    expect(failed?.errors).toEqual([{ partition: "google-sheets-browser", message: "clipboard unavailable" }]);
  });

  it("can restore registry and snapshots exactly after a compensated publication", async () => {
    const repository = new MemoryRepository();
    const originalProduct = {
      key: "example.com:old", domain: "example.com", listingId: "old", brand: "Brand",
      canonicalUrl: "https://example.com/products/old", product: "Brand old", platform: "example",
      firstSeenMonth: "2026-06", lastSeenMonth: "2026-06"
    };
    const originalSnapshots = { "2026-06": { "example.com:old": { ...run().observations[0], listingId: "old" } } };
    await repository.replaceProducts("test_sheet", [originalProduct]);
    await repository.replaceSnapshots("test_sheet", originalSnapshots);

    await repository.saveProducts("test_sheet", [{ ...originalProduct, key: "example.com:new", listingId: "new" }]);
    await repository.saveSnapshot("test_sheet", "2026-07", run().observations);
    await repository.replaceProducts("test_sheet", [originalProduct]);
    await repository.replaceSnapshots("test_sheet", originalSnapshots);

    expect(await repository.listProducts("test_sheet")).toEqual([originalProduct]);
    expect(await repository.getSnapshots("test_sheet")).toEqual(originalSnapshots);
  });
});
