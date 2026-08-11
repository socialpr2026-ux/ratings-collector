import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRunSummary, nextProgressPollDelay } from "../src/client/progress.js";
import { registerApi } from "../src/server/api.js";
import { RatingsService } from "../src/server/orchestrator.js";
import {
  createRunSummaryV2,
  MemoryRepository,
  runSummaryEtag
} from "../src/server/repository.js";
import type { RunActivity, RunState } from "../src/shared/types.js";
import { runProgressResponse } from "../cloud-functions/api/[[default]].js";

afterEach(() => vi.unstubAllEnvs());

function run(): RunState {
  const now = "2026-08-11T10:00:00.000Z";
  const activity = (sequence: number): RunActivity => ({
    id: `activity-${sequence}`,
    sequence,
    stage: "collection",
    status: sequence % 2 ? "active" : "complete",
    label: `Чтение карточки ${"x".repeat(500)}`,
    detail: `Технические детали ${"y".repeat(1_000)}`,
    domain: "market.yandex.ru",
    brand: `Максилак ${"z".repeat(300)}`,
    listingId: `listing-${"1".repeat(300)}`,
    startedAt: now
  });
  return {
    id: "run-summary",
    ownerEmail: "local@ratings",
    request: {
      sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit",
      month: "2026-08",
      region: "Москва",
      domains: ["market.yandex.ru", "ozon.ru"],
      brands: ["Максилак"]
    },
    status: "running",
    createdAt: now,
    updatedAt: now,
    progress: { totalPartitions: 2, completedPartitions: 1, current: "Читаем карточки" },
    observations: Array.from({ length: 250 }, () => ({} as RunState["observations"][number])),
    partitions: [{
      domain: "market.yandex.ru", brand: "Максилак", status: "complete", discovered: 250, collected: 250
    }],
    errors: [],
    sheetPreflight: {
      spreadsheetId: "test",
      capturedAt: now,
      tabs: [{
        spreadsheetId: "test", tabName: "Максилак", values: [["private".repeat(10_000)]],
        formulas: [[null]], merges: [], revision: "private", rows: 1, columns: 1
      }]
    },
    activity: {
      sequence: 30,
      active: Array.from({ length: 10 }, (_, index) => activity(index + 1)),
      recent: Array.from({ length: 20 }, (_, index) => ({ ...activity(index + 11), status: "complete" }))
    }
  };
}

describe("compact run progress summary", () => {
  it("shadow-writes a monotonic compact revision without observations or sheet preflight", async () => {
    const repository = new MemoryRepository();
    const current = run();

    await repository.saveRun(current);
    const first = await repository.getRunSummary(current.id);
    expect(first).toMatchObject({
      version: 2,
      revision: 1,
      observationCount: 250,
      partitionCounts: { complete: 1, pending: 1, no_results: 0, blocked: 0, error: 0 }
    });
    expect(first).not.toHaveProperty("observations");
    expect(first).not.toHaveProperty("sheetPreflight");
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(16 * 1024);

    await repository.saveRun(current);
    expect((await repository.getRunSummary(current.id))?.revision).toBe(1);

    current.progress.completedPartitions = 2;
    current.updatedAt = "2026-08-11T10:01:00.000Z";
    await repository.saveRun(current);
    expect((await repository.getRunSummary(current.id))?.revision).toBe(2);
  });

  it("returns 304 for matching revision or ETag and a body only after progress changes", async () => {
    const summary = createRunSummaryV2(run(), 7);
    const initial = runProgressResponse(summary, new Request(
      "https://ratings.example/api/runs/run-summary/progress"
    ));
    expect(initial.status).toBe(200);
    expect(initial.headers.get("etag")).toBe(runSummaryEtag(summary));
    expect(await initial.json()).toMatchObject({ version: 2, revision: 7, observationCount: 250 });

    const byRevision = runProgressResponse(summary, new Request(
      "https://ratings.example/api/runs/run-summary/progress?sinceRevision=7"
    ));
    expect(byRevision.status).toBe(304);
    expect(await byRevision.text()).toBe("");

    const byEtag = runProgressResponse(summary, new Request(
      "https://ratings.example/api/runs/run-summary/progress",
      { headers: { "if-none-match": runSummaryEtag(summary) } }
    ));
    expect(byEtag.status).toBe(304);
  });

  it("merges only lightweight live fields and backs polling off to ten seconds", () => {
    const current = run();
    const summary = createRunSummaryV2({
      ...current,
      updatedAt: "2026-08-11T10:02:00.000Z",
      progress: { totalPartitions: 2, completedPartitions: 2 },
      observations: [...current.observations, {} as RunState["observations"][number]]
    }, 2);
    const merged = applyRunSummary(current, summary);

    expect(merged.updatedAt).toBe("2026-08-11T10:02:00.000Z");
    expect(merged.progress.completedPartitions).toBe(2);
    expect(merged.observations).toHaveLength(250);
    expect(nextProgressPollDelay(2_500, false)).toBe(5_000);
    expect(nextProgressPollDelay(5_000, false)).toBe(10_000);
    expect(nextProgressPollDelay(10_000, false)).toBe(10_000);
    expect(nextProgressPollDelay(10_000, true)).toBe(2_500);
  });

  it("serves the same conditional progress contract from the local API", async () => {
    vi.stubEnv("RATINGS_ALLOW_UNAUTHENTICATED", "true");
    const repository = new MemoryRepository();
    await repository.saveRun(run());
    const getRun = vi.spyOn(repository, "getRun");
    const server = Fastify();
    await registerApi(server, {
      repository,
      service: new RatingsService(repository, async () => { throw new Error("not used"); })
    });
    try {
      const first = await server.inject({ method: "GET", url: "/api/runs/run-summary/progress" });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ version: 2, revision: 1, observationCount: 250 });
      expect(getRun).not.toHaveBeenCalled();

      const unchanged = await server.inject({
        method: "GET",
        url: "/api/runs/run-summary/progress?sinceRevision=1",
        headers: { "if-none-match": first.headers.etag }
      });
      expect(unchanged.statusCode).toBe(304);
      expect(unchanged.body).toBe("");
      expect(getRun).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
