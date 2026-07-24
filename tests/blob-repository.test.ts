import type { Store } from "@edgeone/pages-blob";
import { describe, expect, it, vi } from "vitest";
import { BlobRepository } from "../src/server/blob-repository.js";
import type { RunState } from "../src/shared/types.js";

function run(id: string, brand: string, updatedAt: string): RunState {
  return {
    id,
    ownerEmail: "operator@example.com",
    status: "failed",
    request: {
      sheetUrl: "https://docs.google.com/spreadsheets/d/example/edit",
      month: "2026-07",
      region: "Москва",
      domains: ["asna.ru", "market.yandex.ru"],
      brands: [brand]
    },
    progress: { completedPartitions: 1, totalPartitions: 2 },
    partitions: [],
    observations: [],
    errors: [],
    qa: { ok: false, blockers: [], warnings: [] },
    createdAt: updatedAt,
    updatedAt
  };
}

describe("BlobRepository run lookup", () => {
  it("returns only the newest exact-brand checkpoints without observations", async () => {
    const values = new Map<string, RunState>([
      ["runs/old.json", run("old", "Акваоптик", "2026-07-22T08:00:00.000Z")],
      ["runs/new.json", run("new", "Акваоптик", "2026-07-22T09:00:00.000Z")],
      ["runs/other.json", run("other", "Аквадетрим", "2026-07-22T10:00:00.000Z")]
    ]);
    const store = {
      list: vi.fn(async () => ({ blobs: [...values.keys()].map((key) => ({ key, etag: key })), directories: [] })),
      get: vi.fn(async (key: string) => values.get(key) ?? null)
    } as unknown as Store;

    const found = await new BlobRepository(store).findRecentRunsByBrand(" акваоптик ", 1);

    expect(found).toEqual([{
      id: "new",
      status: "failed",
      updatedAt: "2026-07-22T09:00:00.000Z",
      brands: ["Акваоптик"],
      completedPartitions: 1,
      totalPartitions: 2
    }]);
  });

  it("reads compact completed-run history without loading full run payloads", async () => {
    const values = new Map([
      ["run-history/mine.json", {
        id: "mine", ownerEmail: "operator@example.com", brands: ["Бактоблис"],
        createdAt: "2026-07-24T09:00:00.000Z", collectionStartedAt: "2026-07-24T09:00:00.000Z",
        collectionFinishedAt: "2026-07-24T09:08:00.000Z", durationMs: 480_000
      }],
      ["run-history/other.json", {
        id: "other", ownerEmail: "other@example.com", brands: ["Кагоцел"],
        createdAt: "2026-07-24T10:00:00.000Z", collectionStartedAt: "2026-07-24T10:00:00.000Z",
        collectionFinishedAt: "2026-07-24T10:03:00.000Z", durationMs: 180_000
      }]
    ]);
    const store = {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        blobs: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: key })),
        directories: []
      })),
      get: vi.fn(async (key: string) => values.get(key) ?? null)
    } as unknown as Store;

    const history = await new BlobRepository(store).listRecentRuns("operator@example.com", 8);

    expect(history).toEqual([{
      id: "mine", brands: ["Бактоблис"], createdAt: "2026-07-24T09:00:00.000Z",
      collectionStartedAt: "2026-07-24T09:00:00.000Z",
      collectionFinishedAt: "2026-07-24T09:08:00.000Z", durationMs: 480_000
    }]);
    expect(store.list).toHaveBeenCalledWith({ prefix: "run-history/", consistency: "strong" });
    expect(store.get).not.toHaveBeenCalledWith(expect.stringMatching(/^runs\//), expect.anything());
  });
});
