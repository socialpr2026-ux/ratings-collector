import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type {
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductEvidence,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { matchesBrand, normalizeText } from "../utils/normalize.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { AdapterBlockedError, AdapterQuotaError, ParserChangedError } from "./errors.js";

const DOMAIN = "vitaexpress.ru";
const ORIGIN = `https://${DOMAIN}`;
const MAX_DOCUMENT_BYTES = 1_500_000;
const BLOCKED_STATUSES = new Set([401, 403, 429, 498]);
const TRANSIENT_STATUSES = new Set([408, 425, 499, 500, 502, 503, 504]);
const BLOCK_MARKERS = /captcha|access denied|forbidden|cloudflare|qrator|temporarily unavailable|\u0434\u043e\u0441\u0442\u0443\u043f (?:\u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0435\u043d|\u0437\u0430\u043f\u0440\u0435\u0449[\u0435\u0451]\u043d)|\u0441\u043b\u0438\u0448\u043a\u043e\u043c \u043c\u043d\u043e\u0433\u043e \u0437\u0430\u043f\u0440\u043e\u0441\u043e\u0432|\u043f\u0440\u043e\u0432\u0435\u0440(?:\u043a\u0430|\u044c\u0442\u0435),? \u0447\u0442\u043e \u0432\u044b \u043d\u0435 \u0440\u043e\u0431\u043e\u0442|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435,? \u0447\u0442\u043e \u0432\u044b \u0447\u0435\u043b\u043e\u0432\u0435\u043a/iu;
const TERMINAL_RETRY_BODY = /monthly\s+sandbox[\s\S]{0,80}gb-s|(?:quota|limit)[\s\S]{0,80}(?:exceeded|exhausted|reached)|(?:лимит|квот\w*)[\s\S]{0,80}(?:исчерпан\w*|превышен\w*|законч\w*)/iu;
const TRANSIENT_TRANSPORT_ERROR = /fetch\s+failed|network|socket|econn|etimedout|headers?\s+timeout|request\s+exceeded|чтение\s+ответа\s+превысило|таймаут\s+внешнего\s+запроса|operation\s+was\s+aborted\s+due\s+to\s+timeout/iu;
const EMPTY_REVIEW_TEXT = "\u0432\u0430\u0448 \u043e\u0442\u0437\u044b\u0432 \u043e \u0442\u043e\u0432\u0430\u0440\u0435 \u0441\u0442\u0430\u043d\u0435\u0442 \u043f\u0435\u0440\u0432\u044b\u043c";
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type ExactProduct = {
  id: string;
  brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442" | "\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d" | "\u041e\u0444\u0442\u0430\u0440\u0438\u043d\u0442" | "\u0422\u0430\u0443\u0441\u0442\u0438\u043d" | "Бактоблис" | "Энтеролактис" | "Хлорэтта" | "Тирзетта" | "Седжаро";
  url: string;
  requiredPhrases: readonly string[];
};

type ExactFamily = {
  id: string;
  tagId: string;
  brand: "Кагоцел" | "Трекрезан" | "Гриппферон" | "Ингавирин" | "Арбидол";
  url: string;
  variants: readonly { name: string; url: string }[];
};

type ParsedPage = {
  canonicalUrl: string;
  title: string;
  productEvidence: ProductEvidence;
  reviews: number;
  writtenReviewCount: number;
  rating: number | null;
  ratingCount: number;
};

type FetchedPage = ParsedPage & {
  body: string;
  status: number;
};

type ParsedFamilyPage = ParsedPage & {
  rating: number;
  starScores: number[];
  starTotal: number;
};

type FetchedFamilyPage = ParsedFamilyPage & {
  body: string;
  status: number;
};

const EXACT_PRODUCTS: readonly ExactProduct[] = [
  {
    id: "193139",
    brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442",
    url: `${ORIGIN}/product/biviart_komfort_r_r_uvlazhn__oftalmolog__0_18_10ml__1_fl_/`,
    requiredPhrases: ["\u0431\u0438\u0432\u0438\u0430\u0440\u0442 \u043a\u043e\u043c\u0444\u043e\u0440\u0442", "0 18", "10\u043c\u043b"]
  },
  {
    id: "193140",
    brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442",
    url: `${ORIGIN}/product/biviart_soft_r_r_uvlazhn__oftalmolog__0_1_10ml__1_fl_/`,
    requiredPhrases: ["\u0431\u0438\u0432\u0438\u0430\u0440\u0442 \u0441\u043e\u0444\u0442", "0 1", "10\u043c\u043b"]
  },
  {
    id: "193141",
    brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442",
    url: `${ORIGIN}/product/biviart_ultra_r_r_uvlazhn__oftalmolog__0_3_10ml__1_fl_/`,
    requiredPhrases: ["\u0431\u0438\u0432\u0438\u0430\u0440\u0442 \u0443\u043b\u044c\u0442\u0440\u0430", "0 3", "10\u043c\u043b"]
  },
  {
    id: "178185",
    brand: "\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d",
    url: `${ORIGIN}/product/okusalin_rastvor_dlya_promyvaniya_glaz_3_2ml_10/`,
    requiredPhrases: ["\u043e\u043a\u0443\u0441\u0430\u043b\u0438\u043d", "\u0440\u0430\u0441\u0442\u0432\u043e\u0440 \u0434\u043b\u044f \u043f\u0440\u043e\u043c\u044b\u0432\u0430\u043d\u0438\u044f \u0433\u043b\u0430\u0437", "3", "2\u043c\u043b", "no10"]
  },
  {
    id: "202806",
    brand: "\u041e\u0444\u0442\u0430\u0440\u0438\u043d\u0442",
    url: `${ORIGIN}/product/oftarint_kapli_glaznye_2mg_20mg_0_675mgml_10ml_fl_kap_/`,
    requiredPhrases: ["\u043e\u0444\u0442\u0430\u0440\u0438\u043d\u0442", "\u043a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435", "10\u043c\u043b"]
  },
  {
    id: "203245",
    brand: "\u0422\u0430\u0443\u0441\u0442\u0438\u043d",
    url: `${ORIGIN}/product/taurin__taustin__kapli_glaznye_4_10ml_solofarm/`,
    requiredPhrases: ["\u0442\u0430\u0443\u0441\u0442\u0438\u043d", "\u0441\u043e\u043b\u043e\u0444\u0430\u0440\u043c", "\u043a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435", "4", "10\u043c\u043b"]
  },
  {
    id: "211589",
    brand: "Хлорэтта",
    url: `${ORIGIN}/product/khloretta_tab__ppo_2mg_0_03mg__21/`,
    requiredPhrases: ["хлорэтта", "таблетки", "2мг 0 03мг", "no21"]
  },
  {
    id: "211590",
    brand: "Хлорэтта",
    url: `${ORIGIN}/product/khloretta_tab__ppo_2mg_0_03mg__21_3/`,
    requiredPhrases: ["хлорэтта", "таблетки", "2мг 0 03мг", "no63"]
  },
  ...[
    ["206090", "2_5", "2 5мг"],
    ["206091", "5", "5мг"],
    ["206092", "7_5", "7 5мг"],
    ["206093", "10", "10мг"],
    ["206094", "12_5", "12 5мг"],
    ["206095", "15", "15мг"]
  ].map(([id, slugDose, phraseDose]): ExactProduct => ({
    id: id!,
    brand: "Тирзетта",
    url: `${ORIGIN}/product/tirzetta_r_r_dpk_vved__${slugDose}mg_0_5ml__4_shpr__v_avtoinzhekt_/`,
    requiredPhrases: ["тирзетта", "раствор для подкожного введения", phraseDose!, "0 5мл", "no4"]
  })),
  {
    id: "207078",
    brand: "Седжаро",
    url: `${ORIGIN}/product/sedzharo_r_r_dpk_vved__2_5mgdoza_2_4ml__1_shpr__ruchk____igly__4_v_kompl_/`,
    requiredPhrases: ["седжаро", "раствор для подкожного введения", "2 5мг доза", "2 4мл", "no1", "4иглы"]
  },
  {
    id: "207079",
    brand: "Седжаро",
    url: `${ORIGIN}/product/sedzharo_r_r_dpk_vved__5mgdoza_2_4ml__1_shpr__ruchk____igly__4_v_kompl_/`,
    requiredPhrases: ["седжаро", "раствор для подкожного введения", "5мг доза", "2 4мл", "no1", "4иглы"]
  },
  {
    id: "203657",
    brand: "Бактоблис",
    url: `${ORIGIN}/product/baktoblis_plyus_tab__drassas___30_bsakhara_bad/`,
    requiredPhrases: ["бактоблис", "таблетки для рассасывания", "no30", "без сахара"]
  },
  {
    id: "197583",
    brand: "Бактоблис",
    url: `${ORIGIN}/product/baktoblis_plyus_tab__drassas__950mg__90_bad/`,
    requiredPhrases: ["бактоблис плюс", "таблетки для рассасывания", "no90"]
  },
  {
    id: "190233",
    brand: "Бактоблис",
    url: `${ORIGIN}/product/baktoblis_por__dpr__vnutr_1500mg__15_sashe_pak__bad/`,
    requiredPhrases: ["бактоблис", "порошок в саше пакетах", "no15"]
  },
  {
    id: "193661",
    brand: "Бактоблис",
    url: `${ORIGIN}/product/baktoblis_por__dpr__vnutr_1500mg__30_sashe_pak__bad/`,
    requiredPhrases: ["бактоблис", "порошок в саше пакетах", "no30"]
  },
  {
    id: "175303",
    brand: "Бактоблис",
    url: `${ORIGIN}/product/baktoblis_tabletki_bad_30/`,
    requiredPhrases: ["бактоблис плюс", "таблетки для рассасывания", "no30"]
  },
  {
    id: "196245",
    brand: "Энтеролактис",
    url: `${ORIGIN}/product/enterolaktis_plyus_kaps___15_bad/`,
    requiredPhrases: ["энтеролактис плюс", "капсулы", "no15"]
  },
  {
    id: "196246",
    brand: "Энтеролактис",
    url: `${ORIGIN}/product/enterolaktis_duo_por__5g__20_sashe_bad/`,
    requiredPhrases: ["энтеролактис дуо", "порошок", "no20"]
  },
  {
    id: "196244",
    brand: "Энтеролактис",
    url: `${ORIGIN}/product/enterolaktis_fibra_10ml__12fl__sirop_kaps_s_por_v_kr_fl__bad/`,
    requiredPhrases: ["энтеролактис фибра", "сироп", "10мл", "no12"]
  }
] as const;

const KAGOCEL_FAMILY: ExactFamily = {
  id: "tag-7419",
  tagId: "7419",
  brand: "Кагоцел",
  url: `${ORIGIN}/tag/kagotsel/`,
  variants: [
    { name: "Кагоцел таблетки 12мг, №30", url: `${ORIGIN}/product/kagotsel_tab__12mg__30/` },
    { name: "Кагоцел таблетки 12мг, №10", url: `${ORIGIN}/product/kagotsel_tab_12mg_10/` },
    { name: "Кагоцел таблетки 12мг, №20", url: `${ORIGIN}/product/kagotsel_tab__12mg__20/` },
    { name: "Кагоцел таблетки 12мг, №20,Ниармедик Фарма", url: `${ORIGIN}/product/kagotsel_tab_12mg_20/` }
  ]
};

const ANTIVIRAL_FAMILIES: readonly ExactFamily[] = [
  KAGOCEL_FAMILY,
  {
    id: "tag-6039",
    tagId: "6039",
    brand: "Трекрезан",
    url: `${ORIGIN}/tag/trekrezan/`,
    variants: [
      { name: "Трекрезан таблетки 200мг, №10 Канонфарма", url: `${ORIGIN}/product/trekrezan_tabletki_200mg_10_148246/` },
      { name: "Трекрезан таблетки 200мг, №10", url: `${ORIGIN}/product/trekrezan_tabletki_200mg_10/` },
      { name: "Трекрезан сироп 20мг/мл, 100мл", url: `${ORIGIN}/product/trekrezan_sirop_20mgml_100ml__1_fl_/` }
    ]
  },
  {
    id: "tag-754",
    tagId: "754",
    brand: "Гриппферон",
    url: `${ORIGIN}/tag/grippferon/`,
    variants: [
      { name: "Гриппферон капли назальные 10 000МЕ/мл, 10мл", url: `${ORIGIN}/product/grippferon_kapli_v_nos_10ml/` },
      { name: "Гриппферон спрей назальный дозированный 500МЕ/доза, 10мл", url: `${ORIGIN}/product/grippferon_sprey_nazal_10ml/` },
      { name: "Гриппферон мазь назальная с лоратадином 10 000МЕ/г+2мг/г, 5г", url: `${ORIGIN}/product/grippferon_s_loratadinom_maz_nazalnaya_5g/` }
    ]
  },
  {
    id: "tag-3282",
    tagId: "3282",
    brand: "Ингавирин",
    url: `${ORIGIN}/tag/ingavirin/`,
    variants: [
      { name: "Ингавирин капсулы 60мг, №10", url: `${ORIGIN}/product/ingavirin_kapsuly_60mg_10_175448/` },
      { name: "Ингавирин сироп 30мг/5мл, 90мл", url: `${ORIGIN}/product/ingavirin_sirop_30mg_5ml_90ml/` },
      { name: "Ингавирин капсулы 90мг, №10", url: `${ORIGIN}/product/ingavirin_kaps_90_mg_10/` },
      { name: "Ингавирин сироп 30мг/5мл, 50мл", url: `${ORIGIN}/product/ingavirin_sirop_30mg5ml_50ml/` }
    ]
  },
  {
    id: "tag-2382",
    tagId: "2382",
    brand: "Арбидол",
    url: `${ORIGIN}/tag/arbidol/`,
    variants: [
      { name: "Арбидол Максимум капсулы 200мг, №20", url: `${ORIGIN}/product/arbidol_maksimum_kaps__200mg__2/` },
      { name: "Арбидол таблетки покрыт. п/о 50мг, №20", url: `${ORIGIN}/product/arbidol_tab__po_50mg__20/` },
      { name: "Арбидол таблетки покрыт. п/о 50мг, №20 Фармстандарт", url: `${ORIGIN}/product/arbidol_tab_p_o_0_05g_20/` },
      { name: "Арбидол Максимум капсулы 200мг, №10 Фармстандарт", url: `${ORIGIN}/product/arbidol_maksimum_kaps_0_2g_10/` },
      { name: "Арбидол капсулы 100мг, №10", url: `${ORIGIN}/product/arbidol_kaps_0_1g_10/` },
      { name: "Арбидол капсулы 100мг, №20 Фармстандарт", url: `${ORIGIN}/product/arbidol_kaps_0_1g_20/` }
    ]
  }
];

const PRODUCTS_BY_ID = new Map(EXACT_PRODUCTS.map((product) => [product.id, product]));
const PRODUCTS_BY_BRAND = new Map<string, ExactProduct[]>();
for (const product of EXACT_PRODUCTS) {
  const key = normalizeText(product.brand);
  PRODUCTS_BY_BRAND.set(key, [...(PRODUCTS_BY_BRAND.get(key) ?? []), product]);
}
const FAMILIES_BY_ID = new Map(ANTIVIRAL_FAMILIES.map((family) => [family.id, family]));
const FAMILIES_BY_BRAND = new Map(ANTIVIRAL_FAMILIES.map((family) => [normalizeText(family.brand), family]));
const HEALTH_PRODUCT = PRODUCTS_BY_ID.get("178185")!;

function compactText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizedHost(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/^www\./u, "");
}

