import { createHash } from "node:crypto";
import type { BrowserContext, Page, Route } from "playwright-core";
import { RatingsService } from "../../src/server/orchestrator.js";
import { RemoteEvidenceStore, RemoteRepository } from "../../src/server/remote-repository.js";
import {
  BrowserSheetRollbackError,
  BrowserSheetsPublisher,
  type BrowserSheetPublication
} from "../../src/server/sheets/browser-publisher.js";
import { PlaywrightSheetsUiDriver, type PlaywrightPageLike } from "../../src/server/sheets/browser-ui-driver.js";
import type { BrowserSheetReadback } from "../../src/server/sheets/browser-ui-driver.js";
import {
  AppsScriptSheetRollbackError,
  AppsScriptSheetsPublisher,
  type AppsScriptSheetReadback
} from "../../src/server/sheets/apps-script-publisher.js";
import { buildBrandSheetDocument } from "../../src/server/sheets/model.js";
import {
  ratingsTabNameForBrand,
  type RatingsTabName
} from "../../src/server/sheets/tab-name.js";
import {
  completeBrowserPublication,
  failBrowserPublication,
  prepareBrowserPublication,
  PublicationCommitUncertainError
} from "../../src/server/sheets/publication-state.js";
import { productKey } from "../../src/server/repository.js";
import { readAgentJson } from "../../src/server/utils/agent-request.js";
import { safeErrorMessage } from "../../src/server/utils/error-message.js";
import { loadPlaywright } from "../../src/server/utils/playwright-runtime.js";
import { playwrightCdpBaseUrl } from "../../src/server/utils/sandbox-cdp.js";
import { extractSpreadsheetId } from "../../src/server/utils/urls.js";

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

const OPEN_ACCESS_OWNER = "local@ratings";
const GOOGLE_RESOURCE_DOMAINS = [
  "google.com",
  "gstatic.com",
  "googleapis.com",
  "googleusercontent.com"
] as const;

/**
 * This deployment deliberately has one shared access level and does not use
 * Google OAuth. INTERNAL_AGENT_TOKEN still protects the private Agent ->
 * Cloud Function state channel and is unrelated to employee access.
 */
export function assertOpenPublisherMode(env: Record<string, string | undefined>): { email: string } {
  if (env.RATINGS_ALLOW_UNAUTHENTICATED !== "true") {
    throw new Error(
      "Открытый режим публикации не включён: задайте RATINGS_ALLOW_UNAUTHENTICATED=true; Google OAuth в этом проекте не используется"
    );
  }
  return { email: OPEN_ACCESS_OWNER };
}

