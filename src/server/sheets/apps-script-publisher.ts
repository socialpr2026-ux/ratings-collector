import type { SheetDocument, SheetRowKind, SheetScalar } from "./model.js";
import { columnLetter } from "./model.js";
import { extractSpreadsheetId } from "../utils/urls.js";

const SHEET_TAB = "Рейтинги";
const MAX_CELLS = 50_000;
const ROW_KINDS = new Set<SheetRowKind>([
  "brand",
  "title",
  "subheader",
  "section",
  "product",
  "blank",
  "summaryHeader",
  "summary",
  "footnote"
]);

export type AppsScriptSheetMerge = {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
};

export type AppsScriptSheetReadback = {
  spreadsheetId: string;
  tabName: "Рейтинги";
  values: SheetScalar[][];
  formulas: Array<Array<string | null>>;
  merges: AppsScriptSheetMerge[];
  revision: string;
  rows: number;
  columns: number;
};

export type AppsScriptPublicationResult = {
  status: "published";
  range: string;
  attempts: number;
  verifiedAt: string;
  limitations: string[];
  revision: string;
  readback: AppsScriptSheetReadback;
};

type AppsScriptPublisherOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type AppsScriptErrorPayload = {
  ok?: false;
  code?: string;
  error?: string;
  retryable?: boolean;
  rollbackFailed?: boolean;
};

export class AppsScriptPublisherError extends Error {
  constructor(
    message: string,
    readonly code = "apps_script_error",
    readonly retryable = false
  ) {
    super(message);
    this.name = "AppsScriptPublisherError";
  }
}

export class AppsScriptSheetRollbackError extends AppsScriptPublisherError {
  constructor(message: string, code = "rollback_failed") {
    super(message, code, false);
    this.name = "AppsScriptSheetRollbackError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppsScriptPublisherError("Google Apps Script вернул некорректный JSON-объект", "invalid_response");
  }
  return value as Record<string, unknown>;
}

function scalar(value: unknown, location: string): SheetScalar {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new AppsScriptPublisherError(`Некорректное значение ${location}`, "invalid_response");
}

function integer(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AppsScriptPublisherError(`Некорректное целое число ${location}`, "invalid_response");
  }
  return value;
}

function parseMerge(value: unknown, index: number, rows: number, columns: number): AppsScriptSheetMerge {
  const candidate = record(value);
  const merge = {
    startRow: integer(candidate.startRow, `merges[${index}].startRow`),
    endRow: integer(candidate.endRow, `merges[${index}].endRow`),
    startColumn: integer(candidate.startColumn, `merges[${index}].startColumn`),
    endColumn: integer(candidate.endColumn, `merges[${index}].endColumn`)
  };
  if (
    merge.endRow <= merge.startRow ||
    merge.endColumn <= merge.startColumn ||
    merge.endRow > rows ||
    merge.endColumn > columns
  ) {
    throw new AppsScriptPublisherError(`Объединение merges[${index}] выходит за границы листа`, "invalid_response");
  }
  return merge;
}

function mergeKey(merge: AppsScriptSheetMerge): string {
  return `${merge.startRow}:${merge.endRow}:${merge.startColumn}:${merge.endColumn}`;
}

function assertNonOverlappingMerges(merges: AppsScriptSheetMerge[]): void {
  const covered = new Set<string>();
  merges.forEach((merge, index) => {
    for (let row = merge.startRow; row < merge.endRow; row += 1) {
      for (let column = merge.startColumn; column < merge.endColumn; column += 1) {
        const key = `${row}:${column}`;
        if (covered.has(key)) {
          throw new AppsScriptPublisherError(`Объединения пересекаются в merges[${index}]`, "invalid_response");
        }
        covered.add(key);
      }
    }
  });
}

export function validateAppsScriptEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("SHEETS_APPS_SCRIPT_URL должен быть корректным URL развёрнутого Web App");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLocaleLowerCase("en-US") !== "script.google.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(url.pathname)
  ) {
    throw new Error("SHEETS_APPS_SCRIPT_URL должен иметь вид https://script.google.com/macros/s/.../exec");
  }
  return url.toString();
}

export function validateAppsScriptDocument(document: SheetDocument): void {
  const rows = document.values.length;
  const columns = document.columnCount;
  if (!Number.isSafeInteger(columns) || columns < 1 || rows < 1 || rows * columns > MAX_CELLS) {
    throw new Error(`Диапазон публикации должен содержать от 1 до ${MAX_CELLS} ячеек`);
  }
  if (document.formulas.length !== rows || document.rowKinds.length !== rows) {
    throw new Error("SheetDocument содержит несовместимые размеры values, formulas и rowKinds");
  }
  for (let row = 0; row < rows; row += 1) {
    if (document.values[row].length !== columns || document.formulas[row].length !== columns) {
      throw new Error(`Строка ${row + 1} SheetDocument не соответствует columnCount`);
    }
    if (!ROW_KINDS.has(document.rowKinds[row])) throw new Error(`Некорректный rowKind в строке ${row + 1}`);
    for (let column = 0; column < columns; column += 1) {
      const value = document.values[row][column];
      if (!(value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`Некорректное значение в ячейке ${row + 1}:${column + 1}`);
      }
      const formula = document.formulas[row][column];
      if (!(formula === null || typeof formula === "string" && formula.startsWith("="))) {
        throw new Error(`Некорректная формула в ячейке ${row + 1}:${column + 1}`);
      }
    }
  }
  const merges = document.merges.map((merge, index) => {
    const parsed = parseMerge(merge, index, rows, columns);
    return parsed;
  });
  assertNonOverlappingMerges(merges);
}

