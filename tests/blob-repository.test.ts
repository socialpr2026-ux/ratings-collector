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
});
