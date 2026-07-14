import { describe, expect, it, vi } from "vitest";
import { isPrivateNetworkAddress, readTextBounded } from "../src/server/utils/safe-fetch.js";

describe("bounded network reads", () => {
  it("cancels a response body that stalls past the deadline", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise(() => undefined); },
      cancel
    });

    await expect(readTextBounded(new Response(body), 1024, 10))
      .rejects.toThrow("Чтение ответа превысило");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("recognizes private IPv4, mapped IPv4 and local IPv6", () => {
    expect(isPrivateNetworkAddress("127.0.0.1")).toBe(true);
    expect(isPrivateNetworkAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateNetworkAddress("fd00::1")).toBe(true);
    expect(isPrivateNetworkAddress("8.8.8.8")).toBe(false);
  });

  it("cancels a body rejected from its declared content length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { headers: { "content-length": "2048" } });

    await expect(readTextBounded(response, 1024)).rejects.toThrow("превышает лимит");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