export function parseAppsScriptReadback(input: unknown): AppsScriptSheetReadback {
  const value = record(input);
  const rows = integer(value.rows, "rows");
  const columns = integer(value.columns, "columns");
  if (rows * columns > MAX_CELLS) {
    throw new AppsScriptPublisherError(`Лист превышает безопасный лимит ${MAX_CELLS} ячеек`, "sheet_too_large");
  }
  if (!Array.isArray(value.values) || !Array.isArray(value.formulas) || value.values.length !== rows || value.formulas.length !== rows) {
    throw new AppsScriptPublisherError("Некорректные размеры values/formulas", "invalid_response");
  }
  const values = value.values.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns) {
      throw new AppsScriptPublisherError(`Некорректная ширина values[${rowIndex}]`, "invalid_response");
    }
    return row.map((item, columnIndex) => scalar(item, `values[${rowIndex}][${columnIndex}]`));
  });
  const formulas = value.formulas.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns) {
      throw new AppsScriptPublisherError(`Некорректная ширина formulas[${rowIndex}]`, "invalid_response");
    }
    return row.map((item, columnIndex) => {
      if (item === null || typeof item === "string" && item.startsWith("=")) return item;
      throw new AppsScriptPublisherError(`Некорректная формула formulas[${rowIndex}][${columnIndex}]`, "invalid_response");
    });
  });
  if (!Array.isArray(value.merges)) throw new AppsScriptPublisherError("Некорректный массив merges", "invalid_response");
  const merges = value.merges.map((merge, index) => parseMerge(merge, index, rows, columns));
  assertNonOverlappingMerges(merges);
  if (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/i.test(value.revision)) {
    throw new AppsScriptPublisherError("Некорректная revision листа", "invalid_response");
  }
  if (typeof value.spreadsheetId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value.spreadsheetId)) {
    throw new AppsScriptPublisherError("Некорректный spreadsheetId в ответе", "invalid_response");
  }
  if (value.tabName !== SHEET_TAB) {
    throw new AppsScriptPublisherError(`Web App вернул недопустимую вкладку ${String(value.tabName)}`, "invalid_response");
  }
  return {
    spreadsheetId: value.spreadsheetId,
    tabName: SHEET_TAB,
    values,
    formulas,
    merges,
    revision: value.revision,
    rows,
    columns
  };
}

function normalizedFormula(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/СЧ[ЕЁ]ТЕСЛИМН(?=\()/gi, "COUNTIFS")
    .replace(/ЕСЛИОШИБКА(?=\()/gi, "IFERROR")
    .replace(/СУММ(?=\()/gi, "SUM")
    .replace(/;/g, ",")
    .toUpperCase();
}

function sameScalar(left: SheetScalar, right: SheetScalar): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) < 1e-9;
  return false;
}

export function verifyAppsScriptReadback(readback: AppsScriptSheetReadback, document: SheetDocument): string[] {
  const mismatches: string[] = [];
  if (readback.rows !== document.values.length || readback.columns !== document.columnCount) {
    mismatches.push(`размер ${readback.rows}x${readback.columns}, ожидался ${document.values.length}x${document.columnCount}`);
    return mismatches;
  }
  for (let row = 0; row < readback.rows; row += 1) {
    for (let column = 0; column < readback.columns; column += 1) {
      const expectedFormula = document.formulas[row][column];
      const actualFormula = readback.formulas[row][column];
      if (expectedFormula) {
        if (!actualFormula || normalizedFormula(actualFormula) !== normalizedFormula(expectedFormula)) {
          mismatches.push(`${columnLetter(column + 1)}${row + 1}: формула не совпала`);
        }
      } else if (actualFormula) {
        mismatches.push(`${columnLetter(column + 1)}${row + 1}: появилась лишняя формула`);
      } else if (!sameScalar(readback.values[row][column], document.values[row][column])) {
        mismatches.push(`${columnLetter(column + 1)}${row + 1}: значение не совпало`);
      }
      if (mismatches.length >= 20) return mismatches;
    }
  }
  const expectedMerges = new Set(document.merges.map(mergeKey));
  const actualMerges = new Set(readback.merges.map(mergeKey));
  for (const expected of expectedMerges) {
    if (!actualMerges.has(expected)) mismatches.push(`отсутствует объединение ${expected}`);
  }
  for (const actual of actualMerges) {
    if (!expectedMerges.has(actual)) mismatches.push(`лишнее объединение ${actual}`);
  }
  return mismatches.slice(0, 20);
}

