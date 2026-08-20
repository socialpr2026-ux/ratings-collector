import { describe, expect, it, vi } from "vitest";
import type { RunState } from "../src/shared/types.js";
import {
  AMBIGUOUS_TRIGGER_GRACE_POLLS,
  MAX_AUTOMATIC_COLLECTION_BUDGET_MS,
  MAX_AUTOMATIC_CONTINUATIONS,
  MAX_TRANSIENT_CHECKPOINT_READ_FAILURES,
  checkpointContinuationDecision,
  collectWithCheckpointContinuation,
  pollSavedCollectionAttempt
} from "../src/client/checkpoint-resume.js";

function run(input: Partial<RunState> & { completed: number; updatedAt: string }): RunState {
  const { completed, updatedAt, ...overrides } = input;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    request: {
      sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
      month: "2026-07",
      region: "Москва",
      domains: ["example.com"],
      brands: ["Бренд"]
    },
    status: "failed",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt,
    progress: { totalPartitions: 100, completedPartitions: completed },
    observations: [],
    partitions: [],
    errors: [{ partition: "orchestrator", message: "run_deadline_exceeded" }],
    ...overrides
  };
}

describe("checkpoint continuation eligibility", () => {
  const initial = run({ status: "queued", completed: 0, updatedAt: "2026-07-15T00:00:00.000Z", errors: [] });

  it("continues only an advanced checkpoint with an explicit collection timeout", () => {
    const advanced = run({ completed: 30, updatedAt: "2026-07-15T00:01:00.000Z" });
    expect(checkpointContinuationDecision(initial, advanced, 0)).toEqual({ eligible: true, reason: "eligible" });
  });

  it("does not continue when partition progress or updatedAt did not advance", () => {
    expect(checkpointContinuationDecision(initial, run({ completed: 0, updatedAt: "2026-07-15T00:01:00.000Z" }), 0))
      .toEqual({ eligible: false, reason: "no_progress" });
    expect(checkpointContinuationDecision(initial, run({ completed: 30, updatedAt: initial.updatedAt }), 0))
      .toEqual({ eligible: false, reason: "no_progress" });
  });

  it("never continues quota, lease or publication failures", () => {
    for (const message of [
      "quota_exceeded: monthly budget reached",
      "acquireLease failed",
      "publishing operation timed out"
    ]) {
      const current = run({
        completed: 30,
        updatedAt: "2026-07-15T00:01:00.000Z",
        errors: [
          { partition: "orchestrator", message: "The operation was aborted due to timeout" },
          { partition: "example.com/Бренд", message }
        ]
      });
      expect(checkpointContinuationDecision(initial, current, 0)).toEqual({ eligible: false, reason: "unsafe" });
    }
  });

  it("stops for non-timeout failures and the attempt limit", () => {
    const parserFailure = run({
      completed: 30,
      updatedAt: "2026-07-15T00:01:00.000Z",
      errors: [{ partition: "orchestrator", message: "parser_changed" }]
    });
    expect(checkpointContinuationDecision(initial, parserFailure, 0).reason).toBe("not_timeout");
    expect(checkpointContinuationDecision(initial, run({ completed: 30, updatedAt: "2026-07-15T00:01:00.000Z" }), MAX_AUTOMATIC_CONTINUATIONS).reason)
      .toBe("limit");
  });

  it("does not continue after the cumulative automatic collection budget", () => {
    const overBudget = run({
      completed: 30,
      collectionStartedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: new Date(Date.parse("2026-07-15T00:00:00.000Z") + MAX_AUTOMATIC_COLLECTION_BUDGET_MS).toISOString()
    });

    expect(checkpointContinuationDecision(initial, overBudget, 0))
      .toEqual({ eligible: false, reason: "budget" });
  });

  it("continues once more when every partition is checkpointed but final QA timed out", () => {
    const finalized = run({ completed: 100, updatedAt: "2026-07-15T00:01:00.000Z" });

    expect(checkpointContinuationDecision(initial, finalized, 0))
      .toEqual({ eligible: true, reason: "eligible" });
  });
});

