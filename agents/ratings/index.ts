import type { Browser, BrowserContext, Page, Response as PlaywrightResponse } from "playwright-core";
import { authenticate, authConfig } from "../../src/server/auth.js";
import { AdapterBlockedError, AdapterQuotaError } from "../../src/server/adapters/errors.js";
import { createSerialExecutor } from "../../src/server/adapters/budgeted.js";
import { RemoteEvidenceStore, RemoteRepository } from "../../src/server/remote-repository.js";
import { createCollectorRuntime } from "../../src/server/runtime.js";
import { shouldUseHardenedBrowser } from "../../src/server/utils/agent-browser-routing.js";
import { readAgentJson } from "../../src/server/utils/agent-request.js";
import { safeErrorMessage } from "../../src/server/utils/error-message.js";
import { loadPlaywright } from "../../src/server/utils/playwright-runtime.js";
import { playwrightCdpBaseUrl } from "../../src/server/utils/sandbox-cdp.js";
import { collectorPublicEndpoint } from "../../src/server/utils/collector-public-endpoint.js";
import { assertSafePublicDestination, isPrivateNetworkAddress } from "../../src/server/utils/safe-fetch.js";

type BrowserApi = { cdpUrl: string };
type SandboxCommands = { run(command: string): Promise<unknown> };
type SandboxApi = {
  browser: BrowserApi;
  commands: SandboxCommands;
  readonly envdAccessToken: string;
};
type AgentContext = {
  request: Request;
  conversation_id: string;
  env: Record<string, string | undefined>;
  sandbox: SandboxApi;
};

export function shouldAutoRetryInitialCollection(
  initialStatus: "queued" | "running" | "review" | "publishing" | "published" | "failed",
  partitions: Array<{ status: string; message?: string }>
): boolean {
  if (initialStatus !== "queued" || partitions.length > 50) return false;
  const failures = partitions.filter(({ status }) => status !== "complete" && status !== "no_results");
  if (failures.length === 0 || failures.length > 10) return false;
  return failures.every(({ status, message = "" }) =>
    (status === "blocked" || status === "error") &&
    !/^(?:quota_exceeded|parser_changed)\s*:/i.test(message.trim()) &&
    !/Ozon exact product proof is unavailable/i.test(message) &&
    !/Ozon[^\n]*HTTP\s+502/i.test(message) &&
    /\bcaptcha\b|капч|HTTP\s+(?:408|425|429|498|499|5\d{2})\b/i.test(message)
  );
}

export const MAX_INITIAL_TRANSIENT_RECOVERY_PASSES = 3;
export const STATIC_PROXY_REQUEST_TIMEOUT_MS = 55_000;

export function transientRecoveryDelayMs(
  partitions: Array<{ domain?: string; status: string; message?: string }>,
  recoveryPass: number
): number {
  const transientFailure = partitions.some(({ status, message = "" }) =>
    status !== "complete" && status !== "no_results" &&
    /\bcaptcha\b|капч|HTTP\s+(?:408|425|429|498|499|5\d{2})\b/i.test(message)
  );
  return transientFailure ? Math.min(3_000, 750 * (recoveryPass + 1)) : 0;
}

const TRANSIENT_STATIC_PROXY_STATUSES = new Set([403, 408, 425, 429, 498, 502, 503, 504]);
const YANDEX_BATCH_ENDPOINT = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
const YANDEX_MARKET_STATIC_RETRY_DELAY_MS = 200;
// The singleton fixed Function owns a 55-second exact-shard budget and the
// public boundary closes around sixty seconds. Give that response a small
// delivery margin, then release the Agent lane so the adapter's failed-shard
// recovery round can continue; the old 125-second two-shard split budget only
// doubled every stalled singleton pause.
export const YANDEX_BATCH_GATEWAY_TIMEOUT_MS = 70_000;
type YandexBatchCapableFetch = typeof fetch & {
  yandexBatchEndpoint?: string;
  yandexDirectRecovery?: boolean;
};
type YandexMarketCapableFetch = YandexBatchCapableFetch & { yandexMarketBrowserEndpoint?: string };

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function sameDomain(left: string, right: string): boolean {
  const first = left.toLocaleLowerCase("en-US");
  const second = right.toLocaleLowerCase("en-US");
  return first === second || first.endsWith(`.${second}`) || second.endsWith(`.${first}`);
}

function normalizedVisibleText(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function hasExplicitWildberriesNoResults(bodyText: string, query: string): boolean {
  const normalizedQuery = normalizedVisibleText(query);
  if (!normalizedQuery) return false;
  return normalizedVisibleText(bodyText).includes(
    `по запросу ${normalizedQuery} ничего не нашлось`
  );
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
  });
}

export function createLazySandboxAcquire(sandbox: Pick<SandboxApi, "commands">): () => Promise<void> {
  let acquisition: Promise<void> | undefined;
  return () => acquisition ??= Promise.resolve()
    .then(() => sandbox.commands.run("true"))
    .then(() => undefined)
    .catch((error) => {
      const message = safeErrorMessage(error);
      if (/quota|monthly[^.]{0,80}GB-s|limit[^.]{0,80}(?:exceeded|reached)|лимит[^.]{0,80}(?:исчерпан|превышен)/i.test(message)) {
        throw new AdapterQuotaError(`EdgeOne Sandbox quota is exhausted: ${message}`);
      }
      throw new AdapterBlockedError(`EdgeOne Sandbox is unavailable: ${message}`);
    });
}

export function hasExplicitYandexMarketNoResults(bodyText: string, query: string): boolean {
  const normalizedQuery = normalizedVisibleText(query);
  if (!normalizedQuery) return false;
  const body = normalizedVisibleText(bodyText);
  return body.includes(`по запросу ${normalizedQuery} ничего не нашли`) ||
    body.includes(`по запросу ${normalizedQuery} ничего не нашлось`);
}

type YandexMarketSearchProductProof = {
  id: string;
  name: string;
  url: string;
  ratingCount?: number;
  rating?: number;
  familyId?: string;
};

function structuredFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replace(",", ".");
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function extractYandexMarketSearchHtmlProof(
  html: string,
  query: string,
  pageNumber: number
): { query: string; page: number; hasNext: boolean; products: YandexMarketSearchProductProof[] } | undefined {
  const normalizedQuery = normalizedVisibleText(query);
  if (!normalizedQuery || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 50) return undefined;
  const products = new Map<string, YandexMarketSearchProductProof>();
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    if (!/\btype\s*=\s*(?:["']application\/ld\+json["']|application\/ld\+json(?:\s|$))/i.test(match[1] ?? "")) continue;
    let value: unknown;
    try { value = JSON.parse(match[2] ?? ""); }
    catch { continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const itemList = value as Record<string, unknown>;
    if (itemList["@type"] !== "ItemList" || typeof itemList.name !== "string" ||
      !normalizedVisibleText(itemList.name).includes(normalizedQuery) || !Array.isArray(itemList.itemListElement)) continue;
    for (const entry of itemList.itemListElement) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = (entry as Record<string, unknown>).item;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const product = item as Record<string, unknown>;
      const name = typeof product.name === "string" ? product.name.trim() : "";
      const rawUrl = typeof product.url === "string" ? product.url :
        typeof product["@id"] === "string" ? product["@id"] : "";
      let target: URL;
      try { target = new URL(rawUrl); }
      catch { continue; }
      const id = target.pathname.match(/^\/card\/[a-z0-9][a-z0-9-]*\/(\d+)\/?$/i)?.[1];
      if (!name || target.origin !== "https://market.yandex.ru" || !id || target.search || target.hash) continue;
      const proof: YandexMarketSearchProductProof = { id, name, url: target.toString() };
      const aggregate = product.aggregateRating;
      if (aggregate && typeof aggregate === "object" && !Array.isArray(aggregate)) {
        const ratingCount = structuredFiniteNumber((aggregate as Record<string, unknown>).ratingCount);
        const rating = structuredFiniteNumber((aggregate as Record<string, unknown>).ratingValue);
        if (ratingCount !== undefined && Number.isSafeInteger(ratingCount) && ratingCount >= 0 &&
          rating !== undefined && rating >= 0 && rating <= 5 &&
          (ratingCount === 0 || rating > 0)) {
          proof.ratingCount = ratingCount;
          proof.rating = rating;
        }
      }
      const familyId = typeof product.sku === "number" || typeof product.sku === "string"
        ? String(product.sku).trim()
        : "";
      if (/^\d{1,40}$/.test(familyId)) proof.familyId = familyId;
      products.set(id, proof);
    }
  }
  if (products.size === 0) return undefined;

  let hasNext = false;
  const hrefPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(hrefPattern)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? "").replace(/&amp;/gi, "&");
    try {
      const target = new URL(href, "https://market.yandex.ru");
      if (target.origin === "https://market.yandex.ru" && target.pathname === "/search" &&
        normalizedVisibleText(target.searchParams.get("text") ?? "") === normalizedQuery &&
        Number(target.searchParams.get("page")) === pageNumber + 1) {
        hasNext = true;
        break;
      }
    } catch { /* ignore malformed links */ }
  }
  return { query, page: pageNumber, hasNext, products: [...products.values()] };
}

