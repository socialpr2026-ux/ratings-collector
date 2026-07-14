import { describe, expect, it } from "vitest";
import type { RunState } from "../src/shared/types.js";
import { RatingsService } from "../src/server/orchestrator.js";
import { MemoryRepository } from "../src/server/repository.js";
import {
  completeBrowserPublication,
  failBrowserPublication,
  prepareBrowserPublication,
  reconcileBrowserPublication
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
      limitations: ["UI publication"]
    });
    expect(completed.status).toBe("published");
    expect(completed.publication?.verification?.method).toBe("anonymous-browser-readback");
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
      limitations: []
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
      limitations: []
    });

    expect((await repository.getRun(first.id))?.status).toBe("published");
    expect((await repository.getRun(second.id))?.status).toBe("published");
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
      verificationMethod: "apps-script-readback"
    });

    expect(completed.publication?.verification?.method).toBe("apps-script-readback");
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