export function isAllowedGoogleSheetsResource(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    return GOOGLE_RESOURCE_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

async function protectBrowser(page: Page): Promise<void> {
  await page.route("**/*", async (route: Route) => {
    const targetText = route.request().url();
    if (/^(?:data|blob|about):/i.test(targetText)) return route.continue();
    if (!isAllowedGoogleSheetsResource(targetText)) return route.abort("blockedbyclient");
    const target = new URL(targetText);
    const isMainNavigation = route.request().isNavigationRequest() && route.request().frame() === page.mainFrame();
    if (isMainNavigation && target.hostname.toLocaleLowerCase("en-US") !== "docs.google.com") {
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
}

function existingValues(readback: Awaited<ReturnType<PlaywrightSheetsUiDriver["captureCurrentRegion"]>>) {
  return readback.cells.map((row) => row.map((cell) => cell.text));
}

function readbackEvidence(readback: BrowserSheetReadback) {
  const payload = {
    plainText: readback.payload.plainText,
    htmlText: readback.payload.htmlText,
    formulas: readback.cells.map((row) => row.map((cell) => cell.formula ?? null)),
    merges: readback.merges
  };
  return {
    ...payload,
    sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex")
  };
}

function appsScriptReadbackEvidence(readback: AppsScriptSheetReadback) {
  const payload = {
    tabName: readback.tabName,
    values: readback.values,
    formulas: readback.formulas,
    merges: readback.merges,
    revision: readback.revision,
    rows: readback.rows,
    columns: readback.columns
  };
  return {
    ...payload,
    sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex")
  };
}

async function withSheetBrowser<T>(
  context: AgentContext,
  sheetUrl: string,
  action: (driver: PlaywrightSheetsUiDriver, page: Page) => Promise<T>
): Promise<T> {
  // EdgeOne initializes Sandbox lazily; cdpUrl is unavailable before one async call.
  await context.sandbox.commands.run("true");
  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(playwrightCdpBaseUrl(context.sandbox.browser.cdpUrl), {
    headers: { "X-Access-Token": context.sandbox.envdAccessToken },
    timeout: 60_000
  });
  let browserContext: BrowserContext | undefined;
  let page: Page | undefined;
  let ownsContext = false;
  try {
    // Publishing must never inherit marketplace cookies, service workers or a
    // signed-in Google session from another Agent page in the same Sandbox.
    browserContext = await browser.newContext({ locale: "ru-RU", serviceWorkers: "block" });
    ownsContext = true;
    page = await browserContext.newPage();
    await protectBrowser(page);
    const driver = new PlaywrightSheetsUiDriver(page as unknown as PlaywrightPageLike, {
      timeoutMs: 60_000,
      settleMs: 1_500,
      modifier: "Control"
    });
    await driver.open(sheetUrl);
    await driver.assertEditable();
    return await action(driver, page);
  } finally {
    await page?.close().catch(() => undefined);
    if (ownsContext) await browserContext?.close().catch(() => undefined);
  }
}

export function brandTabNames(brands: string[]): RatingsTabName[] {
  const tabNames = brands.map(ratingsTabNameForBrand);
  const identities = tabNames.map((tabName) => tabName.normalize("NFKC").toLocaleLowerCase("ru-RU"));
  if (new Set(identities).size !== tabNames.length) {
    throw new Error("Названия брендов дают одинаковые имена вкладок Google Sheets");
  }
  return tabNames;
}

export async function rollbackBrowserTabs(
  publisher: BrowserSheetsPublisher,
  publications: BrowserSheetPublication[],
  publishedCount: number,
  publicationError: unknown
): Promise<string[]> {
  const failures: string[] = [];
  for (let index = publishedCount - 1; index >= 0; index -= 1) {
    try {
      await publisher.rollbackVerifiedPublication(publications[index]!, publicationError);
    } catch (rollbackError) {
      if (rollbackError instanceof BrowserSheetRollbackError) failures.push(...rollbackError.rollbackMismatches);
      else failures.push(`${publications[index]!.tabName}: ${safeErrorMessage(rollbackError)}`);
    }
  }
  return failures;
}

export async function onRequest(context: AgentContext): Promise<Response> {
  if (context.request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let user;
  try { user = assertOpenPublisherMode(context.env); }
  catch (error) { return json({ error: safeErrorMessage(error) }, 401); }

  let repository: RemoteRepository | undefined;
  let runId = "";
  let ownerVerified = false;
  let runLease: { token: string; keys: string[] } | undefined;
  let sheetLease: { token: string; keys: string[] } | undefined;
  let operation: "preflight" | "publish" = "publish";
  const appsScriptUrl = context.env.SHEETS_APPS_SCRIPT_URL?.trim();
  try {
    const body = await readAgentJson<{ runId?: string; operation?: "preflight" | "publish" }>(context.request);
    runId = body.runId ?? "";
    if (body.operation !== undefined && body.operation !== "preflight" && body.operation !== "publish") {
      throw new Error("Некорректная операция sheet-publisher");
    }
    operation = body.operation ?? "publish";
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Некорректный runId");
    const endpoint = new URL("/api/internal/repository", context.request.url).toString();
    repository = new RemoteRepository(endpoint, context.env.INTERNAL_AGENT_TOKEN ?? "");
    const initial = await repository.getRun(runId);
    if (!initial) throw new Error("Запуск не найден");
    if (initial.ownerEmail && initial.ownerEmail !== user.email) {
      throw new Error("Этот запуск принадлежит другому сотруднику");
    }
    ownerVerified = true;
    const spreadsheetId = extractSpreadsheetId(initial.request.sheetUrl);
    try {
      runLease = await repository.acquireLease(`publish-run:${runId}`, 3_700_000);
    } catch (error) {
      const active = await repository.getRun(runId);
      if (active?.status === "publishing") {
        return json({
          id: active.id,
          status: active.status,
          publicationStatus: "publishing",
          alreadyRunning: true
        }, 202);
      }
      throw error;
    }
    sheetLease = await repository.acquireLease(`sheet-publish:${spreadsheetId}`, 3_700_000);

    const run = await repository.getRun(runId);
    if (!run) throw new Error("Запуск не найден");
    if (run.ownerEmail && run.ownerEmail !== user.email) throw new Error("Владелец запуска изменился");
    if (operation === "preflight") {
      const tabNames = brandTabNames(run.request.brands);
      const result = appsScriptUrl
        ? await new AppsScriptSheetsPublisher(appsScriptUrl).readMany(run.request.sheetUrl, tabNames).then((current) => ({
            rows: current.reduce((sum, sheet) => sum + sheet.rows, 0),
            columns: Math.max(0, ...current.map((sheet) => sheet.columns)),
            tabName: current[0]!.tabName,
            tabNames: current.map((sheet) => sheet.tabName),
            publisher: "apps-script" as const
          }))
        : await withSheetBrowser(context, run.request.sheetUrl, async (driver) => {
            let rows = 0;
            let columns = 0;
            for (const tabName of tabNames) {
              await driver.ensureTab(tabName, []);
              const current = await driver.captureCurrentRegion();
              const currentColumns = Math.max(0, ...current.cells.map((row) => row.length));
              rows += current.cells.length;
              columns = Math.max(columns, currentColumns);
              if (rows * Math.max(columns, 1) > 50_000) {
                throw new Error(`Листы слишком велики для безопасной браузерной публикации: более 50000 ячеек`);
              }
            }
            return { rows, columns, tabName: tabNames[0]!, tabNames, publisher: "browser" as const };
          });
      const refreshed = await repository.getRun(run.id);
      if (refreshed && refreshed.status !== "published") {
        const previousErrorCount = refreshed.errors.length;
        const tabChanged = refreshed.sheetTabName !== result.tabName;
        refreshed.sheetTabName = result.tabName;
        refreshed.errors = refreshed.errors.filter((item) => item.partition !== "sheet-preflight");
        if (
          refreshed.status === "failed" &&
          refreshed.errors.length === 0 &&
          refreshed.progress.completedPartitions === 0
        ) {
          refreshed.status = "queued";
        }
        if (tabChanged || refreshed.errors.length !== previousErrorCount || refreshed.status !== run.status) {
          refreshed.updatedAt = new Date().toISOString();
          await repository.saveRun(refreshed);
        }
      }
      return json({
        id: run.id,
        status: refreshed?.status ?? run.status,
        publicationStatus: "ready",
        sheetReady: true,
        ...result
      });
    }
    const service = new RatingsService(repository, async () => {
      throw new Error("Адаптеры недоступны в Agent публикации");
    });
    const intent = await prepareBrowserPublication(repository, service, run);
    if (!intent.shouldPublish) return json({
      id: intent.run.id,
      status: intent.run.status,
      publicationStatus: "published",
      idempotentReplay: true,
      publication: intent.run.publication
    });

    const registry = await repository.listProducts(spreadsheetId);
    const registryBeforePublication = structuredClone(registry);
    const snapshots = await repository.getSnapshots(spreadsheetId);
    const snapshotsBeforePublication = structuredClone(snapshots);
    snapshots[run.request.month] = Object.fromEntries(
      run.observations.map((item) => [productKey(item.domain, item.listingId), item])
    );
    const publicationRepository = repository;

    if (appsScriptUrl) {
      const publisher = new AppsScriptSheetsPublisher(appsScriptUrl);
      const tabNames = brandTabNames(run.request.brands);
      const current = await publisher.readMany(run.request.sheetUrl, tabNames);
      const sheets = current.map((readback, index) => ({
        tabName: tabNames[index]!,
        expectedRevision: readback.revision,
        document: buildBrandSheetDocument(
          { values: readback.values },
          run.request,
          run.request.brands[index]!,
          registry,
          snapshots
        )
      }));
      const evidence = new RemoteEvidenceStore(publicationRepository);
      const preimageEvidenceRef = await evidence.put({
        kind: "apps-script-google-sheets-preimage",
        runId: run.id,
        spreadsheetId,
        month: run.request.month,
        capturedAt: new Date().toISOString(),
        readbacks: current.map(appsScriptReadbackEvidence)
      });
      const published = await publisher.publishBatch({
        sheetUrl: run.request.sheetUrl,
        sheets
      });
      const evidenceRef = await evidence.put({
        kind: "apps-script-google-sheets-publication",
        runId: run.id,
        spreadsheetId,
        month: run.request.month,
        ranges: published.sheets.map((sheet) => ({ tabName: sheet.readback.tabName, range: sheet.range })),
        attempts: published.attempts,
        verifiedAt: published.verifiedAt,
        limitations: published.limitations,
        preimageEvidenceRef,
        postimages: published.sheets.map((sheet) => appsScriptReadbackEvidence(sheet.readback))
      });
      const completed = await completeBrowserPublication(publicationRepository, service, intent, {
        range: published.sheets[0]!.range,
        attempts: published.attempts,
        verifiedAt: published.verifiedAt,
        limitations: published.limitations,
        tabs: published.sheets.map((sheet) => ({ tabName: sheet.readback.tabName, range: sheet.range })),
        evidenceRef,
        verificationMethod: "apps-script-readback"
      });
      return json({
        id: completed.id,
        status: completed.status,
        publicationStatus: "published",
        publication: completed.publication
      });
    }

    return await withSheetBrowser(context, run.request.sheetUrl, async (driver, page) => {
      const tabNames = brandTabNames(run.request.brands);
      const publications: BrowserSheetPublication[] = [];
      for (let index = 0; index < tabNames.length; index += 1) {
        const tabName = tabNames[index]!;
        await driver.ensureTab(tabName, []);
        const current = await driver.captureCurrentRegion();
        const document = buildBrandSheetDocument(
          { values: existingValues(current) },
          run.request,
          run.request.brands[index]!,
          registry,
          snapshots
        );
        publications.push({ sheetUrl: run.request.sheetUrl, document, tabName, preimage: current });
      }
      const evidence = new RemoteEvidenceStore(publicationRepository);
      const preimageEvidenceRef = await evidence.put({
        kind: "anonymous-google-sheets-preimage",
        runId: run.id,
        spreadsheetId,
        month: run.request.month,
        capturedAt: new Date().toISOString(),
        readbacks: publications.map((publication) => ({
          tabName: publication.tabName!,
          ...readbackEvidence(publication.preimage!)
        }))
      });
      const browserPublisher = new BrowserSheetsPublisher(driver, {
        locale: "ru-RU",
        maxAttempts: 2,
        maxBackupCells: 50_000
      });
      const published: Array<Awaited<ReturnType<BrowserSheetsPublisher["publish"]>>> = [];
      try {
        for (const publication of publications) published.push(await browserPublisher.publish(publication));
      } catch (publishError) {
        const rollbackFailures = await rollbackBrowserTabs(browserPublisher, publications, published.length, publishError);
        if (rollbackFailures.length) throw new BrowserSheetRollbackError(publishError, rollbackFailures);
        throw publishError;
      }

      try {
        const screenshotBase64 = await page.screenshot({ type: "png" })
          .then((bytes) => bytes.toString("base64"))
          .catch(() => undefined);
        const evidenceRef = await evidence.put({
          kind: "anonymous-google-sheets-publication",
          runId: run.id,
          spreadsheetId,
          month: run.request.month,
          ranges: published.map((item, index) => ({ tabName: publications[index]!.tabName!, range: item.range })),
          attempts: published.reduce((sum, item) => sum + item.attempts, 0),
          verifiedAt: published[0]!.verifiedAt,
          limitations: published.flatMap((item) => item.limitations),
          preimageEvidenceRef,
          postimages: published.map((item, index) => ({
            tabName: publications[index]!.tabName!,
            ...readbackEvidence(item.readback)
          })),
          screenshotPngBase64: screenshotBase64
        });
        const completed = await completeBrowserPublication(publicationRepository, service, intent, {
          range: published[0]!.range,
          attempts: published.reduce((sum, item) => sum + item.attempts, 0),
          verifiedAt: published[0]!.verifiedAt,
          limitations: published.flatMap((item) => item.limitations),
          tabs: published.map((item, index) => ({ tabName: publications[index]!.tabName!, range: item.range })),
          evidenceRef
        });
        return json({
          id: completed.id,
          status: completed.status,
          publicationStatus: "published",
          publication: completed.publication
        });
      } catch (postPublicationError) {
        if (postPublicationError instanceof PublicationCommitUncertainError) throw postPublicationError;
        const compensationFailures = await rollbackBrowserTabs(
          browserPublisher,
          publications,
          published.length,
          postPublicationError
        );
        try { await publicationRepository.replaceProducts(spreadsheetId, registryBeforePublication); }
        catch (error) { compensationFailures.push(`реестр не восстановлен: ${safeErrorMessage(error)}`); }
        try { await publicationRepository.replaceSnapshots(spreadsheetId, snapshotsBeforePublication); }
        catch (error) { compensationFailures.push(`снимки не восстановлены: ${safeErrorMessage(error)}`); }
        if (compensationFailures.length) {
          throw new BrowserSheetRollbackError(postPublicationError, compensationFailures);
        }
        throw postPublicationError;
      }
    });
  } catch (error) {
    if (repository && runId && ownerVerified && runLease) {
      if (operation === "preflight") {
        const failed = await repository.getRun(runId).catch(() => undefined);
        if (failed && failed.status !== "published") {
          failed.status = "failed";
          failed.updatedAt = new Date().toISOString();
          failed.errors = failed.errors.filter((item) => item.partition !== "sheet-preflight");
          failed.errors.push({ partition: "sheet-preflight", message: safeErrorMessage(error) });
          await repository.saveRun(failed).catch(() => undefined);
        }
      } else {
        const uncertain = error instanceof BrowserSheetRollbackError ||
          error instanceof AppsScriptSheetRollbackError ||
          error instanceof PublicationCommitUncertainError;
        await failBrowserPublication(
          repository,
          runId,
          error,
          uncertain,
          appsScriptUrl ? "google-sheets-apps-script" : "google-sheets-browser"
        ).catch(() => undefined);
      }
    }
    const uncertain = error instanceof BrowserSheetRollbackError ||
      error instanceof AppsScriptSheetRollbackError ||
      error instanceof PublicationCommitUncertainError;
    return json({
      error: safeErrorMessage(error),
      publicationStatus: operation === "preflight" ? "preflight_failed" : uncertain ? "state_uncertain" : "retryable_failure",
      retryable: operation !== "preflight" && !uncertain
    }, 400);
  } finally {
    if (repository && sheetLease) await repository.releaseLease(sheetLease).catch(() => undefined);
    if (repository && runLease) await repository.releaseLease(runLease).catch(() => undefined);
  }
}
