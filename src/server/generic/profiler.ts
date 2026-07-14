import type { SiteProfile } from "../../shared/types.js";
import { load } from "cheerio";
import { matchesBrand } from "../utils/normalize.js";
import { safeErrorMessage } from "../utils/error-message.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { extractJsonLdProducts } from "./jsonld.js";

const SEARCH_CANDIDATES = ["/?s={query}", "/search?q={query}", "/search/?q={query}", "/catalogsearch/result/?q={query}"];
const ROOT_SITEMAP_HARD_CAP = 50;

function unique<T>(items: T[]): T[] { return [...new Set(items)]; }
function sameSite(value: string, domain: string) {
  try { const host = new URL(value).hostname.replace(/^www\./, ""); return host === domain || host.endsWith(`.${domain}`); }
  catch { return false; }
}
function examplesFromSearch(html: string, base: string, domain: string, brand: string) {
  const $ = load(html); const examples: Array<{ url: string; title?: string }> = [];
  $("a[href]").each((_index, element) => {
    if (examples.length >= 12) return;
    try {
      const url = new URL($(element).attr("href")!, base).toString();
      const title = $(element).text().replace(/\s+/g, " ").trim();
      if (sameSite(url, domain) && matchesBrand(`${title} ${url}`, brand) && !examples.some((item) => item.url === url)) examples.push({ url, title: title || undefined });
    } catch { /* malformed link */ }
  });
  return examples;
}

function robotsBlocksRoot(text: string): boolean {
  let agents: string[] = [];
  let rulesStarted = false;
  let blocked = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) { agents = []; rulesStarted = false; continue; }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLocaleLowerCase("en-US");
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (rulesStarted) agents = [];
      agents.push(value.toLocaleLowerCase("en-US")); rulesStarted = false; continue;
    }
    rulesStarted = true;
    if (!agents.includes("*") && !agents.some((agent) => agent.includes("ratingscollector"))) continue;
    if (key === "allow" && value === "/") blocked = false;
    if (key === "disallow" && value === "/") blocked = true;
  }
  return blocked;
}

function searchTemplatesFromHomepage(html: string, origin: string, domain: string): string[] {
  const $ = load(html);
  const templates: string[] = [];
  $("form").each((_index, form) => {
    const method = ($(form).attr("method") ?? "get").toLocaleLowerCase("en-US");
    if (method !== "get") return;
    const input = $(form).find("input[type='search'][name], input[name='q'], input[name='query'], input[name='search'], input[name='keyword'], input[name='s']").first();
    const name = input.attr("name");
    if (!name) return;
    try {
      const action = new URL($(form).attr("action") || origin, origin);
      if (!sameSite(action.toString(), domain) || action.protocol !== "https:") return;
      action.searchParams.set(name, "__RATINGS_QUERY__");
      templates.push(action.toString().replace("__RATINGS_QUERY__", "{query}"));
    } catch { /* malformed form action */ }
  });
  $("a[href]").each((_index, link) => {
    try {
      const target = new URL($(link).attr("href")!, origin);
      if (!sameSite(target.toString(), domain) || target.protocol !== "https:") return;
      const key = [...target.searchParams.keys()].find((name) => /^(?:q|query|search|keyword|s)$/i.test(name));
      if (!key || !/search|find|query|catalog/i.test(`${target.pathname} ${$(link).text()}`)) return;
      target.searchParams.set(key, "__RATINGS_QUERY__");
      templates.push(target.toString().replace("__RATINGS_QUERY__", "{query}"));
    } catch { /* malformed navigation link */ }
  });
  return unique(templates);
}

function searchSignals(html: string): Pick<SiteProfile, "productLinkSelector" | "nextPageSelector" | "infiniteScroll"> {
  const $ = load(html);
  const productSelectors = ["[itemtype*='Product'] a[href]", "[data-product-id] a[href]", ".product-card a[href]", ".product-item a[href]", ".catalog-item a[href]"];
  const productLinkSelector = productSelectors.find((selector) => $(selector).length > 0);
  const nextSelectors = ["a[rel='next']", ".pagination a.next", ".pagination__next", "a.next", "[data-next-page]"];
  const nextPageSelector = nextSelectors.find((selector) => $(selector).length > 0);
  const infiniteScroll = /IntersectionObserver|infinite[-_ ]?scroll|load[-_ ]?more|data-(?:page|cursor|offset)/i.test(html) && !nextPageSelector;
  return { productLinkSelector, nextPageSelector, infiniteScroll };
}

