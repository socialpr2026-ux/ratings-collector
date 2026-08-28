import { Parser } from "htmlparser2";

const SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";
const MODEL_SITEMAP_PATH = /^\/ugcpub\/sitemap_model_(\d+)-(\d+)-\d+\.xml$/iu;
const MODEL_PRODUCT_PATH = /^\/product\/(?:[a-z0-9][a-z0-9_-]*)?--([1-9]\d*)$/iu;
const MODEL_PRODUCT_URL = /^https:\/\/reviews\.yandex\.ru\/product\/(?:[a-z0-9][a-z0-9_-]*)?--([1-9]\d*)$/iu;
const INVALID_XML_10_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;

export type YandexModelSitemapFailureReason =
  | "is incomplete"
  | "contains an invalid URL"
  | "contains an unknown product route"
  | "contains a cross-range product";

export type YandexModelSitemapProof =
  | { ok: true; locations: number }
  | { ok: false; reason: YandexModelSitemapFailureReason };

/**
 * Proves the complete, source-bound XML shape of one Yandex model shard
 * without building a DOM. Unknown wrappers/elements, duplicate URLs,
 * malformed nesting and cross-range model IDs all fail closed. An exact empty
 * <urlset> remains a valid proof of an empty shard.
 */
export function proveCompleteYandexModelSitemap(xml: string, sitemap: string): YandexModelSitemapProof {
  let requested: URL;
  try { requested = new URL(sitemap); }
  catch { return { ok: false, reason: "is incomplete" }; }
  const range = requested.pathname.match(MODEL_SITEMAP_PATH);
  if (requested.protocol !== "https:" || requested.hostname !== "reviews.yandex.ru" || requested.port ||
    requested.username || requested.password || requested.search || requested.hash || !range) {
    return { ok: false, reason: "is incomplete" };
  }
  if (![range[1], range[2]].every((value) => /^(?:0|[1-9]\d*)$/u.test(value ?? ""))) {
    return { ok: false, reason: "is incomplete" };
  }
  const minimumId = BigInt(range[1]!);
  const maximumId = BigInt(range[2]!);
  if (minimumId > maximumId) return { ok: false, reason: "is incomplete" };
  if (!hasStrictYandexUrlsetXmlShape(xml)) return { ok: false, reason: "is incomplete" };
  const stack: string[] = [];
  const seenLocations = new Set<string>();
  let rootSeen = false;
  let rootClosed = false;
  let currentLocation = "";
  let currentUrlHasLocation = false;
  let reason: YandexModelSitemapFailureReason | undefined;

  const fail = (value: YandexModelSitemapFailureReason) => { reason ??= value; };
  const parser = new Parser({
    onprocessinginstruction(name) {
      if (reason) return;
      if (rootSeen || name.toLocaleLowerCase("en-US") !== "?xml") fail("is incomplete");
    },
    onopentag(name, attributes) {
      if (reason) return;
      if (rootClosed) return fail("is incomplete");
      const parent = stack.at(-1);
      if (!parent) {
        if (rootSeen || name !== "urlset" || attributes.xmlns !== SITEMAP_NAMESPACE ||
          Object.keys(attributes).some((key) => key !== "xmlns" && !key.startsWith("xmlns:"))) {
          return fail("is incomplete");
        }
        rootSeen = true;
      } else if (parent === "urlset") {
        if (name !== "url" || Object.keys(attributes).length > 0) return fail("is incomplete");
        currentUrlHasLocation = false;
      } else if (parent === "url") {
        if (!["loc", "lastmod", "changefreq", "priority"].includes(name) || Object.keys(attributes).length > 0) {
          return fail("is incomplete");
        }
        if (name === "loc") {
          if (currentUrlHasLocation) return fail("is incomplete");
          currentLocation = "";
          currentUrlHasLocation = true;
        }
      } else {
        return fail("is incomplete");
      }
      stack.push(name);
    },
    ontext(value) {
      if (reason) return;
      if (stack.at(-1) === "loc") currentLocation += value;
      else if (!stack.at(-1) || stack.at(-1) === "urlset" || stack.at(-1) === "url") {
        if (value.trim()) fail("is incomplete");
      }
    },
    onclosetag(name, isImplied) {
      if (reason) return;
      if (isImplied) return fail("is incomplete");
      if (stack.at(-1) !== name) return fail("is incomplete");
      if (name === "loc") {
        const location = currentLocation.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
        if (/[ \t\r\n]/u.test(location)) return fail("contains an invalid URL");
        let product: URL;
        try { product = new URL(location); }
        catch { return fail("contains an invalid URL"); }
        const modelId = location.match(MODEL_PRODUCT_URL)?.[1];
        if (product.toString() !== location || product.protocol !== "https:" ||
          product.hostname !== "reviews.yandex.ru" || product.port ||
          product.username || product.password || product.search || product.hash || !modelId ||
          product.pathname.match(MODEL_PRODUCT_PATH)?.[1] !== modelId) {
          return fail("contains an unknown product route");
        }
        const numericId = BigInt(modelId);
        if (numericId < minimumId || numericId > maximumId) return fail("contains a cross-range product");
        if (seenLocations.has(location)) return fail("is incomplete");
        seenLocations.add(location);
      } else if (name === "url" && !currentUrlHasLocation) {
        return fail("is incomplete");
      }
      stack.pop();
      if (name === "urlset") rootClosed = true;
    },
    onerror() { fail("is incomplete"); }
  }, { xmlMode: true, decodeEntities: true });
  try { parser.end(xml); }
  catch { fail("is incomplete"); }
  if (reason || !rootSeen || !rootClosed || stack.length > 0) return { ok: false, reason: reason ?? "is incomplete" };
  return { ok: true, locations: seenLocations.size };
}

