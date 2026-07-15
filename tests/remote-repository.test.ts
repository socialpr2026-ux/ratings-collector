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

  it("does not retry non-idempotent quota reservations", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<!doctype html><title>Bad Gateway</title>", { status: 502 }));
    const repository = new RemoteRepository(endpoint, token, fetchMock, async () => undefined);

    await expect(repository.reserveUsage("budget", 1, 4.5))
      .rejects.toThrow("Repository RPC HTTP 502: non-JSON response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
