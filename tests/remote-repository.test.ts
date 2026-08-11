import { describe, expect, it, vi } from "vitest";
import { RemoteRepository } from "../src/server/remote-repository.js";

const endpoint = "https://ratings.example/api/internal/repository";
const token = "a".repeat(32);

describe("remote repository transient edge failures", () => {
  it("retries an idempotent collection checkpoint after an HTML 502", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("<!doctype html><title>Bad Gateway</title>", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const wait = vi.fn(async () => undefined);
    const repository = new RemoteRepository(endpoint, token, fetchMock, wait);

    await expect(repository.saveRun({ id: "run-1" } as never)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(200);
  });

  it("returns a stable diagnostic instead of leaking a JSON parser error", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<!doctype html><title>Bad Gateway</title>", { status: 502 }));
    const repository = new RemoteRepository(endpoint, token, fetchMock, async () => undefined);

    await expect(repository.getRun("run-1")).rejects.toThrow("Repository RPC HTTP 502: non-JSON response");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps an idempotent run checkpoint alive through a short gateway brownout", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 500 }))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 500 }))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 500 }))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: null }), { status: 200 }));
    const wait = vi.fn(async (_milliseconds: number) => undefined);
    const repository = new RemoteRepository(endpoint, token, fetchMock, wait);

    await expect(repository.saveRun({ id: "run-1" } as never)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([200, 400, 800, 1_600]);
  });

  it("attaches the active fencing token to every Agent run checkpoint", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "saveRun",
        run: { id: "run-1" },
        attemptFence: { attemptId: "attempt-2", fencingToken: 2 }
      });
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    });
    const repository = new RemoteRepository(endpoint, token, fetchMock, async () => undefined);
    repository.bindRunAttempt({ attemptId: "attempt-2", fencingToken: 2 } as never);

    await repository.saveRun({ id: "run-1" } as never);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry non-idempotent quota reservations", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<!doctype html><title>Bad Gateway</title>", { status: 502 }));
    const repository = new RemoteRepository(endpoint, token, fetchMock, async () => undefined);

    await expect(repository.reserveUsage("budget", 1, 4.5))
      .rejects.toThrow("Repository RPC HTTP 502: non-JSON response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends lease renewal once and surfaces a stale-token conflict without retrying", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "renewLease",
        lease: { token: "stale", keys: ["locks/one.json"], scope: "collection:ozon" },
        leaseMs: 120_000
      });
      return new Response(JSON.stringify({ error: "lease_token_conflict" }), {
        status: 409,
        headers: { "content-type": "application/json" }
      });
    });
    const wait = vi.fn(async () => undefined);
    const repository = new RemoteRepository(endpoint, token, fetchMock, wait);

    await expect(repository.renewLease({
      token: "stale", keys: ["locks/one.json"], scope: "collection:ozon"
    }, 120_000)).rejects.toThrow("lease_token_conflict");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
});
