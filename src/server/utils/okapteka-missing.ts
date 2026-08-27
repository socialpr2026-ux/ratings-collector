const DOMAIN = "okapteka.ru";
const GROUP_PATH = /^\/pg\/[^/]+\/$/iu;
const CHALLENGE_MARKERS = /captcha|data-sitekey|cf-chl|challenge-page|access denied|forbidden|проверка браузера|доступ (?:ограничен|запрещен)|не робот/iu;
export const OKAPTEKA_MISSING_HTML_MAX_BYTES = 400_000;

function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu"));
  return match?.[1] ?? match?.[2];
}

function openingTags(html: string, name: string): Array<{ tag: string; index: number }> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...html.matchAll(new RegExp(`<${escaped}\\b[^>]*>`, "giu"))].map((match) => ({
    tag: match[0],
    index: match.index
  }));
}

function classNames(tag: string): string[] {
  return (attribute(tag, "class") ?? "").split(/\s+/u).filter(Boolean);
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/giu, " ")
    .replace(/&quot;/giu, "\"")
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function exactCanonical(html: string, source: URL): boolean {
  const canonical = openingTags(html, "link").filter(({ tag }) =>
    (attribute(tag, "rel") ?? "").toLocaleLowerCase("en-US").split(/\s+/u).includes("canonical")
  );
  if (canonical.length !== 1) return false;
  const href = attribute(canonical[0].tag, "href")?.replace(/&amp;/giu, "&");
  if (!href) return false;
  try {
    const target = new URL(href, source);
    return target.protocol === "https:" && target.hostname === DOMAIN && !target.port &&
      !target.username && !target.password && !target.search && !target.hash &&
      target.pathname === source.pathname;
  } catch {
    return false;
  }
}

/**
 * Proves the current, exact Okapteka first-party 404 template for one brand
 * group. A bare terminal status is insufficient: anti-bot pages sometimes
 * reuse 404/410 and must remain blocked instead of becoming an empty result.
 */
export function provesExactOkaptekaMissingHtml(html: string, sourceUrl: string): boolean {
  let source: URL;
  try { source = new URL(sourceUrl); }
  catch { return false; }
  if (source.protocol !== "https:" || source.hostname !== DOMAIN || source.port || source.username ||
    source.password || source.search || source.hash || !GROUP_PATH.test(source.pathname) ||
    html.length < 1_000 || html.length > OKAPTEKA_MISSING_HTML_MAX_BYTES || CHALLENGE_MARKERS.test(html)) return false;
  if (!exactCanonical(html, source)) return false;

  const errorBlocks = openingTags(html, "div").filter(({ tag }) => classNames(tag).includes("error-page"));
  if (errorBlocks.length !== 1) return false;
  const blockStart = errorBlocks[0].index + errorBlocks[0].tag.length;
  const blockEnd = html.indexOf("</div>", blockStart);
  if (blockEnd < blockStart) return false;
  const block = html.slice(blockStart, blockEnd);
  if (/<div\b/iu.test(block)) return false;

  const images = openingTags(block, "img").filter(({ tag }) => classNames(tag).includes("error-page__image"));
  const links = openingTags(block, "a");
  return images.length === 1 && attribute(images[0].tag, "alt") === "404" &&
    links.length === 1 && attribute(links[0].tag, "href") === "/" &&
    visibleText(block) === "похоже вы потерялись попробуйте вернуться назад или поищите что нибудь другое вернуться на главную";
}
