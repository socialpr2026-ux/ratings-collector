import { aliasesForBrand, normalizeText } from "./normalize.js";
import type { ProductEvidence, ProductIdentity } from "../../shared/types.js";

type ProductParts = {
  modifier?: string;
  form?: string;
  doses: string[];
  count?: number;
  multipack?: number;
  fallback?: string;
  generic: boolean;
  genericPage?: boolean;
  contentPage?: boolean;
  unknownModel?: boolean;
};

export type ProductNameInput = {
  brand: string;
  product: string;
  url?: string;
  evidence?: ProductEvidence;
  /** Reuse the run-time decision when a caller already calculated it. */
  productIdentity?: ProductIdentity;
};

const FORM_RULES: Array<{ value: string; pattern: RegExp }> = [
  { value: "суппозитории вагинальные и ректальные", pattern: /(?<![\p{L}\p{N}])(?:суппозитор(?:ии|иев)|свечи)[^,.]{0,30}вагинальн[^,.]{0,30}ректальн/iu },
  { value: "раствор для приема внутрь", pattern: /(?<![\p{L}\p{N}])(?:раствор(?:а|ом)?|р[.\s-]*р)[^,.;]{0,60}для\s+при[её]ма\s+внутрь(?![\p{L}\p{N}])/iu },
  { value: "раствор в ампулах", pattern: /(?<![\p{L}\p{N}])раствор[^,.]{0,70}(?:ампул(?:а|ы|ах)?|амп\.?)(?![\p{L}\p{N}])/iu },
  { value: "таблетки для рассасывания", pattern: /(?<![\p{L}\p{N}])(?:табл?\.?|таблет(?:ка|ки|ок)|пастил(?:ки|ок)|леденц(?:ы|ов))(?![\p{L}\p{N}])[^,.]{0,24}(?:для\s+рассасывания|д\s*\/?\s*рассас|рассасывающ)/iu },
  { value: "таблетки", pattern: /(?<![\p{L}\p{N}])(?:табл?\.?|таблет(?:ка|ки|ок|ку|кой))(?![\p{L}\p{N}])/iu },
  { value: "капсулы", pattern: /(?<![\p{L}\p{N}])(?:капс?\.?|капсул(?:а|ы|у|ой|ок)?)(?![\p{L}\p{N}])/iu },
  { value: "саше", pattern: /(?<![\p{L}\p{N}])(?:саше(?:[-\s]?пакет(?:ы|ов|а)?)?|пакетик(?:и|ов)?|стик(?:и|ов)?)(?![\p{L}\p{N}])/iu },
  { value: "порошок", pattern: /(?<![\p{L}\p{N}])(?:пор(?:ошок|ошка)?\.?)(?![\p{L}\p{N}])/iu },
  { value: "гранулы гомеопатические", pattern: /(?<![\p{L}\p{N}])гран(?:\.|ул(?:ы|а|ах)?)\s*гомеопатическ(?:ие|их|ими)?(?![\p{L}\p{N}])/iu },
  { value: "гранулы", pattern: /(?<![\p{L}\p{N}])гран(?:\.|ул(?:ы|а|ах)?)(?![\p{L}\p{N}])/iu },
  { value: "раствор", pattern: /(?<![\p{L}\p{N}])раствор(?:а|ом)?(?![\p{L}\p{N}])/iu },
  { value: "сироп", pattern: /(?<![\p{L}\p{N}])сироп(?:а|ом)?(?![\p{L}\p{N}])/iu },
  { value: "суспензия", pattern: /(?<![\p{L}\p{N}])суспензи(?:я|и|ю|ей)(?![\p{L}\p{N}])/iu },
  { value: "спрей", pattern: /(?<![\p{L}\p{N}])спре(?:й|я|ем)(?![\p{L}\p{N}])/iu },
  { value: "капли", pattern: /(?<![\p{L}\p{N}])кап(?:ли|ель)(?![\p{L}\p{N}])/iu },
  { value: "суппозитории", pattern: /(?<![\p{L}\p{N}])(?:суппозитори(?:и|ев|й)|свеч(?:и|ей))(?![\p{L}\p{N}])/iu },
  { value: "ампулы", pattern: /(?<![\p{L}\p{N}])ампул(?:а|ы|у|ах)?(?![\p{L}\p{N}])/iu },
  { value: "флаконы", pattern: /(?<![\p{L}\p{N}])(?:фл\.?|флакон(?:ы|ов|а)?)(?![\p{L}\p{N}])/iu },
  { value: "лиофилизат", pattern: /(?<![\p{L}\p{N}])лиоф(?:\.|ил(?:изат)?(?:а|ом)?)(?![\p{L}\p{N}])/iu },
  { value: "гель", pattern: /(?<![\p{L}\p{N}])гел(?:ь|я|ем)(?![\p{L}\p{N}])/iu },
  { value: "крем", pattern: /(?<![\p{L}\p{N}])крем(?:а|ом)?(?![\p{L}\p{N}])/iu },
  { value: "мазь", pattern: /(?<![\p{L}\p{N}])маз(?:ь|и|ью)(?![\p{L}\p{N}])/iu }
];

const COUNT_UNIT = "(?:шт(?:ук[аи]?)?\\.?|таб(?:л(?:ет(?:ок|ки|ка)?)?)?\\.?|капс(?:ул(?:а|ы|ок)?)?\\.?|саше(?:[-\\s]?пакет(?:ов|а|ы)?)?|пакет(?:ов|а|ы)?|пастил(?:ок|ки)?|ампул(?:а|ы)?|фл\\.?|флакон(?:ов|а|ы)?|свеч(?:ей|и)|суппозитори(?:ев|и)|доз(?:а|ы)?)";
const NUMBER = "(\\d{1,4})";