describe("automatic checkpoint continuation loop", () => {
  it("passes each saved checkpoint into the next bounded attempt", async () => {
    const checkpoints = [
      run({ status: "queued", completed: 0, updatedAt: "2026-07-15T00:00:00.000Z", errors: [] }),
      run({ completed: 30, updatedAt: "2026-07-15T00:01:00.000Z" }),
      run({ status: "review", completed: 100, updatedAt: "2026-07-15T00:02:00.000Z", errors: [] })
    ];
    const seen: number[] = [];
    const execute = vi.fn(async (checkpoint: RunState) => {
      seen.push(checkpoint.progress.completedPartitions);
      const next = checkpoints[seen.length]!;
      return { run: next, ...(next.status === "failed" ? { error: new Error("timeout") } : {}) };
    });
    const notices = vi.fn();

    const result = await collectWithCheckpointContinuation(checkpoints[0], execute, notices);

    expect(seen).toEqual([0, 30]);
    expect(result).toMatchObject({ run: { status: "review" }, continuations: 1, error: undefined });
    expect(notices.mock.calls.map(([notice]) => notice)).toEqual([
      { attempt: 1, maxAttempts: 1, completedPartitions: 30, totalPartitions: 100 }
    ]);
  });

  it("stops after the configured number of continuations", async () => {
    let completed = 0;
    const execute = vi.fn(async () => {
      completed += 10;
      return {
        run: run({ completed, updatedAt: `2026-07-15T00:0${completed / 10}:00.000Z` }),
        error: new Error("timeout")
      };
    });
    const initial = run({ status: "queued", completed: 0, updatedAt: "2026-07-15T00:00:00.000Z", errors: [] });

    const result = await collectWithCheckpointContinuation(initial, execute);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ run: { status: "failed" }, continuations: 1 });
  });

  it("treats a completed review checkpoint as success even if the HTTP response was lost", async () => {
    const initial = run({ status: "queued", completed: 0, updatedAt: "2026-07-15T00:00:00.000Z", errors: [] });
    const completed = run({
      status: "review",
      completed: 100,
      updatedAt: "2026-07-15T00:01:00.000Z",
      errors: []
    });

    const result = await collectWithCheckpointContinuation(initial, async () => ({
      run: completed,
      error: new Error("connection closed")
    }));

    expect(result).toMatchObject({ run: { status: "review" }, continuations: 0, error: undefined });
  });

  it("keeps a lease error when the terminal checkpoint never advanced", async () => {
    const initial = run({
      status: "review",
      completed: 70,
      updatedAt: "2026-07-15T00:00:00.000Z",
      errors: []
    });
    const leaseError = new Error("acquireLease failed");

    const result = await collectWithCheckpointContinuation(initial, async () => ({
      run: structuredClone(initial),
      error: leaseError
    }));

    expect(result).toMatchObject({ run: { status: "review" }, continuations: 0, error: leaseError });
  });

  it("keeps an advanced saved failure authoritative over a lost Agent HTTP acknowledgement", async () => {
    const initial = run({
      status: "review",
      completed: 99,
      updatedAt: "2026-07-17T13:47:08.000Z",
      errors: []
    });
    const savedFailure = run({
      status: "failed",
      completed: 99,
      updatedAt: "2026-07-17T13:58:15.000Z",
      errors: [{ partition: "asna.ru/Церетон", message: "blocked: exact ASNA discovery remained unproven" }]
    });
    const trigger = vi.fn(async () => ({
      run: savedFailure,
      error: new Error("POST /ratings returned status code 404")
    }));

    const result = await collectWithCheckpointContinuation(initial, trigger);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      run: {
        status: "failed",
        errors: [{ partition: "asna.ru/Церетон", message: "blocked: exact ASNA discovery remained unproven" }]
      },
      error: undefined,
      continuations: 0
    });
  });
});

