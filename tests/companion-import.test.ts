import { describe, expect, it } from "vitest";
import type { RunState } from "../src/shared/types.js";
import { MemoryRepository } from "../src/server/repository.js";
import {
  eligibleOzonCompanionBrands,
  importOzonCompanionResult,
  issueOzonCompanionSession
} from "../src/server/companion-import.js";

const now = new Date("2026-07-14T12:00:00.000Z");
const owner = "employee@ratings";

function blockedRun(message = "quota_exceeded: cloud collector limit exceeded"): RunState {
  return {
    id: "run-companion",
    ownerEmail: owner,
    request: {
      sheetUrl: "https://docs.google.com/spreadsheets/d/test-sheet-id/edit",
      month: "2026-07",
      region: "Москва",
      domains: ["ozon.ru"],
      brands: ["Тестбренд"]
    },
    status: "review",
    createdAt: "2026-07-14T11:55:00.000Z",
    updatedAt: "2026-07-14T11:59:00.000Z",
    progress: { totalPartitions: 1, completedPartitions: 1 },
    observations: [],
    partitions: [{
      domain: "ozon.ru",
      brand: "Тестбренд",
      status: "blocked",
      discovered: 0,
      collected: 0,
      message
    }],
    errors: [{ partition: "ozon.ru/Тестбренд", message }],
    qa: { ok: false, blockers: [message], warnings: [] }
  };
}

function result(nonce: string) {
  return {
    version: 1,
    nonce,
    observations: [{
      listingId: "123456789",
      brand: "Тестбренд",
      canonicalUrl: "https://www.ozon.ru/product/testbrand-tabletki-123456789/",
      product: "Тестбренд таблетки 10 мг №20",
      reviews: 7,
      rating: 4.9,
      status: "ok",
      capturedAt: now.toISOString()
    }],
    partitions: [{ brand: "Тестбренд", status: "complete", discovered: 1, collected: 1 }]
  } as const;
}

describe("Ozon companion import", () => {
  it("issues a short-lived hashed session only for an honest Ozon access blocker", async () => {
    const repository = new MemoryRepository({ runs: { "run-companion": blockedRun() } });
    const session = await issueOzonCompanionSession(repository, "run-companion", owner, { now: () => now });
    const stored = await repository.getRun("run-companion");

    expect(session.brands).toEqual(["Тестбренд"]);
    expect(session.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(session.expiresAt) - now.getTime()).toBe(30 * 60 * 1000);
    expect(stored?.companionSessions?.ozon?.nonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(session.nonce);
    expect(eligibleOzonCompanionBrands(blockedRun("parser_changed: tile schema changed"))).toEqual([]);
  });

  it("atomically replaces only the failed Ozon partition and makes the run publishable", async () => {
    const repository = new MemoryRepository({ runs: { "run-companion": blockedRun() } });
    const session = await issueOzonCompanionSession(repository, "run-companion", owner, { now: () => now });
    const imported = await importOzonCompanionResult(
      repository, "run-companion", owner, result(session.nonce), { now: () => now }
    );

    expect(imported.partitions).toEqual([expect.objectContaining({ status: "complete", discovered: 1, collected: 1 })]);
    expect(imported.observations).toEqual([expect.objectContaining({
      domain: "ozon.ru",
      platform: "ozon",
      listingId: "123456789",
      reviews: 7,
      rating: 4.9,
      source: "ozon:composer-api:local-companion"
    })]);
    expect(imported.errors).toEqual([]);
    expect(imported.qa?.ok).toBe(true);
    expect(imported.companionSessions?.ozon).toMatchObject({ usedAt: now.toISOString() });
  });

  it("allows an idempotent replay of the same payload but rejects a changed replay", async () => {
    const repository = new MemoryRepository({ runs: { "run-companion": blockedRun() } });
    const session = await issueOzonCompanionSession(repository, "run-companion", owner, { now: () => now });
    const payload = result(session.nonce);
    const first = await importOzonCompanionResult(repository, "run-companion", owner, payload, { now: () => now });
    const replay = await importOzonCompanionResult(repository, "run-companion", owner, payload, { now: () => now });
    expect(replay.payloadHash).toBe(first.payloadHash);

    await expect(importOzonCompanionResult(repository, "run-companion", owner, {
      ...payload,
      observations: payload.observations.map((item) => ({ ...item, rating: 4.8 }))
    }, { now: () => now })).rejects.toThrow("уже использована");
  });

  it("serializes concurrent imports so one nonce cannot accept two different payloads", async () => {
    const repository = new MemoryRepository({ runs: { "run-companion": blockedRun() } });
    const session = await issueOzonCompanionSession(repository, "run-companion", owner, { now: () => now });
    const first = result(session.nonce);
    const second = {
      ...first,
      observations: first.observations.map((item) => ({ ...item, reviews: 8 }))
    };
    const settled = await Promise.allSettled([
      importOzonCompanionResult(repository, "run-companion", owner, first, { now: () => now }),
      importOzonCompanionResult(repository, "run-companion", owner, second, { now: () => now })
    ]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
  });

  it("rejects another owner, expired sessions and a URL whose SKU does not match", async () => {
    const repository = new MemoryRepository({ runs: { "run-companion": blockedRun() } });
    await expect(issueOzonCompanionSession(repository, "run-companion", "other@ratings", { now: () => now }))
      .rejects.toThrow("другому сотруднику");

    const session = await issueOzonCompanionSession(repository, "run-companion", owner, { now: () => now });
    await expect(importOzonCompanionResult(repository, "run-companion", owner, result(session.nonce), {
      now: () => new Date(now.getTime() + 31 * 60 * 1000)
    })).rejects.toThrow("истекла");

    const fresh = await issueOzonCompanionSession(repository, "run-companion", owner, { now: () => now });
    const unsafe = result(fresh.nonce);
    await expect(importOzonCompanionResult(repository, "run-companion", owner, {
      ...unsafe,
      observations: unsafe.observations.map((item) => ({
        ...item,
        canonicalUrl: "https://www.ozon.ru/product/another-999999999/"
      }))
    }, { now: () => now })).rejects.toThrow("ссылка не соответствует SKU");
  });

  it("accepts proven empty discovery without inventing a zero-review card", async () => {
    const repository = new MemoryRepository({ runs: { "run-companion": blockedRun() } });
    const session = await issueOzonCompanionSession(repository, "run-companion", owner, { now: () => now });
    const imported = await importOzonCompanionResult(repository, "run-companion", owner, {
      version: 1,
      nonce: session.nonce,
      observations: [],
      partitions: [{ brand: "Тестбренд", status: "no_results", discovered: 0, collected: 0 }]
    }, { now: () => now });
    expect(imported.observations).toEqual([]);
    expect(imported.partitions[0]).toMatchObject({ status: "no_results", discovered: 0, collected: 0 });
    expect(imported.qa?.ok).toBe(true);
  });
});
