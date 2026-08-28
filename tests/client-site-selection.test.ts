import { describe, expect, it } from "vitest";
import {
  CATALOG_DOMAINS,
  SELECTABLE_CATALOG_DOMAINS,
  SITE_CATALOG,
  countCustomDomains,
  parseDomainList,
  parseRunnableDomainList,
  parseTemporarilyBlockedDomainList,
  selectedYandexSourceDomains,
  updateDomainSelection
} from "../src/client/site-catalog.js";
import { INITIAL_DOMAINS } from "../src/shared/constants.js";

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
      "009.xn--p1ai",
      "uteka.ru",
      "megapteka.ru",
      "vapteke.ru",
      "apteka.magnit.ru",
      "maksavit.ru",
      "vitaexpress.ru",
      "apteka.ru",
      "nfapteka.ru",
      "budzdorov.ru",
      "etabl.ru",
      "apteka-april.ru"
    ]));
    expect(SITE_CATALOG.flatMap((group) => group.sites).find((site) => site.domain === "reviews.yandex.ru"))
      .toMatchObject({ note: "Отдельная площадка; не объединяется с Яндекс Маркетом" });
    expect(SELECTABLE_CATALOG_DOMAINS).not.toContain("medum.ru");
    expect(SELECTABLE_CATALOG_DOMAINS).not.toContain("med-otzyv.ru");
    expect(SITE_CATALOG.flatMap((group) => group.sites).find((site) => site.domain === "med-otzyv.ru")).toMatchObject({
      availability: "temporarily_blocked",
      note: "Сайт сейчас недоступен"
    });
    expect(SITE_CATALOG.flatMap((group) => group.sites).find((site) => site.domain === "medum.ru")).toMatchObject({
      availability: "temporarily_blocked"
    });
    expect(SELECTABLE_CATALOG_DOMAINS).toEqual(expect.arrayContaining([
      "apteka.ru", "nfapteka.ru", "budzdorov.ru", "eapteka.ru", "vapteke.ru",
      "maksavit.ru", "vitaexpress.ru", "polza.ru", "009.xn--p1ai"
    ]));
    expect(SELECTABLE_CATALOG_DOMAINS).not.toContain("apteka-april.ru");
    expect(SELECTABLE_CATALOG_DOMAINS).not.toContain("apteka.magnit.ru");
    expect(SELECTABLE_CATALOG_DOMAINS).not.toContain("etabl.ru");
    expect(SITE_CATALOG.flatMap((group) => group.sites).find((site) => site.domain === "apteka.magnit.ru")).toMatchObject({
      availability: "temporarily_blocked",
      note: "Рейтинг не отображается на карточке товара; скрытые API-агрегаты исключены"
    });
    expect(SITE_CATALOG.flatMap((group) => group.sites).find((site) => site.domain === "etabl.ru")).toMatchObject({
      availability: "temporarily_blocked",
      note: "Публичные рейтинги подтверждены; автоматический маршрут сейчас недоступен"
    });
    expect(SITE_CATALOG.flatMap((group) => group.sites).find((site) => site.domain === "polza.ru"))
      .toEqual({ domain: "polza.ru", label: "POLZAru" });
    expect(SITE_CATALOG.flatMap((group) => group.sites).find((site) => site.domain === "009.xn--p1ai"))
      .toEqual({ domain: "009.xn--p1ai", label: "009.рф" });
  });

  it("selects every runnable catalog site in a new collection by default", () => {
    expect(INITIAL_DOMAINS).toEqual(SELECTABLE_CATALOG_DOMAINS);
    expect(INITIAL_DOMAINS).toHaveLength(29);
  });

  it("keeps Yandex Market and Yandex Reviews as separate refresh targets", () => {
    expect(selectedYandexSourceDomains([
      "ozon.ru",
      "reviews.yandex.ru",
      "market.yandex.ru",
      "reviews.yandex.ru"
    ])).toEqual(["reviews.yandex.ru", "market.yandex.ru"]);
    expect(selectedYandexSourceDomains(["ozon.ru"])).toEqual([]);
  });

  it("shows the complete requested pharmacy list alongside additional connected pharmacies", () => {
    const pharmacyDomains = SITE_CATALOG.find((group) => group.id === "pharmacies")!.sites.map((site) => site.domain);
    expect(pharmacyDomains).toEqual(expect.arrayContaining([
      "009.xn--p1ai", "aptekaplus.ru", "megapteka.ru", "redapteka.ru", "maksavit.ru", "vapteke.ru", "polza.ru",
      "expero.ru", "rigla.ru", "gorzdrav.org", "366.ru", "stolichki.ru", "neopharm.ru", "ozerki.ru",
      "stoletov.ru", "apteka-april.ru", "farmlend.ru", "planetazdorovo.ru", "budzdorov.ru",
      "samson-pharma.ru", "zdesapteka.ru", "apteka.magnit.ru", "superapteka.ru", "vitaexpress.ru",
      "zhivika.ru", "aptekasalve.ru", "zdorov.ru", "tabletka.ru", "pharmeconom.ru", "aptstore.ru",
      "newapteka.ru", "ovita.ru"
    ]));
    expect(pharmacyDomains).toHaveLength(41);
    expect(CATALOG_DOMAINS).toHaveLength(54);
  });

  it("normalizes pasted URLs for the run without duplicating a site", () => {
    expect(parseDomainList([
      "https://www.ozon.ru/",
      "ozon.ru",
      "https://market.yandex.ru/search?text=test",
      "https://009.рф/kupit-lirika/otzyvy",
      "custom.example/path"
    ].join("\n"))).toEqual(["ozon.ru", "market.yandex.ru", "009.xn--p1ai", "custom.example"]);
  });

  it("keeps a manually pasted unavailable site visible but excludes it from the runnable set", () => {
    const value = "https://medum.ru/\nmed-otzyv.ru\npolza.ru\neapteka.ru\ncustom.example";

    expect(parseDomainList(value)).toEqual(["medum.ru", "med-otzyv.ru", "polza.ru", "eapteka.ru", "custom.example"]);
    expect(parseRunnableDomainList(value)).toEqual(["polza.ru", "eapteka.ru", "custom.example"]);
    expect(parseTemporarilyBlockedDomainList(value)).toEqual(["medum.ru", "med-otzyv.ru"]);
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