describe("ambiguous collection POST recovery", () => {
  it("follows saved activity to terminal without issuing a duplicate attempt", async () => {
    const initial = run({
      status: "review",
      completed: 99,
      updatedAt: "2026-07-17T10:00:00.000Z",
      errors: []
    });
    const unchanged = structuredClone(initial);
    const active = run({
      status: "running",
      completed: 99,
      updatedAt: "2026-07-17T10:00:01.000Z",
      errors: []
    });
    const completed = run({
      status: "review",
      completed: 100,
      updatedAt: "2026-07-17T10:00:20.000Z",
      errors: []
    });
    const delayedUnchangedReads = Array.from({ length: 25 }, () => structuredClone(unchanged));
    const checkpoints = [...delayedUnchangedReads, active, active, active, active, completed];
    const readCheckpoint = vi.fn(async () => checkpoints.shift()!);
    const trigger = vi.fn(async () => { throw new Error("Failed to fetch"); });
    let triggerFailure: Error | undefined;

    const result = await collectWithCheckpointContinuation(initial, async (checkpoint) => {
      await trigger().catch((error) => { triggerFailure = error as Error; });
      return {
        run: await pollSavedCollectionAttempt({
          checkpoint,
          readCheckpoint,
          triggerError: () => triggerFailure,
          triggerFinished: () => true,
          wait: async () => undefined
        }),
        error: triggerFailure
      };
    });

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(readCheckpoint).toHaveBeenCalledTimes(30);
    expect(result).toMatchObject({ run: { status: "review", progress: { completedPartitions: 100 } }, error: undefined });
  });

  it("keeps the trigger error when no saved checkpoint proves the attempt started", async () => {
    const initial = run({
      status: "review",
      completed: 99,
      updatedAt: "2026-07-17T10:00:00.000Z",
      errors: []
    });
    const readCheckpoint = vi.fn(async () => structuredClone(initial));
    const triggerFailure = new Error("Failed to fetch");

    const result = await pollSavedCollectionAttempt({
      checkpoint: initial,
      readCheckpoint,
      triggerError: () => triggerFailure,
      triggerFinished: () => true,
      wait: async () => undefined
    });

    expect(result).toEqual(initial);
    expect(readCheckpoint).toHaveBeenCalledTimes(AMBIGUOUS_TRIGGER_GRACE_POLLS);
  });

  it("keeps following a live checkpoint across transient progress read failures", async () => {
    const initial = run({ status: "queued", completed: 0, updatedAt: "2026-07-17T10:00:00.000Z", errors: [] });
    const running = run({ status: "running", completed: 1, updatedAt: "2026-07-17T10:00:01.000Z", errors: [] });
    const completed = run({ status: "review", completed: 2, updatedAt: "2026-07-17T10:00:20.000Z", errors: [] });
    const readCheckpoint = vi.fn()
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new Error("progress gateway HTTP 502"))
      .mockRejectedValueOnce(new Error("progress gateway HTTP 502"))
      .mockResolvedValueOnce(completed);
    const wait = vi.fn(async () => undefined);

    const result = await pollSavedCollectionAttempt({
      checkpoint: initial,
      readCheckpoint,
      triggerError: () => new Error("POST /ratings connection closed"),
      triggerFinished: () => true,
      wait
    });

    expect(result).toEqual(completed);
    expect(readCheckpoint).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("surfaces a checkpoint read failure only after the bounded retry allowance", async () => {
    const initial = run({ status: "queued", completed: 0, updatedAt: "2026-07-17T10:00:00.000Z", errors: [] });
    const readCheckpoint = vi.fn(async () => { throw new Error("progress unavailable"); });
    const wait = vi.fn(async () => undefined);

    await expect(pollSavedCollectionAttempt({
      checkpoint: initial,
      readCheckpoint,
      triggerError: () => undefined,
      triggerFinished: () => false,
      wait
    })).rejects.toThrow("progress unavailable");

    expect(readCheckpoint).toHaveBeenCalledTimes(MAX_TRANSIENT_CHECKPOINT_READ_FAILURES + 1);
    expect(wait).toHaveBeenCalledTimes(MAX_TRANSIENT_CHECKPOINT_READ_FAILURES);
  });
});