type StrictXmlAttribute = { name: string; value: string };
type StrictXmlOpeningTag = { name: string; attributes: StrictXmlAttribute[]; selfClosing: boolean };

/**
 * htmlparser2 deliberately recovers malformed input, even in xmlMode. That is
 * useful for scraping pages but unsafe for an exhaustive sitemap proof: an
 * ignored close tag or an implied close could make a truncated shard look
 * complete. This small lexical layer accepts only the exact sitemap grammar
 * before htmlparser2 is allowed to decode and validate product locations.
 */
function hasStrictYandexUrlsetXmlShape(xml: string): boolean {
  if (INVALID_XML_10_CHARACTER.test(xml)) return false;
  let cursor = xml.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let declarationSeen = false;
  let preambleMarkupSeen = false;
  let rootSeen = false;
  let rootClosed = false;
  const stack: string[] = [];
  let currentUrlFields: Set<string> | undefined;

  while (cursor < xml.length) {
    const opening = xml.indexOf("<", cursor);
    if (opening < 0) {
      return rootSeen && rootClosed && stack.length === 0 &&
        strictXmlTextIsValid(xml.slice(cursor), stack.at(-1));
    }
    const text = xml.slice(cursor, opening);
    if (!strictXmlTextIsValid(text, stack.at(-1))) return false;
    if (!rootSeen && !declarationSeen && text.length > 0) preambleMarkupSeen = true;

    if (xml.startsWith("<!--", opening)) {
      const end = xml.indexOf("-->", opening + 4);
      if (end < 0) return false;
      const comment = xml.slice(opening + 4, end);
      if (comment.includes("--") || comment.endsWith("-")) return false;
      if (!rootSeen) preambleMarkupSeen = true;
      cursor = end + 3;
      continue;
    }

    if (xml.startsWith("<![CDATA[", opening)) {
      if (stack.at(-1) !== "loc") return false;
      const end = xml.indexOf("]]>", opening + 9);
      if (end < 0) return false;
      cursor = end + 3;
      continue;
    }

    if (xml.startsWith("<?", opening)) {
      const end = xml.indexOf("?>", opening + 2);
      if (end < 0 || rootSeen || declarationSeen || preambleMarkupSeen || stack.length > 0 ||
        !isStrictXmlDeclaration(xml.slice(opening + 2, end))) return false;
      declarationSeen = true;
      cursor = end + 2;
      continue;
    }

    if (xml.startsWith("</", opening)) {
      const end = xml.indexOf(">", opening + 2);
      if (end < 0) return false;
      const close = xml.slice(opening + 2, end).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*$/u);
      const name = close?.[1];
      if (!name || stack.at(-1) !== name) return false;
      if (name === "url" && !currentUrlFields?.has("loc")) return false;
      stack.pop();
      if (name === "url") currentUrlFields = undefined;
      if (name === "urlset") rootClosed = true;
      cursor = end + 1;
      continue;
    }

    if (xml.startsWith("<!", opening)) return false;
    const end = findStrictXmlTagEnd(xml, opening + 1);
    if (end < 0) return false;
    const tag = parseStrictXmlOpeningTag(xml.slice(opening + 1, end));
    if (!tag || tag.selfClosing || rootClosed) return false;
    const parent = stack.at(-1);
    const attributes = new Map(tag.attributes.map((attribute) => [attribute.name, attribute.value]));
    if (!parent) {
      if (rootSeen || tag.name !== "urlset" || tag.attributes.length !== 1 ||
        attributes.get("xmlns") !== SITEMAP_NAMESPACE) return false;
      rootSeen = true;
    } else if (parent === "urlset") {
      if (tag.name !== "url" || tag.attributes.length > 0) return false;
      currentUrlFields = new Set();
    } else if (parent === "url") {
      if (!["loc", "lastmod", "changefreq", "priority"].includes(tag.name) ||
        tag.attributes.length > 0 || !currentUrlFields || currentUrlFields.has(tag.name)) return false;
      currentUrlFields.add(tag.name);
    } else {
      return false;
    }
    stack.push(tag.name);
    cursor = end + 1;
  }

  return rootSeen && rootClosed && stack.length === 0;
}

