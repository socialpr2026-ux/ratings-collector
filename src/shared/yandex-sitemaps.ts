/**
 * Yandex has advertised these exact model ranges in both sitemap index aliases
 * while returning a bodyless 404 for the shard itself on repeated direct
 * checks. Treat them as source-index tombstones, not as product or feedback
 * observations. A later 200 response still wins and is parsed normally; every
 * other indexed 404 remains fail-closed.
 */
const YANDEX_INDEX_TOMBSTONE_SITEMAPS = new Set([
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5880000000-5889999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5900000000-5909999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5910000000-5919999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5920000000-5929999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5930000000-5939999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5940000000-5949999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5950000000-5959999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5960000000-5969999999-0.xml",
  "https://reviews.yandex.ru/ugcpub/sitemap_model_5970000000-5979999999-0.xml"
]);

export function isKnownYandexIndexTombstoneSitemap(input: string | URL): boolean {
  try {
    return YANDEX_INDEX_TOMBSTONE_SITEMAPS.has(new URL(input).toString());
  } catch {
    return false;
  }
}