const MODIFIERS: Array<{ value: string; pattern: RegExp }> = [
  { value: "Максимум", pattern: /(?<![\p{L}\p{N}])максимум(?![\p{L}\p{N}])/iu },
  { value: "Плюс", pattern: /(?<![\p{L}\p{N}])плюс(?![\p{L}\p{N}])/iu },
  { value: "Дуо", pattern: /(?<![\p{L}\p{N}])дуо(?![\p{L}\p{N}])/iu },
  { value: "Форте", pattern: /(?<![\p{L}\p{N}])форте(?![\p{L}\p{N}])/iu },
  { value: "Экспресс", pattern: /(?<![\p{L}\p{N}])экспресс(?![\p{L}\p{N}])/iu },
  { value: "Лайт", pattern: /(?<![\p{L}\p{N}])лайт(?![\p{L}\p{N}])/iu },
  { value: "Интенс", pattern: /(?<![\p{L}\p{N}])интенс(?![\p{L}\p{N}])/iu },
  { value: "детский", pattern: /(?<![\p{L}\p{N}])(?:детск(?:ий|ая|ое)|для\s+детей)(?![\p{L}\p{N}])/iu },
  { value: "без сахара", pattern: /(?<![\p{L}\p{N}])(?:без\s+сахара|б\s*\/\s*сах)(?![\p{L}\p{N}])/iu },
  { value: "вкус клубники", pattern: /(?<![\p{L}\p{N}])(?:вкус\s+клубники|клубничн(?:ый|ая|ое))(?![\p{L}\p{N}])/iu },
  { value: "Нео", pattern: /(?<![\p{L}\p{N}])нео(?![\p{L}\p{N}])/iu },
  { value: "Кидс", pattern: /(?<![\p{L}\p{N}])кидс(?![\p{L}\p{N}])/iu },
  { value: "Иммуно", pattern: /(?<![\p{L}\p{N}])иммуно(?![\p{L}\p{N}])/iu },
  { value: "с лоратадином", pattern: /(?<![\p{L}\p{N}])с\s+лоратадином(?![\p{L}\p{N}])/iu },
  { value: "пролонгированные", pattern: /(?<![\p{L}\p{N}])(?:пролонгированн(?:ого|ые|ая|ый)|пролонг)(?![\p{L}\p{N}])/iu },
  { value: "кишечнорастворимые", pattern: /(?<![\p{L}\p{N}])кишечнорастворим(?:ые|ая|ый|ого)(?![\p{L}\p{N}])/iu },
  { value: "жевательные", pattern: /(?<![\p{L}\p{N}])жевательн(?:ые|ая|ый|ого)(?![\p{L}\p{N}])/iu },
  { value: "шипучие", pattern: /(?<![\p{L}\p{N}])шипуч(?:ие|ая|ий|его)(?![\p{L}\p{N}])/iu },
  { value: "диспергируемые", pattern: /(?<![\p{L}\p{N}])диспергируем(?:ые|ая|ый|ого)(?![\p{L}\p{N}])/iu }
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactRequestedBrand(value: string, brand: string): boolean {
  const requested = brand.normalize("NFKC").trim();
  if (!requested) return false;
  const flexible = escapeRegExp(requested)
    .replace(/[\s‐‑‒–—−-]+/g, "[\\s‐‑‒–—−-]*");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${flexible}(?=$|[^\\p{L}\\p{N}])`, "iu").test(value);
}

function removeForeignVendorAfterBrandMatch(value: string, brand: string): string {
  // SANOFI is a manufacturer token in source titles, not a Cogitum product
  // modifier. Never strip it from an unverified title: the exact requested
  // brand must be present in the same source-bound text first.
  if (!hasExactRequestedBrand(value, brand)) return value;
  return value.replace(/(?<![\p{L}\p{N}])SANOFI(?![\p{L}\p{N}])/giu, " ");
}

const LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
};

function latinize(value: string): string {
  return normalizeText(value).split("").map((character) => LATIN[character] ?? character).join("");
}

function latinizeKh(value: string): string {
  return normalizeText(value).split("").map((character) => character === "х" ? "kh" : LATIN[character] ?? character).join("");
}

function russianBrandForms(value: string): string[] {
  if (!/^[а-яё]+$/iu.test(value)) return [value];
  if (/[бвгджзклмнпрстфхцчшщ]$/iu.test(value)) return [value, `${value}а`];
  if (/й$/iu.test(value)) return [value, `${value.slice(0, -1)}я`];
  if (/ь$/iu.test(value)) return [value, `${value.slice(0, -1)}я`];
  return [value];
}

function removeBrand(value: string, brand: string): string {
  let result = value;
  const canonical = normalizeText(brand);
  const baseAliases = aliasesForBrand(brand)
    .filter((alias) => {
      const normalized = normalizeText(alias);
      // Keep a true product modifier such as "Максимум" when it is part of a
      // broad search alias ("Арбидол Максимум").
      return normalized === canonical || !normalized.startsWith(`${canonical} `);
    });
  const aliases = [...new Set(baseAliases.flatMap((alias) => [...russianBrandForms(alias), latinize(alias), latinizeKh(alias)]))]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const alias of aliases) {
    const flexible = escapeRegExp(alias.normalize("NFKC"))
      .replace(/[\s‐‑‒–—−-]+/g, "[\\s‐‑‒–—−-]*");
    result = result.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${flexible}(?=$|[^\\p{L}\\p{N}])`, "giu"), "$1");
  }
  return result;
}

function decimal(value: string): number {
  return Number(value.replace(",", "."));
}

function prettyNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4))).replace(".", ",");
}