function strictXmlTextIsValid(value: string, parent: string | undefined): boolean {
  if (!value) return true;
  if (!parent || parent === "urlset" || parent === "url") return /^[ \t\r\n]*$/u.test(value);
  if (value.includes("]]>") || value.includes("<")) return false;
  return xmlEntitiesAreValid(value);
}

function findStrictXmlTagEnd(xml: string, start: number): number {
  let quote: "\"" | "'" | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index;
    else if (character === "<") return -1;
  }
  return -1;
}

function parseStrictXmlOpeningTag(source: string): StrictXmlOpeningTag | undefined {
  let cursor = 0;
  const name = readStrictXmlName(source, cursor);
  if (!name) return undefined;
  cursor = name.end;
  const attributes: StrictXmlAttribute[] = [];
  const seen = new Set<string>();
  let selfClosing = false;

  while (cursor < source.length) {
    const whitespaceStart = cursor;
    while (isStrictXmlWhitespace(source[cursor])) cursor += 1;
    if (source[cursor] === "/") {
      selfClosing = true;
      cursor += 1;
      while (isStrictXmlWhitespace(source[cursor])) cursor += 1;
      if (cursor !== source.length) return undefined;
      break;
    }
    if (cursor === source.length) break;
    if (cursor === whitespaceStart) return undefined;
    const attributeName = readStrictXmlName(source, cursor);
    if (!attributeName || seen.has(attributeName.name)) return undefined;
    seen.add(attributeName.name);
    cursor = attributeName.end;
    while (isStrictXmlWhitespace(source[cursor])) cursor += 1;
    if (source[cursor] !== "=") return undefined;
    cursor += 1;
    while (isStrictXmlWhitespace(source[cursor])) cursor += 1;
    const quote = source[cursor];
    if (quote !== "\"" && quote !== "'") return undefined;
    const valueStart = ++cursor;
    while (cursor < source.length && source[cursor] !== quote) {
      if (source[cursor] === "<") return undefined;
      cursor += 1;
    }
    if (cursor >= source.length) return undefined;
    const rawValue = source.slice(valueStart, cursor);
    if (!xmlEntitiesAreValid(rawValue)) return undefined;
    attributes.push({ name: attributeName.name, value: decodeStrictXmlEntities(rawValue) });
    cursor += 1;
  }
  return { name: name.name, attributes, selfClosing };
}

