import { describe, expect, it, vi } from "vitest";
import type { AdapterContext, Observation, ProductRef, SiteAdapter } from "../src/shared/types.js";
import { BudgetedAdapter } from "../src/server/adapters/budgeted.js";
import { AdapterBlockedError, AdapterQuotaError, ParserChangedError } from "../src/server/adapters/errors.js";
import { ResilientAdapter } from "../src/server/adapters/resilient.js";
import { isWildberriesApifyRef } from "../src/server/adapters/wildberries-apify.js";
import { isYandexApifyRef } from "../src/server/adapters/yandex-apify.js";

const context: AdapterContext = { region: "Москва", runId: "run-1" };
const ref = (collector: string): ProductRef => ({
  domain: "example.ru", platform: "example", listingId: "1", brand: "Бренд",
  url: "https://example.ru/product/1", title: "Бренд товар", metadata: { collector }
});
const observation = (source: string): Observation => ({
  domain: "example.ru", platform: "example", listingId: "1", brand: "Бренд",
  canonicalUrl: "https://example.ru/product/1", product: "Бренд товар", reviews: 1,
  rating: 5, status: "ok", capturedAt: "2026-07-13T00:00:00.000Z", source
});

function adapter(name: "primary" | "fallback", discover: SiteAdapter["discover"]): SiteAdapter {
  return {
    id: "example", supportedDomains: ["example.ru"], discover,
    async healthCheck() { return { ok: true, checkedAt: "2026-07-13T00:00:00.000Z" }; },
    async collect() { return observation(name); }
  };
}