async function verifyExamples(
  candidates: Array<{ url: string; title?: string }>, domain: string, brand: string, fetchImpl: typeof fetch
): Promise<{ examples: Array<{ url: string; title?: string }>; meaning: SiteProfile["reviewCountMeaning"] }> {
  const examples: Array<{ url: string; title?: string }> = [];
  const meanings: SiteProfile["reviewCountMeaning"][] = [];
  for (const candidate of candidates.slice(0, 12)) {
    try {
      const response = await safeFetch(candidate.url, { headers: { "x-ratings-browser": "1" } }, fetchImpl);
      if (!response.ok) continue;
      const html = await readTextBounded(response, 10_000_000);
      const products = extractJsonLdProducts(html, candidate.url);
      const title = products.find((item) => matchesBrand(item.name ?? "", brand))?.name ?? candidate.title;
      const productEvidence = products.length > 0 || /отзыв|review|оцен|rating|feedback/i.test(html);
      if (!sameSite(candidate.url, domain) || !matchesBrand(`${title ?? ""} ${candidate.url}`, brand) || !productEvidence) continue;
      examples.push({ url: candidate.url, title });
      if (products.some((item) => item.reviewCount !== undefined)) meanings.push("reviews");
      else if (products.some((item) => item.ratingCount !== undefined)) meanings.push("ratings");
      else if (/\bотзыв|\breviews?\b/i.test(html)) meanings.push("reviews");
      else if (/\bоцен(?:ок|ки)|\bratings?\b/i.test(html)) meanings.push("ratings");
      else if (/\bfeedback\b/i.test(html)) meanings.push("feedback");
      if (examples.length === 3) break;
    } catch { /* candidate is not a verifiable product page */ }
  }
  const meaning = (["reviews", "ratings", "feedback"] as const).find((value) => meanings.filter((item) => item === value).length >= 2) ?? meanings[0] ?? "unknown";
  return { examples, meaning };
}

