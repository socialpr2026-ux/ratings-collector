import { describe, expect, it } from "vitest";
import { authenticate, authConfig } from "../src/server/auth.js";
import { RemoteRepository } from "../src/server/remote-repository.js";

describe("shared open access mode", () => {
  it("returns one technical owner without inspecting an OAuth token", async () => {
    const headers = new Headers({ authorization: "Bearer deliberately-ignored" });
    const config = authConfig({ RATINGS_ALLOW_UNAUTHENTICATED: "true" });
    expect(config).toEqual({ clientId: undefined, allowedEmails: [], allowUnauthenticated: true });
    await expect(authenticate(headers, config)).resolves.toEqual({ email: "local@ratings" });
  });

  it("fails closed when the production open-mode variable is missing", async () => {
    await expect(authenticate(new Headers(), authConfig({}))).rejects.toThrow(
      "RATINGS_ALLOW_UNAUTHENTICATED=true"
    );
  });

  it("keeps the internal Agent channel separate and protected", () => {
    expect(() => new RemoteRepository("https://ratings.example/api/internal/repository", "short"))
      .toThrow("короче 32 символов");
    expect(() => new RemoteRepository(
      "https://ratings.example/api/internal/repository",
      "a".repeat(32)
    )).not.toThrow();
  });
});