describe("ResilientAdapter", () => {
  it("circuit-breaks a stable primary block and routes fallback refs back to the fallback collector", async () => {
    const primaryDiscover = vi.fn(async () => { throw new AdapterBlockedError("429"); });
    const fallbackDiscover = vi.fn(async () => [ref("fallback")]);
    const resilient = new ResilientAdapter(
      adapter("primary", primaryDiscover), adapter("fallback", fallbackDiscover),
      { isFallbackRef: (item) => item.metadata.collector === "fallback" }
    );

    await expect(resilient.discover("Бренд", context)).resolves.toHaveLength(1);
    await expect(resilient.discover("Другой", context)).resolves.toHaveLength(1);
    await expect(resilient.collect(ref("fallback"), context)).resolves.toMatchObject({ source: "fallback" });
    await expect(resilient.collect(ref("primary"), context)).resolves.toMatchObject({ source: "primary" });
    expect(primaryDiscover).toHaveBeenCalledTimes(1);
    expect(fallbackDiscover).toHaveBeenCalledTimes(2);
  });

  it("retries a transient free primary for the next brand instead of poisoning the whole run", async () => {
    const directRef = ref("primary");
    const primaryDiscover = vi.fn()
      .mockRejectedValueOnce(new AdapterBlockedError("temporary 429"))
      .mockResolvedValueOnce([directRef]);
    const fallbackDiscover = vi.fn(async () => [ref("fallback")]);
    const resilient = new ResilientAdapter(
      adapter("primary", primaryDiscover),
      adapter("fallback", fallbackDiscover),
      {
        isFallbackRef: (item) => item.metadata.collector === "fallback",
        stickyPrimaryFailure: false
      }
    );

    await expect(resilient.discover("First brand", context)).resolves.toMatchObject([
      { metadata: { collector: "fallback" } }
    ]);
    await expect(resilient.discover("Second brand", context)).resolves.toEqual([directRef]);

    expect(primaryDiscover).toHaveBeenCalledTimes(2);
    expect(fallbackDiscover).toHaveBeenCalledTimes(1);
  });

  it("preserves both causes and avoids paying repeatedly for deterministic fallback drift", async () => {
    const fallbackDiscover = vi.fn(async () => { throw new ParserChangedError("missing reviewCount"); });
    const resilient = new ResilientAdapter(
      adapter("primary", async () => { throw new AdapterBlockedError("blocked"); }),
      adapter("fallback", fallbackDiscover),
      { isFallbackRef: () => true }
    );

    await expect(resilient.discover("Бренд", context)).rejects.toThrow(/primary: blocked; fallback: missing reviewCount/);
    await expect(resilient.discover("Другой", context)).rejects.toThrow(/primary: blocked; fallback: missing reviewCount/);
    expect(fallbackDiscover).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Wildberries", "wildberries-apify", isWildberriesApifyRef],
    ["Yandex", "yandex-apify", isYandexApifyRef]
  ])("routes %s fallback refs to fallback collect", async (_platform, collector, isFallbackRef) => {
    const fallbackRef = ref(collector);
    const primaryCollect = vi.fn(async () => observation("primary"));
    const fallbackCollect = vi.fn(async () => observation("fallback"));
    const primary = {
      ...adapter("primary", async () => { throw new AdapterBlockedError("direct blocked"); }),
      collect: primaryCollect
    };
    const fallback = {
      ...adapter("fallback", async () => [fallbackRef]),
      collect: fallbackCollect
    };
    const resilient = new ResilientAdapter(primary, fallback, { isFallbackRef });

    await expect(resilient.discover("Бренд", context)).resolves.toEqual([fallbackRef]);
    await expect(resilient.collect(fallbackRef, context)).resolves.toMatchObject({ source: "fallback" });
    expect(fallbackCollect).toHaveBeenCalledTimes(1);
    expect(primaryCollect).not.toHaveBeenCalled();
  });

  it("recovers when discovery works but the primary card endpoint is blocked", async () => {
    const directRef = ref("primary");
    const fallbackRef = ref("wildberries-apify");
    const fallbackDiscover = vi.fn(async () => [fallbackRef]);
    const fallbackCollect = vi.fn(async () => observation("fallback"));
    const primary = {
      ...adapter("primary", async () => [directRef]),
      collect: vi.fn(async () => { throw new AdapterBlockedError("card HTTP 403"); })
    };
    const fallback = {
      ...adapter("fallback", fallbackDiscover),
      collect: fallbackCollect
    };
    const resilient = new ResilientAdapter(primary, fallback, { isFallbackRef: isWildberriesApifyRef });

    await expect(resilient.discover("Бренд", context)).resolves.toEqual([directRef]);
    await expect(resilient.collect(directRef, context)).resolves.toMatchObject({ source: "fallback" });
    await expect(resilient.collect(directRef, context)).resolves.toMatchObject({ source: "fallback" });
    expect(fallbackDiscover).toHaveBeenCalledTimes(1);
    expect(fallbackCollect).toHaveBeenCalledTimes(2);
  });

  it("fails closed when fallback discovery cannot reproduce a blocked primary card ID", async () => {
    const directRef = ref("primary");
    const differentFallbackRef = { ...ref("wildberries-apify"), listingId: "2" };
    const resilient = new ResilientAdapter(
      {
        ...adapter("primary", async () => [directRef]),
        async collect() { throw new AdapterBlockedError("card HTTP 403"); }
      },
      adapter("fallback", async () => [differentFallbackRef]),
      { isFallbackRef: isWildberriesApifyRef }
    );

    await expect(resilient.collect(directRef, context)).rejects.toThrow(/fallback did not return the same listing ID/);
  });

  it("fails before either paid fallback when the common live budget cannot fund a reservation", async () => {
    const externalUsageUsd = vi.fn(async () => 4.3);
    const firstPaidDiscover = vi.fn(async () => [ref("wildberries-apify")]);
    const secondPaidDiscover = vi.fn(async () => [ref("yandex-apify")]);
    const fallback = (discover: SiteAdapter["discover"]) => new BudgetedAdapter(
      adapter("fallback", discover),
      { reservePerDiscovery: 0.25, monthlyLimit: 4.5, externalUsageUsd }
    );
    const first = new ResilientAdapter(
      adapter("primary", async () => { throw new AdapterBlockedError("429"); }),
      fallback(firstPaidDiscover),
      { isFallbackRef: isWildberriesApifyRef }
    );
    const second = new ResilientAdapter(
      adapter("primary", async () => { throw new AdapterBlockedError("fetch failed"); }),
      fallback(secondPaidDiscover),
      { isFallbackRef: isYandexApifyRef }
    );

    await expect(first.discover("Бренд", context)).rejects.toBeInstanceOf(AdapterQuotaError);
    await expect(second.discover("Бренд", context)).rejects.toBeInstanceOf(AdapterQuotaError);
    expect(externalUsageUsd).toHaveBeenCalledTimes(2);
    expect(firstPaidDiscover).not.toHaveBeenCalled();
    expect(secondPaidDiscover).not.toHaveBeenCalled();
  });
});
