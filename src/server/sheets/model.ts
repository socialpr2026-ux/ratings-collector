import { createHash } from "node:crypto";
import type { Observation, ProductRecord, RunRequest } from "../../shared/types.js";
import { normalizeText } from "../utils/normalize.js";
import { analyzeProductIdentity, canonicalProductVariants } from "../utils/product-name.js";
import { productKey } from "../repository.js";

export type SheetScalar = string | number | null;
export type ExistingSheet = { values: SheetScalar[][] };
export type SheetRowKind = "brand" | "title" | "subheader" | "section" | "product" | "blank" | "summaryHeader" | "summary" | "footnote";
export type SheetDocument = {
  values: SheetScalar[][];
  formulas: Array<Array<string | null>>;
  rowKinds: SheetRowKind[];
  months: string[];
  productStartRow: number;
  productEndRow: number;
  summaryStartRow: number;
  columnCount: number;
  merges: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>;
};

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
};

function transliterate(value: string) {
  return normalizeText(value).split("").map((char) => LATIN[char] ?? char).join("").replace(/\s+/g, "-");
}
function monthLabel(month: string) { const [year, number] = month.split("-"); return `${MONTHS[Number(number) - 1]} ${year}`; }
function legacyMonthKey(label: unknown, fallbackYear: number): string | undefined {
  if (typeof label !== "string") return undefined;
  const match = label.trim().match(new RegExp(`^(${MONTHS.join("|")})(?:\\s+(\\d{4}))?$`, "i"));
  if (!match) return undefined;
  const month = MONTHS.findIndex((item) => item.toLocaleLowerCase("ru") === match[1].toLocaleLowerCase("ru")) + 1;
  return `${match[2] ?? fallbackYear}-${String(month).padStart(2, "0")}`;
}
function inferListing(url: string): { domain: string; listingId: string } {
  const parsed = new URL(url);
  const domain = parsed.hostname.replace(/^www\./, "").replace(/^reviews\./, "market.");
  const ozon = parsed.pathname.match(/-(\d+)\/?$/); if (domain === "ozon.ru" && ozon) return { domain, listingId: ozon[1] };
  const wb = parsed.pathname.match(/\/catalog\/(\d+)/); if (domain === "wildberries.ru" && wb) return { domain, listingId: wb[1] };
  const yandex = parsed.pathname.match(/--(\d+)/); if ((domain === "market.yandex.ru" || domain === "yandex.ru") && yandex) return { domain: "market.yandex.ru", listingId: yandex[1] };
  return { domain, listingId: createHash("sha256").update(url).digest("hex").slice(0, 20) };
}
function inferBrand(url: string, product: string, brands: string[]): string {
  // Rows written by this service always start with `Brand — ...`. Preserve
  // that canonical brand when a later run intentionally covers only a subset
  // of brands; otherwise every out-of-scope historical row would be relabelled
  // as "Без бренда" while rebuilding the same sheet.
  const storedPrefix = product.match(/^(.{1,80}?)\s+[—–]\s+\S/u)?.[1]?.trim();
  if (storedPrefix) return storedPrefix;
  const haystack = `${normalizeText(url)} ${normalizeText(product)} ${url.toLocaleLowerCase("ru")}`;
  return brands.find((brand) => haystack.includes(normalizeText(brand)) || haystack.includes(transliterate(brand))) ?? "Без бренда";
}
function asMetric(value: SheetScalar | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const number = Number(value.replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

type RowProduct = ProductRecord & { metrics: Record<string, { reviews: number | null; rating: number | null }> };

type SheetCategory = {
  id: "review-sites" | "pharmacies" | "marketplaces";
  label: "Отзовики" | "Аптеки" | "Маркетплейсы";
};

const SHEET_CATEGORIES: readonly SheetCategory[] = [
  { id: "review-sites", label: "Отзовики" },
  { id: "pharmacies", label: "Аптеки" },
  { id: "marketplaces", label: "Маркетплейсы" }
] as const;

const MARKETPLACE_DOMAINS = new Set([
  "ozon.ru", "wildberries.ru", "market.yandex.ru", "yandex.ru", "megamarket.ru"
]);

const PHARMACY_DOMAINS = new Set([
  "uteka.ru", "megapteka.ru", "medum.ru", "eapteka.ru", "polza.ru", "asna.ru",
  "farmlend.ru", "okapteka.ru", "rigla.ru", "zdravcity.ru", "apteka.ru", "nfapteka.ru",
  "budzdorov.ru", "etabl.ru", "apteka-april.ru"
]);

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  "ozon.ru": "Ozon",
  "wildberries.ru": "Wildberries",
  "market.yandex.ru": "Яндекс Маркет",
  "megamarket.ru": "Мегамаркет",
  "irecommend.ru": "iRecommend",
  "med-otzyv.ru": "Мед-отзыв",
  "otzovik.com": "Отзовик",
  "otzyv.pro": "Отзыв.pro",
  "vseotzyvy.ru": "Все отзывы",
  "otzyvru.com": "ОтзывРу",
  "pravogolosa.net": "Право голоса",
  "ru.otzyv.com": "Otzyv.com",
  "uteka.ru": "Ютека",
  "megapteka.ru": "Мегаптека",
  "medum.ru": "Medum",
  "eapteka.ru": "ЕАПТЕКА",
  "polza.ru": "POLZAru",
  "asna.ru": "АСНА",
  "farmlend.ru": "Фармленд",
  "okapteka.ru": "ОК Аптека",
  "rigla.ru": "Ригла",
  "zdravcity.ru": "Здравсити",
  "apteka.ru": "Apteka.ru",
  "nfapteka.ru": "Надежда-Фарм",
  "budzdorov.ru": "Будь Здоров",
  "etabl.ru": "eTabl.ru",
  "apteka-april.ru": "Апрель"
};

function normalizedDomain(domain: string): string {
  return domain.toLocaleLowerCase("en-US").replace(/^www\./, "").replace(/^reviews\.yandex\.ru$/, "market.yandex.ru");
}

function platformLabel(domain: string): string {
  const normalized = normalizedDomain(domain);
  return PLATFORM_LABELS[normalized] ?? normalized;
}

function sheetCategory(domain: string): SheetCategory {
  const normalized = normalizedDomain(domain);
  if (MARKETPLACE_DOMAINS.has(normalized)) return SHEET_CATEGORIES[2];
  if (PHARMACY_DOMAINS.has(normalized) || /(?:^|[.-])(?:apteka|pharm|farm|zdrav|drugstore)(?:[.-]|$)/iu.test(normalized)) {
    return SHEET_CATEGORIES[1];
  }
  // A new or custom domain must still fit the stable three-section report.
  // Until it is explicitly classified as a pharmacy or marketplace, it is a
  // public feedback source and belongs to the review-sites section.
  return SHEET_CATEGORIES[0];
}

function canonicalRowIdentity(item: Pick<RowProduct, "domain" | "canonicalUrl">): string {
  try {
    const url = new URL(item.canonicalUrl);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return `${item.domain.toLocaleLowerCase("en-US")}:${url.toString()}`;
  } catch {
    return `${item.domain.toLocaleLowerCase("en-US")}:${item.canonicalUrl.trim()}`;
  }
}

function mergeCanonicalDuplicates(products: Iterable<RowProduct>): RowProduct[] {
  const byCanonical = new Map<string, RowProduct>();
  for (const item of products) {
    const identity = canonicalRowIdentity(item);
    const previous = byCanonical.get(identity);
    if (!previous) {
      byCanonical.set(identity, item);
      continue;
    }
    const metrics = { ...previous.metrics };
    for (const [month, current] of Object.entries(item.metrics)) {
      const old = metrics[month];
      metrics[month] = current.reviews !== null || current.rating !== null || !old ? current : old;
    }
    byCanonical.set(identity, {
      ...item,
      firstSeenMonth: [previous.firstSeenMonth, item.firstSeenMonth].sort()[0],
      lastSeenMonth: [previous.lastSeenMonth, item.lastSeenMonth].sort().at(-1)!,
      metrics
    });
  }
  return [...byCanonical.values()];
}

function combinedAggregateLabel(items: readonly RowProduct[]): string {
  const labels = [...new Set(items.map((item) => item.product.trim()))];
  if (labels.length < 2) return labels[0] ?? "";
  const parsed = labels.map((label) => label.match(/^(.*?)(?:\s*№\s*)(\d+)(.*)$/u));
  if (parsed.every((match) => match)) {
    const prefix = parsed[0]![1]!.trim();
    const suffix = parsed[0]![3]!.trim();
    const sameShape = parsed.every((match) =>
      normalizeText(match![1]!) === normalizeText(prefix) && normalizeText(match![3]!) === normalizeText(suffix)
    );
    if (sameShape) {
      const variants = [...new Set(parsed.map((match) => Number(match![2]!)))]
        .sort((left, right) => left - right)
        .map((value) => `№${value}`);
      const list = variants.length === 2
        ? variants.join(" и ")
        : `${variants.slice(0, -1).join(", ")} и ${variants.at(-1)}`;
      return [prefix, list, suffix].filter(Boolean).join(" ");
    }
  }
  return labels.join(" / ");
}

function collapseSharedAggregateRows(products: readonly RowProduct[], months: readonly string[]): RowProduct[] {
  const groups = new Map<string, RowProduct[]>();
  for (const item of products) {
    const key = item.aggregateGroupId
      ? `${item.domain}\u0000${normalizeText(item.brand)}\u0000${item.aggregateGroupId}`
      : `${item.domain}\u0000${item.listingId}`;
    const members = groups.get(key) ?? [];
    members.push(item);
    groups.set(key, members);
  }
  return [...groups.values()].flatMap((members) => {
    if (members.length < 2 || !members[0]!.aggregateGroupId) return members;
    for (const month of months) {
      const fingerprints = new Set(members.flatMap((item) => {
        const metric = item.metrics[month];
        return metric && (metric.reviews !== null || metric.rating !== null)
          ? [`${metric.reviews ?? "null"}:${metric.rating ?? "null"}`]
          : [];
      }));
      if (fingerprints.size > 1) return members;
    }
    const first = members[0]!;
    const metrics: RowProduct["metrics"] = {};
    for (const month of months) {
      const metric = members.map((item) => item.metrics[month])
        .find((value) => value && (value.reviews !== null || value.rating !== null));
      if (metric) metrics[month] = metric;
    }
    return [{
      ...first,
      product: combinedAggregateLabel(members),
      firstSeenMonth: members.map((item) => item.firstSeenMonth).sort()[0]!,
      lastSeenMonth: members.map((item) => item.lastSeenMonth).sort().at(-1)!,
      metrics
    }];
  });
}

function parseLegacy(existing: ExistingSheet, request: RunRequest): { products: RowProduct[]; months: string[] } {
  const values = existing.values;
  const secondHeader = normalizeText(String(values[1]?.[1] ?? ""));
  const thirdHeader = normalizeText(String(values[1]?.[2] ?? ""));
  const brandedLayout = normalizeText(String(values[0]?.[0] ?? "")) === "interfox ratings" &&
    normalizeText(String(values[1]?.[0] ?? "")) === "бренд" &&
    (secondHeader === "ссылка" || secondHeader === "площадка" && thirdHeader === "ссылка");
  const headerRow = brandedLayout ? 1 : 0;
  const headerSecond = normalizeText(String(values[headerRow]?.[1] ?? ""));
  const headerThird = normalizeText(String(values[headerRow]?.[2] ?? ""));
  const platformFirstLayout = normalizeText(String(values[headerRow]?.[0] ?? "")) === "бренд" &&
    headerSecond === "площадка" && headerThird === "ссылка";
  const linkFirstLayout = normalizeText(String(values[headerRow]?.[0] ?? "")) === "бренд" &&
    headerSecond === "ссылка";
  const currentLayout = platformFirstLayout || linkFirstLayout;
  const urlColumn = platformFirstLayout ? 2 : linkFirstLayout ? 1 : 0;
  const productColumn = platformFirstLayout ? 3 : linkFirstLayout ? 2 : 1;
  const metricStartColumn = currentLayout ? 4 : 3;
  const months: string[] = [];
  for (let column = metricStartColumn; column < (values[headerRow]?.length ?? 0); column += 2) {
    const key = legacyMonthKey(values[headerRow]?.[column], Number(request.month.slice(0, 4)));
    if (key) months.push(key);
  }
  const products: RowProduct[] = [];
  for (let row = headerRow + 2; row < values.length; row += 1) {
    const url = values[row]?.[urlColumn];
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) continue;
    const rawProduct = String(values[row]?.[productColumn] ?? "").trim();
    const { domain, listingId } = inferListing(url);
    const storedBrand = currentLayout ? String(values[row]?.[0] ?? "").trim() : "";
    const brand = storedBrand || inferBrand(url, rawProduct, request.brands);
    const metrics: RowProduct["metrics"] = {};
    months.forEach((month, index) => {
      metrics[month] = {
        reviews: asMetric(values[row]?.[metricStartColumn + index * 2]),
        rating: asMetric(values[row]?.[metricStartColumn + 1 + index * 2])
      };
    });
    products.push({
      key: productKey(domain, listingId), domain, listingId, brand, canonicalUrl: url, product: rawProduct,
      platform: domain, firstSeenMonth: months[0] ?? request.month, lastSeenMonth: months.at(-1) ?? request.month, metrics
    });
  }
  return { products, months };
}

