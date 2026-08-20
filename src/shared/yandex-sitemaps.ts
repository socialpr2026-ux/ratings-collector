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
