import { describe, expect, it } from "vitest";
import { extractPageProductEvidence } from "../src/server/utils/product-evidence.js";
import {
  analyzeProductIdentity,
  canonicalProductDescriptors
} from "../src/server/utils/product-name.js";

const emptyFamilyEvidence = {
  scope: "product_family" as const,
  signals: [] as Array<{ source: "title" | "json_ld" | "description" | "variant" | "instruction" | "image_alt" | "url"; text: string }>,
  variants: [] as string[],
  identifiers: [],
  imageUrls: [],
  instructionUrls: []
};

describe("cross-site product identity contract", () => {
  it("never promotes a bare review counter to a product named 'Общий рейтинг: №30'", () => {
    const identity = analyzeProductIdentity({
      brand: "Оциллококцинум",
      product: "Оциллококцинум отзывы",
      evidence: {
        ...emptyFamilyEvidence,
        signals: [{ source: "title", text: "Оциллококцинум отзывы" }],
        variants: ["№30"]
      }
    });

    expect(identity).toMatchObject({
      label: "Общий рейтинг бренда",
      granularity: "family",
      confidence: "partial"
    });
    expect(identity.label).not.toContain("№30");
  });

  it("migrates a stored bare-counter aggregate from the real source title", () => {
    const [recovered, unknown] = canonicalProductDescriptors([
      {
        brand: "Оциллококцинум",
        product: "Оциллококцинум гранулы гомеопатические 30 доз",
        productIdentity: {
          label: "Общий рейтинг: №30",
          granularity: "family",
          confidence: "exact",
          missing: [],
          reasons: ["legacy"]
        }
      },
      {
        brand: "Оциллококцинум",
        product: "Общий рейтинг: №30",
        productIdentity: {
          label: "Общий рейтинг: №30",
          granularity: "family",
          confidence: "exact",
          missing: [],
          reasons: ["legacy"]
        }
      }
    ]);

    expect(recovered).toBe("гранулы №30");
    expect(unknown).toBe("Общий рейтинг бренда");
  });

  it("treats one exact pack on an aggregate review domain as that product, not a brand aggregate", () => {
    const identity = analyzeProductIdentity({
      brand: "Оциллококцинум",
      product: "Оциллококцинум 30 доз гранулы гомеопатические",
      url: "https://otzyv.pro/category/badyi/62074-ocillokokcinum-30-doz-grangomeopaticheskie.html",
      evidence: {
        ...emptyFamilyEvidence,
        signals: [{ source: "title", text: "Оциллококцинум 30 доз гранулы гомеопатические" }],
        variants: ["Оциллококцинум 30 доз гранулы гомеопатические"]
      }
    });

    expect(identity).toMatchObject({
      granularity: "variant",
      confidence: "exact",
      label: "гранулы №30"
    });
    expect(identity.label).not.toMatch(/^Общий рейтинг/iu);
  });

  it("uses one canonical label for equivalent Oscillococcinum pack wording across sites", () => {
    const labels = canonicalProductDescriptors([
      { brand: "Оциллококцинум", product: "Оциллококцинум гранулы гомеопатические 1 г №30" },
      { brand: "Оциллококцинум", product: "Оциллококцинум гранулы 1 г 1 доза 30 шт" },
      { brand: "Оциллококцинум", product: "Оциллококцинум гранулы №30" }
    ]);

    expect(labels).toEqual(["гранулы №30", "гранулы №30", "гранулы №30"]);
  });

  it.each([
    ["Кагоцел таблетки 12 мг 20 шт", "Кагоцел табл. 12мг №20", "таблетки 12 мг №20"],
    ["Анвифен капсулы 250 мг 20 шт", "Анвифен капс. 0,25 г №20", "капсулы 250 мг №20"],
    ["Цитовир-3 порошок в саше 20 мг №12", "Цитовир-3 порошок 0,02 г 12 саше", "порошок в саше 20 мг №12"]
  ])("normalizes equivalent form, strength and pack notation: %s", (left, right, expected) => {
    expect(canonicalProductDescriptors([
      { brand: left.split(" ")[0], product: left },
      { brand: left.split(" ")[0], product: right }
    ])).toEqual([expected, expected]);
  });

  it("does not merge real product differences while shortening redundant wording", () => {
    const labels = canonicalProductDescriptors([
      { brand: "Анвифен", product: "Анвифен капсулы 50 мг №20" },
      { brand: "Анвифен", product: "Анвифен капсулы 250 мг №20" },
      { brand: "Анвифен", product: "Анвифен капсулы 50 мг №10" },
      { brand: "Анвифен", product: "Анвифен таблетки 50 мг №20" }
    ]);

    expect(new Set(labels).size).toBe(4);
  });

  it("does not turn company or marketing words into a separate product", () => {
    expect(canonicalProductDescriptors([
      { brand: "Кагоцел", product: "Кагоцел таблетки 12 мг №20" },
      { brand: "Кагоцел", product: "Ниармедик Плюс Кагоцел таблетки 12 мг 20 шт" }
    ])).toEqual(["таблетки 12 мг №20", "таблетки 12 мг №20"]);

    expect(analyzeProductIdentity({ brand: "Бактоблис", product: "Бактоблис Плюс отзывы" }))
      .toMatchObject({ granularity: "family" });
  });

  it("keeps a real multi-variant review page as a family aggregate", () => {
    const identity = analyzeProductIdentity({
      brand: "Бактоблис",
      product: "Бактоблис отзывы",
      evidence: {
        ...emptyFamilyEvidence,
        variants: [
          "Бактоблис порошок в саше 1500 мг №15",
          "Бактоблис Плюс таблетки для рассасывания 950 мг №30"
        ]
      }
    });

    expect(identity).toMatchObject({
      granularity: "family",
      confidence: "exact",
      variantCount: 2
    });
  });
});

describe("product evidence provenance contract", () => {
  it("never exposes review titles or review text as product variants", () => {
    const evidence = extractPageProductEvidence(`
      <main>
        <h1>Оциллококцинум гранулы гомеопатические 30 доз</h1>
        <article class="review user-comment">
          <select data-testid="review-variant">
            <option>Гранулы или плацебо?</option>
            <option>6 грамм сахара за 400 рублей</option>
          </select>
          <h3>Супер препарат от гриппа и ОРВИ, мне и ребёнку помогает 100%!</h3>
        </article>
      </main>
    `, "https://otzyv.pro/category/badyi/62074-ocillokokcinum-30-doz-grangomeopaticheskie.html", "Оциллококцинум", {
      forceFamily: true
    });

    expect(evidence.variants).toEqual([]);
    expect(evidence.signals.map((signal) => signal.text).join("\n")).not.toMatch(
      /Гранулы или плацебо|6 грамм сахара|Супер препарат/iu
    );
  });

  it("still accepts structured product-local variant controls", () => {
    const evidence = extractPageProductEvidence(`
      <main itemscope itemtype="https://schema.org/Product">
        <h1 itemprop="name">Оциллококцинум</h1>
        <div data-testid="product-variant" role="listbox">
          <div role="option">Оциллококцинум гранулы №6</div>
          <div role="option">Оциллококцинум гранулы №12</div>
          <div role="option">Оциллококцинум гранулы №30</div>
        </div>
      </main>
    `, "https://example.ru/ocillococcinum", "Оциллококцинум", { forceFamily: true });

    expect(evidence.variants).toEqual([
      "Оциллококцинум гранулы №6",
      "Оциллококцинум гранулы №12",
      "Оциллококцинум гранулы №30"
    ]);
  });
});