export function browserFetch(
  sandbox: SandboxApi,
  staticProxy?: { endpoint: string; token: string }
): typeof fetch {
  let queue = Promise.resolve();
  let connected: Promise<Browser> | undefined;
  let ozonPage: Promise<Page> | undefined;
  let wildberriesPage: Promise<Page> | undefined;
  const ozonResponseChecks: Promise<void>[] = [];
  let ozonNetworkViolation: Error | undefined;
  const wildberriesResponseChecks: Promise<void>[] = [];
  let wildberriesNetworkViolation: Error | undefined;
  const hardenedContexts = new Map<string, Promise<BrowserContext>>();
  const fetchViaStaticProxy = async (url: URL, signal: AbortSignal) => {
    if (!staticProxy) throw new Error("Static proxy is not configured");
    const attemptAbort = new AbortController();
    const combinedSignal = AbortSignal.any([signal, attemptAbort.signal]);
    try {
      const response = await withDeadline(fetch(staticProxy.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${staticProxy.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ url: url.toString() }),
        signal: combinedSignal
      }), STATIC_PROXY_REQUEST_TIMEOUT_MS, `Static proxy request exceeded ${STATIC_PROXY_REQUEST_TIMEOUT_MS} ms`);
      // A fetch promise resolves as soon as response headers arrive. Buffer the
      // bounded proxy response before disposing the per-attempt signal; aborting
      // it while the caller still reads the stream produces a misleading
      // `This operation was aborted` health-check failure on selective retry.
      const body = await withDeadline(
        response.arrayBuffer(),
        STATIC_PROXY_REQUEST_TIMEOUT_MS,
        `Static proxy response exceeded ${STATIC_PROXY_REQUEST_TIMEOUT_MS} ms`
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      // A failed fixed-egress request is an access-path failure, never evidence
      // that the marketplace markup changed. Preserve an explicit blocked
      // classification so Ozon can offer the employee its local Chrome route.
      if (signal.aborted) throw error;
      throw new AdapterBlockedError(
        error instanceof Error ? error.message : `Static proxy request failed: ${String(error)}`
      );
    } finally {
      attemptAbort.abort();
    }
  };
  const fetchVaptekeViaStaticProxy = async (request: Request) => {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/ajax/autocomplete") {
      return fetchViaStaticProxy(url, request.signal);
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
      throw new AdapterBlockedError("vapteke.ru autocomplete request has an unexpected content type");
    }
    const text = await request.text();
    if (text.length > 1_000) throw new AdapterBlockedError("vapteke.ru autocomplete request is too large");
    const form = new URLSearchParams(text);
    const query = form.get("query")?.normalize("NFKC").trim() ?? "";
    if ([...form.keys()].some((key) => key !== "query") || form.getAll("query").length !== 1 ||
      query.length < 2 || query.length > 160) {
      throw new AdapterBlockedError("vapteke.ru autocomplete request is not an exact bounded brand query");
    }
    return fetch(staticProxy!.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${staticProxy!.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ url: url.toString(), vaptekeAutocomplete: { query } }),
      signal: request.signal
    });
  };
  const fetchYandexBatchViaStaticProxy = async (request: Request) => {
    if (!staticProxy) throw new Error("Static proxy is not configured");
    const text = await request.text();
    if (text.length > 100_000) throw new Error("Yandex batch request exceeds the internal safety limit");
    let batch: unknown;
    try { batch = JSON.parse(text); }
    catch { throw new Error("Yandex batch request is not valid JSON"); }
    const input = batch && typeof batch === "object" && !Array.isArray(batch)
      ? batch as { sitemaps?: unknown; brands?: unknown }
      : undefined;
    // The fixed Function already retries the exact upstream shard. Return its
    // authoritative batch response unchanged: YandexAdapter owns the bounded
    // batch-level retry, so stacking another loop here would multiply a slow
    // shard into as many as nine expensive attempts.
    const requestProof = async (payload: unknown): Promise<Response> => {
      const attemptAbort = new AbortController();
      const signal = AbortSignal.any([request.signal, attemptAbort.signal]);
      try {
        return await withDeadline(fetch(staticProxy.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${staticProxy.token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ url: request.url, yandexBatch: payload }),
          signal
        }), YANDEX_BATCH_GATEWAY_TIMEOUT_MS, "Yandex batch gateway transport timed out");
      } catch (error) {
        attemptAbort.abort(error);
        request.signal.throwIfAborted();
        // The deadline is beyond the Function's platform ceiling, so this
        // synthetic response cannot overlap a still-valid fixed invocation.
        return json({ error: safeErrorMessage(error) }, 504);
      }
    };
    const splitTimedOutProof = async (payload: { sitemaps: string[]; brands?: unknown }): Promise<Response> => {
      const response = await requestProof(payload);
      // A transport/runtime 502 has the same practical meaning here as the
      // explicit 504 deadline: the fixed function could not prove this whole
      // bounded group. Reduce the payload recursively instead of repeating the
      // same expensive group request.
      if (![500, 502, 503, 504].includes(response.status) || payload.sitemaps.length <= 1) return response;
      await response.body?.cancel().catch(() => undefined);
      request.signal.throwIfAborted();

      const middle = Math.ceil(payload.sitemaps.length / 2);
      // Both halves are independent and the production adapter sends two-shard
      // groups. Recover them in parallel so the bounded 125-second gateway
      // attempts remain inside the adapter's 330-second transport deadline.
      // Proof is still fail-closed: neither half is accepted on its own.
      const [left, right] = await Promise.all([
        splitTimedOutProof({ ...payload, sitemaps: payload.sitemaps.slice(0, middle) }),
        splitTimedOutProof({ ...payload, sitemaps: payload.sitemaps.slice(middle) })
      ]);
      if (!left.ok || !right.ok) {
        if (!left.ok) {
          await right.body?.cancel().catch(() => undefined);
          return left;
        }
        await left.body?.cancel().catch(() => undefined);
        return right;
      }
      const [leftProof, rightProof] = await Promise.all([
        left.json(),
        right.json()
      ]) as Array<{
        processed?: unknown; firstSitemap?: unknown; lastSitemap?: unknown;
        verifiedSitemaps?: unknown; tombstonedSitemaps?: unknown; matches?: unknown;
      }>;
      if (!Array.isArray(leftProof.matches) || !Array.isArray(rightProof.matches) ||
        !Array.isArray(leftProof.verifiedSitemaps) || !Array.isArray(rightProof.verifiedSitemaps)) {
        return json({ error: "Split Yandex batch proof is unreadable" }, 502);
      }
      const tombstonedSitemaps = [
        ...(Array.isArray(leftProof.tombstonedSitemaps) ? leftProof.tombstonedSitemaps : []),
        ...(Array.isArray(rightProof.tombstonedSitemaps) ? rightProof.tombstonedSitemaps : [])
      ];
      return json({
        processed: Number(leftProof.processed) + Number(rightProof.processed),
        firstSitemap: leftProof.firstSitemap,
        lastSitemap: rightProof.lastSitemap,
        verifiedSitemaps: [...leftProof.verifiedSitemaps, ...rightProof.verifiedSitemaps],
        ...(tombstonedSitemaps.length > 0 ? { tombstonedSitemaps } : {}),
        matches: [...leftProof.matches, ...rightProof.matches]
      });
    };
    if (input && Array.isArray(input.sitemaps) && input.sitemaps.length > 1 &&
      input.sitemaps.every((item): item is string => typeof item === "string")) {
      return splitTimedOutProof({ ...input, sitemaps: input.sitemaps });
    }
    return requestProof(batch);
  };
  const fetchWildberriesViaStaticProxy = async (url: URL, signal: AbortSignal) => {
    const first = await fetchViaStaticProxy(url, signal);
    if (!TRANSIENT_STATIC_PROXY_STATUSES.has(first.status)) return first;
    await first.body?.cancel().catch(() => undefined);
    signal.throwIfAborted();
    // One bounded retry absorbs a transient Function/upstream hand-off. The
    // second response remains authoritative and can never become a fake zero.
    await new Promise((resolve) => setTimeout(resolve, 200));
    signal.throwIfAborted();
    return fetchViaStaticProxy(url, signal);
  };
  const acquireSandbox = createLazySandboxAcquire(sandbox);
  const getBrowser = () => connected ??= acquireSandbox()
    .then(() => loadPlaywright())
    .then(({ chromium }) => chromium.connectOverCDP(playwrightCdpBaseUrl(sandbox.browser.cdpUrl), {
      headers: { "X-Access-Token": sandbox.envdAccessToken },
      timeout: 60_000
    }));
  const getContext = (key: "trusted-yandex" | "trusted-yandex-market" | "trusted-irecommend" | "trusted-ozon" | "trusted-wildberries" | "untrusted-static") => {
    const trustedDynamic = key !== "untrusted-static";
    let context = hardenedContexts.get(key);
    if (!context) {
      context = getBrowser().then((browser) => browser.newContext({
        locale: "ru-RU",
        serviceWorkers: "block",
        javaScriptEnabled: trustedDynamic
      }));
      hardenedContexts.set(key, context);
    }
    return context;
  };
  const assertActualServer = async (response: PlaywrightResponse) => {
    const address = await response.serverAddr();
    if (!address?.ipAddress || isPrivateNetworkAddress(address.ipAddress)) {
      throw new Error(`Браузер подключился к запрещённому сетевому адресу: ${address?.ipAddress ?? "не определён"}`);
    }
  };
  const getOzonPage = () => {
    if (!ozonPage) {
      ozonPage = getContext("trusted-ozon").then(async (context) => {
        const page = await context.newPage();
        page.on("response", (pageResponse) => {
          ozonResponseChecks.push(assertActualServer(pageResponse).catch((error) => {
            ozonNetworkViolation ??= error as Error;
          }));
        });
        await page.route("**/*", async (route) => {
          const targetText = route.request().url();
          if (/^(?:data|blob):/i.test(targetText)) return route.continue();
          try {
            await assertSafePublicDestination(targetText);
            return route.continue();
          } catch {
            return route.abort("blockedbyclient");
          }
        });
        const home = await assertSafePublicDestination("https://www.ozon.ru/");
        const navigation = await page.goto(home.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
        if (!navigation) throw new Error("Ozon browser canary returned no network response");
        await assertActualServer(navigation);
        await page.waitForTimeout(10_000);
        await Promise.all(ozonResponseChecks);
        if (ozonNetworkViolation) throw ozonNetworkViolation;
        const title = await page.title();
        if (/captcha|antibot|access denied|доступ (?:ограничен|запрещен)|variti/i.test(title)) {
          throw new Error(`Ozon browser challenge was not passed: ${title.slice(0, 120)}`);
        }
        page.once("close", () => { ozonPage = undefined; });
        return page;
      }).catch((error) => {
        ozonPage = undefined;
        throw error;
      });
    }
    return ozonPage;
  };
  const getWildberriesPage = () => {
    if (!wildberriesPage) {
      wildberriesPage = getContext("trusted-wildberries").then(async (context) => {
        const page = await context.newPage();
        page.on("response", (pageResponse) => {
          wildberriesResponseChecks.push(assertActualServer(pageResponse).catch((error) => {
            wildberriesNetworkViolation ??= error as Error;
          }));
        });
        await page.route("**/*", async (route) => {
          const targetText = route.request().url();
          if (/^(?:data|blob):/i.test(targetText)) return route.continue();
          try {
            await assertSafePublicDestination(targetText);
            return route.continue();
          } catch {
            return route.abort("blockedbyclient");
          }
        });
        const home = await assertSafePublicDestination("https://www.wildberries.ru/");
        const navigation = await page.goto(home.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
        if (!navigation) throw new Error("Wildberries browser canary returned no network response");
        await assertActualServer(navigation);
        await page.waitForTimeout(8_000);
        await Promise.all(wildberriesResponseChecks);
        if (wildberriesNetworkViolation) throw wildberriesNetworkViolation;
        const title = await page.title();
        if (/captcha|proof[\s_-]*of[\s_-]*work|access denied|доступ (?:ограничен|запрещен)/i.test(title)) {
          throw new Error(`Wildberries browser challenge was not passed: ${title.slice(0, 120)}`);
        }
        page.once("close", () => { wildberriesPage = undefined; });
        return page;
      }).catch((error) => {
        wildberriesPage = undefined;
        throw error;
      });
    }
    return wildberriesPage;
  };
  const routedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    const fixedYandexBatchTarget = staticProxy && request.method === "POST" &&
      url.toString() === YANDEX_BATCH_ENDPOINT;
    const fixedWildberriesTarget = !shouldUseHardenedBrowser(request) && (
      url.hostname === "search.wb.ru" && [
        "/exactmatch/ru/common/v14/search",
        "/exactmatch/ru/common/v18/search"
      ].includes(url.pathname) ||
      url.hostname === "card.wb.ru" && url.pathname === "/cards/v4/detail"
    );
    const fixedYandexTarget = url.protocol === "https:" && url.hostname === "reviews.yandex.ru" &&
      !url.port && !url.username && !url.password && !url.hash && !url.search && (
        url.pathname === "/ugcpub/sitemap.xml" ||
        /^\/ugcpub\/sitemap_model_\d+-\d+-\d+\.xml$/i.test(url.pathname) ||
        /^\/product\/(?:[a-z0-9_-]+--)?\d+$/i.test(url.pathname)
      );
    const fixedZdravcityTarget = url.protocol === "https:" && url.hostname === "zdravcity.ru" &&
      !url.port && !url.username && !url.password && !url.hash && !url.search && (
        /^\/g_[a-z0-9-]+\/$/i.test(url.pathname) ||
        /^\/p_[a-z0-9][a-z0-9-]*-\d+\.html$/i.test(url.pathname)
      );
    const fixedAptekaTarget = url.protocol === "https:" && url.hostname === "apteka.ru" &&
      !url.port && !url.username && !url.password && !url.hash && (
        !url.search && (
          /^\/preparation\/[a-z0-9][a-z0-9-]*\/$/i.test(url.pathname) ||
          /^\/product\/[a-z0-9-]+-[a-f0-9]{24}\/$/i.test(url.pathname)
        ) ||
        url.pathname === "/sitemap-product.xml" && url.searchParams.getAll("slugs").length === 1 &&
          [...url.searchParams.keys()].every((key) => key === "slugs") &&
          url.searchParams.get("slugs")!.split(",").every((slug) => /^[a-z0-9-]{3,80}$/i.test(slug))
      );
    const fixedAsnaSitemapTarget = url.protocol === "https:" && url.hostname === "www.asna.ru" &&
      !url.port && !url.username && !url.password && !url.hash &&
      ["/sitemap/sitemap_cards.xml", "/sitemap/sitemap_cards1.xml"].includes(url.pathname) &&
      url.searchParams.getAll("slugs").length === 1 && [...url.searchParams.keys()].every((key) => key === "slugs") &&
      url.searchParams.get("slugs")!.split(",").every((slug) => /^[a-z0-9][a-z0-9-]{0,79}$/i.test(slug));
    if (fixedYandexBatchTarget) {
      return fetchYandexBatchViaStaticProxy(request);
    }
    if (staticProxy && [
      "translate.yandex.ru",
      "www-ozon-ru.translate.goog",
      "farmlend-ru.translate.goog",
      "okapteka-ru.translate.goog",
      "www-asna-ru.translate.goog",
      "polza-ru.translate.goog",
      "apteka-ru.translate.goog",
      "nfapteka-ru.translate.goog",
      "www-budzdorov-ru.translate.goog",
      "market-yandex-ru.translate.goog",
      "megamarket-ru.translate.goog"
    ].includes(url.hostname)) {
      const maxAttempts = url.hostname === "megamarket-ru.translate.goog" ? 3 : 2;
      for (let attempt = 1; ; attempt += 1) {
        const response = await fetchViaStaticProxy(url, request.signal);
        if (![429, 502, 503, 504].includes(response.status)) return response;
        if (attempt >= maxAttempts) {
          if ([
            "apteka-ru.translate.goog",
            "www-budzdorov-ru.translate.goog",
            "www-asna-ru.translate.goog"
          ].includes(url.hostname)) {
            try {
              const direct = await fetch(request);
              if (direct.ok) {
                await response.body?.cancel().catch(() => undefined);
                return direct;
              }
              await direct.body?.cancel().catch(() => undefined);
            } catch {
              request.signal.throwIfAborted();
            }
          }
          return response;
        }
        await response.body?.cancel().catch(() => undefined);
        request.signal.throwIfAborted();
        // Megamarket's translated product renderer intermittently returns two
        // consecutive 502s for a valid card. A third bounded attempt with a
        // short increasing cooldown recovers that exact route; every final
        // failure remains unchanged and fail-closed.
        const delayMs = url.hostname === "megamarket-ru.translate.goog" ? attempt * 500 : 200;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        request.signal.throwIfAborted();
      }
    }
    if (staticProxy && fixedAptekaTarget) {
      return fetchViaStaticProxy(url, request.signal);
    }
    if (staticProxy && fixedAsnaSitemapTarget) {
      // ASNA serves multi-megabyte card maps. Keep their bounded brand-filtered
      // route on the same fixed egress as the proven translated product card.
      return fetchViaStaticProxy(url, request.signal);
    }
    if (staticProxy && fixedWildberriesTarget) {
      let proxied: Response | undefined;
      try {
        // Agent egress is consistently throttled while the fixed Function
        // egress succeeds for the same bounded buyer API request. Prefer the
        // free fixed route so a healthy response never reaches Sandbox.
        proxied = await fetchWildberriesViaStaticProxy(url, request.signal);
        if (proxied.ok || !TRANSIENT_STATIC_PROXY_STATUSES.has(proxied.status)) return proxied;
      } catch (error) {
        if (request.signal.aborted) throw error;
      }
      try {
        const direct = await fetch(request);
        return direct.ok ? direct : proxied ?? direct;
      } catch (error) {
        if (proxied) return proxied;
        throw error;
      }
    }
    if (staticProxy && fixedYandexTarget && request.headers.get("x-ratings-yandex-direct-recovery") !== "1") {
      // EdgeOne's direct egress can leave an exact Yandex sitemap or product
      // request pending until the adapter's 90-second discovery deadline.
      // The fixed Function route is the proven collector path for these
      // allowlisted URLs, so use it immediately. Its response still passes
      // through the adapter's strict XML/product proof and fail-closed checks.
      return fetchViaStaticProxy(url, request.signal);
    }
    if (staticProxy && fixedZdravcityTarget) {
      try {
        const direct = await fetch(request);
        const shouldFallback = [403, 408, 425, 429].includes(direct.status) || direct.status >= 500;
        if (!shouldFallback) return direct;
        const proxied = await fetchViaStaticProxy(url, request.signal);
        if (proxied.ok) {
          await direct.body?.cancel().catch(() => undefined);
          return proxied;
        }
        await proxied.body?.cancel().catch(() => undefined);
        return direct;
      } catch {
        return fetchViaStaticProxy(url, request.signal);
      }
    }
    if (staticProxy && host === "vapteke.ru" && !shouldUseHardenedBrowser(request)) {
      return fetchVaptekeViaStaticProxy(request);
    }
    if (staticProxy && (
      host === "uteka.ru" ||
      host === "megapteka.ru" ||
      host === "irecommend.ru" ||
      host === "otzovik.com" ||
      host === "vseotzyvy.ru" ||
      host === "pravogolosa.net" ||
      host === "ru.otzyv.com" ||
      host === "med-otzyv.ru"
    )) {
      return fetchViaStaticProxy(url, request.signal);
    }
    if (!shouldUseHardenedBrowser(request)) {
      return fetch(request);
    }
    const browserMode = request.headers.get("x-ratings-browser-mode");
    if (browserMode === "ozon-composer") {
      if (url.protocol !== "https:" || url.hostname !== "www.ozon.ru" || url.pathname !== "/api/composer-api.bx/page/json/v2") {
        throw new Error("Ozon browser mode is restricted to the fixed composer endpoint");
      }
      if ([...url.searchParams.keys()].some((key) => key !== "url") || url.searchParams.getAll("url").length !== 1) {
        throw new Error("Ozon composer request has unexpected parameters");
      }
      const nested = new URL(url.searchParams.get("url") ?? "", "https://www.ozon.ru");
      const nestedPage = nested.searchParams.get("page");
      const safeSearch = nested.origin === "https://www.ozon.ru" && nested.pathname === "/search/" &&
        !nested.hash && (nested.searchParams.get("text")?.trim().length ?? 0) > 0 &&
        (nested.searchParams.get("text")?.trim().length ?? 0) <= 160 &&
        nested.searchParams.get("from_global") === "true" &&
        (nestedPage === null || /^\d+$/.test(nestedPage) && Number(nestedPage) >= 2 && Number(nestedPage) <= 100) &&
        [...nested.searchParams.keys()].every((key) => ["text", "from_global", "page"].includes(key));
      const safeProduct = nested.origin === "https://www.ozon.ru" && !nested.hash && !nested.search &&
        /^\/product\/[a-z0-9-]*\d{5,}\/$/i.test(nested.pathname);
      if (!safeSearch && !safeProduct) {
        throw new Error("Ozon composer request is restricted to product search or one exact product card");
      }
      // First try a fixed, authenticated Cloud Function egress. It costs no
      // Sandbox GB-s and preserves the browser path as a fallback when Ozon
      // blocks that IP range too.
      if (staticProxy) {
        try {
          const proxied = await fetchViaStaticProxy(url, request.signal);
          const contentType = proxied.headers.get("content-type") ?? "";
          if (proxied.ok && /json/i.test(contentType)) return proxied;
        } catch {
          // Continue to the hardened browser route below.
        }
      }
      let response!: Response;
      queue = queue.catch(() => undefined).then(async () => {
        request.signal.throwIfAborted();
        await assertSafePublicDestination(url.toString());
        const page = await getOzonPage();
        const result = await withDeadline(page.evaluate(async (endpoint) => {
          const value = await fetch(endpoint, { credentials: "include", headers: { accept: "application/json" } });
          return {
            status: value.status,
            text: await value.text(),
            contentType: value.headers.get("content-type") ?? "application/json",
            finalUrl: value.url
          };
        }, url.toString()), 45_000, "Ozon composer browser request exceeded 45000 ms");
        await Promise.all(ozonResponseChecks);
        if (ozonNetworkViolation) throw ozonNetworkViolation;
        const final = await assertSafePublicDestination(result.finalUrl || url.toString());
        if (!sameDomain("ozon.ru", final.hostname)) throw new Error(`Ozon composer redirected to ${final.hostname}`);
        response = new Response(result.text, {
          status: result.status >= 200 && result.status <= 599 ? result.status : 502,
          headers: { "content-type": result.contentType, "x-ratings-final-url": final.toString() }
        });
      });
      await queue;
      return response;
    }
    if (browserMode === "yandex-market-proof") {
      const query = url.searchParams.get("text")?.normalize("NFKC").trim() ?? "";
      const pageText = url.searchParams.get("page") ?? "1";
      const isSearch = url.protocol === "https:" && url.hostname === "market.yandex.ru" &&
        url.pathname === "/search" && !url.hash && query.length >= 2 && query.length <= 160 &&
        /^\d+$/.test(pageText) && Number(pageText) >= 1 && Number(pageText) <= 50 &&
        url.searchParams.getAll("text").length === 1 && url.searchParams.getAll("page").length <= 1 &&
        [...url.searchParams.keys()].every((key) => key === "text" || key === "page");
      const card = url.pathname.match(/^\/card\/([a-z0-9][a-z0-9-]*)\/(\d+)\/reviews\/?$/i);
      const isCard = url.protocol === "https:" && url.hostname === "market.yandex.ru" && !url.search &&
        !url.hash && Boolean(card);
      if (!isSearch && !isCard) {
        throw new Error("Yandex Market browser proof is restricted to bounded search or exact reviews routes");
      }
      if (isSearch && staticProxy) {
        // Yandex intermittently serves an unhydrated 200 shell from one fixed
        // egress request and the complete source-bound ItemList immediately
        // afterwards. Retry that exact bounded URL once before entering the
        // shared Sandbox queue. Both attempts use the same strict proof; two
        // misses still fall through and can never become an empty result.
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const proxied = await fetchViaStaticProxy(url, request.signal);
            const contentType = proxied.headers.get("content-type") ?? "";
            const contentLength = Number(proxied.headers.get("content-length"));
            if (proxied.ok && /html/i.test(contentType) &&
              (!Number.isFinite(contentLength) || contentLength <= 10_000_000)) {
              const html = await proxied.text();
              if (html.length <= 10_000_000) {
                const proof = extractYandexMarketSearchHtmlProof(html, query, Number(pageText));
                if (proof) return json(proof);
              }
            }
          } catch (error) {
            request.signal.throwIfAborted();
            if (attempt === 2) break;
          }
          request.signal.throwIfAborted();
          if (attempt === 1) {
            await abortableDelay(YANDEX_MARKET_STATIC_RETRY_DELAY_MS, request.signal);
          }
        }
        // The strict first-party JSON-LD proof was unavailable twice through
        // fixed egress. Continue to the rendered browser route without changing
        // a challenge, timeout or unknown response into an empty result.
      }
      let response!: Response;
      queue = queue.catch(() => undefined).then(async () => {
        request.signal.throwIfAborted();
        const initial = await assertSafePublicDestination(url.toString());
        const context = await getContext("trusted-yandex-market");
        const page = await context.newPage();
        try {
          const responseChecks: Promise<void>[] = [];
          let networkViolation: Error | undefined;
          page.on("response", (pageResponse) => {
            responseChecks.push(assertActualServer(pageResponse).catch((error) => {
              networkViolation ??= error as Error;
            }));
          });
          await page.route("**/*", async (route) => {
            const targetText = route.request().url();
            if (/^(?:data|blob):/i.test(targetText)) return route.continue();
            try {
              await assertSafePublicDestination(targetText);
              return route.continue();
            } catch {
              return route.abort("blockedbyclient");
            }
          });
          const navigation = await page.goto(initial.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
          if (!navigation) throw new Error("Yandex Market browser proof returned no network response");
          await assertActualServer(navigation);
          const final = await assertSafePublicDestination(page.url() || initial.toString());
          if (!sameDomain("market.yandex.ru", final.hostname) || final.pathname !== initial.pathname) {
            throw new Error(`Yandex Market browser proof redirected to ${final.hostname}${final.pathname}`);
          }

          if (isSearch) {
            let explicitNoResults = false;
            let visibleProducts = 0;
            for (let attempt = 0; attempt < 30; attempt += 1) {
              request.signal.throwIfAborted();
              await page.waitForTimeout(1_000);
              const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
              explicitNoResults = hasExplicitYandexMarketNoResults(bodyText, query);
              visibleProducts = await page.locator('article a[href*="/card/"]').count();
              if (explicitNoResults || visibleProducts > 0) break;
            }
            if (!explicitNoResults && visibleProducts === 0) {
              throw new Error("Yandex Market search rendered neither product cards nor explicit no-results proof");
            }
            const pageNumber = Number(pageText);
            const proof = await page.evaluate(({ query, pageNumber, explicitNoResults }) => {
              const products = new Map<string, {
                id: string;
                name: string;
                url: string;
                ratingCount?: number;
                rating?: number;
                familyId?: string;
              }>();
              const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
              const structuredNumber = (value: unknown): number | undefined => {
                if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
                if (typeof value !== "string" || !value.trim()) return undefined;
                const normalized = value.trim().replace(",", ".");
                if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return undefined;
                const parsed = Number(normalized);
                return Number.isFinite(parsed) ? parsed : undefined;
              };
              for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
                let itemList: Record<string, unknown>;
                try { itemList = JSON.parse(script.textContent ?? "") as Record<string, unknown>; }
                catch { continue; }
                if (itemList["@type"] !== "ItemList" || typeof itemList.name !== "string" ||
                  !itemList.name.normalize("NFKC").toLocaleLowerCase("ru-RU").includes(normalizedQuery) ||
                  !Array.isArray(itemList.itemListElement)) continue;
                for (const entry of itemList.itemListElement) {
                  if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
                  const item = (entry as Record<string, unknown>).item;
                  if (!item || typeof item !== "object" || Array.isArray(item)) continue;
                  const product = item as Record<string, unknown>;
                  const name = typeof product.name === "string" ? product.name.trim() : "";
                  const rawUrl = typeof product.url === "string" ? product.url :
                    typeof product["@id"] === "string" ? product["@id"] : "";
                  let target: URL;
                  try { target = new URL(rawUrl, window.location.origin); }
                  catch { continue; }
                  const match = target.pathname.match(/^\/card\/[a-z0-9][a-z0-9-]*\/(\d+)\/?$/i);
                  if (!name || target.origin !== "https://market.yandex.ru" || !match) continue;
                  target.search = "";
                  target.hash = "";
                  const proof: {
                    id: string;
                    name: string;
                    url: string;
                    ratingCount?: number;
                    rating?: number;
                    familyId?: string;
                  } = { id: match[1]!, name, url: target.toString() };
                  const aggregate = product.aggregateRating;
                  if (aggregate && typeof aggregate === "object" && !Array.isArray(aggregate)) {
                    const ratingCount = structuredNumber((aggregate as Record<string, unknown>).ratingCount);
                    const rating = structuredNumber((aggregate as Record<string, unknown>).ratingValue);
                    if (ratingCount !== undefined && Number.isSafeInteger(ratingCount) && ratingCount >= 0 &&
                      rating !== undefined && rating >= 0 && rating <= 5 && (ratingCount === 0 || rating > 0)) {
                      proof.ratingCount = ratingCount;
                      proof.rating = rating;
                    }
                  }
                  const familyId = typeof product.sku === "number" || typeof product.sku === "string"
                    ? String(product.sku).trim()
                    : "";
                  if (/^\d{1,40}$/.test(familyId)) proof.familyId = familyId;
                  products.set(match[1]!, proof);
                }
              }
              for (const article of document.querySelectorAll("article")) {
                const link = article.querySelector<HTMLAnchorElement>('a[href*="/card/"]');
                if (!link) continue;
                let target: URL;
                try { target = new URL(link.href, window.location.origin); }
                catch { continue; }
                const match = target.pathname.match(/^\/card\/[a-z0-9][a-z0-9-]*\/(\d+)\/?$/i);
                if (target.origin !== "https://market.yandex.ru" || !match) continue;
                target.search = "";
                target.hash = "";
                const imageTitle = article.querySelector<HTMLImageElement>("img[alt]")?.alt?.trim();
                const name = imageTitle || link.textContent?.replace(/\s+/g, " ").trim() || "";
                if (!name) continue;
                if (!products.has(match[1]!)) {
                  products.set(match[1]!, { id: match[1]!, name, url: target.toString() });
                }
              }
              let hasNext = false;
              for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
                try {
                  const target = new URL(anchor.href, window.location.origin);
                  if (target.origin === "https://market.yandex.ru" && target.pathname === "/search" &&
                    target.searchParams.get("text") === query && Number(target.searchParams.get("page")) === pageNumber + 1) {
                    hasNext = true;
                    break;
                  }
                } catch { /* ignore malformed page links */ }
              }
              return { query, page: pageNumber, hasNext, products: [...products.values()], explicitNoResults };
            }, { query, pageNumber, explicitNoResults });
            if (proof.products.length === 0 && !proof.explicitNoResults) {
              throw new Error("Yandex Market search product proof disappeared before extraction");
            }
            response = json({
              query: proof.query,
              page: proof.page,
              hasNext: proof.hasNext,
              products: proof.products
            });
          } else {
            let productProof = false;
            for (let attempt = 0; attempt < 30; attempt += 1) {
              request.signal.throwIfAborted();
              await page.waitForTimeout(1_000);
              productProof = await page.locator('script[type="application/ld+json"]').evaluateAll((nodes) =>
                nodes.some((node) => /"@type"\s*:\s*"Product"/i.test(node.textContent ?? ""))
              );
              if (productProof) break;
            }
            if (!productProof) throw new Error(`Yandex Market card ${card![2]} has no rendered Product JSON-LD`);
            response = new Response(await page.content(), {
              status: navigation.status() >= 200 && navigation.status() <= 599 ? navigation.status() : 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
                "x-ratings-final-url": final.toString(),
                "x-ratings-proof-route": "yandex-market-browser"
              }
            });
          }
          await Promise.all(responseChecks);
          if (networkViolation) throw networkViolation;
        } finally {
          await page.close();
        }
      });
      await queue;
      return response;
    }
    if (browserMode === "wildberries-api") {
      const fixedSearch = url.hostname === "search.wb.ru" && [
        "/exactmatch/ru/common/v14/search",
        "/exactmatch/ru/common/v18/search"
      ].includes(url.pathname);
      const fixedCard = url.hostname === "card.wb.ru" && url.pathname === "/cards/v4/detail";
      if (url.protocol !== "https:" || (!fixedSearch && !fixedCard)) {
        throw new Error("Wildberries browser mode is restricted to the fixed search and card endpoints");
      }
      let response!: Response;
      queue = queue.catch(() => undefined).then(async () => {
        request.signal.throwIfAborted();
        await assertSafePublicDestination(url.toString());
        const page = await getWildberriesPage();
        const result = await withDeadline(page.evaluate(async (endpoint) => {
          const value = await fetch(endpoint, {
            credentials: "include",
            headers: { accept: "application/json, text/plain, */*" }
          });
          return {
            status: value.status,
            text: await value.text(),
            contentType: value.headers.get("content-type") ?? "application/json",
            finalUrl: value.url
          };
        }, url.toString()), 45_000, "Wildberries API browser request exceeded 45000 ms");
        await Promise.all(wildberriesResponseChecks);
        if (wildberriesNetworkViolation) throw wildberriesNetworkViolation;
        const final = await assertSafePublicDestination(result.finalUrl || url.toString());
        const isExpectedFinal =
          fixedSearch && final.hostname === "search.wb.ru" && final.pathname === url.pathname ||
          fixedCard && final.hostname === "card.wb.ru" && final.pathname === "/cards/v4/detail";
        if (!isExpectedFinal) throw new Error(`Wildberries API redirected to ${final.hostname}`);
        response = new Response(result.text, {
          status: result.status >= 200 && result.status <= 599 ? result.status : 502,
          headers: { "content-type": result.contentType, "x-ratings-final-url": final.toString() }
        });
      });
      await queue;
      return response;
    }
    if (browserMode === "wildberries-search-proof") {
      const query = url.searchParams.get("search")?.trim() ?? "";
      const pageNumber = url.searchParams.get("page") ?? "1";
      const allowedParameters = [...url.searchParams.keys()].every((key) => key === "search" || key === "page");
      if (
        url.protocol !== "https:" ||
        url.hostname !== "www.wildberries.ru" ||
        url.pathname !== "/catalog/0/search.aspx" ||
        !allowedParameters ||
        query.length < 1 ||
        query.length > 200 ||
        !/^\d+$/.test(pageNumber) ||
        Number(pageNumber) < 1 ||
        Number(pageNumber) > 50
      ) {
        throw new Error("Wildberries search proof is restricted to a bounded public search URL");
      }
      let response!: Response;
      queue = queue.catch(() => undefined).then(async () => {
        request.signal.throwIfAborted();
        const initial = await assertSafePublicDestination(url.toString());
        try {
          const direct = await fetch(initial, {
            method: "GET",
            redirect: "follow",
            signal: request.signal,
            headers: {
              accept: "text/html,application/xhtml+xml",
              "accept-language": "ru-RU,ru;q=0.9"
            }
          });
          const directFinal = await assertSafePublicDestination(direct.url || initial.toString());
          if (sameDomain("wildberries.ru", directFinal.hostname) && direct.ok) {
            const directText = await direct.text();
            if (hasExplicitWildberriesNoResults(directText, query)) {
              response = new Response(JSON.stringify({
                products: [],
                total: 0,
                metadata: { source: "wildberries-static-explicit-no-results", query }
              }), {
                status: 200,
                headers: {
                  "content-type": "application/json; charset=utf-8",
                  "x-ratings-final-url": directFinal.toString()
                }
              });
              return;
            }
          }
        } catch {
          // Continue to the bounded browser proof below.
        }
        const page = await getWildberriesPage();
        const navigation = await page.goto(initial.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
        if (!navigation) throw new Error("Wildberries search proof returned no network response");
        await assertActualServer(navigation);
        const final = await assertSafePublicDestination(page.url() || initial.toString());
        if (!sameDomain("wildberries.ru", final.hostname) || final.pathname !== "/catalog/0/search.aspx") {
          throw new Error(`Wildberries search proof redirected to ${final.hostname}${final.pathname}`);
        }

        let explicitNoResults = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          request.signal.throwIfAborted();
          await page.waitForTimeout(1_000);
          const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
          if (hasExplicitWildberriesNoResults(bodyText, query)) {
            explicitNoResults = true;
            break;
          }
          const visibleProducts = await page.locator('a[href*="/catalog/"][href*="/detail.aspx"]').count();
          if (visibleProducts > 0) break;
        }
        await Promise.all(wildberriesResponseChecks);
        if (wildberriesNetworkViolation) throw wildberriesNetworkViolation;
        response = new Response(
          explicitNoResults
            ? JSON.stringify({
              products: [],
              total: 0,
              metadata: { source: "wildberries-visible-explicit-no-results", query }
            })
            : JSON.stringify({ error: "No explicit Wildberries no-results proof was rendered" }),
          {
            status: explicitNoResults ? 200 : 503,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "x-ratings-final-url": final.toString()
            }
          }
        );
      });
      await queue;
      return response;
    }
    const shouldScroll = request.headers.get("x-ratings-scroll") === "1";
    // Only reviewed first-party adapters are allowed to execute page
    // JavaScript. Newly supplied domains remain static with subresources
    // blocked until a dedicated adapter is reviewed.
    const trustedContext = url.hostname === "reviews.yandex.ru"
      ? "trusted-yandex"
      : sameDomain(url.hostname, "irecommend.ru")
        ? "trusted-irecommend"
        : "untrusted-static";
    const trustedDynamic = trustedContext !== "untrusted-static";
    let response!: Response;
    queue = queue.catch(() => undefined).then(async () => {
      const initial = await assertSafePublicDestination(url.toString());
        const context = await getContext(trustedContext);
      const page = await context.newPage();
      try {
        const responseChecks: Promise<void>[] = [];
        let networkViolation: Error | undefined;
        page.on("response", (pageResponse) => {
          responseChecks.push(assertActualServer(pageResponse).catch((error) => {
            networkViolation ??= error as Error;
          }));
        });
        await page.route("**/*", async (route) => {
          const targetText = route.request().url();
          if (/^(?:data|blob):/i.test(targetText)) return route.continue();
          try {
            const target = await assertSafePublicDestination(targetText);
            const isMainNavigation = route.request().isNavigationRequest() && route.request().frame() === page.mainFrame();
            if (isMainNavigation && !sameDomain(initial.hostname, target.hostname)) return route.abort("blockedbyclient");
            if (!isMainNavigation && !trustedDynamic) return route.abort("blockedbyclient");
            return route.continue();
          } catch {
            return route.abort("blockedbyclient");
          }
        });
        const navigation = await page.goto(initial.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (!navigation) throw new Error(`Браузер не получил сетевой ответ от ${initial.hostname}`);
        await assertActualServer(navigation);
        const final = await assertSafePublicDestination(page.url() || initial.toString());
        if (!sameDomain(initial.hostname, final.hostname)) {
          throw new Error(`Браузерное перенаправление на другой домен запрещено: ${final.hostname}`);
        }
        if (shouldScroll && trustedDynamic) {
          let previousHeight = 0; let stableRounds = 0;
          for (let index = 0; index < 20 && stableRounds < 3; index += 1) {
            const height = await page.evaluate(() => {
              const value = Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0);
              window.scrollTo(0, value);
              return value;
            });
            stableRounds = height === previousHeight ? stableRounds + 1 : 0;
            previousHeight = height;
            await page.waitForTimeout(500);
          }
        }
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
        await Promise.all(responseChecks);
        if (networkViolation) throw networkViolation;
        const navigationHeaders = await navigation.allHeaders();
        const isHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(navigationHeaders["content-type"] ?? "");
        const content = shouldScroll && trustedDynamic || isHtml
          ? await page.content()
          : new Uint8Array(await withDeadline(
            navigation.body(),
            30_000,
            `Чтение браузерного ответа от ${final.hostname} превысило 30000 мс`
          ));
        response = new Response(content, {
          status: navigation?.status() && navigation.status() >= 200 && navigation.status() <= 599 ? navigation.status() : 200,
          headers: {
            "content-type": navigationHeaders["content-type"] ?? "text/html; charset=utf-8",
            "x-ratings-final-url": final.toString()
          }
        });
      } finally {
        await page.close();
      }
    });
    await queue;
    return response;
  }) as YandexMarketCapableFetch;
  if (staticProxy) routedFetch.yandexBatchEndpoint = YANDEX_BATCH_ENDPOINT;
  if (staticProxy) routedFetch.yandexDirectRecovery = true;
  routedFetch.yandexMarketBrowserEndpoint = "https://market.yandex.ru/search";
  return routedFetch;
}

