import type { Store } from "@edgeone/pages-blob";
import { describe, expect, it, vi } from "vitest";
import { BlobRepository } from "../src/server/blob-repository.js";
import {
  LeaseConflictError,
  MemoryRepository
} from "../src/server/repository.js";
import type { RunState } from "../src/shared/types.js";

function run(id = "fenced-run"): RunState {
  const now = "2026-08-11T12:00:00.000Z";
  return {
    id,
    request: {
      sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit",
      month: "2026-08",
      region: "Москва",
      domains: ["market.yandex.ru", "ozon.ru"],
      brands: ["Максилак"]
    },
    status: "queued",
    createdAt: now,
    updatedAt: now,
    progress: { totalPartitions: 2, completedPartitions: 0 },
    observations: [],
    partitions: [],
    errors: []
  };
}

const partition = (domain: string) => ({
  domain,
  brand: "Максилак",
  status: "no_results" as const,
  discovered: 0,
  collected: 0
});

describe("fenced run attempts", () => {
  it("rejects an old worker after a newer attempt takes ownership", async () => {
    const repository = new MemoryRepository();
    const legacy = run();
    await repository.saveRun(legacy);

    const first = await repository.beginAttempt({ runId: legacy.id, expectedRevision: 0 });
    const firstCheckpoint = await repository.commitPartition({
      runId: legacy.id,
      attemptId: first.attemptId,
      fencingToken: first.fencingToken,
      expectedRevision: first.revision,
      partition: partition("market.yandex.ru"),
      observations: []
    });
    const second = await repository.beginAttempt({
      runId: legacy.id,
      expectedRevision: firstCheckpoint.revision
    });

    expect(second).toMatchObject({ fencingToken: 2, revision: 3, status: "running" });
    await expect(repository.commitPartition({
      runId: legacy.id,
      attemptId: first.attemptId,
      fencingToken: first.fencingToken,
      expectedRevision: firstCheckpoint.revision,
      partition: partition("ozon.ru"),
      observations: []
    })).rejects.toMatchObject({
      name: "AttemptConflictError",
      code: "attempt_fencing_conflict"
    });
    expect(await repository.getRunAttempt(legacy.id)).toEqual(second);
    expect(await repository.getPartitionCheckpoint(
      legacy.id, first.fencingToken, "ozon.ru", "Максилак"
    )).toBeUndefined();
    await expect(repository.saveRun(legacy, {
      attemptId: first.attemptId,
      fencingToken: first.fencingToken
    })).rejects.toMatchObject({ code: "attempt_fencing_conflict" });
    await expect(repository.saveRun(legacy)).rejects.toMatchObject({ code: "attempt_fencing_conflict" });
    await expect(repository.saveRun(legacy, {
      attemptId: second.attemptId,
      fencingToken: second.fencingToken
    })).resolves.toBeUndefined();

    const secondCheckpoint = await repository.commitPartition({
      runId: legacy.id,
      attemptId: second.attemptId,
      fencingToken: second.fencingToken,
      expectedRevision: second.revision,
      partition: partition("ozon.ru"),
      observations: []
    });
    const finished = await repository.finishAttempt({
      runId: legacy.id,
      attemptId: second.attemptId,
      fencingToken: second.fencingToken,
      expectedRevision: secondCheckpoint.revision,
      status: "completed"
    });
    expect(finished).toMatchObject({ fencingToken: 2, revision: 5, status: "completed" });
    expect(await repository.getRun(legacy.id)).toEqual(legacy);
  });

  it("makes an exact checkpoint replay idempotent but rejects a stale expected revision", async () => {
    const repository = new MemoryRepository();
    const legacy = run();
    await repository.saveRun(legacy);
    const attempt = await repository.beginAttempt({ runId: legacy.id, expectedRevision: 0 });
    const command = {
      runId: legacy.id,
      attemptId: attempt.attemptId,
      fencingToken: attempt.fencingToken,
      expectedRevision: attempt.revision,
      partition: partition("market.yandex.ru"),
      observations: []
    };

    const committed = await repository.commitPartition(command);
    await expect(repository.commitPartition(command)).resolves.toEqual(committed);
    expect(await repository.getRunAttempt(legacy.id)).toMatchObject({ revision: 2, committedPartitions: 1 });

    await expect(repository.commitPartition({
      ...command,
      partition: { ...command.partition, status: "blocked", message: "late stale rewrite" }
    })).rejects.toMatchObject({ code: "attempt_checkpoint_conflict" });
    await expect(repository.getPartitionCheckpoint(
      legacy.id, attempt.fencingToken, "market.yandex.ru", "Максилак"
    )).resolves.toEqual(committed);

    await expect(repository.commitPartition({ ...command, partition: partition("ozon.ru") }))
      .rejects.toMatchObject({ code: "attempt_revision_conflict" });
  });

  it("enforces the same fencing head in Blob storage", async () => {
    const values = new Map<string, unknown>([["runs/blob-run.json", run("blob-run")]]);
    const store = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      setJSON: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }),
      delete: vi.fn(async (key: string) => { values.delete(key); })
    } as unknown as Store;
    const repository = new BlobRepository(store);
    vi.spyOn(repository, "acquireLease").mockResolvedValue({ token: "lock", keys: [] });
    vi.spyOn(repository, "releaseLease").mockResolvedValue();

    const oldWorker = await repository.beginAttempt({ runId: "blob-run", expectedRevision: 0 });
    const newWorker = await repository.beginAttempt({ runId: "blob-run", expectedRevision: 1 });
    await expect(repository.commitPartition({
      runId: "blob-run",
      attemptId: oldWorker.attemptId,
      fencingToken: oldWorker.fencingToken,
      expectedRevision: oldWorker.revision,
      partition: partition("market.yandex.ru"),
      observations: []
    })).rejects.toMatchObject({ code: "attempt_fencing_conflict" });

    expect(await repository.getRunAttempt("blob-run")).toEqual(newWorker);
    expect([...values.keys()].filter((key) => key.startsWith("run-attempt-partitions/"))).toEqual([]);
  });
});

