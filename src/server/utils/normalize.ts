import { BRAND_ALIASES } from "../../shared/constants.js";

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

export function aliasesForBrand(brand: string): string[] {
  return [...new Set([brand, ...(BRAND_ALIASES[brand] ?? [])])];
}

export function matchesBrand(title: string, brand: string): boolean {
  const normalizedTitle = ` ${normalizeText(title)} `;
  return aliasesForBrand(brand).some((alias) =>
    normalizedTitle.includes(` ${normalizeText(alias)} `)
  );
}

export function normalizeRating(value: number, scale = 5): number {
  const rating = (value / scale) * 5;
  return Math.round(Math.max(0, Math.min(5, rating)) * 10) / 10;
}

