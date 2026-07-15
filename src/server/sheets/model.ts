import { createHash } from "node:crypto";
import type { Observation, ProductRecord, RunRequest } from "../../shared/types.js";
import { normalizeText } from "../utils/normalize.js";
import { analyzeProductIdentity, canonicalProductVariants } from "../utils/product-name.js";
import { productKey } from "../repository.js";

export type SheetScalar = string | number | null;
export type ExistingSheet = { values: SheetScalar[][] };
export type SheetRowKind = "title" | "subheader" | "section" | "product" | "blank" | "summaryHeader" | "summary" | "footnote";
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

function parseLegacy(existing: ExistingSheet, request: RunRequest): { products: RowProduct[]; months: string[] } {
  const values = existing.values;
  const currentLayout = normalizeText(String(values[0]?.[0] ?? "")) === "бренд" &&
    normalizeText(String(values[0]?.[1] ?? "")) === "ссылка";
  const urlColumn = currentLayout ? 1 : 0;
  const productColumn = currentLayout ? 2 : 1;
  const metricStartColumn = currentLayout ? 4 : 3;
  const months: string[] = [];
  for (let column = metricStartColumn; column < (values[0]?.length ?? 0); column += 2) {
    const key = legacyMonthKey(values[0]?.[column], Number(request.month.slice(0, 4)));
    if (key) months.push(key);
  }
  const products: RowProduct[] = [];
  for (let row = 2; row < values.length; row += 1) {
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
  const ordered = deduplicated.sort((a, b) =>
    domainOrder.indexOf(a.domain) - domainOrder.indexOf(b.domain) ||
    brandOrder.indexOf(a.brand) - brandOrder.indexOf(b.brand) ||
    a.product.localeCompare(b.product, "ru") || a.listingId.localeCompare(b.listingId)
  );
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
  const title: SheetScalar[] = ["Бренд", "Ссылка", "Продукт", null];
  const subheader: SheetScalar[] = [null, null, null, null];
  for (let column = 0; column < 3; column += 1) {
    merges.push({ startRow: 0, endRow: 2, startColumn: column, endColumn: column + 1 });
  }
  months.forEach((month, index) => {
    const column = 4 + index * 2;
    title[column] = monthLabel(month); subheader[column] = "Отзывы / оценки"; subheader[column + 1] = "Рейтинг";
    merges.push({ startRow: 0, endRow: 1, startColumn: column, endColumn: column + 2 });
  });
  add("title", title); add("subheader", subheader);
  const productStartRow = 3;
  for (const domain of domainOrder) {
    const inDomain = ordered.filter((item) => item.domain === domain);
    if (!inDomain.length) continue;
    add("section", [domain, null, "Продукт", null]);
    for (const item of inDomain) {
      const row: SheetScalar[] = [item.brand, item.canonicalUrl, item.product, null];
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
    months.forEach((month, index) => {
      const reviewsColumn = columnLetter(5 + index * 2); const ratingColumn = columnLetter(6 + index * 2);
      const countRow = summaryStartRow + 1 + metricIndex;
      const groups = new Map<string, Array<{ item: RowProduct; row: number }>>();
      for (const entry of productRows) {
        const key = entry.item.aggregateGroupId
          ? `${entry.item.domain}\u0000${normalizeText(entry.item.brand)}\u0000${entry.item.aggregateGroupId}`
          : `${entry.item.domain}\u0000${entry.item.listingId}`;
        const members = groups.get(key) ?? [];
        members.push(entry);
        groups.set(key, members);
      }
      const representatives = [...groups.values()].flatMap((members) => {
        if (members.length < 2 || !members[0]!.item.aggregateGroupId) return members;
        const populated = members.filter(({ item }) => {
          const metric = item.metrics[month];
          return metric && (metric.reviews !== null || metric.rating !== null);
        });
        if (populated.length < 2) return populated.length ? [populated[0]!] : [members[0]!];
        const fingerprints = new Set(populated.map(({ item }) => {
          const metric = item.metrics[month]!;
          return `${metric.reviews ?? "null"}:${metric.rating ?? "null"}`;
        }));
        // A platform aggregate is counted once only while every populated
        // member proves the same metrics. Conflicts remain visible and are not
        // silently collapsed.
        return fingerprints.size === 1 ? [populated[0]!] : members;
      });
      const reviewCells = representatives.map(({ row: productRow }) => `${reviewsColumn}${productRow}`);
      const ratingCells = representatives.map(({ row: productRow }) => `${ratingColumn}${productRow}`);
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