export async function onRequest(context: AgentContext): Promise<Response> {
  if (context.request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let user;
  try { user = await authenticate(context.request.headers, authConfig(context.env)); }
  catch (error) { return json({ error: safeErrorMessage(error) }, 401); }
  try {
    const body = await readAgentJson<{ runId?: string }>(context.request);
    if (!body.runId || !/^[0-9a-f-]{36}$/i.test(body.runId)) throw new Error("Некорректный runId");
    const endpoint = collectorPublicEndpoint("/api/internal/repository");
    const repository = new RemoteRepository(endpoint, context.env.INTERNAL_AGENT_TOKEN ?? "");
    const lease = await repository.acquireLease(`execute-run:${body.runId}`, 3_700_000);
    try {
      const run = await repository.getRun(body.runId);
      if (!run) throw new Error("Запуск не найден");
      if (run.ownerEmail && run.ownerEmail !== user.email) throw new Error("Этот запуск принадлежит другому сотруднику");
      const ozonLease = run.request.domains.includes("ozon.ru")
        ? await repository.acquireLease("collection:ozon", 3_700_000)
        : undefined;
      try {
        const localApifyExclusive = createSerialExecutor();
        const apifyExclusive = <T>(operation: () => Promise<T>) => localApifyExclusive(async () => {
          let apifyLease: { token: string; keys: string[] };
          try {
            apifyLease = await repository.acquireLease("collection:apify", 370_000);
          } catch (error) {
            throw new AdapterQuotaError(`Apify fallback is busy in another run: ${safeErrorMessage(error)}`);
          }
          try {
            return await operation();
          } finally {
            await repository.releaseLease(apifyLease).catch(() => undefined);
          }
        });
        const runtimeOptions = () => ({
          repository,
          evidence: new RemoteEvidenceStore(repository),
          fetch: browserFetch(context.sandbox, {
            endpoint: collectorPublicEndpoint("/api/internal/static-review-fetch"),
            token: context.env.INTERNAL_AGENT_TOKEN ?? ""
          }),
          env: context.env,
          apifyExclusive
        });
        let runtime = await createCollectorRuntime(runtimeOptions());
        try {
          let completed = await runtime.service.executeRun(run.id);
          for (
            let recoveryPass = 0;
            recoveryPass < MAX_INITIAL_TRANSIENT_RECOVERY_PASSES &&
              shouldAutoRetryInitialCollection(run.status, completed.partitions);
            recoveryPass += 1
          ) {
            // A fresh runtime clears per-adapter cooldowns and transient route
            // state. Successful partitions are checkpointed, so the second
            // through fourth passes touch only failed domain/brand pairs and cannot create
            // duplicate observations.
            const recoveryDelay = transientRecoveryDelayMs(completed.partitions, recoveryPass);
            if (recoveryDelay > 0) {
              context.request.signal.throwIfAborted();
              await new Promise((resolve) => setTimeout(resolve, recoveryDelay));
              context.request.signal.throwIfAborted();
            }
            runtime = await createCollectorRuntime(runtimeOptions());
            completed = await runtime.service.executeRun(run.id);
          }
          return json({ id: completed.id, status: completed.status });
        } catch (error) {
          const failed = await runtime.service.getRun(run.id);
          if (failed) {
            failed.status = "failed";
            failed.updatedAt = new Date().toISOString();
            failed.errors.push({ partition: "orchestrator", message: safeErrorMessage(error) });
            await runtime.repository.saveRun(failed);
          }
          throw error;
        }
      } finally {
        if (ozonLease) await repository.releaseLease(ozonLease);
      }
    } finally {
      await repository.releaseLease(lease);
    }
  } catch (error) {
    return json({ error: safeErrorMessage(error) }, 400);
  }
}
