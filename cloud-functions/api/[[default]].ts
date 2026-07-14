import { timingSafeEqual } from "node:crypto";
import { INITIAL_BRANDS, INITIAL_DOMAINS } from "../../src/shared/constants.js";
import type { RunState } from "../../src/shared/types.js";
import { authenticate, authConfig, type AuthUser } from "../../src/server/auth.js";
import { BlobEvidenceStore, BlobRepository } from "../../src/server/blob-repository.js";
import { RatingsService } from "../../src/server/orchestrator.js";
import type { RepositoryRpc } from "../../src/server/remote-repository.js";
import { prepareBrowserPublication, reconcileBrowserPublication } from "../../src/server/sheets/publication-state.js";
import { safeErrorMessage } from "../../src/server/utils/error-message.js";
import { readTextBounded, safeFetch } from "../../src/server/utils/safe-fetch.js";
import { readerMarkdownToHtml, readerProxyUrl } from "../../src/server/utils/reader-proxy.js";

type Context = { request: Request; env: Record<string, string | undefined> };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertOwner(run: RunState, user: AuthUser): void {
  if (run.ownerEmail && run.ownerEmail !== user.email) throw new Error("Этот запуск принадлежит другому сотруднику");
}

function pagedRun(run: RunState, url: URL): RunState & { observationPage: { offset: number; limit: number; total: number } } {
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset") ?? 0)) || 0);
  const limit = Math.max(1, Math.min(250, Math.trunc(Number(url.searchParams.get("limit") ?? 200)) || 200));
  return { ...run, observations: run.observations.slice(offset, offset + limit), observationPage: { offset, limit, total: run.observations.length } };
}

async function repositoryRpc(request: Request, env: Record<string, string | undefined>, repository: BlobRepository): Promise<Response> {
  const configured = env.INTERNAL_AGENT_TOKEN?.trim() ?? "";
  const supplied = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (configured.length < 32 || !secureEqual(configured, supplied)) return json({ error: "Internal authorization failed" }, 401);
  const body = await request.json() as RepositoryRpc;
  let result: unknown;
  switch (body.action) {
    case "getRun": result = await repository.getRun(body.id); break;
    case "saveRun": {
      const previous = await repository.getRun(body.run.id);
      if (previous?.ownerEmail && body.run.ownerEmail !== previous.ownerEmail) throw new Error("Нельзя изменить владельца запуска");
      await repository.saveRun(body.run); result = null; break;
    }
    case "getProfile": result = await repository.getProfile(body.domain); break;
    case "saveProfile": await repository.saveProfile(body.profile); result = null; break;
    case "listProducts": result = await repository.listProducts(body.spreadsheetId); break;
    case "saveProducts": await repository.saveProducts(body.spreadsheetId, body.records); result = null; break;
    case "replaceProducts": await repository.replaceProducts(body.spreadsheetId, body.records); result = null; break;
    case "getSnapshots": result = await repository.getSnapshots(body.spreadsheetId); break;
    case "saveSnapshot": await repository.saveSnapshot(body.spreadsheetId, body.month, body.observations); result = null; break;
    case "replaceSnapshots": await repository.replaceSnapshots(body.spreadsheetId, body.snapshots); result = null; break;
    case "getPublication": result = await repository.getPublication(body.key); break;
    case "savePublication": await repository.savePublication(body.key, body.publication); result = null; break;
    case "reserveUsage": result = await repository.reserveUsage(body.key, body.amount, body.limit); break;
    case "releaseUsage": result = await repository.releaseUsage(body.key, body.amount); break;
    case "acquireLease": result = await repository.acquireLease(body.scope, body.leaseMs, 1); break;
    case "releaseLease": await repository.releaseLease(body.lease); result = null; break;
    case "putEvidence": result = await new BlobEvidenceStore().put(body.payload); break;
    default: return json({ error: "Unknown repository action" }, 400);
  }
  return json({ result });
}

