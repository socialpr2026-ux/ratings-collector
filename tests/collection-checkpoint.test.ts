import { describe, expect, it, vi } from "vitest";
import type { Observation, ProductRef, RunState, SiteAdapter } from "../src/shared/types.js";
import {
  STALE_COLLECTION_CHECKPOINT_ERROR,
  STALE_COLLECTION_CHECKPOINT_MS,
  reconcileStaleCollectionCheckpoint
} from "../src/server/collection-checkpoint.js";
import { RatingsService } from "../src/server/orchestrator.js";
import { MemoryRepository } from "../src/server/repository.js";

const now = new Date("2026-07-16T10:30:00.000Z");

function runningCheckpoint(updatedAt: string): RunState {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    request: {
      sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
      month: "2026-07",
      region: "Москва",
      domains: ["example.com"],
      brands: ["Кагоцел"]
    },
    status: "running",
    createdAt: "2026-07-16T09:00:00.000Z",
    updatedAt,
    progress: { totalPartitions: 1, completedPartitions: 0, current: "example.com / Кагоцел" },
    observations: [],
    partitions: [],
    errors: [],
    activity: {
      sequence: 1,
      active: [{
        id: "00000000-0000-4000-8000-000000000001:1",
        sequence: 1,
        stage: "discovery",
        status: "active",
        label: "Поиск карточек",
        startedAt: updatedAt,
        domain: "example.com",
        brand: "Кагоцел"
      }],
      recent: []
    }
  };
}

describe("stale collection checkpoint reconciliation", () => {
  it("makes an expired running checkpoint retryable and executes a new adapter pass", async () => {
    const fresh = runningCheckpoint(new Date(now.getTime() - STALE_COLLECTION_CHECKPOINT_MS + 1).toISOString());
    expect(reconcileStaleCollectionCheckpoint(fresh, now)).toBe(false);
    expect(fresh.status).toBe("running");

    const repository = new MemoryRepository();
    const stale = runningCheckpoint("2026-07-16T09:13:33.895Z");
    expect(reconcileStaleCollectionCheckpoint(stale, now)).toBe(true);
    expect(stale).toMatchObject({
      status: "failed",
      updatedAt: now.toISOString(),
      progress: { totalPartitions: 1, completedPartitions: 0 },
      observations: [],
      partitions: [],
      errors: [{ partition: "orchestrator", message: expect.stringContaining(STALE_COLLECTION_CHECKPOINT_ERROR) }]
    });
    expect(stale.progress.current).toBeUndefined();
    expect(stale.activity?.active).toEqual([]);
    expect(stale.activity?.recent).toMatchObject([{
      status: "warning",
      finishedAt: now.toISOString(),
      detail: "Collection checkpoint stopped advancing; retry required"
    }]);
    await repository.saveRun(stale);

    const discover = vi.fn(async (brand: string): Promise<ProductRef[]> => [{
      domain: "example.com",
      platform: "example.com",
      listingId: "kagocel",
      brand,
      url: "https://example.com/products/kagocel",
      metadata: {}
    }]);
    const adapter: SiteAdapter = {
      id: "checkpoint-regression",
      supportedDomains: ["example.com"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      discover,
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain,
          platform: ref.platform,
          listingId: ref.listingId,
          brand: ref.brand,
          canonicalUrl: ref.url,
          product: "Кагоцел таблетки 12 мг №20",
          reviews: 23,
          rating: 5,
          status: "ok",
          capturedAt: new Date().toISOString()
        };
      }
    };
    const service = new RatingsService(repository, async () => adapter);

    const retried = await service.executeRun(stale.id);

    expect(discover).toHaveBeenCalledOnce();
    expect(retried.updatedAt).not.toBe(stale.updatedAt);
    expect(retried.status).toBe("review");
    expect(retried.partitions).toMatchObject([{
      domain: "example.com",
      brand: "Кагоцел",
      status: "complete",
      discovered: 1,
      collected: 1
    }]);
    expect(retried.errors).toEqual([]);
  });
});
