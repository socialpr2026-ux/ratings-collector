const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^\[?::1\]?$/
];

export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|yclid$|gclid$|srsltid$|at$|from$|ref)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString().replace(/\?$/, "");
}

export function assertSafePublicUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error("Разрешены только HTTPS-сайты");
  if (url.username || url.password) throw new Error("Ссылки со встроенными учётными данными запрещены");
  if (url.port && url.port !== "443") throw new Error("Для HTTPS разрешён только стандартный порт 443");
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    throw new Error("Локальные и частные адреса запрещены");
  }
  return url;
}

export function extractSpreadsheetId(input: string): string {
  const url = assertSafePublicUrl(input);
  if (url.hostname.toLocaleLowerCase("en-US") !== "docs.google.com") {
    throw new Error("Разрешены только Google-таблицы на docs.google.com");
  }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (!match) throw new Error("Не удалось определить ID Google-таблицы");
  return match[1];
}