function isBlockedBody(body: string): boolean {
  const sample = body.slice(0, 250_000);
  return BLOCK_MARKERS.test(sample) || /<(?:iframe|input)\b[^>]*(?:captcha|challenge)/iu.test(sample);
}

function parseJsonAttribute(value: string | undefined, label: string, productId: string): unknown {
  if (!value || value.length > 100_000) {
    throw new ParserChangedError(`${DOMAIN}:${productId}: missing or oversized ${label} payload`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new ParserChangedError(`${DOMAIN}:${productId}: invalid ${label} JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeVitaIdentityText(value: string): string {
  // Vita currently abbreviates only the component-bound form name while the
  // exact H1 keeps the long spelling. Expand this one proven phrase locally;
  // every product ID, brand, modifier, dosage, pack and URL check remains strict.
  return normalizeText(value).replace(/(^| )д рассасывания(?= |$)/gu, "$1для рассасывания");
}

function matchesExactTitle(title: string, product: ExactProduct): boolean {
  if (!matchesBrand(title, product.brand)) return false;
  const normalized = ` ${normalizeVitaIdentityText(title)} `;
  return product.requiredPhrases.every((phrase) =>
    normalized.includes(` ${normalizeVitaIdentityText(phrase)} `)
  );
}

function explicitlyUnavailableReviewChannel($: CheerioAPI, product: ExactProduct): boolean {
  const headers = $("product-detail-header").filter((_index, node) => $(node).attr(":product") !== undefined);
  if (headers.length !== 1) return false;
  const payload = parseJsonAttribute(headers.first().attr(":product"), "product", product.id);
  if (!isRecord(payload)) return false;
  const expectedUrl = new URL(product.url);
  return String(payload.ID) === product.id && String(payload.XML_ID) === product.id &&
    payload.DETAIL_PAGE_URL === expectedUrl.pathname &&
    typeof payload.NAME === "string" && matchesExactTitle(payload.NAME, product) &&
    payload.APLAUT === 0 && (payload.SHOW_REVIEW === 0 || payload.SHOW_REVIEW === 1);
}

function productEvidence(product: ExactProduct, title: string): ProductEvidence {
  return {
    scope: "listing",
    signals: [
      { source: "title", text: title },
      { source: "url", text: product.url }
    ],
    variants: [],
    identifiers: [{ type: "product_id", value: product.id }],
    imageUrls: [],
    instructionUrls: []
  };
}

function hasJsonLdType(value: Record<string, unknown>, expected: string): boolean {
  const type = value["@type"];
  return type === expected || Array.isArray(type) && type.includes(expected);
}

function exactUrl(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  try { return new URL(value, ORIGIN).toString() === expected; }
  catch { return false; }
}

function parseExactFamilyPage(body: string, family: ExactFamily): ParsedFamilyPage {
  const $ = load(body);
  const titleNodes = $("h1");
  const title = compactText(titleNodes.first().text());
  if (titleNodes.length !== 1 || normalizeText(title) !== normalizeText(family.brand)) {
    throw new ParserChangedError(`${DOMAIN}:${family.id}: exact family title changed`);
  }

  const canonicalNodes = $("link[rel='canonical'][href]");
  if (canonicalNodes.length !== 1 || !exactUrl(canonicalNodes.first().attr("href"), family.url)) {
    throw new ParserChangedError(`${DOMAIN}:${family.id}: canonical family URL changed`);
  }

  const jsonLdRecords: Record<string, unknown>[] = [];
  for (const script of $("script[type='application/ld+json']").toArray()) {
    const raw = $(script).text().trim();
    if (!raw) continue;
    if (raw.length > 250_000) {
      throw new ParserChangedError(`${DOMAIN}:${family.id}: family JSON-LD is oversized`);
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new ParserChangedError(`${DOMAIN}:${family.id}: family JSON-LD is invalid`); }
    if (!isRecord(value)) continue;
    const graph = value["@graph"];
    if (Array.isArray(graph)) jsonLdRecords.push(...graph.filter(isRecord));
    else jsonLdRecords.push(value);
  }

  const collectionId = `${family.url}#collectionpage`;
  const itemListId = `${family.url}#itemlist`;
  const collections = jsonLdRecords.filter((item) =>
    hasJsonLdType(item, "CollectionPage") && item["@id"] === collectionId && exactUrl(item.url, family.url)
  );
  if (collections.length !== 1) {
    throw new ParserChangedError(`${DOMAIN}:${family.id}: exact family CollectionPage proof changed`);
  }
  const collection = collections[0];
  const about = collection.about;
  const mainEntity = collection.mainEntity;
  const aboutMatches = about === undefined ||
    isRecord(about) && hasJsonLdType(about, "Brand") && about.name === family.brand;
  if (collection.name !== family.brand || !aboutMatches ||
      !isRecord(mainEntity) || mainEntity["@id"] !== itemListId) {
    throw new ParserChangedError(`${DOMAIN}:${family.id}: CollectionPage is not bound to the exact brand family`);
  }

  const itemLists = jsonLdRecords.filter((item) =>
    hasJsonLdType(item, "ItemList") && item["@id"] === itemListId && exactUrl(item.url, family.url)
  );
  if (itemLists.length !== 1) {
    throw new ParserChangedError(`${DOMAIN}:${family.id}: exact family ItemList proof changed`);
  }
  const itemList = itemLists[0];
  const elements = itemList.itemListElement;
  if (itemList.name !== `Список товаров ${family.brand}` || itemList.numberOfItems !== family.variants.length ||
      !Array.isArray(elements) || elements.length !== family.variants.length) {
    throw new ParserChangedError(`${DOMAIN}:${family.id}: exact family variant count changed`);
  }

  const provenVariants = new Map<string, Record<string, unknown>>();
  const positions = new Set<number>();
  for (const element of elements) {
    if (!isRecord(element) || !hasJsonLdType(element, "ListItem") ||
        !Number.isInteger(element.position) || Number(element.position) < 1) {
      throw new ParserChangedError(`${DOMAIN}:${family.id}: family variant ListItem changed`);
    }
    const item = element.item;
    if (!isRecord(item) || !hasJsonLdType(item, "Product") || typeof item.url !== "string" ||
        provenVariants.has(item.url)) {
      throw new ParserChangedError(`${DOMAIN}:${family.id}: family variant Product proof changed`);
    }
    positions.add(Number(element.position));
    provenVariants.set(item.url, item);
  }
  if (positions.size !== family.variants.length ||
      [...positions].some((position) => position < 1 || position > family.variants.length)) {
    throw new ParserChangedError(`${DOMAIN}:${family.id}: family variant positions changed`);
  }
  for (const variant of family.variants) {
    const item = provenVariants.get(variant.url);
    const brand = item?.brand;
    const structuredBrand = isRecord(brand) && typeof brand.name === "string" && brand.name.trim()
      ? brand.name
      : undefined;
    const brandMatches = structuredBrand
      ? hasJsonLdType(brand as Record<string, unknown>, "Brand") && structuredBrand === family.brand
      : matchesBrand(String(item?.name ?? ""), family.brand);
    if (!item || item.name !== variant.name || item["@id"] !== `${variant.url}#product` ||
        !exactUrl(item.url, variant.url) || !brandMatches) {
      throw new ParserChangedError(`${DOMAIN}:${family.id}: exact family variant identity changed`);
    }
  }

  const reviewBlocks = $("#tag-reviews");
  const reviewBlock = reviewBlocks.first();
  const headings = reviewBlock.children("h2");
  const headingMatch = /^Отзывы\s*\((\d+)\)$/u.exec(compactText(headings.first().text()));
  const tagIds = reviewBlock.find("input[type='hidden'][name='tagId']");
  const reviewLists = reviewBlock.children(".tag-reviews");
  if (reviewBlocks.length !== 1 || headings.length !== 1 || !headingMatch ||
      tagIds.length !== 1 || tagIds.first().attr("value") !== family.tagId || reviewLists.length !== 1) {
    throw new ParserChangedError(`${DOMAIN}:${family.id}: source-bound family review block changed`);
  }

  const reviewCount = Number(headingMatch[1]);
  const reviewNodes = reviewLists.first().children(".tag-review");
  if (!Number.isSafeInteger(reviewCount) || reviewCount <= 0 || reviewNodes.length !== reviewCount ||
      reviewLists.first().children().length !== reviewNodes.length) {
    throw new ParserChangedError(`${DOMAIN}:${family.id}: family review count is incomplete`);
  }

  const starScores: number[] = [];
  for (const review of reviewNodes.toArray()) {
    const item = $(review);
    const names = item.children(".review-name");
    const dates = item.children(".review-date");
    const texts = item.children(".review-text");
    const starBlocks = item.children(".product__stars");
    if (names.length !== 1 || dates.length !== 1 || texts.length !== 1 || starBlocks.length !== 1 ||
        !compactText(names.text()) || !compactText(dates.text()) || !compactText(texts.text())) {
      throw new ParserChangedError(`${DOMAIN}:${family.id}: family review item is incomplete`);
    }
    const stars = starBlocks.first().children();
    if (stars.length !== 5 || starBlocks.first().find(".product__star").length !== stars.length) {
      throw new ParserChangedError(`${DOMAIN}:${family.id}: family review star score is incomplete`);
    }
    let filledStars = 0;
    for (const star of stars.toArray()) {
      const classes = compactText($(star).attr("class") ?? "").split(" ").filter(Boolean).sort();
      const signature = classes.join(" ");
      if (star.tagName !== "span" || !["product__star", "product__star star-old"].includes(signature)) {
        throw new ParserChangedError(`${DOMAIN}:${family.id}: unknown family review star markup`);
      }
      if (signature === "product__star star-old") filledStars += 1;
    }
    if (filledStars < 1 || filledStars > 5) {
      throw new ParserChangedError(`${DOMAIN}:${family.id}: family review star score is incomplete`);
    }
    starScores.push(filledStars);
  }

  const starTotal = starScores.reduce((sum, score) => sum + score, 0);
  return {
    canonicalUrl: family.url,
    title,
    productEvidence: {
      scope: "product_family",
      signals: [
        { source: "title", text: title },
        { source: "url", text: family.url },
        ...family.variants.map((variant) => ({ source: "variant" as const, text: variant.name }))
      ],
      variants: family.variants.map((variant) => variant.name),
      identifiers: [],
      imageUrls: [],
      instructionUrls: []
    },
    reviews: reviewCount,
    writtenReviewCount: reviewCount,
    rating: Math.round((starTotal / reviewCount) * 10) / 10,
    ratingCount: reviewCount,
    starScores,
    starTotal
  };
}

function parseExactPage(body: string, product: ExactProduct): ParsedPage {
  const $ = load(body);
  const titleNodes = $("h1");
  const title = compactText(titleNodes.first().text());
  if (titleNodes.length !== 1 || !title || !matchesExactTitle(title, product)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: exact product title changed`);
  }

  const canonicalNodes = $("link[rel='canonical'][href]");
  if (canonicalNodes.length !== 1) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: canonical URL is missing or duplicated`);
  }
  let canonical: URL;
  try { canonical = new URL(canonicalNodes.first().attr("href") ?? "", ORIGIN); }
  catch { throw new ParserChangedError(`${DOMAIN}:${product.id}: canonical URL is invalid`); }
  const expectedUrl = new URL(product.url);
  if (canonical.protocol !== "https:" || normalizedHost(canonical.hostname) !== DOMAIN ||
      canonical.pathname !== expectedUrl.pathname || canonical.search || canonical.hash) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: canonical URL belongs to another product`);
  }

  const pageRoots = $("#page-content[data-id]");
  const pageRoot = pageRoots.first();
  if (pageRoots.length !== 1 || pageRoot.attr("data-id") !== product.id ||
      pageRoot.attr("data-xml") !== product.id || pageRoot.attr("data-xml_id") !== product.id ||
      pageRoot.attr("data-url") !== expectedUrl.pathname ||
      !matchesExactTitle(pageRoot.attr("data-name") ?? "", product)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: first-party product identity changed`);
  }

  const reviewComponents = $("product-reviews");
  const reviews = reviewComponents.first();
  if (reviewComponents.length === 0 && explicitlyUnavailableReviewChannel($, product)) {
    const header = $("product-detail-header").first();
    const payload = parseJsonAttribute(header.attr(":product"), "product", product.id) as Record<string, unknown>;
    throw new AdapterBlockedError(
      `${DOMAIN}:${product.id}: review_channel_unavailable: exact product has APLAUT=0 and SHOW_REVIEW=${payload.SHOW_REVIEW}`
    );
  }
  if (reviewComponents.length !== 1 || reviews.attr(":id") !== product.id ||
      reviews.attr(":product-id") !== product.id ||
      !matchesExactTitle(reviews.attr("name") ?? "", product)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: product-bound review component changed`);
  }

  const reviewPayload = parseJsonAttribute(reviews.attr(":reviews"), "reviews", product.id);
  if (!isRecord(reviewPayload) || String(reviewPayload.productId) !== product.id ||
      reviewPayload.reviewList !== null && !Array.isArray(reviewPayload.reviewList)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: written-review list is not source-bound`);
  }

  const ratingPayload = parseJsonAttribute(reviews.attr(":rating"), "rating", product.id);
  if (!Array.isArray(ratingPayload) || ratingPayload.length !== 1 || !isRecord(ratingPayload[0])) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: rating-count payload changed`);
  }
  const aggregate = ratingPayload[0];
  const reviewsCount = Number(aggregate.reviewsCount);
  const rawRating = Number(aggregate.rating);
  if (String(aggregate.productId) !== product.id || aggregate.status !== true ||
      !Number.isInteger(reviewsCount) || reviewsCount < 0 ||
      !Number.isFinite(rawRating) || rawRating < 0 || rawRating > 5 ||
      (reviewsCount === 0) !== (rawRating === 0)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: source-bound review aggregate is invalid`);
  }

  const reviewText = normalizeText(reviews.text());
  const headings = reviews.find("h2");
  const headingText = compactText(headings.first().text());
  if (headings.length !== 1 || !normalizeText(headingText).startsWith("отзывы о товаре ") ||
      !matchesExactTitle(headingText, product)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: visible review heading is missing`);
  }
  const reviewList = reviewPayload.reviewList;
  if (reviewsCount === 0 && (reviewList !== null || !reviewText.includes(EMPTY_REVIEW_TEXT))) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: visible first-review empty state is missing`);
  }
  if (reviewsCount > 0 && (!Array.isArray(reviewList) || reviewList.length === 0 || reviewText.includes(EMPTY_REVIEW_TEXT))) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: positive written-review state is not proven`);
  }

  return {
    canonicalUrl: product.url,
    title,
    productEvidence: productEvidence(product, title),
    reviews: reviewsCount,
    writtenReviewCount: Array.isArray(reviewList) ? reviewList.length : 0,
    rating: reviewsCount === 0 ? null : rawRating,
    ratingCount: reviewsCount
  };
}

export class VitaExpressAdapter implements SiteAdapter {
  readonly id = DOMAIN;
  readonly supportedDomains = [DOMAIN, `www.${DOMAIN}`] as const;
  private readonly pageCache = new Map<string, Promise<FetchedPage>>();
  private readonly familyPageCache = new Map<string, Promise<FetchedFamilyPage>>();

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await this.fetchExact(HEALTH_PRODUCT, context);
      return { ok: true, checkedAt, message: `${DOMAIN}: exact product identity and visible empty-review state are healthy` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        checkedAt,
        message: error instanceof ParserChangedError ? `parser_changed: ${message}` : `blocked_free_mode: ${message}`
      };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const family = FAMILIES_BY_BRAND.get(normalizeText(brand));
    if (family) {
      const page = await this.fetchFamily(family, context);
      return [{
        domain: DOMAIN,
        platform: DOMAIN,
        listingId: family.id,
        brand,
        url: family.url,
        title: page.title,
        metadata: { discovery: "vitaexpress-bounded-exact-family-page", variantCount: family.variants.length }
      }];
    }

    const expected = PRODUCTS_BY_BRAND.get(normalizeText(brand));
    if (!expected) {
      throw new ParserChangedError(`${DOMAIN}: brand ${brand} is outside the bounded exact registry`);
    }

    const pages = await Promise.all(expected.map(async (product) => ({
      product,
      page: await this.fetchExact(product, context)
    })));
    return pages.map(({ product, page }): ProductRef => ({
      domain: DOMAIN,
      platform: DOMAIN,
      listingId: product.id,
      brand,
      url: product.url,
      title: page.title,
      metadata: { discovery: "vitaexpress-bounded-exact-product-page" }
    }));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const family = FAMILIES_BY_ID.get(ref.listingId);
    if (family) return this.collectFamily(ref, family, context);

    const product = PRODUCTS_BY_ID.get(ref.listingId);
    if (!product || normalizeText(product.brand) !== normalizeText(ref.brand) || ref.url !== product.url) {
      throw new ParserChangedError(`${DOMAIN}: product reference ${ref.listingId} is outside the bounded exact registry`);
    }

    const capturedAt = new Date().toISOString();
    const page = await this.fetchExact(product, context);
    const source = page.reviews === 0
      ? "vitaexpress-visible-first-review-empty-state"
      : "vitaexpress-source-bound-review-aggregate";
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: product.url,
      status: page.status,
      bodyDigest: createHash("sha256").update(page.body).digest("hex"),
      parsed: {
        listingId: product.id,
        title: page.title,
        canonicalUrl: page.canonicalUrl,
        reviews: page.reviews,
        writtenReviewCount: page.writtenReviewCount,
        rating: page.rating,
        ratingCount: page.ratingCount,
        countMeaning: "source-bound reviewsCount plus product-bound written-review component"
      },
      productEvidence: page.productEvidence,
      source
    });

    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId: product.id,
      brand: ref.brand,
      canonicalUrl: page.canonicalUrl,
      product: page.title,
      reviews: page.reviews,
      writtenReviewCount: page.writtenReviewCount,
      rating: page.rating,
      ratingCount: page.ratingCount,
      status: page.reviews === 0 ? "no_reviews" : "ok",
      capturedAt,
      evidenceRef,
      productEvidence: page.productEvidence,
      source
    };
  }

  private async collectFamily(ref: ProductRef, family: ExactFamily, context: AdapterContext): Promise<Observation> {
    if (normalizeText(ref.brand) !== normalizeText(family.brand) || ref.url !== family.url) {
      throw new ParserChangedError(`${DOMAIN}: family reference ${ref.listingId} is outside the bounded exact registry`);
    }
    const capturedAt = new Date().toISOString();
    const page = await this.fetchFamily(family, context);
    const source = "vitaexpress-source-bound-family-review-stars";
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: family.url,
      status: page.status,
      bodyDigest: createHash("sha256").update(page.body).digest("hex"),
      parsed: {
        listingId: family.id,
        tagId: family.tagId,
        title: page.title,
        canonicalUrl: page.canonicalUrl,
        variants: family.variants.map((variant) => ({ name: variant.name, url: variant.url })),
        reviews: page.reviews,
        writtenReviewCount: page.writtenReviewCount,
        rating: page.rating,
        ratingCount: page.ratingCount,
        starScores: page.starScores,
        starTotal: page.starTotal,
        countMeaning: "complete source-bound #tag-reviews items; rating computed from exact item stars"
      },
      productEvidence: page.productEvidence,
      source
    });
    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId: family.id,
      brand: ref.brand,
      canonicalUrl: page.canonicalUrl,
      product: page.title,
      reviews: page.reviews,
      writtenReviewCount: page.writtenReviewCount,
      rating: page.rating,
      ratingCount: page.ratingCount,
      status: "ok",
      capturedAt,
      evidenceRef,
      aggregateGroupId: `vitaexpress:family:${family.id}`,
      productEvidence: page.productEvidence,
      source
    };
  }

  private fetchExact(product: ExactProduct, context: AdapterContext): Promise<FetchedPage> {
    if (!context.runId) return this.loadExact(product, context);
    const key = `${context.runId}:${product.id}`;
    const cached = this.pageCache.get(key);
    if (cached) return cached;
    const pending = this.loadExact(product, context).catch((error) => {
      this.pageCache.delete(key);
      throw error;
    });
    this.pageCache.set(key, pending);
    return pending;
  }

  private fetchFamily(family: ExactFamily, context: AdapterContext): Promise<FetchedFamilyPage> {
    if (!context.runId) return this.loadFamily(family, context);
    const key = `${context.runId}:${family.id}`;
    const cached = this.familyPageCache.get(key);
    if (cached) return cached;
    const pending = this.loadFamily(family, context).catch((error) => {
      this.familyPageCache.delete(key);
      throw error;
    });
    this.familyPageCache.set(key, pending);
    return pending;
  }

  private async loadExact(product: ExactProduct, context: AdapterContext): Promise<FetchedPage> {
    let response: Response;
    try {
      response = await safeFetch(product.url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "ru-RU,ru;q=0.9",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
        },
        signal: context.signal
      }, context.fetch ?? this.fetchImpl);
    } catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}:${product.id}: request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let body: string;
    try { body = await readTextBounded(response, MAX_DOCUMENT_BYTES); }
    catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}:${product.id}: response could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (BLOCKED_STATUSES.has(response.status) || response.status >= 500 || isBlockedBody(body)) {
      throw new AdapterBlockedError(`${DOMAIN}:${product.id}: blocked response HTTP ${response.status}`);
    }
    if (response.status === 404 || response.status === 410) {
      throw new ParserChangedError(`${DOMAIN}:${product.id}: expected exact product page disappeared (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new AdapterBlockedError(`${DOMAIN}:${product.id}: unexpected HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
      throw new ParserChangedError(`${DOMAIN}:${product.id}: product page returned non-HTML content`);
    }

    return { ...parseExactPage(body, product), body, status: response.status };
  }

  private async loadFamily(family: ExactFamily, context: AdapterContext): Promise<FetchedFamilyPage> {
    let response!: Response;
    let body = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        response = await safeFetch(family.url, {
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "ru-RU,ru;q=0.9",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
          },
          signal: context.signal
        }, context.fetch ?? this.fetchImpl, 4, 20_000, {
          forwardSameDomainCookies: ["ngx_s_id", "PHPSESSID", "ChoosenCityForCart", "ChoosenCityForCartNewCity", "user_city_info", "user_city"]
        });
        body = await readTextBounded(response, MAX_DOCUMENT_BYTES);
      } catch (error) {
        const terminal = error instanceof AdapterQuotaError ||
          TERMINAL_RETRY_BODY.test(error instanceof Error ? error.message : String(error));
        const transient = TRANSIENT_TRANSPORT_ERROR.test(error instanceof Error ? error.message : String(error));
        if (attempt === 1 && !context.signal?.aborted && !terminal && transient &&
          !(error instanceof AdapterBlockedError) && !(error instanceof ParserChangedError)) {
          await delay(100 + Math.floor(Math.random() * 151));
          continue;
        }
        if (error instanceof AdapterQuotaError) throw error;
        throw new AdapterBlockedError(`${DOMAIN}:${family.id}: request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok && TERMINAL_RETRY_BODY.test(body.slice(0, 200_000))) {
        throw new AdapterQuotaError(`${DOMAIN}:${family.id}: provider quota is exhausted`);
      }
      const retryable = attempt === 1 && TRANSIENT_STATUSES.has(response.status) &&
        !isBlockedBody(body) && !TERMINAL_RETRY_BODY.test(body.slice(0, 200_000));
      if (!retryable) break;
      await delay(100 + Math.floor(Math.random() * 151));
      context.signal?.throwIfAborted();
    }

    if (BLOCKED_STATUSES.has(response.status) || response.status >= 500 || isBlockedBody(body)) {
      throw new AdapterBlockedError(`${DOMAIN}:${family.id}: blocked response HTTP ${response.status}`);
    }
    if (response.status === 404 || response.status === 410) {
      throw new ParserChangedError(`${DOMAIN}:${family.id}: expected exact family page disappeared (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new AdapterBlockedError(`${DOMAIN}:${family.id}: unexpected HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
      throw new ParserChangedError(`${DOMAIN}:${family.id}: family page returned non-HTML content`);
    }

    return { ...parseExactFamilyPage(body, family), body, status: response.status };
  }
}