function isAdministrationContext(value: string, index: number, length: number): boolean {
  const before = normalizeText(value.slice(Math.max(0, index - 60), index));
  const after = normalizeText(value.slice(index + length, Math.min(value.length, index + length + 60)));
  // "15 саше-пакетов по 1500 мг" describes pack composition, not a dosing
  // instruction. Keep this common pharmacy wording as product evidence.
  if (/(?:саше|пакет(?:ов|а)?|таблет(?:ок|ки)|капсул|флакон(?:ов|а)?|ампул(?:ы)?)\s+по$/u.test(before)) return false;
  return /(?:принимать|принимают|применять|назначают|рекомендуется|употреблять|по)$/u.test(before)
    || /^(?:по\s+)?\d+\s+раз(?:а)?\s+(?:в|за)\s+(?:день|сутки)/u.test(after)
    || /^раз(?:а)?\s+(?:в|за)\s+(?:день|сутки)/u.test(after)
    || /^(?:утром|вечером|ежедневно|в\s+сутки)/u.test(after);
}

function massInMg(value: string, unit: string): number | undefined {
  const number = decimal(value);
  if (!Number.isFinite(number)) return undefined;
  const normalized = unit.toLocaleLowerCase("ru-RU");
  if (normalized === "мкг" || normalized === "мкг.") return number / 1000;
  if (normalized === "мг" || normalized === "мг.") return number;
  if (normalized === "г" || normalized === "гр" || normalized === "г.") return number * 1000;
  return undefined;
}

function formatMass(mg: number): string {
  if (mg > 0 && mg < 1) return `${prettyNumber(mg * 1000)} мкг`;
  return `${prettyNumber(mg)} мг`;
}

