import { describe, expect, it } from "vitest";
import type { RunState } from "../src/shared/types.js";
import { ozonCompanionEligibleBrands } from "../src/client/review-copy.js";

function run(message: string, status: RunState["status"] = "review"): Pick<RunState, "status" | "request" | "partitions"> {
  return {
    status,
    request: {
      sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit",
      month: "2026-07",
      region: "Москва",
      domains: ["ozon.ru", "wildberries.ru"],
      brands: ["Бренд А", "Бренд Б"]
    },
    partitions: [
      { domain: "ozon.ru", brand: "Бренд А", status: "blocked", discovered: 0, collected: 0, message },
      { domain: "ozon.ru", brand: "Бренд Б", status: "complete", discovered: 1, collected: 1 },
      { domain: "wildberries.ru", brand: "Бренд А", status: "complete", discovered: 1, collected: 1 }
    ]
  };
}

describe("Ozon companion UI gate", () => {
  it("offers local Chrome only after a real cloud access or quota blocker", () => {
    expect(ozonCompanionEligibleBrands(run("blocked: Ozon browser challenge HTTP 403"))).toEqual(["Бренд А"]);
    expect(ozonCompanionEligibleBrands(run("quota_exceeded: Sandbox limit exceeded"))).toEqual(["Бренд А"]);
  });

  it("does not offer local Chrome for parser failures, successful runs or active collection", () => {
    expect(ozonCompanionEligibleBrands(run("parser_changed: unexpected tile schema"))).toEqual([]);
    expect(ozonCompanionEligibleBrands(run("blocked: HTTP 403", "running"))).toEqual([]);
    expect(ozonCompanionEligibleBrands(run("blocked: HTTP 403", "published"))).toEqual([]);
  });
});