function readStrictXmlName(source: string, start: number): { name: string; end: number } | undefined {
  const match = source.slice(start).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/u);
  return match?.[1] ? { name: match[1], end: start + match[1].length } : undefined;
}

function isStrictXmlDeclaration(source: string): boolean {
  if (source.includes("&")) return false;
  const parsed = parseStrictXmlOpeningTag(source);
  if (!parsed || parsed.name !== "xml" || parsed.selfClosing) return false;
  const attributes = new Map(parsed.attributes.map(({ name, value }) => [name, value]));
  const order = parsed.attributes.map(({ name }) => name).join(",");
  return attributes.get("version") === "1.0" &&
    ["version", "version,encoding", "version,standalone", "version,encoding,standalone"].includes(order) &&
    (!attributes.has("encoding") || /^utf-8$/iu.test(attributes.get("encoding")!)) &&
    (!attributes.has("standalone") || /^(?:yes|no)$/u.test(attributes.get("standalone")!));
}

function xmlEntitiesAreValid(value: string): boolean {
  for (let index = value.indexOf("&"); index >= 0; index = value.indexOf("&", index + 1)) {
    const end = value.indexOf(";", index + 1);
    if (end < 0) return false;
    const entity = value.slice(index + 1, end);
    if (!["amp", "lt", "gt", "apos", "quot"].includes(entity)) {
      const decimal = entity.match(/^#(\d+)$/u)?.[1];
      const hexadecimal = entity.match(/^#x([0-9a-fA-F]+)$/u)?.[1];
      const codePoint = decimal ? Number(decimal) : hexadecimal ? Number.parseInt(hexadecimal, 16) : Number.NaN;
      if (!isValidXmlCodePoint(codePoint)) return false;
    }
    index = end;
  }
  return true;
}

function isValidXmlCodePoint(value: number): boolean {
  return Number.isSafeInteger(value) && (value === 0x9 || value === 0xA || value === 0xD ||
    value >= 0x20 && value <= 0xD7FF || value >= 0xE000 && value <= 0xFFFD ||
    value >= 0x10000 && value <= 0x10FFFF);
}

function isStrictXmlWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\r" || value === "\n";
}

function decodeStrictXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);/gu, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&apos;": "'", "&quot;": "\"" };
    const canonical = entity.toLocaleLowerCase("en-US");
    if (named[canonical]) return named[canonical]!;
    const hexadecimal = canonical.startsWith("&#x");
    const raw = canonical.slice(hexadecimal ? 3 : 2, -1);
    const codePoint = hexadecimal ? Number.parseInt(raw, 16) : Number(raw);
    return String.fromCodePoint(codePoint);
  });
}

/**
 * Yandex has advertised these exact model ranges in both sitemap index aliases
 * while returning a bodyless 404 for the shard itself on repeated direct
 * checks. Treat them as source-index tombstones, not as product or feedback
 * observations. A later 200 response still wins and is parsed normally; every
 * other indexed 404 remains fail-closed.
 */
const YANDEX_INDEX_TOMBSTONE_SITEMAPS = new Set([
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5880000000-5889999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5890000000-5899999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5900000000-5909999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5910000000-5919999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5920000000-5929999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5930000000-5939999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5940000000-5949999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5950000000-5959999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5960000000-5969999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5970000000-5979999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5980000000-5989999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5990000000-5999999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6000000000-6009999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6010000000-6019999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6020000000-6029999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6030000000-6039999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6040000000-6049999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6050000000-6059999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6060000000-6069999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6070000000-6079999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6080000000-6089999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6090000000-6099999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6100000000-6109999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_6110000000-6119999999-0.xml"
]);

export function isKnownYandexIndexTombstoneSitemap(input: string | URL): boolean {
  try {
    return YANDEX_INDEX_TOMBSTONE_SITEMAPS.has(new URL(input).toString());
  } catch {
    return false;
  }
}
