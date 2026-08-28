import { BRAND_ALIASES } from "../../shared/constants.js";
import { normalizeRatingToFive } from "../../shared/rating.js";

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[‐‑‒–—−-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NORMALIZED_BRAND_ALIASES = (() => {
  const result = new Map<string, string[]>();
  const owners = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(BRAND_ALIASES)) {
    const group = [...new Set([canonical, ...aliases])];
    const owner = normalizeText(canonical);
    for (const value of group) {
      const key = normalizeText(value);
      const existing = owners.get(key);
      if (existing && existing !== owner) {
        throw new Error(`Brand alias ${value} belongs to more than one canonical brand`);
      }
      owners.set(key, owner);
      result.set(key, group);
    }
  }
  return result;
})();

export function aliasesForBrand(brand: string): string[] {
  return [...new Set([brand, ...(NORMALIZED_BRAND_ALIASES.get(normalizeText(brand)) ?? [])])];
}

export function matchesBrand(title: string, brand: string): boolean {
  const normalizedTitle = ` ${normalizeText(title)} `;
  return aliasesForBrand(brand).some((alias) =>
    normalizedTitle.includes(` ${normalizeText(alias)} `)
  );
}

export function normalizeRating(value: number, scale = 5): number {
  return normalizeRatingToFive(value, scale);
}

