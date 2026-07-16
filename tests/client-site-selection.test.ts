import { describe, expect, it } from "vitest";
import {
  CATALOG_DOMAINS,
  SELECTABLE_CATALOG_DOMAINS,
  SITE_CATALOG,
  countCustomDomains,
  parseDomainList,
  parseRunnableDomainList,
  parseTemporarilyBlockedDomainList,
  updateDomainSelection
} from "../src/client/site-catalog.js";

describe("site picker catalog", () => {
  it("exposes every confirmed production site in clear groups", () => {
    expect(SITE_CATALOG.map((group) => group.id)).toEqual(["marketplaces", "review-sites", "pharmacies"]);
    expect(CATALOG_DOMAINS).toEqual(expect.arrayContaining([
      "ozon.ru",
      "wildberries.ru",
      "market.yandex.ru",
      "megamarket.ru",
      "reviews.yandex.ru",
      "med-otzyv.ru",
      "irecommend.ru",
      "otzovik.com",
      "otzyv.pro",
      "vseotzyvy.ru",
      "otzyvru.com",
      "pravogolosa.net",
      "ru.otzyv.com",
      "uteka.ru",
      "megapteka.ru",
      "apteka.ru",
      "nfapteka.ru",
      "budzdorov.ru",
      "etabl.ru",
      "apteka-april.ru"
    ]));
    expect(SELECTABLE_CATALOG_DOMAINS).not.toContain("medum.ru");
    expect(SITE_CATALOG.flatMap((group) => group.sites).find((site) => site.domain === "medum.ru")).toMatchObject({
      availability: "temporarily_blocked"
    });
    expect(SELECTABLE_CATALOG_DOMAINS).toEqual(expect.arrayContaining([
      "apteka.ru", "nfapteka.ru", "budzdorov.ru", "etabl.ru"
    ]));
    expect(SELECTABLE_CATALOG_DOMAINS).not.toContain("apteka-april.ru");
    expect(SELECTABLE_CATALOG_DOMAINS).not.toContain("eapteka.ru");
    expect(SELECTABLE_CATALOG_DOMAINS).not.toContain("polza.ru");
    expect(SITE_CATALOG.flatMap((group) => group.sites).filter((site) =>
      ["eapteka.ru", "polza.ru"].includes(site.domain)
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "eapteka.ru", availability: "temporarily_blocked" }),
      expect.objectContaining({ domain: "polza.ru", availability: "temporarily_blocked" })
    ]));
  });

  it("normalizes pasted URLs for the run without duplicating a site", () => {
    expect(parseDomainList([
      "https://www.ozon.ru/",
      "ozon.ru",
      "https://market.yandex.ru/search?text=test",
      "custom.example/path"
    ].join("\n"))).toEqual(["ozon.ru", "market.yandex.ru", "custom.example"]);
  });

  it("keeps a manually pasted unavailable site visible but excludes it from the runnable set", () => {
    const value = "https://medum.ru/\npolza.ru\neapteka.ru\ncustom.example";

    expect(parseDomainList(value)).toEqual(["medum.ru", "polza.ru", "eapteka.ru", "custom.example"]);
    expect(parseRunnableDomainList(value)).toEqual(["custom.example"]);
    expect(parseTemporarilyBlockedDomainList(value)).toEqual(["medum.ru", "polza.ru", "eapteka.ru"]);
  });

  it("keeps unrelated manual entries unchanged when a preset is toggled", () => {
    const value = "https://Custom.Example/catalog\nozon.ru";
    const selected = updateDomainSelection(value, ["wildberries.ru"], true);
    expect(selected).toBe("https://Custom.Example/catalog\nozon.ru\nwildberries.ru");

    const cleared = updateDomainSelection(selected, ["ozon.ru", "wildberries.ru"], false);
    expect(cleared).toBe("https://Custom.Example/catalog");
  });

  it("adds a whole group idempotently and reports only non-catalog domains as custom", () => {
    const marketplaceDomains = SITE_CATALOG[0].sites.map((site) => site.domain);
    const once = updateDomainSelection("custom.example\nozon.ru", marketplaceDomains, true);
    const twice = updateDomainSelection(once, marketplaceDomains, true);

    expect(twice).toBe(once);
    expect(parseDomainList(twice)).toEqual(["custom.example", "ozon.ru", "wildberries.ru", "market.yandex.ru", "megamarket.ru"]);
    expect(countCustomDomains(twice)).toBe(1);
  });
});
