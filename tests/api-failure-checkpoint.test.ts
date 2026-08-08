import { describe, expect, it } from "vitest";
import { executeRunWithFailureCheckpoint } from "../src/server/api.js";
import { RatingsService } from "../src/server/orchestrator.js";
import { MemoryRepository } from "../src/server/repository.js";

describe("local collection failure checkpoint", () => {
  it("makes a propagated retry deadline retryable instead of leaving the run running", async () => {
    const repository = new MemoryRepository();
    const service = new RatingsService(repository, async () => ({
      id: "deadline",
      supportedDomains: ["example.com"],
      async healthCheck(context) {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(context.signal?.reason ?? new Error("aborted"));
          if (context.signal?.aborted) abort();
          else context.signal?.addEventListener("abort", abort, { once: true });
        });
        return { ok: true, checkedAt: new Date().toISOString() };
      },
      async discover() { return []; },
      async collect() { throw new Error("not reached"); }
    }), { runDeadlineMs: 5 });
    const run = await service.createRun({
      sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
      month: "2026-08",
      region: "Москва",
      domains: ["example.com"],
      brands: ["Бренд"]
    });

    await expect(executeRunWithFailureCheckpoint({ repository, service }, run.id))
      .rejects.toThrow("run_deadline_exceeded");

    expect(await repository.getRun(run.id)).toMatchObject({
      status: "failed",
      errors: [{ partition: "orchestrator", message: "run_deadline_exceeded" }]
    });
  });
});