export async function profileSite(domain: string, testBrand: string, fetchImpl: typeof fetch = fetch): Promise<SiteProfile> {
  const now = new Date().toISOString();
  const origin = `https://${domain}`;
  const notes: string[] = [];
  const declaredSitemapUrls: string[] = [];
  let declaredSitemapFailure = false;
  let robotsBlocked = false;
  let rateLimitMs = 1500;
  try {
    const robots = await safeFetch(`${origin}/robots.txt`, { headers: { "x-ratings-browser": "1" } }, fetchImpl);
    if (robots.ok) {
      const text = await readTextBounded(robots, 1_000_000);
      for (const match of text.matchAll(/^sitemap:\s*(\S.*?)\s*$/gim)) {
        const declared = match[1].trim();
        try {
          const parsed = new URL(declared);
          if (parsed.protocol !== "https:" || !sameSite(parsed.toString(), domain)) {
            declaredSitemapFailure = true;
            notes.push(`robots.txt объявляет небезопасный root sitemap: ${declared}`);
            continue;
          }
          declaredSitemapUrls.push(parsed.toString());
        } catch {
          declaredSitemapFailure = true;
          notes.push(`robots.txt объявляет некорректный root sitemap: ${declared}`);
        }
      }
      robotsBlocked = robotsBlocksRoot(text);
      const crawlDelay = Number(text.match(/^crawl-delay:\s*(\d+(?:\.\d+)?)/im)?.[1]);
      if (Number.isFinite(crawlDelay) && crawlDelay > 0) rateLimitMs = Math.min(30_000, Math.max(1000, Math.ceil(crawlDelay * 1000)));
      if (robotsBlocked) notes.push("robots.txt запрещает автоматический доступ для User-agent: *");
    }
  } catch (error) { notes.push(`robots.txt недоступен: ${safeErrorMessage(error)}`); }
  const syntheticSitemapUrls = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];

  const verifiedSitemaps: string[] = [];
  const declaredSitemapSet = new Set(unique(declaredSitemapUrls));
  const rootSitemapCandidates = unique([...declaredSitemapSet, ...syntheticSitemapUrls]);
  const sitemapCandidateOverflow = rootSitemapCandidates.length > ROOT_SITEMAP_HARD_CAP;
  if (sitemapCandidateOverflow) {
    notes.push(
      `Обнаружено ${rootSitemapCandidates.length} корневых sitemap при лимите ${ROOT_SITEMAP_HARD_CAP}; нужен отдельный адаптер`
    );
  }
  if (!robotsBlocked && !sitemapCandidateOverflow) {
    for (const sitemap of rootSitemapCandidates) {
      try {
        const response = await safeFetch(sitemap, { headers: { "x-ratings-browser": "1" } }, fetchImpl);
        if (!response.ok) {
          if (declaredSitemapSet.has(sitemap)) {
            declaredSitemapFailure = true;
            notes.push(`Root sitemap из robots.txt недоступен: ${sitemap} (HTTP ${response.status})`);
          }
          continue;
        }
        const xml = await readTextBounded(response, 15_000_000);
        if (xml.length <= 15_000_000 && /<(?:urlset|sitemapindex)\b/i.test(xml)) {
          verifiedSitemaps.push(sitemap);
        } else if (declaredSitemapSet.has(sitemap)) {
          declaredSitemapFailure = true;
          notes.push(`Root sitemap из robots.txt содержит невалидный XML: ${sitemap}`);
        }
      } catch (error) {
        if (declaredSitemapSet.has(sitemap)) {
          declaredSitemapFailure = true;
          notes.push(`Root sitemap из robots.txt не проверен: ${sitemap}: ${safeErrorMessage(error)}`);
        }
        // Failures of conventional synthetic fallbacks are expected and do not
        // invalidate an otherwise complete search-based profile.
      }
    }
  }

  let homepage = "";
  if (!robotsBlocked) {
    try {
      const response = await safeFetch(origin, { headers: { "x-ratings-browser": "1" } }, fetchImpl);
      if (response.ok) homepage = await readTextBounded(response, 5_000_000);
    } catch (error) { notes.push(`Главная страница недоступна: ${safeErrorMessage(error)}`); }
  }
  const detectedTemplates = searchTemplatesFromHomepage(homepage, origin, domain);
  const searchCandidates = unique([
    ...detectedTemplates,
    ...SEARCH_CANDIDATES.map((candidate) => `${origin}${candidate}`)
  ]);
  let searchUrlTemplate: string | undefined;
  let testExamples: Array<{ url: string; title?: string }> = [];
  let signals: Pick<SiteProfile, "productLinkSelector" | "nextPageSelector" | "infiniteScroll"> = { infiniteScroll: false };
  for (const candidate of robotsBlocked ? [] : searchCandidates) {
    const url = candidate.replace("{query}", encodeURIComponent(testBrand));
    try {
      const response = await safeFetch(url, { headers: { "x-ratings-browser": "1" } }, fetchImpl);
      const html = response.ok ? await readTextBounded(response, 5_000_000) : "";
      if (response.ok) {
        if (html.toLocaleLowerCase("ru-RU").includes(testBrand.toLocaleLowerCase("ru-RU"))) {
          searchUrlTemplate = candidate;
          testExamples = examplesFromSearch(html, url, domain, testBrand);
          signals = searchSignals(html);
          break;
        }
      }
    } catch { /* try the next conservative pattern */ }
  }
  const verified = await verifyExamples(testExamples, domain, testBrand, fetchImpl);
  testExamples = verified.examples;
  if (!searchUrlTemplate) notes.push("Внутренний поиск не определён; discovery будет проверять sitemap");
  if (signals.infiniteScroll) {
    notes.push("Обнаружена динамическая выдача с infinite scroll; нужен отдельный адаптер");
  }
  if (verified.meaning !== "unknown") notes.push(`Автоматически определён смысл счётчика: ${verified.meaning}; оператор обязан подтвердить его`);
  const status = robotsBlocked || declaredSitemapFailure || sitemapCandidateOverflow || signals.infiniteScroll ||
    !searchUrlTemplate && verifiedSitemaps.length === 0
    ? "blocked_free_mode" as const
    : "draft" as const;
  return {
    domain,
    version: 1,
    status,
    searchUrlTemplate,
    sitemapUrls: verifiedSitemaps,
    productLinkSelector: signals.productLinkSelector,
    nextPageSelector: signals.nextPageSelector,
    infiniteScroll: signals.infiniteScroll,
    titleSelector: "[itemprop='name'], h1",
    reviewCountSelector: "[itemprop='reviewCount'], [data-review-count], .review-count, .reviews-count, .reviews__count",
    ratingSelector: "[itemprop='ratingValue'], [data-rating], .rating-value, .rating__value",
    ratingScale: 5,
    reviewCountMeaning: verified.meaning,
    rateLimitMs,
    canaryUrls: testExamples.map((item) => item.url),
    testExamples,
    createdAt: now,
    updatedAt: now,
    notes
  };
}