export function buildSheetDocument(
  existing: ExistingSheet,
  request: RunRequest,
  registry: ProductRecord[],
  snapshots: Record<string, Record<string, Observation>>
): SheetDocument {
  const legacy = parseLegacy(existing, request);
  const months = [...new Set([...legacy.months, ...Object.keys(snapshots), request.month])].sort();
  const productMap = new Map<string, RowProduct>(legacy.products.map((item) => [item.key, item]));
  for (const item of registry) {
    const previous = productMap.get(item.key);
    productMap.set(item.key, { ...item, metrics: previous?.metrics ?? {} });
  }
  for (const item of productMap.values()) {
    if (request.domains.includes(item.domain) && request.brands.includes(item.brand)) {
      item.metrics[request.month] = { reviews: null, rating: null };
    }
  }
  const snapshotEntries = Object.entries(snapshots).sort(([left], [right]) => {
    if (left === request.month) return 1;
    if (right === request.month) return -1;
    return left.localeCompare(right);
  });
  for (const [month, items] of snapshotEntries) {
    for (const [key, observation] of Object.entries(items)) {
      const previous = productMap.get(key);
      productMap.set(key, {
        key, domain: observation.domain, listingId: observation.listingId, brand: observation.brand,
        canonicalUrl: observation.canonicalUrl, product: observation.product,
        platform: observation.platform, groupId: observation.groupId,
        aggregateGroupId: observation.aggregateGroupId,
        productIdentity: observation.productIdentity,
        firstSeenMonth: previous ? [previous.firstSeenMonth, month].sort()[0] : month,
        lastSeenMonth: previous ? [previous.lastSeenMonth, month].sort().at(-1)! : month,
        metrics: { ...(previous?.metrics ?? {}), [month]: { reviews: observation.reviews, rating: observation.rating } }
      });
    }
  }
  const deduplicated = mergeCanonicalDuplicates(productMap.values());
  for (let index = deduplicated.length - 1; index >= 0; index -= 1) {
    const item = deduplicated[index];
    // Product rules evolve independently from the monthly metrics. Rebuild
    // older unresolved/draft labels so a later publication migrates
    // "Вариант не определён · известно: таблетки №20" to the final
    // "таблетки №20" without losing history.
    if (!item.productIdentity || item.productIdentity.granularity === "unresolved" || /вариант не определён/iu.test(item.productIdentity.label)) {
      item.productIdentity = analyzeProductIdentity({ brand: item.brand, product: item.product, url: item.canonicalUrl });
    }
    if (item.productIdentity.granularity === "not_product") deduplicated.splice(index, 1);
  }
  const variants = canonicalProductVariants(deduplicated.map((item) => ({
    brand: item.brand,
    product: item.product,
    url: item.canonicalUrl,
    productIdentity: item.productIdentity
  })));
  deduplicated.forEach((item, index) => { item.product = variants[index].label; });
  const domainOrder = [...new Set([...request.domains, ...deduplicated.map((item) => item.domain).filter((domain) => !request.domains.includes(domain)).sort()])];
  const brandOrder = [...new Set([...request.brands, ...deduplicated.map((item) => item.brand).filter((brand) => !request.brands.includes(brand)).sort((a, b) => a.localeCompare(b, "ru"))])];
  const ordered = collapseSharedAggregateRows(deduplicated.sort((a, b) =>
    SHEET_CATEGORIES.findIndex((category) => category.id === sheetCategory(a.domain).id) -
      SHEET_CATEGORIES.findIndex((category) => category.id === sheetCategory(b.domain).id) ||
    domainOrder.indexOf(a.domain) - domainOrder.indexOf(b.domain) ||
    brandOrder.indexOf(a.brand) - brandOrder.indexOf(b.brand) ||
    a.product.localeCompare(b.product, "ru") || a.listingId.localeCompare(b.listingId)
  ), months);
  const columnCount = 4 + months.length * 2;
  const values: SheetScalar[][] = [];
  const formulas: Array<Array<string | null>> = [];
  const rowKinds: SheetRowKind[] = [];
  const merges: SheetDocument["merges"] = [];
  const productRows: Array<{ item: RowProduct; row: number }> = [];
  const add = (kind: SheetRowKind, row: SheetScalar[], formula: Array<string | null> = []) => {
    // Some presentation rows are intentionally assembled by assigning cells
    // at month columns (for example D, F, ...). Array spread preserves those
    // leading holes as `undefined`, which is outside the Sheets JSON contract.
    // Densify every row here so both values and formulas contain explicit nulls.
    values.push(Array.from(
      { length: Math.max(columnCount, row.length) },
      (_, column) => row[column] ?? null
    ));
    formulas.push(Array.from(
      { length: Math.max(columnCount, formula.length) },
      (_, column) => formula[column] ?? null
    ));
    rowKinds.push(kind);
  };
  const brandRow: SheetScalar[] = ["Interfox Ratings", null, null, null, `Рейтинги товаров · ${request.region}`];
  add("brand", brandRow);
  merges.push({ startRow: 0, endRow: 1, startColumn: 0, endColumn: 4 });
  if (columnCount > 4) merges.push({ startRow: 0, endRow: 1, startColumn: 4, endColumn: columnCount });

  const title: SheetScalar[] = ["Бренд", "Площадка", "Ссылка", "Продукт"];
  const subheader: SheetScalar[] = [null, null, null, null];
  for (let column = 0; column < 4; column += 1) {
    merges.push({ startRow: 1, endRow: 3, startColumn: column, endColumn: column + 1 });
  }
  months.forEach((month, index) => {
    const column = 4 + index * 2;
    title[column] = monthLabel(month); subheader[column] = "Отзывы / оценки"; subheader[column + 1] = "Рейтинг";
    merges.push({ startRow: 1, endRow: 2, startColumn: column, endColumn: column + 2 });
  });
  add("title", title); add("subheader", subheader);
  const productStartRow = 5;
  for (const category of SHEET_CATEGORIES) {
    const inCategory = ordered.filter((item) => sheetCategory(item.domain).id === category.id);
    if (!inCategory.length) continue;
    add("section", [
      category.label,
      `Площадок: ${new Set(inCategory.map((item) => normalizedDomain(item.domain))).size}`,
      `Карточек: ${inCategory.length}`,
      null
    ]);
    for (const item of inCategory) {
      const row: SheetScalar[] = [item.brand, platformLabel(item.domain), item.canonicalUrl, item.product];
      months.forEach((month, index) => {
        const metric = item.metrics[month]; row[4 + index * 2] = metric?.reviews ?? null; row[5 + index * 2] = metric?.rating ?? null;
      });
      add("product", row);
      productRows.push({ item, row: values.length });
    }
  }
  const productEndRow = Math.max(productStartRow, values.length);
  add("blank", []);
  const summaryStartRow = values.length + 1;
  const summaryHeader: SheetScalar[] = [];
  months.forEach((_, index) => { summaryHeader[4 + index * 2] = "Кол-во"; summaryHeader[5 + index * 2] = "Доля"; });
  const summaryHeaderRow = values.length;
  add("summaryHeader", summaryHeader);
  merges.push({ startRow: summaryHeaderRow, endRow: summaryHeaderRow + 1, startColumn: 0, endColumn: 3 });
  const labels = ["Всего отзывов / оценок", "Карточки с рейтингом ≥4 баллов", "Карточки с рейтингом <4 баллов", "Карточки без отзывов / оценок"];
  labels.forEach((label, metricIndex) => {
    const row: SheetScalar[] = [label]; const formula: Array<string | null> = [];
    months.forEach((_month, index) => {
      const reviewsColumn = columnLetter(5 + index * 2); const ratingColumn = columnLetter(6 + index * 2);
      const countRow = summaryStartRow + 1 + metricIndex;
      const reviewCells = productRows.map(({ row: productRow }) => `${reviewsColumn}${productRow}`);
      const ratingCells = productRows.map(({ row: productRow }) => `${ratingColumn}${productRow}`);
      const reviewArray = `{${reviewCells.join(";")}}`;
      const ratingArray = `{${ratingCells.join(";")}}`;
      const formulasForMetric = [
        reviewCells.length ? `=SUM(${reviewCells.join(";")})` : "=0",
        ratingCells.length ? `=COUNTIFS(${ratingArray};">=4";${reviewArray};">0")` : "=0",
        ratingCells.length ? `=COUNTIFS(${ratingArray};"<4";${ratingArray};"<>";${reviewArray};">0")` : "=0",
        ratingCells.length ? `=COUNTIFS(${reviewArray};0;${reviewArray};"<>";${ratingArray};"")` : "=0"
      ];
      formula[4 + index * 2] = formulasForMetric[metricIndex];
      if (metricIndex > 0) formula[5 + index * 2] = `=IFERROR(${reviewsColumn}${countRow}/SUM(${reviewsColumn}${summaryStartRow + 2}:${reviewsColumn}${summaryStartRow + 4});0)`;
    });
    const summaryRow = values.length;
    add("summary", row, formula);
    merges.push({ startRow: summaryRow, endRow: summaryRow + 1, startColumn: 0, endColumn: 3 });
  });
  add("footnote", ["*Публичные агрегаты отзывов, оценок и голосов; ошибки и блокировки не подменяются нулевыми значениями."]);
  merges.push({ startRow: values.length - 1, endRow: values.length, startColumn: 0, endColumn: 3 });
  return { values, formulas, rowKinds, months, productStartRow, productEndRow, summaryStartRow, columnCount, merges };
}

export function columnLetter(oneBased: number): string {
  let result = ""; let value = oneBased;
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}