describe("renewable repository leases", () => {
  it("moves a valid token into the current lease slots", async () => {
    const oldKeys = ["locks/old/1.json", "locks/old/2.json"];
    const values = new Map<string, unknown>(oldKeys.map((key) => [key, {
      token: "current-token", scope: "collection:ozon", expiresAt: Date.now() + 120_000
    }]));
    const store = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      setJSON: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
      delete: vi.fn(async (key: string) => { values.delete(key); })
    } as unknown as Store;
    const repository = new BlobRepository(store);

    const renewed = await repository.renewLease({
      token: "current-token", keys: oldKeys, scope: "collection:ozon"
    }, 120_000);

    expect(renewed).toMatchObject({ token: "current-token", scope: "collection:ozon" });
    expect(renewed.keys.length).toBeGreaterThan(oldKeys.length);
    expect(renewed.keys).toEqual(expect.arrayContaining(oldKeys));
    for (const key of renewed.keys) expect(values.get(key)).toMatchObject({ token: "current-token" });
    await expect(repository.renewLease({
      token: "current-token", keys: oldKeys, scope: "collection:ozon"
    }, 120_000)).resolves.toEqual(renewed);
  });

  it("does not let a wrong or stale token renew someone else's lease", async () => {
    const keys = ["locks/scope/1.json", "locks/scope/2.json"];
    const values = new Map<string, unknown>(keys.map((key) => [key, {
      token: "current-token", scope: "collection:ozon", expiresAt: Date.now() + 120_000
    }]));
    const store = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      setJSON: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
      delete: vi.fn(async (key: string) => { values.delete(key); })
    } as unknown as Store;
    const repository = new BlobRepository(store);

    await expect(repository.renewLease({
      token: "stale-token", keys, scope: "collection:ozon"
    }, 120_000)).rejects.toBeInstanceOf(LeaseConflictError);
    expect(store.setJSON).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
    expect(values.get(keys[0]!)).toMatchObject({ token: "current-token" });
  });
});
