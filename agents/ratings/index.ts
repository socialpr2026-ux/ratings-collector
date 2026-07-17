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
type YandexBatchCapableFetch = typeof fetch & { yandexBatchEndpoint?: string };

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

export function createLazySandboxAcquire(sandbox: Pick<SandboxApi, "commands">): () => Promise<void> {
  let acquisition: Promise<void> | undefined;
  return () => acquisition ??= Promise.resolve()
    .then(() => sandbox.commands.run("true"))
    .then(() => undefined)
    .catch((error) => {
      throw new AdapterBlockedError(`EdgeOne Sandbox is unavailable: ${safeErrorMessage(error)}`);
    });
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
  const fetchViaStaticProxy = (url: URL, signal: AbortSignal) => {
    if (!staticProxy) throw new Error("Static proxy is not configured");
    return fetch(staticProxy.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${staticProxy.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ url: url.toString() }),
      signal
    });
  };
  const fetchYandexBatchViaStaticProxy = async (request: Request) => {
    if (!staticProxy) throw new Error("Static proxy is not configured");
    const text = await request.text();
    if (text.length > 100_000) throw new Error("Yandex batch request exceeds the internal safety limit");
    let batch: unknown;
    try { batch = JSON.parse(text); }
    catch { throw new Error("Yandex batch request is not valid JSON"); }
    return fetch(staticProxy.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${staticProxy.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ url: request.url, yandexBatch: batch }),
      signal: request.signal
    });
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
  const getContext = (key: "trusted-yandex" | "trusted-irecommend" | "trusted-ozon" | "trusted-wildberries" | "untrusted-static") => {
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
      "megamarket-ru.translate.goog"
    ].includes(url.hostname)) {
      const first = await fetchViaStaticProxy(url, request.signal);
      if (![429, 502, 503, 504].includes(first.status)) return first;
      await first.body?.cancel().catch(() => undefined);
      request.signal.throwIfAborted();
      // One bounded retry covers a transient Function/upstream hand-off. A
      // second failure is returned unchanged and remains fail-closed.
      await new Promise((resolve) => setTimeout(resolve, 200));
      request.signal.throwIfAborted();
      return fetchViaStaticProxy(url, request.signal);
    }
    if (staticProxy && fixedAptekaTarget) {
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
    if (staticProxy && fixedYandexTarget) {
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
    if (staticProxy && (
      host === "uteka.ru" ||
      host === "megapteka.ru" ||
      host === "irecommend.ru" ||
      host === "otzovik.com" ||
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
  }) as YandexBatchCapableFetch;
  if (staticProxy) routedFetch.yandexBatchEndpoint = YANDEX_BATCH_ENDPOINT;
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
    const endpoint = new URL("/api/internal/repository", context.request.url).toString();
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
            endpoint: new URL("/api/internal/static-review-fetch", context.request.url).toString(),
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