function countFromText(value: string): number | undefined {
  const explicit = value.match(new RegExp(`(?:№|#|\\bN(?:o)?\\.?)(?:\\s*)${NUMBER}\\b`, "iu"));
  if (explicit) return Number(explicit[1]);
  const labelled = value.match(/(?:кол(?:ичество|-?во)(?:\s+в\s+упаковке)?|фасовка|комплектация)\s*[:—-]?\s*(\d{1,4})(?!\d)/iu);
  if (labelled) return Number(labelled[1]);
  const afterPattern = new RegExp(`(?<!\\d)${NUMBER}\\s*${COUNT_UNIT}(?![\\p{L}\\p{N}])`, "giu");
  let doseCount: number | undefined;
  for (const after of value.matchAll(afterPattern)) {
    if (isAdministrationContext(value, after.index ?? 0, after[0].length)) continue;
    // Marketplace titles often contain both the unit composition and the
    // package size: "1 доза, 30 шт".  A physical pack unit is the SKU count;
    // the dose count is only a fallback for titles such as "6 доз".
    if (/доз/iu.test(after[0])) {
      doseCount ??= Number(after[1]);
      continue;
    }
    return Number(after[1]);
  }
  if (doseCount !== undefined) return doseCount;
  const beforePattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:табл?\\.?|таблет(?:ка|ки)?|капс?\\.?|капсул(?:а|ы)?|саше|пастилки)\\s*${NUMBER}(?!\\d)(?!\\s*(?:мкг|мг|гр?|г|мл|%|ме))`, "giu");
  for (const before of value.matchAll(beforePattern)) {
    if (!isAdministrationContext(value, before.index ?? 0, before[0].length)) return Number(before[1]);
  }
  return undefined;
}

function formFromText(value: string): string | undefined {
  const found = FORM_RULES.filter((rule) => rule.pattern.test(value)).map((rule) => rule.value);
  if (found.includes("порошок") && found.includes("саше")) return "порошок в саше";
  if (found.includes("гранулы") && found.includes("саше")) return "гранулы в саше";
  return found[0];
}

function extractDoses(brand: string, value: string, form: string | undefined, count: number | undefined): string[] {
  const doses: string[] = [];
  for (const match of value.matchAll(/(\d+(?:[.,]\d+)?)\s*(мкг|мг|г|ме)\s*\/\s*(мл|г|доз(?:а|у)?)(?![\p{L}\p{N}])/giu)) {
    const numerator = match[2].toLocaleLowerCase("ru-RU") === "ме" ? "МЕ" : match[2].toLocaleLowerCase("ru-RU");
    const denominator = match[3].toLocaleLowerCase("ru-RU").startsWith("доз") ? "доза" : match[3].toLocaleLowerCase("ru-RU");
    doses.push(`${prettyNumber(decimal(match[1]))} ${numerator}/${denominator}`);
  }
  const massMatches = [...value.matchAll(/(\d+(?:[.,]\d+)?)\s*(мкг|мг|гр|г)\.?(?![\p{L}\p{N}])/giu)];
  for (const match of massMatches) {
    if (isAdministrationContext(value, match.index ?? 0, match[0].length)) continue;
    const after = value.slice((match.index ?? 0) + match[0].length);
    if (/^\s*\/\s*(?:мл|г|доз)/iu.test(after)) continue;
    let mg = massInMg(match[1], match[2]);
    if (mg === undefined) continue;
    const sourceUnit = match[2].replace(".", "").toLocaleLowerCase("ru-RU");
    const prefix = value.slice(Math.max(0, match.index! - 5), match.index).toLocaleLowerCase("ru-RU");
    const isPerUnit = /(?:по|\/|на)\s*$/.test(prefix);
    // Pharmacy listings sometimes state only the total powder mass for the
    // whole pack: "22,5 г, саше №15". Convert it to the per-sachet strength so
    // it matches "1500 мг, 15 саше" from another site.
    if (
      !isPerUnit && normalizeText(brand) === "бактоблис" && count === 15 &&
      form === "порошок в саше" && Math.abs(mg - 22_500) < 0.001
    ) {
      // Confirmed catalog equivalence for Бактоблис: 22.5 g is the total
      // weight of 15 sachets, each containing 1500 mg. Do not generalize this
      // conversion to unknown products where the stated mass may be per unit.
      mg = 1500;
    }
    if (sourceUnit === "г" || sourceUnit === "гр") {
      const grams = decimal(match[1]);
      const knownBaktoblisPack = normalizeText(brand) === "бактоблис" && count === 15 && form === "порошок в саше" && Math.abs(mg - 1500) < 0.001;
      doses.push(grams > 1 && !isPerUnit && !knownBaktoblisPack ? `${prettyNumber(grams)} г` : formatMass(mg));
    } else {
      doses.push(formatMass(mg));
    }
  }
  for (const match of value.matchAll(/(\d+(?:[.,]\d+)?)\s*(мл|%|ме|м\.\s*е\.)(?![\p{L}\p{N}])/giu)) {
    if (isAdministrationContext(value, match.index ?? 0, match[0].length)) continue;
    const unit = match[2].replace(/\s|\./g, "").toLocaleLowerCase("ru-RU");
    doses.push(`${prettyNumber(decimal(match[1]))} ${unit === "ме" ? "МЕ" : unit}`);
  }
  return [...new Set(doses)];
}

function normalizeKnownProductEquivalence(
  brand: string,
  value: string,
  parts: Pick<ProductParts, "form" | "doses" | "count">
): Pick<ProductParts, "form" | "doses"> {
  // Oscillococcinum's sellable tube dose is consistently catalogued as either
  // "1 dose", "1 g" or "1000 mg".  Normalize only when one of those values is
  // present on the current listing. A bare "granules No.12" remains bare: this
  // rule must not manufacture a strength from the brand name alone.
  if (normalizeText(brand) !== "оциллококцинум" || !parts.count) {
    return { form: parts.form, doses: parts.doses };
  }
  const explicitDose = /(?<![\p{L}\p{N}])1\s*(?:доз(?:а|ы|у)?|dose)(?![\p{L}\p{N}])/iu.test(value);
  const explicitOneGram = parts.doses.some((dose) => normalizeText(dose) === "1000 мг");
  if (!explicitDose && !explicitOneGram) return { form: parts.form, doses: parts.doses };

  return {
    form: !parts.form || parts.form === "гранулы" ? "гранулы" : parts.form,
    doses: ["1 г", ...parts.doses.filter((dose) => normalizeText(dose) !== "1000 мг")]
  };
}

/**
 * Descriptions on pharmacy sites mix the dosage form with therapeutic
 * classification.  "Гранулы" and "гранулы гомеопатические" are the same
 * physical dosage form, so the extra adjective must not create another
 * product.  Keep truly different forms (for example ordinary tablets and
 * lozenges) separate.
 */
function canonicalForm(form: string | undefined): string | undefined {
  return form === "гранулы гомеопатические" ? "гранулы" : form;
}

function cleanFallback(value: string): string {
  const cleaned = value
    .replace(/(?<![\p{L}\p{N}])(?:detail(?:\.aspx)?|index(?:\.html?))(?![\p{L}\p{N}])/giu, " ")
    .replace(/(?<![\p{L}\p{N}])(?:отзывы?|reviews?|цена|купить|инструкция(?:\s+по\s+применению)?|instruction|описание|аналоги|применение)(?![\p{L}\p{N}])/giu, " ")
    .replace(/(?<![\p{L}\p{N}])(?:лекарственн(?:ое|ый)\s+(?:средство|препарат)|ноотропн(?:ое|ый)\s+(?:средство|препарат))(?![\p{L}\p{N}])/giu, " ")
    .replace(/[|/\\,:;()\[\]{}]+/g, " ")
    .replace(/[‐‑‒–—−-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 3) return "Общая карточка отзывов";
  return cleaned[0].toLocaleUpperCase("ru-RU") + cleaned.slice(1);
}

function productHintFromUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const segments = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean);
    let slug = segments.at(-1) ?? "";
    if (/^(?:\d+|reviews?|otzyvy|detail(?:\.aspx)?|index(?:\.html?))$/iu.test(slug)) return "";
    slug = slug
      .replace(/\.html?$/iu, "")
      .replace(/^\d{3,}[-_]+/u, "")
      .replace(/--\d+$/u, "")
      .replace(/-\d{6,}$/u, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b(?:tab|tabl|tabletki)\b/giu, " таблетки ")
      .replace(/\b(?:kaps|kapsuly)\b/giu, " капсулы ")
      .replace(/\bporoshok\b/giu, " порошок ")
      .replace(/\bsashe(?: paket)?\b/giu, " саше ")
      .replace(/\bgranuly\b/giu, " гранулы ")
      .replace(/\b(?:d rassas|dlia rassasyvaniia)\b/giu, " для рассасывания ")
      .replace(/\b(?:plyus|plius)\b/giu, " плюс ")
      .replace(/\bdetyam\b/giu, " детский ")
      .replace(/\bs loratadinom\b/giu, " с лоратадином ")
      .replace(/\bsupp vag i rekt\b/giu, " суппозитории вагинальные и ректальные ")
      .replace(/\br r dlia v v vved vved i v m vved amp\b/giu, " раствор в ампулах ")
      .replace(/\bvkus klubniki\b/giu, " вкус клубники ")
      .replace(/(\d+(?:[.,]\d+)?)\s*mg\b/giu, "$1 мг ")
      .replace(/(\d+)\s*sht\b/giu, "$1 шт ")
      .replace(/\s+/g, " ")
      .trim();
    return slug;
  } catch {
    return "";
  }
}

function parseProduct(brand: string, rawProduct: string, url?: string): ProductParts {
  const withoutLegacyDraft = rawProduct
    .replace(/^\s*Вариант не определён\s*·\s*известно:\s*/iu, "")
    .replace(/^\s*Вариант не определён\s*$/iu, "");
  const normalized = (withoutLegacyDraft.trim() || brand)
    .normalize("NFKC")
    .replace(/[\t\r\n\u00a0\u202f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const sourceWithoutVendor = removeForeignVendorAfterBrandMatch(normalized, brand);
  const rawWithoutBrand = removeBrand(sourceWithoutVendor, brand);
  const hasStrongDetail = countFromText(rawWithoutBrand) !== undefined || /\d+(?:[.,]\d+)?\s*(?:мкг|мг|г|мл|ме|%)(?:\s*\/\s*(?:мл|г|доз(?:а|у)?))?/iu.test(rawWithoutBrand);
  const isFinalAggregateLabel = /^(?:Общая карточка|Линейка «)/iu.test(normalized);
  const withUrlHint = hasStrongDetail || isFinalAggregateLabel ? sourceWithoutVendor : `${sourceWithoutVendor} ${productHintFromUrl(url)}`.trim();
  const withoutStoredPrefix = withUrlHint.replace(/^(.{1,160}?)\s+[—–]\s+/, (full, prefix: string) =>
    normalizeText(prefix) === normalizeText(brand) ? "" : full
  );
  const withoutBrand = removeBrand(withoutStoredPrefix, brand)
    // "Ниармедик Плюс" is a company name seen in marketplace
    // titles, not a Кагоцел product line or sellable variant.
    .replace(/(?<![\p{L}\p{N}])ниармедик\s+плюс(?![\p{L}\p{N}])/giu, " ")
    .replace(/^[-—–,.:;\s]+|[-—–,.:;\s]+$/g, "")
    .trim();
  const count = countFromText(withoutBrand);
  const extractedForm = formFromText(withoutBrand);
  const extractedDoses = extractDoses(brand, withoutBrand, extractedForm, count);
  const equivalence = normalizeKnownProductEquivalence(brand, withoutBrand, {
    form: extractedForm,
    doses: extractedDoses,
    count
  });
  const form = equivalence.form;
  const doses = equivalence.doses;
  const multipackMatch = withoutBrand.match(/(?:[xх×]\s*|(?<![\p{L}\p{N}]))(\d+)\s*(?:уп(?:аковк)?\.?|упаков(?:ки|ок|ка))(?![\p{L}\p{N}])/iu);
  const multipack = multipackMatch ? Number(multipackMatch[1]) : undefined;
  const modifiers = MODIFIERS.filter((item) => item.pattern.test(withoutBrand))
    .map((item) => item.value)
    // "Плюс" can qualify a concrete dosage form, but by itself it does
    // not prove a product or a separate line.
    .filter((value) => value !== "Плюс" || Boolean(form || doses.length));
  const modifier = modifiers.length ? modifiers.join(" ") : undefined;
  const generic = !form && !count && doses.length === 0 && !modifier;
  const fallbackText = generic ? withoutBrand.replace(/^плюс(?:\s+отзывы?)?$/iu, "").trim() : withoutBrand;
  const genericPage = !fallbackText || /(?:отзыв|инструкц|цен[аы]|аналог|лекарственн|ноотропн|препарат|средство)/iu.test(fallbackText);
  const contentPage = /(?:пародонтолог|стать[яи]|книг[аи]|методическ|исследован|применение\s+.{0,100}\s+в\s+)/iu.test(withoutBrand);
  const unknownModel = /^\s*(?:модель\s*)?\d{5,}\s*$/iu.test(withoutBrand) || /^\s*модель\s+\d+/iu.test(withoutBrand);
  return {
    modifier,
    form,
    doses,
    count,
    multipack,
    fallback: generic
      ? unknownModel ? "Общая карточка бренда" : genericPage ? "Общая карточка отзывов" : cleanFallback(fallbackText)
      : undefined,
    generic,
    genericPage,
    contentPage,
    unknownModel
  };
}

function partsKey(parts: ProductParts): string {
  return [parts.modifier, canonicalForm(parts.form), parts.doses.join("+"), parts.count, parts.multipack].map((item) => item ?? "").join("|");
}

function specificity(parts: ProductParts): number {
  return Number(Boolean(parts.modifier)) + Number(Boolean(parts.form)) + parts.doses.length + Number(Boolean(parts.count)) + Number(Boolean(parts.multipack));
}

function render(parts: ProductParts): string {
  if (parts.generic) return parts.fallback ?? "Общая карточка отзывов";
  const chunks: string[] = [];
  if (parts.modifier) chunks.push(parts.modifier);
  const form = canonicalForm(parts.form);
  if (form) chunks.push(form);
  chunks.push(...parts.doses);
  if (parts.count) chunks.push(`№${parts.count}`);
  if (parts.multipack && parts.multipack > 1) chunks.push(`×${parts.multipack} упаковки`);
  return chunks.join(" ") || "Общая карточка бренда";
}

const LINE_NAMES = ["Максимум", "Дуо", "Форте", "Экспресс", "Лайт", "Интенс", "Нео", "Кидс", "Иммуно"];
const PACK_MEASURE_FORMS = new Set(["порошок", "гранулы", "раствор", "сироп", "суспензия", "спрей", "капли", "гель", "крем", "мазь", "лиофилизат"]);

function lineName(parts: ProductParts): string | undefined {
  return LINE_NAMES.find((name) => parts.modifier?.split(/\s+/u).includes(name));
}

function hasPackMeasure(parts: ProductParts): boolean {
  return Boolean(parts.form && PACK_MEASURE_FORMS.has(parts.form) && parts.doses.some((dose) => /\s(?:мл|г)$/u.test(dose)));
}

function missingFields(parts: ProductParts): ProductIdentity["missing"] {
  const missing: ProductIdentity["missing"] = [];
  if (!parts.form) missing.push("form");
  const hasPack = Boolean(parts.count || parts.multipack || hasPackMeasure(parts));
  if (!hasPack) missing.push("pack");
  // A dosage is useful, but it is not mandatory when the page proves both the
  // pharmaceutical form and the package size. "таблетки №20" is already a
  // stable, human product label and must not be presented as a draft.
  if (!parts.form && !parts.doses.length && !parts.modifier) missing.push("strength_or_detail");
  return missing;
}

function isExactVariant(parts: ProductParts): boolean {
  const hasPack = Boolean(parts.count || parts.multipack || hasPackMeasure(parts));
  const concentratedOralSolution = parts.form === "раствор для приема внутрь"
    && parts.doses.some((dose) => /\/мл$/u.test(dose));
  // Either the pharmaceutical form or a concrete strength/detail together
  // with a pack is enough to identify a human product.  Thus both
  // "таблетки №20" and "100 мг №10" are publishable, while a bare
  // "таблетки"/"капсулы" remains a review-only aggregate. A source-bound
  // oral solution plus its concentration also identifies the reviewed product
  // even when that review page does not publish the bottle size.
  return !parts.generic && (hasPack && Boolean(parts.form || parts.doses.length) || concentratedOralSolution);
}

function setIsSubset(left: readonly string[], right: readonly string[]): boolean {
  const normalizedRight = new Set(right.map(normalizeText));
  return left.every((value) => normalizedRight.has(normalizeText(value)));
}

function partsCompatible(left: ProductParts, right: ProductParts): boolean {
  if (left.form && right.form && canonicalForm(left.form) !== canonicalForm(right.form)) return false;
  if (left.count && right.count && left.count !== right.count) return false;
  if (left.multipack && right.multipack && left.multipack !== right.multipack) return false;
  if (left.modifier && right.modifier) {
    const leftModifiers = left.modifier.split(/\s+/u);
    const rightModifiers = right.modifier.split(/\s+/u);
    if (!setIsSubset(leftModifiers, rightModifiers) && !setIsSubset(rightModifiers, leftModifiers)) return false;
  }
  if (left.doses.length && right.doses.length && !setIsSubset(left.doses, right.doses) && !setIsSubset(right.doses, left.doses)) return false;
  return true;
}

function partsSubsumes(richer: ProductParts, poorer: ProductParts): boolean {
  if (!partsCompatible(richer, poorer)) return false;
  if (poorer.form && canonicalForm(richer.form) !== canonicalForm(poorer.form)) return false;
  if (poorer.count && richer.count !== poorer.count) return false;
  if (poorer.multipack && richer.multipack !== poorer.multipack) return false;
  if (poorer.modifier && (!richer.modifier || !setIsSubset(poorer.modifier.split(/\s+/u), richer.modifier.split(/\s+/u)))) return false;
  if (!setIsSubset(poorer.doses, richer.doses)) return false;
  return specificity(richer) >= specificity(poorer);
}

function collapseDominatedVariants(values: readonly ProductParts[]): ProductParts[] {
  const result: ProductParts[] = [];
  for (const candidate of values) {
    if (result.some((existing) => partsSubsumes(existing, candidate))) continue;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (partsSubsumes(candidate, result[index])) result.splice(index, 1);
    }
    result.push(candidate);
  }
  return result;
}

function uniqueParsedCandidates(item: ProductNameInput): ProductParts[] {
  const strongTexts = [
    item.product,
    ...(item.evidence?.variants ?? []),
    ...(item.evidence?.signals.filter((signal) => ["title", "json_ld", "variant"].includes(signal.source)).map((signal) => signal.text) ?? [])
  ];
  const fallbackTexts = item.evidence?.signals
    .filter((signal) => signal.source === "description" || signal.source === "instruction" || signal.source === "image_alt")
    .map((signal) => signal.text) ?? [];
  const byKey = new Map<string, ProductParts>();
  for (const [index, text] of strongTexts.entries()) {
    const parsed = parseProduct(item.brand, text, index === 0 ? item.url : undefined);
    const key = partsKey(parsed);
    const previous = byKey.get(key);
    if (!previous || specificity(parsed) > specificity(previous)) byKey.set(key, parsed);
  }
  const strongExact = [...byKey.values()].filter(isExactVariant);
  for (const text of fallbackTexts) {
    const parsed = parseProduct(item.brand, text);
    // Instruction text and image metadata are valuable fallbacks, but must not
    // overturn a concrete title/JSON-LD/variant with incompatible attributes.
    if (isExactVariant(parsed) && strongExact.length) {
      if (!strongExact.every((candidate) => partsCompatible(candidate, parsed))) continue;
      // A listing title/JSON-LD/variant already proves an exact sellable item.
      // Descriptions and instructions may contain ingredient concentrations,
      // administration doses and neighbouring packs.  They can corroborate
      // the exact item, but must not enrich it into a second artificial SKU.
      if (!strongExact.some((candidate) => partsSubsumes(candidate, parsed))) continue;
    }
    const key = partsKey(parsed);
    const previous = byKey.get(key);
    if (!previous || specificity(parsed) > specificity(previous)) byKey.set(key, parsed);
  }
  return [...byKey.values()];
}

function variantWord(count: number): string {
  const modulo100 = count % 100;
  if (modulo100 >= 11 && modulo100 <= 14) return "вариантов";
  const modulo10 = count % 10;
  if (modulo10 === 1) return "вариант";
  if (modulo10 >= 2 && modulo10 <= 4) return "варианта";
  return "вариантов";
}

const CONSUMER_PRODUCT_NOUN = /(?<!\p{L})(?:погремушк\p{L}*|бутылочк\p{L}*|клеенк\p{L}*|накладк\p{L}*|насадк\p{L}*|трусик\p{L}*|пустышк\p{L}*|ниблер\p{L}*|молокоотсос\p{L}*|соск\p{L}*|поильник\p{L}*|игрушк\p{L}*|щетк\p{L}*|контейнер\p{L}*|термометр\p{L}*|прорезывател\p{L}*)(?!\p{L})/iu;

function consumerProductIdentity(item: ProductNameInput): ProductIdentity | undefined {
  const evidence = item.evidence;
  if (evidence?.scope !== "product_family") return undefined;
  const stableProduct = evidence.identifiers.some((identifier) =>
    identifier.type === "product_id" && identifier.value.trim().length > 0
  );
  if (!stableProduct) return undefined;
  const sourceTitle = evidence.signals.find((signal) => signal.source === "title")?.text ?? item.product;
  const withoutBrand = removeBrand(sourceTitle, item.brand)
    .replace(/^\s*[-–—,:;|]+\s*/u, "")
    .replace(/\s+в\s+[А-ЯЁ][\p{L}-]+(?:\s+[А-ЯЁ][\p{L}-]+)?\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!withoutBrand || normalizeText(withoutBrand) === normalizeText(sourceTitle) || !CONSUMER_PRODUCT_NOUN.test(withoutBrand)) {
    return undefined;
  }
  return {
    label: withoutBrand,
    granularity: "variant",
    confidence: "exact",
    missing: [],
    reasons: ["Отдельная товарная страница и стабильный ID подтверждают потребительский вариант"]
  };
}

function unresolvedIdentity(parts: ProductParts, reason: string): ProductIdentity {
  const line = lineName(parts);
  const known = parts.generic ? undefined : render(parts);
  const fallback = parts.fallback && !/^(?:Общая карточка (?:бренда|отзывов)|Уточнение не указано)$/u.test(parts.fallback)
    ? parts.fallback
    : undefined;
  return {
    label: line && !parts.form
      ? `Общая карточка линейки «${line}»`
      : parts.modifier && !parts.form && !parts.count && parts.doses.length === 0
        ? `Общая карточка серии «${parts.modifier}»`
        : parts.modifier && parts.form && !parts.count && !parts.multipack && !hasPackMeasure(parts)
          ? `Общая карточка: ${render(parts)}`
      : parts.form && !parts.count && !parts.multipack && !hasPackMeasure(parts) && parts.doses.length === 0
        ? `Общая карточка формы «${parts.form}»`
        : known ?? fallback ?? "Общая карточка бренда",
    granularity: line && !parts.form ? "line" : "unresolved",
    confidence: "partial",
    missing: missingFields(parts),
    reasons: [reason]
  };
}

export function analyzeProductIdentity(item: ProductNameInput): ProductIdentity {
  const candidates = uniqueParsedCandidates(item);
  const primary = candidates[0] ?? parseProduct(item.brand, item.product, item.url);
  const evidenceVariants = item.evidence?.variants ?? [];
  const aggregateScope = item.evidence?.scope === "product_family";

  if (aggregateScope) {
    const variantGroups = new Map<string, ProductParts>();
    for (const text of evidenceVariants) {
      const parts = parseProduct(item.brand, text);
      if (parts.generic) continue;
      const baseKey = [parts.modifier, canonicalForm(parts.form), [...parts.doses].sort().join("+"), parts.count, parts.multipack].map((value) => value ?? "").join("|");
      const previous = variantGroups.get(baseKey);
      if (!previous || specificity(parts) > specificity(previous)) variantGroups.set(baseKey, parts);
    }
    // A review site may mark every page as an aggregate because one rating is
    // shared by all reviews on that page.  That does not make a page such as
    // "Оциллококцинум гранулы 30 доз" a brand aggregate: the page itself still
    // proves one sellable variant.  Preserve a single unambiguous exact variant
    // and use family/line only when several variants are actually evidenced.
    const consumerProduct = consumerProductIdentity(item);
    if (consumerProduct) return consumerProduct;
    const exactPageVariants = collapseDominatedVariants(candidates.filter(isExactVariant));
    if (exactPageVariants.length === 1 && variantGroups.size <= 1) {
      const resolved = exactPageVariants[0];
      return { label: render(resolved), granularity: "variant", confidence: "exact", missing: [], reasons: [] };
    }
    if (variantGroups.size === 0 && evidenceVariants.length === 0) {
      const line = lineName(primary);
      return {
        label: line ? `Общий рейтинг линейки «${line}»` : "Общий рейтинг бренда",
        granularity: line ? "line" : "family",
        confidence: "partial",
        missing: [],
        reasons: ["Площадка публикует единый рейтинг без списка товарных вариантов"]
      };
    }
    const count = variantGroups.size || evidenceVariants.length;
    const line = lineName(primary);
    const humanVariants = [...variantGroups.values()].map(render);
    const visibleVariants = humanVariants.slice(0, 3);
    const hiddenVariantCount = Math.max(0, humanVariants.length - visibleVariants.length);
    const variantDetails = visibleVariants.length
      ? `${visibleVariants.join("; ")}${hiddenVariantCount ? `; ещё ${hiddenVariantCount}` : ""}`
      : `${count} ${variantWord(count)}`;
    return {
      label: line ? `Общий рейтинг линейки «${line}»: ${variantDetails}` : `Общий рейтинг: ${variantDetails}`,
      granularity: line ? "line" : "family",
      confidence: evidenceVariants.length ? "exact" : "partial",
      missing: [],
      reasons: ["Площадка показывает один общий рейтинг для нескольких товарных вариантов"],
      variantCount: count
    };
  }

  // Preserve already published aggregate labels byte-for-byte when rebuilding
  // monthly history. Fresh page evidence above still takes precedence.
  const storedLine = item.product.trim().match(/^Общая карточка линейки «([^»]+)»(?:\s*\((\d+)\s+вариант(?:а|ов)?\))?$/iu);
  if (storedLine) {
    const variantCount = storedLine[2] ? Number(storedLine[2]) : undefined;
    if (normalizeText(storedLine[1]) === "плюс") {
      return {
        label: `Общая карточка бренда${variantCount ? ` (${variantCount} ${variantWord(variantCount)})` : ""}`,
        granularity: "family", confidence: variantCount ? "exact" : "partial",
        missing: [], reasons: ["Метка «Плюс» не считается отдельной товарной линейкой"], variantCount
      };
    }
    return {
      label: item.product.trim(), granularity: "line", confidence: variantCount ? "exact" : "partial",
      missing: [], reasons: ["Сохранённая общая карточка линейки"], variantCount
    };
  }
  const storedFamily = item.product.trim().match(/^Общая карточка бренда(?:\s*\((\d+)\s+вариант(?:а|ов)?\))?$/iu);
  if (storedFamily) {
    const variantCount = storedFamily[1] ? Number(storedFamily[1]) : undefined;
    return {
      label: item.product.trim(), granularity: "family", confidence: variantCount ? "exact" : "partial",
      missing: [], reasons: ["Сохранённая общая карточка бренда"], variantCount
    };
  }

  if (candidates.some((candidate) => candidate.contentPage) && !candidates.some(isExactVariant)) {
    return {
      label: "Не товарная карточка",
      granularity: "not_product",
      confidence: "exact",
      missing: [],
      reasons: ["Страница похожа на статью, исследование или материал о применении, а не на карточку товара"]
    };
  }

  const exact = collapseDominatedVariants(candidates.filter(isExactVariant));
  const exactByKey = new Map(exact.map((parts) => [partsKey(parts), parts]));
  if (exactByKey.size > 1) {
    return {
      label: `Общая карточка нескольких вариантов (${exactByKey.size} ${variantWord(exactByKey.size)})`,
      granularity: "unresolved",
      confidence: "ambiguous",
      missing: [],
      reasons: ["На странице найдены противоречащие друг другу форма, дозировка или упаковка"]
    };
  }
  if (exactByKey.size === 1) {
    const resolved = [...exactByKey.values()][0];
    return { label: render(resolved), granularity: "variant", confidence: "exact", missing: [], reasons: [] };
  }

  const best = [...candidates].sort((left, right) => specificity(right) - specificity(left))[0] ?? primary;
  if (best.genericPage) {
    return {
      label: "Общая карточка бренда",
      granularity: "family",
      confidence: "partial",
      missing: [],
      reasons: ["Страница содержит общий рейтинг бренда без доказанного товарного варианта"]
    };
  }
  if (best.unknownModel) return unresolvedIdentity(best, "Площадка не раскрыла характеристики модели");
  return unresolvedIdentity(best, "Не хватает формы, дозировки/уточнения или упаковки для точного варианта");
}

/**
 * Produces a stable, brand-free human label. It never fills missing product
 * attributes from neighbouring listings: incomplete evidence remains explicit.
 */
export function canonicalProductDescriptors(items: readonly ProductNameInput[]): string[] {
  return canonicalProductVariants(items).map((item) => item.label);
}

export type CanonicalProductVariant = {
  label: string;
  /** Stable semantic key. Platform listing IDs remain the row identity. */
  variantKey?: string;
};

function exactParts(item: ProductNameInput): ProductParts | undefined {
  const candidates = uniqueParsedCandidates(item);
  if (item.productIdentity?.granularity === "variant") {
    candidates.push(parseProduct(item.brand, item.productIdentity.label));
  }
  const exact = collapseDominatedVariants(candidates.filter(isExactVariant));
  return exact.length === 1 ? exact[0] : undefined;
}

function variantCoreKey(brand: string, parts: ProductParts): string {
  return [
    normalizeText(brand),
    normalizeText(parts.modifier ?? ""),
    normalizeText(canonicalForm(parts.form) ?? ""),
    parts.count ?? "",
    parts.multipack ?? ""
  ].join("|");
}

function doseKey(parts: ProductParts): string {
  return [...parts.doses].map(normalizeText).sort().join("+");
}

/**
 * Reconciles equivalent variants across sites without borrowing attributes
 * from neighbouring products.  If the same brand/form/pack is observed both
 * with and without one non-conflicting strength, the shorter proven wording is
 * canonical for both rows.  Conflicting strengths are always kept separate.
 */
export function canonicalProductVariants(items: readonly ProductNameInput[]): CanonicalProductVariant[] {
  const identities = items.map((item) => item.productIdentity ?? analyzeProductIdentity(item));
  const parsed = items.map((item, index) => identities[index].granularity === "variant" ? exactParts(item) : undefined);
  const groups = new Map<string, number[]>();

  parsed.forEach((parts, index) => {
    if (!parts) return;
    const key = variantCoreKey(items[index].brand, parts);
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });

  const result = identities.map((identity): CanonicalProductVariant => ({ label: identity.label }));
  for (const [coreKey, indices] of groups) {
    const doseKeys = new Set(indices.map((index) => doseKey(parsed[index]!)).filter(Boolean));
    const hasShortEquivalent = indices.some((index) => parsed[index]!.doses.length === 0);
    const omitNonDiscriminatingDose = hasShortEquivalent && doseKeys.size <= 1;

    for (const index of indices) {
      const parts = parsed[index]!;
      const canonicalParts: ProductParts = {
        ...parts,
        form: canonicalForm(parts.form),
        doses: omitNonDiscriminatingDose ? [] : parts.doses
      };
      const canonicalDose = doseKey(canonicalParts);
      result[index] = {
        label: render(canonicalParts),
        variantKey: canonicalDose ? `${coreKey}|${canonicalDose}` : coreKey
      };
    }
  }
  return result;
}

export function canonicalProductDescriptor(brand: string, product: string): string {
  return canonicalProductDescriptors([{ brand, product }])[0];
}
