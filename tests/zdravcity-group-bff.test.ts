import { describe, expect, it } from "vitest";
import {
  proveExactZdravcityGroupBff,
  zdravcityGroupBffGetUrl,
  zdravcityGroupBffRequest,
  zdravcityGroupSlugFromUrl
} from "../src/server/utils/zdravcity-group-bff.js";

const missing = (slug: string) => ({
  errors: [{
    message: `queryResolver.Group: catalog.Manager.Group: rpc error: code = NotFound desc = group.group: catalog.group by code ${slug}: group not found`,
    path: ["group"],
    extensions: { code: 404 }
  }],
  data: null
});

describe("exact Zdravcity group BFF proof", () => {
  it("builds one bounded Moscow-region query for an exact allowlisted group URL", () => {
    expect(zdravcityGroupSlugFromUrl("https://zdravcity.ru/g_hloretta/")).toBe("hloretta");
    expect(zdravcityGroupSlugFromUrl("https://zdravcity.ru/g_hloretta/?next=evil")).toBeUndefined();
    expect(zdravcityGroupBffRequest("hloretta")).toMatchObject({
      operationName: "ExactGroupPresence",
      variables: { regionID: "moscowregion", code: "hloretta" }
    });
    const direct = new URL(zdravcityGroupBffGetUrl("hloretta"));
    expect(direct.origin + direct.pathname).toBe("https://zdravcity.ru/bff/query");
    expect(direct.searchParams.get("operationName")).toBe("ExactGroupPresence");
    expect(JSON.parse(direct.searchParams.get("variables") ?? "null")).toEqual({
      regionID: "moscowregion", code: "hloretta"
    });
    const translated = new URL(zdravcityGroupBffGetUrl("hloretta", true));
    expect(translated.hostname).toBe("zdravcity-ru.translate.goog");
    expect(translated.searchParams.get("_x_tr_sl")).toBe("ru");
    expect(translated.searchParams.get("_x_tr_tl")).toBe("en");
  });

  it("accepts only the exact first-party missing envelope bound to the requested slug", () => {
    expect(proveExactZdravcityGroupBff(missing("hloretta"), "hloretta")).toBe("missing");
    expect(proveExactZdravcityGroupBff(missing("kagocel"), "hloretta")).toBeUndefined();
    expect(proveExactZdravcityGroupBff({
      ...missing("hloretta"), errors: [{ ...missing("hloretta").errors[0], extensions: { code: 403 } }]
    }, "hloretta")).toBeUndefined();
    expect(proveExactZdravcityGroupBff({ data: null, errors: [] }, "hloretta")).toBeUndefined();
  });

  it("distinguishes an exact present group without turning it into absence", () => {
    expect(proveExactZdravcityGroupBff({
      data: { group: { code: "kagocel", name: "Кагоцел" } }
    }, "kagocel")).toBe("present");
    expect(proveExactZdravcityGroupBff({
      data: { group: { code: "other", name: "Другой бренд" } }
    }, "kagocel")).toBeUndefined();
  });
});
