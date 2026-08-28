import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { assertSafePublicUrl } from "./urls.js";

const DEFAULT_OUTBOUND_TIMEOUT_MS = 20_000;

export type SafeFetchOptions = {
  /** Return the redirect response only when its destination fails the HTTPS/public-address guard. */
  returnUnsafeRedirectResponse?: boolean;
  /** Forward only these response cookies across same-domain redirects. */
  forwardSameDomainCookies?: readonly string[];
};

function responseCookies(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const separate = extended.getSetCookie?.();
  if (separate?.length) return separate;
  const combined = headers.get("set-cookie");
  if (!combined) return [];
  const starts = [...combined.matchAll(/(?:^|,\s*)([A-Za-z0-9_]+)=/g)];
  return starts.map((match, index) => combined.slice(
    (match.index ?? 0) + (match[0].startsWith(",") ? match[0].indexOf(match[1]!) : 0),
    index + 1 < starts.length ? starts[index + 1]!.index : combined.length
  ).replace(/^,\s*/, "").trim());
}

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase("en-US").split("%")[0];
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateNetworkAddress(mapped);
  if (normalized.startsWith("::ffff:")) return true;
  if (normalized === "::" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (/^(?:fc|fd|fe[89a-f]|ff)/.test(normalized)) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 ||
    a === 100 && b >= 64 && b <= 127 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 || a === 198 && (b === 18 || b === 19) || a >= 224;
}

function sameDomain(left: string, right: string): boolean {
  const first = left.toLocaleLowerCase("en-US");
  const second = right.toLocaleLowerCase("en-US");
  return first === second || first.endsWith(`.${second}`) || second.endsWith(`.${first}`);
}

export async function assertSafePublicDestination(input: string): Promise<URL> {
  const url = assertSafePublicUrl(input);
  if (isIP(url.hostname)) {
    if (isPrivateNetworkAddress(url.hostname)) throw new Error("Частные IP-адреса запрещены");
    return url;
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new Error("Домен указывает на запрещённый сетевой адрес");
  }
  return url;
}

export async function safeFetch(
  input: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  maxRedirects = 4,
  timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS,
  options: SafeFetchOptions = {}
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("Некорректный таймаут внешнего запроса");
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Таймаут внешнего запроса")), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  const allowedCookies = new Set(options.forwardSameDomainCookies ?? []);
  if ([...allowedCookies].some((name) => !/^[A-Za-z0-9_]+$/.test(name))) {
    throw new Error("Некорректное имя cookie для перенаправления");
  }
  const cookies = new Map<string, string>();
  try {
    let url = await assertSafePublicDestination(input);
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const requestHeaders = new Headers({
        "user-agent": "RatingsCollector/1.0 (+public aggregate metrics; contact site owner)",
        "accept-language": "ru-RU,ru;q=0.9"
      });
      new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
      if (cookies.size) requestHeaders.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      const response = await fetchImpl(url, {
        ...init,
        signal,
        redirect: "manual",
        headers: requestHeaders
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        const browserFinal = response.headers.get("x-ratings-final-url");
        if (browserFinal) {
          const finalUrl = await assertSafePublicDestination(browserFinal);
          if (!sameDomain(url.hostname, finalUrl.hostname) || url.port !== finalUrl.port) {
            throw new Error(`Перенаправление на другой домен запрещено: ${finalUrl.hostname}`);
          }
        }
        return response;
      }
      const location = response.headers.get("location");
      if (!location) return response;
      for (const cookie of responseCookies(response.headers)) {
        const pair = cookie.match(/^([A-Za-z0-9_]+)=([^;]*)/);
        if (!pair || !allowedCookies.has(pair[1]!)) continue;
        if (/;\s*max-age=0(?:;|$)/i.test(cookie) || /;\s*expires=Thu,\s*01\s+Jan\s+1970/i.test(cookie)) {
          cookies.delete(pair[1]!);
        } else {
          cookies.set(pair[1]!, pair[2]!);
        }
      }
      try {
        const next = await assertSafePublicDestination(new URL(location, url).toString());
        if (!sameDomain(url.hostname, next.hostname) || url.port !== next.port) cookies.clear();
        url = next;
      } catch (error) {
        if (options.returnUnsafeRedirectResponse) return response;
        throw error;
      }
    }
    throw new Error("Слишком много перенаправлений");
  } finally {
    clearTimeout(timer);
  }
}

export async function readTextBounded(
  response: Response,
  maxBytes: number,
  timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS
): Promise<string> {
  return new TextDecoder().decode(await readBytesBounded(response, maxBytes, timeoutMs));
}

export async function readBytesBounded(
  response: Response,
  maxBytes: number,
  timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS
): Promise<Uint8Array> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("Некорректный таймаут чтения ответа");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel(`Ответ превышает лимит ${maxBytes} байт`).catch(() => undefined);
    throw new Error(`Ответ превышает лимит ${maxBytes} байт`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Чтение ответа превысило ${timeoutMs} мс`)), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Ответ превышает лимит ${maxBytes} байт`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
