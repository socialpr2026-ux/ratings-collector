import { describe, expect, it } from "vitest";
import type { AdapterContext, Observation, ProductRef, SiteAdapter } from "../src/shared/types.js";
import { RatingsService } from "../src/server/orchestrator.js";
import { runtimeSignals } from "../src/server/runtime-activity.js";
import { MemoryRepository } from "../src/server/repository.js";

const request = {
  sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
  month: "2026-07",
  region: "Москва",
  domains: ["example.com"],
  brands: ["Бренд"]
};

describe("live runtime activity trace", () => {
  it("derives channels from returned collector evidence, never from a domain guess", () => {
    expect(runtimeSignals("ozon.ru")).toEqual({ channels: undefined, parsers: undefined });
    expect(runtimeSignals(
      { source: "ozon:search-html:google-translate" },
      "ozon:product-json-ld:google-translate"
    )).toEqual({
      channels: ["google_translate"],
      parsers: ["json_ld"]
    });
    expect(runtimeSignals("ozon:composer-api:edgeone-browser")).toEqual({
      channels: ["sandbox", "browser", "first_party_api"],
      parsers: ["api_json"]
    });
    expect(runtimeSignals("eapteka-reader-product")).toEqual({
      channels: ["reader_proxy"],
      parsers: undefined
    });
  });

  it("persists the active discovery and the exact completed route for polling clients", async () => {
    const repository = new MemoryRepository();
    let signalDiscoveryStarted!: () => void;
    let releaseDiscovery!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => { signalDiscoveryStarted = resolve; });
    const discoveryRelease = new Promise<void>((resolve) => { releaseDiscovery = resolve; });

    const adapter: SiteAdapter = {
      id: "evidence-adapter",
      supportedDomains: ["example.com"],
      async healthCheck() {
        return { ok: true, checkedAt: new Date().toISOString(), message: "direct canary is healthy" };
      },
      async discover(brand: string, adapterContext: AdapterContext): Promise<ProductRef[]> {
        await adapterContext.activity?.({
          operationId: "translated-search",
          stage: "discovery",
          status: "active",
          label: "Google Translate · выдача",
          channels: ["google_translate"]
        });
        signalDiscoveryStarted();
        await discoveryRelease;
        await adapterContext.activity?.({
          operationId: "translated-search",
          stage: "discovery",
          status: "complete",
          label: "Google Translate · выдача",
          channels: ["google_translate"]
        });
        return [{
          domain: "example.com",
          platform: "example.com",
          listingId: "1",
          brand,
          url: "https://example.com/p/1",
          title: `${brand} таблетки 100 мг №10`,
          metadata: { source: "search-html:google-translate" }
        }];
      },
      async collect(ref: ProductRef): Promise<Observation> {
        return {
          domain: ref.domain,
          platform: ref.platform,
          listingId: ref.listingId,
          brand: ref.brand,
          canonicalUrl: ref.url,
          product: ref.title!,
          reviews: 7,
          rating: 4.8,
          status: "ok",
          capturedAt: new Date().toISOString(),
          evidenceRef: `${ref.url}#json-ld`,
          source: "product-json-ld:google-translate"
        };
      }
    };
    const service = new RatingsService(repository, async () => adapter);
    const created = await service.createRun(request);
    const execution = service.executeRun(created.id);

    await discoveryStarted;
    const live = await repository.getRun(created.id);
    expect(live?.status).toBe("running");
    expect(live?.activity?.active).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "discovery",
        status: "active",
        domain: "example.com",
        brand: "Бренд"
      }),
      expect.objectContaining({
        stage: "discovery",
        status: "active",
        label: "Google Translate · выдача",
        channels: ["google_translate"]
      })
    ]));

    releaseDiscovery();
    const finished = await execution;
    expect(finished.activity?.active).toEqual([]);
    expect(finished.activity?.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "discovery",
        status: "complete",
        channels: ["google_translate"]
      }),
      expect.objectContaining({
        stage: "collection",
        status: "complete",
        channels: ["google_translate"],
        parsers: ["json_ld"]
      }),
      expect.objectContaining({ stage: "normalization", status: "complete" }),
      expect.objectContaining({ stage: "qa", status: "complete" })
    ]));
  });
});
