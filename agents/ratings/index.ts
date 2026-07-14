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
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    if (staticProxy && (host === "uteka.ru" || host === "megapteka.ru" || host === "irecommend.ru" || host === "otzovik.com")) {
      return fetch(staticProxy.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${staticProxy.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ url: url.toString() }),
        signal: request.signal
      });
    }
    if (!shouldUseHardenedBrowser(request)) {
      return fetch(request);
    }
    const browserMode = request.headers.get("x-ratings-browser-mode");
    if (browserMode === "ozon-composer") {
      if (url.protocol !== "https:" || url.hostname !== "www.ozon.ru" || url.pathname !== "/api/composer-api.bx/page/json/v2") {
        throw new Error("Ozon browser mode is restricted to the fixed composer endpoint");
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
      const fixedSearch = url.hostname === "search.wb.ru" && url.pathname === "/exactmatch/ru/common/v18/search";
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
          fixedSearch && final.hostname === "search.wb.ru" && final.pathname === "/exactmatch/ru/common/v18/search" ||
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
  }) as typeof fetch;
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
        const runtime = await createCollectorRuntime({
          repository,
          evidence: new RemoteEvidenceStore(repository),
          fetch: browserFetch(context.sandbox, {
            endpoint: new URL("/api/internal/static-review-fetch", context.request.url).toString(),
            token: context.env.INTERNAL_AGENT_TOKEN ?? ""
          }),
          env: context.env,
          apifyExclusive
        });
        try {
          const completed = await runtime.service.executeRun(run.id);
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