async function staticReviewFetch(request: Request, env: Record<string, string | undefined>): Promise<Response> {
  const configured = env.INTERNAL_AGENT_TOKEN?.trim() ?? "";
  const supplied = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (configured.length < 32 || !secureEqual(configured, supplied)) return json({ error: "Internal authorization failed" }, 401);
  const body = await request.json() as { url?: string };
  const target = new URL(String(body.url ?? ""));
  const host = target.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  const reviewTarget = new Set([
    "uteka.ru",
    "megapteka.ru",
    "irecommend.ru",
    "otzovik.com",
    "pravogolosa.net"
  ]).has(host);
  const wildberriesTarget = (
    target.hostname === "search.wb.ru" && [
      "/exactmatch/ru/common/v14/search",
      "/exactmatch/ru/common/v18/search"
    ].includes(target.pathname) ||
    target.hostname === "card.wb.ru" && target.pathname === "/cards/v4/detail"
  );
  let ozonTarget = false;
  if (target.hostname === "www.ozon.ru" && target.pathname === "/api/composer-api.bx/page/json/v2") {
    const nested = target.searchParams.get("url") ?? "";
    try {
      const search = new URL(nested, "https://www.ozon.ru");
      const page = search.searchParams.get("page") ?? "1";
      ozonTarget = search.origin === "https://www.ozon.ru" &&
        search.pathname === "/search/" &&
        (search.searchParams.get("text")?.trim().length ?? 0) > 0 &&
        (search.searchParams.get("text")?.trim().length ?? 0) <= 200 &&
        [...search.searchParams.keys()].every((key) => ["text", "from_global", "page"].includes(key)) &&
        /^\d+$/.test(page) && Number(page) >= 1 && Number(page) <= 100;
    } catch { /* invalid nested Ozon search URL */ }
  }
  if (target.protocol !== "https:" || !(reviewTarget || wildberriesTarget || ozonTarget)) {
    return json({ error: "Static review fetch destination is not allowed" }, 400);
  }
  if (host === "megapteka.ru" || host === "irecommend.ru" || host === "otzovik.com") {
    let readerTarget = target;
    if (host === "otzovik.com" && target.pathname === "/__external_search__") {
      const brand = target.searchParams.get("brand")?.trim() ?? "";
      if (brand.length < 2 || brand.length > 160 || [...target.searchParams.keys()].some((key) => key !== "brand")) {
        return json({ error: "Invalid Otzovik external discovery query" }, 400);
      }
      readerTarget = new URL("https://html.duckduckgo.com/html/");
      readerTarget.searchParams.set("q", `site:otzovik.com/reviews/ "${brand}"`);
    }
    const reader = await safeFetch(readerProxyUrl(readerTarget).toString(), {
      method: "GET",
      redirect: "follow",
      headers: { accept: "text/plain; charset=utf-8", "x-no-cache": "true", "x-return-format": "html", dnt: "1" }
    });
    const readerBody = await readTextBounded(reader, 12_000_000, 60_000);
    if (!reader.ok) return new Response(readerBody, { status: reader.status, headers: { "content-type": "text/plain; charset=utf-8" } });
    const html = /^\s*(?:<!doctype\s+html|<html\b)/i.test(readerBody)
      ? readerBody
      : readerMarkdownToHtml(readerBody, target.toString());
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "reader-fallback"
      }
    });
  }
  const upstream = await safeFetch(target.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      accept: wildberriesTarget || ozonTarget ? "application/json, text/plain, */*" : "text/html,application/xhtml+xml",
      "accept-language": "ru-RU,ru;q=0.9",
      ...(wildberriesTarget ? {
        origin: "https://www.wildberries.ru",
        referer: "https://www.wildberries.ru/"
      } : {})
    }
  });
  const text = await readTextBounded(upstream, 12_000_000, 60_000);
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export default async function onRequest(context: Context): Promise<Response> {
  const url = new URL(context.request.url);
  if (url.pathname === "/api/config") return json({
    domains: INITIAL_DOMAINS, brands: INITIAL_BRANDS,
    googleClientId: null,
    authRequired: context.env.RATINGS_ALLOW_UNAUTHENTICATED !== "true", agentMode: true
  });
  if (url.pathname === "/api/health") return json({ ok: true, service: "ratings-collector", runtime: "edgeone" });
  const repository = new BlobRepository();
  if (url.pathname === "/api/internal/repository" && context.request.method === "POST") {
    try { return await repositoryRpc(context.request, context.env, repository); }
    catch (error) { return json({ error: safeErrorMessage(error) }, 400); }
  }
  if (url.pathname === "/api/internal/static-review-fetch" && context.request.method === "POST") {
    try { return await staticReviewFetch(context.request, context.env); }
    catch (error) { return json({ error: safeErrorMessage(error) }, 502); }
  }
  let user: AuthUser;
  try { user = await authenticate(context.request.headers, authConfig(context.env)); }
  catch (error) { return json({ error: safeErrorMessage(error) }, 401); }
  const service = new RatingsService(repository, async () => { throw new Error("Адаптеры выполняются только в изолированном Agent"); });
  try {
    if (context.request.method === "POST" && url.pathname === "/api/runs") {
      const input = await context.request.json();
      // Ozon first uses the free browser collector. The capped Apify fallback
      // performs a live quota check immediately before each serialized Actor
      // call, so creating a run must not fail merely because fallback credit is
      // unavailable.
      const run = await service.createRun(input, user.email);
      return json(pagedRun(run, url), 202);
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    const publishMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/publish$/);
    const reviewMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/review$/);
    const profileGetMatch = url.pathname.match(/^\/api\/site-profiles\/([^/]+)$/);
    const profileMatch = url.pathname.match(/^\/api\/site-profiles\/([^/]+)\/approve$/);
    if (context.request.method === "GET" && runMatch) {
      let run = await service.getRun(decodeURIComponent(runMatch[1]));
      if (!run) return json({ error: "Запуск не найден" }, 404);
      assertOwner(run, user);
      if (run.status !== "published") run = await reconcileBrowserPublication(repository, run);
      return json(pagedRun(run, url));
    }
    if (context.request.method === "POST" && publishMatch) {
      const run = await service.getRun(decodeURIComponent(publishMatch[1]));
      if (!run) return json({ error: "Запуск не найден" }, 404);
      assertOwner(run, user);
      const intent = await prepareBrowserPublication(repository, service, run);
      return json(pagedRun(intent.run, url), intent.shouldPublish ? 202 : 200);
    }
    if (context.request.method === "POST" && reviewMatch) {
      const run = await service.getRun(decodeURIComponent(reviewMatch[1]));
      if (!run) return json({ error: "Запуск не найден" }, 404);
      assertOwner(run, user);
      const body = await context.request.json() as { acceptedKeys?: string[] };
      return json(pagedRun(await service.approveObservations(run.id, body.acceptedKeys ?? []), url));
    }
    if (context.request.method === "GET" && profileGetMatch) {
      const profile = await repository.getProfile(decodeURIComponent(profileGetMatch[1]));
      return profile ? json(profile) : json({ error: "Профиль площадки не найден" }, 404);
    }
    if (context.request.method === "POST" && profileMatch) {
      const body = await context.request.json() as {
        examples?: Array<{ url: string; title?: string }>;
        reviewCountMeaning?: "reviews" | "ratings" | "feedback" | "unknown";
      };
      return json(await service.approveProfile(
        decodeURIComponent(profileMatch[1]), body.examples ?? [], body.reviewCountMeaning ?? "unknown"
      ));
    }
    return json({ error: "API route not found" }, 404);
  } catch (error) {
    return json({ error: safeErrorMessage(error) }, 400);
  }
}