export class AppsScriptSheetsPublisher {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(endpoint: string, options: AppsScriptPublisherOptions = {}) {
    this.endpoint = validateAppsScriptEndpoint(endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(5_000, Math.min(180_000, options.timeoutMs ?? 120_000));
  }

  async read(sheetUrl: string): Promise<AppsScriptSheetReadback> {
    const spreadsheetId = extractSpreadsheetId(sheetUrl);
    const payload = await this.call({ action: "read", spreadsheetId, tabName: SHEET_TAB });
    const response = record(payload);
    if (response.action !== "read") throw new AppsScriptPublisherError("Web App вернул ответ другой операции", "invalid_response");
    const readback = parseAppsScriptReadback(response.readback);
    if (readback.spreadsheetId !== spreadsheetId) {
      throw new AppsScriptPublisherError("Web App вернул данные другой таблицы", "invalid_response");
    }
    return readback;
  }

  async publish(input: {
    sheetUrl: string;
    document: SheetDocument;
    expectedRevision: string;
    tabName?: "Рейтинги";
  }): Promise<AppsScriptPublicationResult> {
    validateAppsScriptDocument(input.document);
    if (!/^[a-f0-9]{64}$/i.test(input.expectedRevision)) throw new Error("Некорректная expectedRevision");
    const spreadsheetId = extractSpreadsheetId(input.sheetUrl);
    const payload = await this.call({
      action: "write",
      spreadsheetId,
      tabName: input.tabName ?? SHEET_TAB,
      expectedRevision: input.expectedRevision,
      document: {
        values: input.document.values,
        formulas: input.document.formulas,
        merges: input.document.merges,
        rowKinds: input.document.rowKinds,
        columnCount: input.document.columnCount
      }
    });
    const response = record(payload);
    if (response.action !== "write") throw new AppsScriptPublisherError("Web App вернул ответ другой операции", "invalid_response");
    const readback = parseAppsScriptReadback(response.readback);
    if (readback.spreadsheetId !== spreadsheetId) {
      throw new AppsScriptPublisherError("Web App записал данные в другую таблицу", "invalid_response");
    }
    const mismatches = verifyAppsScriptReadback(readback, input.document);
    if (mismatches.length) {
      throw new AppsScriptSheetRollbackError(`Apps Script не подтвердил точную запись: ${mismatches.slice(0, 5).join("; ")}`, "unverified_write");
    }
    const range = response.range;
    if (typeof range !== "string" || !/^A1:[A-Z]+[1-9]\d*$/.test(range)) {
      throw new AppsScriptPublisherError("Web App вернул некорректный диапазон", "invalid_response");
    }
    const verifiedAt = response.verifiedAt;
    if (typeof verifiedAt !== "string" || !Number.isFinite(Date.parse(verifiedAt))) {
      throw new AppsScriptPublisherError("Web App вернул некорректное время проверки", "invalid_response");
    }
    const attempts = response.attempts;
    if (attempts !== 0 && attempts !== 1) {
      throw new AppsScriptPublisherError("Web App вернул некорректное число попыток", "invalid_response");
    }
    return {
      status: "published",
      range,
      attempts,
      verifiedAt,
      revision: readback.revision,
      readback,
      limitations: [
        "Запись выполнена Web App под LockService с проверкой revision, резервной копией, точным readback и внутренним rollback.",
        "LockService сериализует вызовы Web App, но не блокирует одновременное ручное редактирование таблицы."
      ]
    };
  }

  private async call(body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("apps_script_timeout")), this.timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "accept": "application/json" },
        redirect: "follow",
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? "Google Apps Script не ответил за отведённое время"
        : `Не удалось вызвать Google Apps Script: ${error instanceof Error ? error.message : String(error)}`;
      throw new AppsScriptPublisherError(message, "network_error", true);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new AppsScriptPublisherError(`Google Apps Script вернул HTTP ${response.status}`, "http_error", response.status >= 500);
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AppsScriptPublisherError(
        "Google Apps Script вернул не JSON; проверьте, что Web App развёрнут для доступа «Anyone»",
        "invalid_response"
      );
    }
    const responseBody = record(payload);
    if (responseBody.ok !== true) {
      const errorPayload = responseBody as AppsScriptErrorPayload;
      const message = typeof errorPayload.error === "string" && errorPayload.error.trim()
        ? errorPayload.error
        : "Google Apps Script отклонил операцию";
      if (errorPayload.rollbackFailed === true || errorPayload.code === "rollback_failed") {
        throw new AppsScriptSheetRollbackError(message, errorPayload.code);
      }
      throw new AppsScriptPublisherError(message, errorPayload.code, errorPayload.retryable === true);
    }
    return responseBody;
  }
}
