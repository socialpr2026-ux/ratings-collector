import { normalizeRating } from "../utils/normalize.js";

export type JsonLdProduct = {
  name?: string;
  description?: string;
  url?: string;
  sku?: string;
  productId?: string;
  rating?: number;
  reviewCount?: number;
  ratingCount?: number;
  ratingScale: number;
};

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return [object, ...nodes(object["@graph"]), ...nodes(object.mainEntity)];
}

function sameDomain(left: string, right: string): boolean {
  const first = left.toLocaleLowerCase("en-US");
  const second = right.toLocaleLowerCase("en-US");
  return first === second || first.endsWith(`.${second}`) || second.endsWith(`.${first}`);
}

function trustedProductUrl(value: unknown, pageUrl: string): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const page = new URL(pageUrl);
    const product = new URL(value, page);
    if (page.protocol !== "https:" || product.protocol !== "https:" || page.port !== product.port) return undefined;
    if (!sameDomain(page.hostname, product.hostname) || page.port !== product.port) return undefined;
    return product.toString();
  } catch {
    return undefined;
  }
}

export function extractJsonLdProducts(html: string, pageUrl: string): JsonLdProduct[] {
  const products: JsonLdProduct[] = [];
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    let parsed: unknown;
    try { parsed = JSON.parse(match[1].replace(/^\s*<!--|-->\s*$/g, "")); } catch { continue; }
    for (const node of nodes(parsed)) {
      const rawType = node["@type"];
      const types = Array.isArray(rawType) ? rawType : [rawType];
      if (!types.some((type) => String(type).toLowerCase() === "product")) continue;
      const aggregate = node.aggregateRating as Record<string, unknown> | undefined;
      const rawRating = asNumber(aggregate?.ratingValue);
      const scale = asNumber(aggregate?.bestRating) ?? 5;
      products.push({
        name: typeof node.name === "string" ? node.name : undefined,
        description: typeof node.description === "string" ? node.description.slice(0, 2000) : undefined,
        url: trustedProductUrl(node.url, pageUrl),
        sku: typeof node.sku === "string" || typeof node.sku === "number" ? String(node.sku) : undefined,
        productId: typeof node.productID === "string" || typeof node.productID === "number" ? String(node.productID) : undefined,
        rating: rawRating === undefined ? undefined : normalizeRating(rawRating, scale),
        reviewCount: asNumber(aggregate?.reviewCount),
        ratingCount: asNumber(aggregate?.ratingCount),
        ratingScale: scale
      });
    }
  }
  return products;
}
