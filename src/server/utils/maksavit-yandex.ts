import { load } from "cheerio";

const SOURCE_PRODUCT_PATH = /^\/catalog\/(\d+)\/$/u;

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

export function maksavitSourceFromYandexTranslateUrl(target: URL): URL | undefined {
  if (
    target.protocol !== "https:" || target.hostname !== "translate.yandex.ru" || target.port ||
    target.username || target.password || target.hash || target.pathname !== "/translate" ||
    target.searchParams.getAll("lang").length !== 1 || target.searchParams.get("lang") !== "ru-en" ||
    target.searchParams.getAll("url").length !== 1 ||
    [...target.searchParams.keys()].some((key) => !["lang", "url"].includes(key))
  ) return undefined;

  let source: URL;
  try { source = new URL(target.searchParams.get("url") ?? ""); }
  catch { return undefined; }
  if (
    source.protocol !== "https:" || source.hostname !== "maksavit.ru" || source.port ||
    source.username || source.password || source.search || source.hash ||
    !SOURCE_PRODUCT_PATH.test(source.pathname)
  ) return undefined;
  return source;
}

export function compactExactMaksavitYandexHtml(html: string, source: URL): string | undefined {
  if (!SOURCE_PRODUCT_PATH.test(source.pathname) || source.origin !== "https://maksavit.ru" ||
    !/<\/body\s*>\s*<\/html\s*>\s*$/iu.test(html)) return undefined;
  const $ = load(html);
  const openGraphUrls = $("meta").filter((_index, element) =>
    ($(element).attr("property") ?? "").trim().toLocaleLowerCase("en-US") === "og:url"
  );
  if (openGraphUrls.length !== 1 || openGraphUrls.first().attr("content")?.trim() !== source.toString()) {
    return undefined;
  }
  const headings = $("h1");
  const feedback = $("section#feedback");
  if (headings.length !== 1 || feedback.length !== 1) return undefined;
  const headingHtml = headings.first().toString();
  const feedbackHtml = feedback.first().toString();
  if (!headingHtml || !feedbackHtml) return undefined;
  const ignoredTemplateAggregate = /"aggregateRating"\s*:\s*\{[^}]*"ratingValue"\s*:\s*5(?:\.0+)?[^}]*"reviewCount"\s*:\s*1[^}]*\}/iu.test(html);
  const sourceText = escapeHtml(source.toString());
  return "<!doctype html><html><head>" +
    `<link rel="canonical" href="${sourceText}">` +
    `<meta property="og:url" content="${sourceText}">` +
    (ignoredTemplateAggregate
      ? '<meta name="ratings:ignored-template-aggregate" content="5/1">'
      : "") +
    `</head><body>${headingHtml}${feedbackHtml}</body></html>`;
}
