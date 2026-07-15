import type { PublicationRecord, RunState } from "../../shared/types.js";
import { validateRun } from "../qa.js";
import type { Repository } from "../repository.js";
import type { RatingsService } from "../orchestrator.js";
import { safeErrorMessage } from "../utils/error-message.js";
import { extractSpreadsheetId } from "../utils/urls.js";

const BROWSER_ERROR_PARTITIONS = new Set([
  "google-sheets",
  "google-sheets-browser",
  "google-sheets-apps-script",
  "publisher-preflight",
  "sheet-preflight"
]);

export type BrowserPublicationIntent = {
  run: RunState;
  spreadsheetId: string;
  publicationKey: string;
  shouldPublish: boolean;
};

function targetsResolvedTab(record: PublicationRecord, run: RunState): boolean {
  const tabName = run.sheetTabName ?? "Ratings";
  const prefix = `'${tabName.replace(/'/g, "''")}'!`;
  return record.updatedRange.startsWith(prefix);
}

export class PublicationCommitUncertainError extends Error {
  constructor(readonly saveError: unknown, readonly verificationError: unknown) {
    super("Маркер публикации мог быть сохранён, но его состояние не удалось подтвердить");
    this.name = "PublicationCommitUncertainError";
  }
}

export async function reconcileBrowserPublication(
  repository: Repository,
  run: RunState
): Promise<RunState> {
  if (!run.payloadHash) return run;
  const spreadsheetId = extractSpreadsheetId(run.request.sheetUrl);
  const prior = await repository.getPublication(`${spreadsheetId}:${run.request.month}`);
  if (prior?.payloadHash !== run.payloadHash || !targetsResolvedTab(prior, run)) return run;
  run.status = "published";
  run.publication = prior;
  run.updatedAt = prior.publishedAt;
  await repository.saveRun(run);
  return run;
}

function clearPublicationErrors(run: RunState): void {
  run.errors = run.errors.filter((error) => !BROWSER_ERROR_PARTITIONS.has(error.partition));
}

/**
 * Performs all state and QA checks before an anonymous browser is allowed to
 * touch the spreadsheet. Calling this function repeatedly is idempotent.
 */
export async function prepareBrowserPublication(
  repository: Repository,
  service: RatingsService,
  run: RunState
): Promise<BrowserPublicationIntent> {
  const spreadsheetId = extractSpreadsheetId(run.request.sheetUrl);
  const publicationKey = `${spreadsheetId}:${run.request.month}`;
  clearPublicationErrors(run);
  await service.assertApprovedProfiles(run);
  run.qa = validateRun(run);
  if (!run.qa.ok) {
    await repository.saveRun(run);
    throw new Error(`Публикация заблокирована: ${run.qa.blockers.join("; ")}`);
  }
  if (!run.payloadHash) throw new Error("У запуска нет контрольной суммы");

  const prior = await repository.getPublication(publicationKey);
  if (prior?.payloadHash === run.payloadHash && targetsResolvedTab(prior, run)) {
    run.status = "published";
    run.publication = prior;
    run.updatedAt = prior.publishedAt;
    await repository.saveRun(run);
    return { run, spreadsheetId, publicationKey, shouldPublish: false };
  }
  if (!(["review", "publishing"] as RunState["status"][]).includes(run.status)) {
    throw new Error(`Нельзя публиковать запуск из статуса ${run.status}`);
  }

  run.status = "publishing";
  run.publication = undefined;
  run.updatedAt = new Date().toISOString();
  await repository.saveRun(run);
  return { run, spreadsheetId, publicationKey, shouldPublish: true };
}

export async function completeBrowserPublication(
  repository: Repository,
  service: RatingsService,
  intent: BrowserPublicationIntent,
  result: {
    range: string;
    verifiedAt: string;
    attempts: number;
    limitations: string[];
    tabName?: string;
    evidenceRef?: string;
    verificationMethod?: "anonymous-browser-readback" | "apps-script-readback";
  }
): Promise<RunState> {
  const { run, spreadsheetId, publicationKey } = intent;
  if (!run.payloadHash) throw new Error("У запуска нет контрольной суммы");
  await service.commitSuccessfulRun(run);
  const tabName = result.tabName ?? run.sheetTabName ?? "Ratings";
  run.sheetTabName = tabName === "Рейтинги" ? "Рейтинги" : "Ratings";
  const publication: PublicationRecord = {
    runId: run.id,
    spreadsheetId,
    month: run.request.month,
    payloadHash: run.payloadHash,
    publishedAt: result.verifiedAt,
    updatedRange: `'${run.sheetTabName}'!${result.range}`,
    verification: {
      method: result.verificationMethod ?? "anonymous-browser-readback",
      attempts: result.attempts,
      limitations: result.limitations
    },
    evidenceRef: result.evidenceRef
  };
  try {
    await repository.savePublication(publicationKey, publication);
  } catch (saveError) {
    let confirmed: PublicationRecord | undefined;
    try {
      confirmed = await repository.getPublication(publicationKey);
    } catch (verificationError) {
      throw new PublicationCommitUncertainError(saveError, verificationError);
    }
    if (confirmed?.payloadHash !== publication.payloadHash) throw saveError;
  }
  run.status = "published";
  run.publication = publication;
  run.updatedAt = publication.publishedAt;
  // The publication record above remains the source-of-truth commit marker.
  // Persist the human-facing run state on a best-effort basis so a later
  // payload for the same sheet/month cannot leave this completed run stuck in
  // `publishing`. A failure here must never roll back an already committed
  // sheet or turn the successful marker into a retryable publication error.
  await repository.saveRun(run).catch(() => undefined);
  return run;
}

export async function failBrowserPublication(
  repository: Repository,
  runId: string,
  error: unknown,
  uncertainSheetState = false,
  partition: "google-sheets-browser" | "google-sheets-apps-script" = "google-sheets-browser"
): Promise<void> {
  const run = await repository.getRun(runId);
  if (!run || run.status === "published") return;
  clearPublicationErrors(run);
  run.status = uncertainSheetState ? "failed" : "review";
  run.updatedAt = new Date().toISOString();
  // QA describes the collected snapshot. A transient browser/clipboard outage
  // is reported separately and remains retryable without recollecting data.
  run.qa = validateRun(run);
  run.errors.push({ partition, message: safeErrorMessage(error) });
  await repository.saveRun(run);
}
