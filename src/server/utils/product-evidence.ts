import { load } from "cheerio";
import type { ProductEvidence } from "../../shared/types.js";
import { matchesBrand, normalizeText } from "./normalize.js";

const PRODUCT_FORM = /(?:табл(?:ет(?:ка|ки|ок)?)?\.?|капс(?:ул(?:а|ы|ок)?)?\.?|саше|пакетик|стик|порош|гран(?:\.|ул)|сироп|суспенз|раствор|спрей|капли|суппозитор|свеч|ампул|флакон|лиоф|гель|крем|мазь)/iu;
const PRODUCT_DETAIL = /(?:\d+(?:[.,]\d+)?\s*(?:мкг|мг|гр?\.?|мл|ме|%)|(?:№|#|\bN(?:o)?\.?)\s*\d+|\d+\s*(?:шт|таблет|капсул|саше|пакет|стик|ампул|флакон|доз)|(?:количеств|фасовк|в\s+упаковк)[^\d]{0,24}\d+|таблет|капсул|саше|порош|гран(?:\.|ул)|сироп|суспенз|раствор|спрей|капли|лиоф)/iu;
const VARIANT_DETAIL = /(?:\d+(?:[.,]\d+)?\s*(?:мкг|мг|гр?\.?|мл|ме|%)|(?:№|#|\bN(?:o)?\.?)\s*\d+|\d+\s*(?:шт|таблет|капсул|саше|пакет|стик|ампул|флакон|доз)|(?:количеств|фасовк|в\s+упаковк)[^\d]{0,24}\d+)/iu;
const ATTRIBUTE_LABEL = /(?:лекарственн(?:ая|ой)\s+форм|форм[аы]\s+выпуск|дозиров|концентрац|фасовк|кол(?:ичество|-?во)(?:\s+в\s+упаковке)?|упаковк|об[ъь]ем|масса|вес|размер|комплектац|вкус|содержание|strength|dosage|dose|form|quantity|pack(?:age)?|size|volume|weight)/iu;
const ATTRIBUTE_EXCLUDE = /(?:способ\s+применения|режим\s+дозирования|суточн(?:ая|ой)\s+доз|курс\s+лечения|условия\s+хранения)/iu;
const INSTRUCTION_LINK = /(?:инструк|состав|форм[аы][-_\s]+выпуск|instruction|composition|dosage-form)/iu;
const PRODUCT_JSON_FIELDS = ["name", "model", "dosageForm", "strength", "packageSize", "size", "weight"] as const;
const REVIEW_CONTENT_SELECTOR = [
  "[itemprop='review']",
  "[itemprop='reviewBody']",
  "[itemtype*='schema.org/Review']",
  "[itemtype*='/Review']",
  "[data-review-id]",
  "[data-reviewid]",
  "article[class*='review']",
  "li[class*='review']",
  "[class*='review-item']",
  "[class*='review_item']",
  "[class*='review-card']",
  "[class*='comment-item']",
  "[class*='comment_item']"
].join(",");

type JsonObject = Record<string, unknown>;
type JsonLdEvidence = {
  signals: string[];
  variants: string[];
  identifiers: ProductEvidence["identifiers"];
  imageUrls: string[];
};

function clean(value: string | undefined, max = 2000): string | undefined {
  if (!value) return undefined;
  // NFKC normally expands the human-readable numero sign to "No". Protect it
  // because Russian pharmacy packs conventionally use "№20" as the clearest
  // compact package identifier.
  const normalized = value.replace(/№/gu, "\uE000").normalize("NFKC").replace(/\uE000/gu, "№")
    .replace(/[\t\r\n\u00a0\u202f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function httpsUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sameSiteUrl(value: string | undefined, base: string): string | undefined {
  const resolved = httpsUrl(value, base);
  if (!resolved) return undefined;
  const target = new URL(resolved);
  const page = new URL(base);
  const left = target.hostname.replace(/^www\./iu, "");
  const right = page.hostname.replace(/^www\./iu, "");
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`) ? resolved : undefined;
}

function unique(values: Array<string | undefined>, limit: number, max = 2000): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = clean(value, max);
    if (!text) continue;
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return clean(String(value), 700);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as JsonObject;
  const main = stringValue(object.value ?? object["@value"] ?? object.name);
  const unit = stringValue(object.unitText ?? object.unitCode);
  return main && unit ? clean(`${main} ${unit}`, 700) : main;
}

function jsonTypes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === "string").map(normalizeText);
}

function jsonImages(value: unknown, pageUrl: string): string[] {
  const items = Array.isArray(value) ? value : [value];
  const urls: Array<string | undefined> = [];
  for (const item of items) {
    if (typeof item === "string") urls.push(httpsUrl(item, pageUrl));
    else if (item && typeof item === "object") {
      const object = item as JsonObject;
      urls.push(httpsUrl(stringValue(object.url ?? object.contentUrl), pageUrl));
    }
  }
  return unique(urls, 6);
}

function jsonPropertyPairs(object: JsonObject): string[] {
  const pairs: string[] = [];
  const labels: Record<(typeof PRODUCT_JSON_FIELDS)[number], string> = {
    name: "Название",
    model: "Модель",
    dosageForm: "Лекарственная форма",
    strength: "Дозировка",
    packageSize: "Количество в упаковке",
    size: "Размер/фасовка",
    weight: "Масса"
  };
  for (const field of PRODUCT_JSON_FIELDS) {
    const value = stringValue(object[field]);
    if (value) pairs.push(`${labels[field]}: ${value}`);
  }
  const properties = Array.isArray(object.additionalProperty) ? object.additionalProperty : [object.additionalProperty];
  for (const property of properties) {
    if (!property || typeof property !== "object") continue;
    const item = property as JsonObject;
    const label = stringValue(item.name ?? item.propertyID);
    const value = stringValue(item.value ?? item.valueReference);
    if (label && value && ATTRIBUTE_LABEL.test(label) && !ATTRIBUTE_EXCLUDE.test(label)) pairs.push(`${label}: ${value}`);
  }
  return unique(pairs, 12, 700);
}

function extractJsonLdEvidence($: ReturnType<typeof load>, pageUrl: string, brand: string): JsonLdEvidence {
  const result: JsonLdEvidence = { signals: [], variants: [], identifiers: [], imageUrls: [] };
  const identifierKeys: Array<{ key: string; type: ProductEvidence["identifiers"][number]["type"] }> = [
    { key: "sku", type: "sku" },
    { key: "productID", type: "product_id" },
    { key: "mpn", type: "product_id" },
    { key: "gtin", type: "gtin" },
    { key: "gtin8", type: "gtin" },
    { key: "gtin12", type: "gtin" },
    { key: "gtin13", type: "gtin" },
    { key: "gtin14", type: "gtin" }
  ];
  const seenObjects = new Set<object>();

  function visit(value: unknown, variantContext = false, inheritedBrand = false, depth = 0): void {
    if (!value || depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) visit(item, variantContext, inheritedBrand, depth + 1);
      return;
    }
    if (typeof value !== "object" || seenObjects.has(value as object)) return;
    seenObjects.add(value as object);
    const object = value as JsonObject;
    const isProduct = jsonTypes(object["@type"]).some((type) => type === "product" || type.endsWith(" product"));
    const objectBrandValues = [object.name, object.brand, object.manufacturer]
      .map(stringValue)
      .filter((item): item is string => Boolean(item));
    const matchesExpectedBrand = objectBrandValues.some((value) => matchesBrand(value, brand));
    const relevantProduct = matchesExpectedBrand || (variantContext && inheritedBrand);

    if ((isProduct || variantContext) && relevantProduct) {
      const pairs = jsonPropertyPairs(object);
      const composed = clean(pairs.join("; "), 1200);
      const name = stringValue(object.name);
      if (composed) result.signals.push(composed);
      if (name && !composed) result.signals.push(name);
      if (variantContext && (name || composed)) result.variants.push(composed ?? name!);
      for (const identifier of identifierKeys) {
        const id = stringValue(object[identifier.key]);
        if (id) result.identifiers.push({ type: identifier.type, value: id });
      }
      result.imageUrls.push(...jsonImages(object.image, pageUrl));
    }

    for (const [key, child] of Object.entries(object).slice(0, 200)) {
      const childIsVariant = key === "hasVariant";
      visit(child, childIsVariant, childIsVariant && (matchesExpectedBrand || inheritedBrand), depth + 1);
    }
  }

  $("script[type='application/ld+json']").each((_index, node) => {
    const source = $(node).text().trim().replace(/^<!--|-->$/gu, "").replace(/^<!\[CDATA\[|\]\]>$/gu, "");
    if (!source || source.length > 1_500_000) return;
    try { visit(JSON.parse(source)); }
    catch { /* Invalid third-party markup is ignored, never evaluated. */ }
  });

  const ids = new Map<string, ProductEvidence["identifiers"][number]>();
  for (const identifier of result.identifiers) ids.set(`${identifier.type}:${normalizeText(identifier.value)}`, identifier);
  return {
    signals: unique(result.signals, 12, 1200),
    variants: unique(result.variants.filter((value) => PRODUCT_DETAIL.test(value)), 30, 1000),
    identifiers: [...ids.values()].slice(0, 20),
    imageUrls: unique(result.imageUrls, 6)
  };
}

function isReviewContent($: ReturnType<typeof load>, node: Parameters<ReturnType<typeof load>>[0]): boolean {
  return $(node).is(REVIEW_CONTENT_SELECTOR) || $(node).closest(REVIEW_CONTENT_SELECTOR).length > 0;
}

function relevantPair(label: string | undefined, value: string | undefined): string | undefined {
  const left = clean(label, 160);
  const right = clean(value, 500);
  if (!left || !right || !ATTRIBUTE_LABEL.test(left) || ATTRIBUTE_EXCLUDE.test(left)) return undefined;
  if (!PRODUCT_DETAIL.test(`${left}: ${right}`) && !PRODUCT_FORM.test(right)) return undefined;
  return `${left}: ${right}`;
}

function structuredAttributeSignals($: ReturnType<typeof load>): string[] {
  const blocks: string[] = [];
  $("table").each((_index, table) => {
    if (isReviewContent($, table)) return;
    const pairs: string[] = [];
    $(table).find("tr").each((_rowIndex, row) => {
      const cells = $(row).children("th,td");
      if (cells.length < 2) return;
      const pair = relevantPair(cells.eq(0).text(), cells.slice(1).map((_cellIndex, cell) => $(cell).text()).get().join(" "));
      if (pair) pairs.push(pair);
    });
    const block = unique(pairs, 12, 700).join("; ");
    if (block) blocks.push(block);
  });
  $("dl").each((_index, list) => {
    if (isReviewContent($, list)) return;
    const pairs: string[] = [];
    $(list).children("dt").each((_termIndex, term) => {
      const value = $(term).next("dd").first().text();
      const pair = relevantPair($(term).text(), value);
      if (pair) pairs.push(pair);
    });
    const block = unique(pairs, 12, 700).join("; ");
    if (block) blocks.push(block);
  });
  return unique(blocks, 8, 1200);
}

function visibleVariantTexts($: ReturnType<typeof load>): string[] {
  const selectors = [
    "[data-test='release-form-badge']",
    "[data-testid*='product-variant'][role='option']",
    "[data-testid*='product-variant'] [role='option']",
    "[data-test*='product-variant'][role='option']",
    "[data-test*='product-variant'] [role='option']",
    "[class*='product-variant'] option",
    "[class*='product-variant'] [role='option']",
    "[class*='product__variant'] option",
    "[class*='product__variant'] [role='option']",
    "select[aria-label*='вариант' i] option",
    "select[aria-label*='упаков' i] option",
    "select[name*='variant' i] option",
    "select[name*='product' i] option"
  ];
  return unique($(selectors.join(",")).map((_index, node) => {
    if (isReviewContent($, node)) return undefined;
    const value = $(node).attr("content") ?? $(node).attr("aria-label") ?? $(node).attr("title") ?? $(node).text();
    const text = clean(value, 1000);
    return text && PRODUCT_DETAIL.test(text) ? text : undefined;
  }).get(), 30, 1000);
}

function instructionSectionSignals($: ReturnType<typeof load>): string[] {
  const signals: Array<string | undefined> = [];
  $("h2,h3,h4,summary,[role='tab']").each((_index, heading) => {
    if (isReviewContent($, heading)) return;
    const label = clean($(heading).text(), 160);
    if (!label || !ATTRIBUTE_LABEL.test(label) || ATTRIBUTE_EXCLUDE.test(label)) return;
    const value = clean($(heading).next().first().text(), 700);
    if (value && (PRODUCT_DETAIL.test(value) || PRODUCT_FORM.test(value))) signals.push(`${label}: ${value}`);
  });
  $("a[href]").each((_index, node) => {
    if (isReviewContent($, node)) return;
    const href = $(node).attr("href");
    const anchor = clean($(node).text(), 500);
    if (href && anchor && INSTRUCTION_LINK.test(`${href} ${anchor}`) && PRODUCT_DETAIL.test(anchor)) signals.push(anchor);
  });
  return unique(signals, 8, 1000);
}

function imageTextSignals($: ReturnType<typeof load>, brand: string): string[] {
  const values: Array<string | undefined> = [];
  $("meta[property='og:image:alt'], meta[name='twitter:image:alt']").each((_index, node) => {
    const text = clean($(node).attr("content"), 1000);
    if (text && PRODUCT_DETAIL.test(text) && (matchesBrand(text, brand) || PRODUCT_FORM.test(text))) values.push(text);
  });
  $("img[alt], img[title], img[aria-label], figure figcaption").each((_index, node) => {
    if (isReviewContent($, node)) return;
    const text = clean($(node).attr("alt") ?? $(node).attr("title") ?? $(node).attr("aria-label") ?? $(node).text(), 1000);
    if (!text || !PRODUCT_DETAIL.test(text)) return;
    const semanticProductArea = $(node).closest("[itemtype*='Product'],[data-product-id],[data-testid*='product-card'],[data-test*='product-card'],figure").length > 0;
    if (matchesBrand(text, brand) || (semanticProductArea && PRODUCT_FORM.test(text))) values.push(text);
  });
  return unique(values, 8, 1000);
}

function imageUrls($: ReturnType<typeof load>, pageUrl: string, brand: string): string[] {
  const values: Array<string | undefined> = [];
  $("meta[property='og:image'], meta[name='twitter:image'], [itemprop='image'], img").each((_index, node) => {
    if (isReviewContent($, node)) return;
    const tag = (node as { tagName?: string }).tagName?.toLocaleLowerCase("en-US");
    const isMeta = tag === "meta";
    const isMicrodataImage = $(node).is("[itemprop='image']");
    const nearbyText = clean([
      $(node).attr("alt"), $(node).attr("title"), $(node).attr("aria-label"), $(node).closest("figure").find("figcaption").first().text()
    ].filter(Boolean).join(" "), 1000);
    if (!isMeta && !isMicrodataImage && !(nearbyText && (matchesBrand(nearbyText, brand) || PRODUCT_DETAIL.test(nearbyText)))) return;
    values.push(httpsUrl($(node).attr("content") ?? $(node).attr("src") ?? $(node).attr("data-src") ?? $(node).attr("data-original"), pageUrl));
    const srcset = $(node).attr("srcset") ?? $(node).attr("data-srcset");
    for (const entry of srcset?.split(",") ?? []) values.push(httpsUrl(entry.trim().split(/\s+/u)[0], pageUrl));
  });
  return unique(values, 6);
}

function visibleDescriptionSignals($: ReturnType<typeof load>, brand: string): string[] {
  const selectors = [
    "[itemprop='description']",
    "[data-testid*='product-description']",
    "[data-test*='product-description']",
    "[id*='product-description']",
    "[class*='product-description']",
    "[class*='product__description']"
  ];
  return unique($(selectors.join(",")).map((_index, node) => {
    if (isReviewContent($, node)) return undefined;
    const text = clean($(node).attr("content") ?? $(node).text(), 1400);
    if (!text || ATTRIBUTE_EXCLUDE.test(text) || !PRODUCT_FORM.test(text)) return undefined;
    return VARIANT_DETAIL.test(text) || matchesBrand(text, brand) ? text : undefined;
  }).get(), 4, 1400);
}

export function titleProductEvidence(
  title: string,
  identifier?: { type: ProductEvidence["identifiers"][number]["type"]; value: string },
  url?: string
): ProductEvidence {
  return {
    scope: "listing",
    signals: [
      { source: "title", text: clean(title)! },
      ...(url ? [{ source: "url" as const, text: url }] : [])
    ],
    variants: [],
    identifiers: identifier ? [identifier] : [],
    imageUrls: [],
    instructionUrls: []
  };
}

export function titleProvesProductVariant(title: string | undefined, brand: string): boolean {
  const text = clean(title);
  return Boolean(text && matchesBrand(text, brand) && PRODUCT_FORM.test(text) && VARIANT_DETAIL.test(text));
}

export function extractPageProductEvidence(
  html: string,
  pageUrl: string,
  brand: string,
  options: { forceFamily?: boolean; extraVariants?: string[]; structuredSignals?: string[] } = {}
): ProductEvidence {
  const $ = load(html);
  const title = clean($("h1").first().text()) ?? clean($("meta[property='og:title']").attr("content")) ?? clean($("title").text());
  // On review pages both meta descriptions and Product.description are often
  // populated from a user's review. They are not product identity evidence.
  const description = options.forceFamily ? undefined : clean(
    $("meta[name='description']").attr("content") ?? $("meta[property='og:description']").attr("content")
  );
  const jsonLd = extractJsonLdEvidence($, pageUrl, brand);
  const visibleVariants = visibleVariantTexts($);
  const titleLooksLikeVariant = titleProvesProductVariant(title, brand);
  const variants = unique([
    ...(options.extraVariants ?? []),
    ...jsonLd.variants,
    ...visibleVariants
  ].filter((value) => PRODUCT_DETAIL.test(value)), 30, 1000);
  const attributes = structuredAttributeSignals($);
  const visibleDescriptions = options.forceFamily ? [] : visibleDescriptionSignals($, brand);
  const imageAlts = imageTextSignals($, brand);
  const pageImageUrls = imageUrls($, pageUrl, brand);

  const instructionUrls = unique($("a[href]").map((_index, node) => {
    const href = $(node).attr("href");
    const anchor = `${href ?? ""} ${$(node).text()}`;
    return INSTRUCTION_LINK.test(anchor) ? sameSiteUrl(href, pageUrl) : undefined;
  }).get(), 3);
  const instructionSignals = instructionSectionSignals($);

  const signals: ProductEvidence["signals"] = [];
  if (title) signals.push({ source: "title", text: title });
  for (const text of unique([...jsonLd.signals, ...(options.structuredSignals ?? [])], 16, 1200)) signals.push({ source: "json_ld", text });
  for (const text of attributes) signals.push({ source: "description", text });
  if (description) signals.push({ source: "description", text: description });
  for (const text of visibleDescriptions) signals.push({ source: "description", text });
  for (const text of variants) signals.push({ source: "variant", text });
  for (const text of instructionSignals) signals.push({ source: "instruction", text });
  for (const text of imageAlts) signals.push({ source: "image_alt", text });
  signals.push({ source: "url", text: pageUrl });

  return {
    scope: options.forceFamily && !titleLooksLikeVariant
      || jsonLd.variants.length > 1
      || visibleVariants.length > 1
      || (options.extraVariants?.length ?? 0) > 1
      ? "product_family"
      : "listing",
    signals: signals.slice(0, 40),
    variants,
    identifiers: jsonLd.identifiers,
    imageUrls: unique([...jsonLd.imageUrls, ...pageImageUrls], 3),
    instructionUrls
  };
}
