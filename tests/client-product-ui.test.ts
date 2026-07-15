import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITE_CATALOG, parseDomainList, updateDomainSelection } from "../src/client/site-catalog.js";

const appSource = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");

describe("Interfox Ratings product shell", () => {
  it("uses the Interfox product name without implementation copy in the main interface", () => {
    expect(appSource).toContain('aria-label="Interfox Ratings — в начало"');
    expect(appSource).toContain('<span className="interfox-wordmark">Interfox</span>');
    expect(appSource).toContain('<span className="ratings-wordmark">Ratings</span>');
    expect(appSource).not.toContain("Ежемесячное обновление таблицы");
    expect(appSource).not.toContain("Без Google API-ключей");
  });

  it("presents the three business categories in the employee workflow order", () => {
    expect(SITE_CATALOG).toHaveLength(3);
    expect(new Map(SITE_CATALOG.map((group) => [group.id, group.label]))).toEqual(new Map([
      ["review-sites", "Отзовики"],
      ["pharmacies", "Аптеки"],
      ["marketplaces", "Маркетплейсы"]
    ]));
    expect(appSource).toContain('["review-sites", "pharmacies", "marketplaces"] as const');
    expect(appSource).toContain('role="tablist" aria-label="Категории площадок"');
    expect(appSource).toContain('role="tabpanel"');
  });

  it("can select and clear every available site in each category without losing a custom domain", () => {
    for (const group of SITE_CATALOG) {
      const availableDomains = group.sites
        .filter((site) => site.availability !== "temporarily_blocked")
        .map((site) => site.domain);
      const selected = updateDomainSelection("custom.example", availableDomains, true);

      expect(parseDomainList(selected)).toEqual(["custom.example", ...availableDomains]);
      expect(updateDomainSelection(selected, availableDomains, false)).toBe("custom.example");
    }
  });

  it("keeps long brand lists manageable instead of permanently exposing a large textarea", () => {
    expect(appSource).toContain('className="brand-picker-button"');
    expect(appSource).toContain('className="brand-edit-button"');
    expect(appSource).toContain('className="brand-choice-list" aria-label="Каталог брендов"');
    expect(appSource).toContain('aria-label="Поиск по доступным брендам"');
    expect(appSource).toContain("setBrandSelection(brand, event.target.checked)");
    expect(appSource).toContain("normalizedBrands.slice(0, 6)");
  });

  it("renders an evidence-backed runtime map instead of a decorative site list", () => {
    expect(appSource).toContain('aria-label="Живая карта реальных процессов сбора"');
    expect(appSource).toContain("run?.activity?.active");
    expect(appSource).toContain('parsing: "Извлечение"');
    expect(appSource).toContain('className={`runtime-live-field state-${focusedActivity?.status ?? "pending"}`}');
    expect(appSource).toContain('runtimeRouteLabels.join(" → ")');
    expect(appSource).toContain("activityChannelLabels[channel]");
    expect(appSource).toContain("Google Translate SSR");
    expect(appSource).not.toContain("Подготавливаем маршрут · ${run.progress.current}");
    expect(appSource).not.toContain('className="runtime-route-node');
    expect(appSource).not.toContain('className={`runtime-stage');
    expect(appSource).not.toContain('className="process-domain-list"');
  });

  it("does not ask for review when a clean run has no disputed cards", () => {
    expect(appSource).toContain('cleanReviewReady ? "Сбор готов"');
    expect(appSource).toContain('reviewItems.length > 0 && <div className="view-switch"');
    expect(appSource).toContain(': "Результат готов"');
  });
});
