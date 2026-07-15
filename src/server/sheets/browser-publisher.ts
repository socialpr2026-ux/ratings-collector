import type { SheetDocument, SheetScalar } from "./model.js";
import type {
  BrowserClipboardPayload,
  BrowserSheetCell,
  BrowserSheetMerge,
  BrowserSheetReadback,
  SheetsUiDriver
} from "./browser-ui-driver.js";
import { LEGACY_RATINGS_TAB_NAME, RATINGS_TAB_NAME } from "./tab-name.js";

export type BrowserSheetPublication = {
  sheetUrl: string;
  document: SheetDocument;
  tabName?: string;
  preimage?: BrowserSheetReadback;
};

export type BrowserSheetPublicationResult = {
  status: "published";
  tabName: string;
  range: string;
  attempts: number;
  verifiedAt: string;
  limitations: string[];
  readback: BrowserSheetReadback;
};

export type BrowserSheetsPublisherOptions = {
  locale?: string;
  maxAttempts?: number;
  maxBackupCells?: number;
};

type ExpectedCell = {
  value: SheetScalar;
  formula?: string;
};

export type BrowserSheetClipboardPlan = {
  payload: BrowserClipboardPayload;
  cells: ExpectedCell[][];
  merges: BrowserSheetMerge[];
  range: string;
};

export class BrowserSheetVerificationError extends Error {
  constructor(message: string, readonly mismatches: string[] = []) {
    super(message);
    this.name = "BrowserSheetVerificationError";
  }
}

export class BrowserSheetRollbackError extends Error {
  constructor(readonly publicationError: unknown, readonly rollbackMismatches: string[]) {
    super(`Публикация через браузер не прошла, а восстановление исходного листа не подтверждено: ${rollbackMismatches.slice(0, 5).join("; ")}`);
    this.name = "BrowserSheetRollbackError";
  }
}

function columnLetter(oneBased: number): string {
  let value = oneBased;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function validateSheetUrl(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "docs.google.com" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !/^\/spreadsheets\/d\/[a-zA-Z0-9_-]+(?:\/|$)/.test(url.pathname)
  ) {
    throw new Error("Браузерная публикация разрешена только в HTTPS-ссылки docs.google.com/spreadsheets/d/…");
  }
  return url.toString();
}

function html(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tsv(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function serializedNumber(value: number, locale: string): string {
  if (!Number.isFinite(value)) throw new Error("Нельзя публиковать NaN или бесконечность в Google Sheets");
  return new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 15 }).format(value);
}

function clipboardText(cell: ExpectedCell, locale: string): string {
  if (cell.formula) return cell.formula;
  if (cell.value === null) return "";
  if (typeof cell.value === "number") return serializedNumber(cell.value, locale);
  // Clipboard paste treats leading =/+/-/@ as a formula. The apostrophe forces
  // a literal string and is not displayed by Google Sheets.
  return /^[=+\-@]/.test(cell.value) ? `'${cell.value}` : cell.value;
}

function mergeKey(merge: BrowserSheetMerge): string {
  return `${merge.startRow}:${merge.endRow}:${merge.startColumn}:${merge.endColumn}`;
}

function cellCss(document: SheetDocument, row: number, column: number, cell: ExpectedCell): string {
  const kind = document.rowKinds[row];
  const metric = column >= 4;
  const css = [
    "overflow:hidden",
    "padding:7px 10px",
    "vertical-align:middle",
    "font-family:Inter,Arial,sans-serif",
    `font-size:${kind === "footnote" ? 9 : 10}pt`,
    "white-space:normal",
    "color:#241f35"
  ];
  if (kind === "brand") {
    css.push("background-color:#120755", "color:#ffffff", "border-bottom:3px solid #ff4d00");
    if (column === 0) css.push("font-size:16pt", "font-weight:bold", "letter-spacing:0.4px");
    if (metric) css.push("color:#aeade5", "font-weight:bold", "text-align:right");
  }
  if (kind === "title" || kind === "subheader" && metric) {
    css.push("background-color:#120755", "color:#ffffff");
    if (kind === "title" || metric) css.push("font-weight:bold");
  }
  if (kind === "section") {
    css.push("background-color:#f0effa", "border-top:1px solid #aeade5", "border-bottom:1px solid #dcd9f1");
    if (column === 0) css.push("font-size:12pt", "font-weight:bold", "color:#120755", "border-left:4px solid #ff4d00");
    if (column === 1 || column === 2) css.push("font-weight:bold", "color:#625b85");
  }
  if (kind === "product") {
    css.push(`background-color:${row % 2 === 0 ? "#ffffff" : "#fbfaff"}`, "border-bottom:1px solid #ebe9f4");
    if (column === 0) css.push("font-weight:bold", "color:#120755");
    if (column === 1) css.push("color:#4932a8", "text-decoration:underline");
  }
  if (kind === "summaryHeader") css.push("background-color:#e7e5f7", "color:#120755", "font-weight:bold", "border-top:3px solid #ff4d00");
  if (kind === "summary") {
    css.push("background-color:#fbfaff", "border-bottom:1px solid #e3e0f1");
    if (column === 0) css.push("font-weight:bold", "color:#120755");
  }
  if (kind === "footnote") css.push("font-style:italic", "color:#746f86", "background-color:#fbfaff");
  if (metric && ["title", "subheader", "section", "product", "summaryHeader", "summary"].includes(kind)) {
    css.push("border-left:1px solid #e3e0f1", "border-right:1px solid #e3e0f1", "text-align:center");
  }
  if ((kind === "product" || kind === "summary") && metric) {
    const share = kind === "summary" && (column - 4) % 2 === 1;
    const rating = kind === "product" && (column - 4) % 2 === 1;
    css.push(`mso-number-format:'${share ? "0%" : rating ? "0.0" : "#,##0"}'`);
    if (kind === "product" && rating && typeof cell.value === "number") {
      css.push("font-weight:bold", `color:${cell.value >= 4 ? "#120755" : "#c83d00"}`);
    }
  }
  if (typeof cell.value === "string" && !cell.formula) css.push("mso-number-format:'\\@'");
  return css.join(";");
}

export function buildBrowserSheetClipboardPlan(document: SheetDocument, locale = "ru-RU"): BrowserSheetClipboardPlan {
  if (!document.values.length || document.columnCount < 1) throw new Error("SheetDocument пуст");
  const cells: ExpectedCell[][] = document.values.map((row, rowIndex) =>
    Array.from({ length: document.columnCount }, (_, columnIndex) => ({
      value: row[columnIndex] ?? null,
      formula: document.formulas[rowIndex]?.[columnIndex] ?? undefined
    }))
  );
  const merges = document.merges.map((merge) => ({ ...merge }));
  const mergeAt = new Map<string, BrowserSheetMerge>();
  const covered = new Set<string>();
  for (const merge of merges) {
    if (merge.startRow < 0 || merge.startColumn < 0 || merge.endRow > cells.length || merge.endColumn > document.columnCount ||
        merge.endRow <= merge.startRow || merge.endColumn <= merge.startColumn) {
      throw new Error(`Некорректное объединение ${mergeKey(merge)}`);
    }
    mergeAt.set(`${merge.startRow}:${merge.startColumn}`, merge);
    for (let row = merge.startRow; row < merge.endRow; row += 1) {
      for (let column = merge.startColumn; column < merge.endColumn; column += 1) {
        const key = `${row}:${column}`;
        if (covered.has(key)) throw new Error(`Пересекающиеся объединения в ${key}`);
        covered.add(key);
      }
    }
  }

  const plainText = cells.map((row) => row.map((cell) => tsv(clipboardText(cell, locale))).join("\t")).join("\r\n");
  const htmlRows: string[] = [];
  for (let row = 0; row < cells.length; row += 1) {
    const htmlCells: string[] = [];
    for (let column = 0; column < document.columnCount; column += 1) {
      const topMerge = mergeAt.get(`${row}:${column}`);
      if (covered.has(`${row}:${column}`) && !topMerge) continue;
      const cell = cells[row][column];
      const value = clipboardText(cell, locale);
      const attributes: string[] = [];
      if (topMerge) {
        attributes.push(`rowspan="${topMerge.endRow - topMerge.startRow}"`, `colspan="${topMerge.endColumn - topMerge.startColumn}"`);
      }
      if (cell.formula) attributes.push(`data-sheets-formula="${html(cell.formula)}"`);
      attributes.push(`style="${cellCss(document, row, column, cell)}"`);
      const content = document.rowKinds[row] === "product" && column === 1 && typeof cell.value === "string" && /^https:\/\//i.test(cell.value)
        ? `<a href="${html(cell.value)}">${html(value)}</a>`
        : html(value);
      htmlCells.push(`<td ${attributes.join(" ")}>${content}</td>`);
    }
    const height = document.rowKinds[row] === "brand" ? 44
      : document.rowKinds[row] === "section" ? 36
        : document.rowKinds[row] === "blank" ? 16
          : document.rowKinds[row] === "product" ? 32
            : 30;
    htmlRows.push(`<tr style="height:${height}px">${htmlCells.join("")}</tr>`);
  }
  const widths = [150, 320, 310, 18, ...Array.from(
    { length: Math.max(0, document.columnCount - 4) },
    (_, index) => index % 2 === 0 ? 110 : 82
  )];
  const colgroup = `<colgroup>${widths.map((width) => `<col width="${width}">`).join("")}</colgroup>`;
  const htmlText = `<google-sheets-html-origin><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" data-sheets-root="1" style="table-layout:fixed;font-size:10pt;font-family:Inter,Arial,sans-serif;width:0px">${colgroup}<tbody>${htmlRows.join("")}</tbody></table></google-sheets-html-origin>`;
  return {
    payload: { plainText, htmlText }, cells, merges,
    range: `A1:${columnLetter(document.columnCount)}${document.values.length}`
  };
}

function normalizedFormula(value: string): string {
  return value
    .replace(/СЧ[ЕЁ]ТЕСЛИМН(?=\()/gi, "COUNTIFS")
    .replace(/ЕСЛИОШИБКА(?=\()/gi, "IFERROR")
    .replace(/СУММ(?=\()/gi, "SUM")
    .replace(/;/g, ",")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normalizedText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function displayedNumber(value: string): number | undefined {
  const normalized = value.trim().replace(/[\s\u00a0\u202f]/g, "").replace(/,/g, ".");
  if (!normalized || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function compareCell(actual: BrowserSheetCell | undefined, expected: ExpectedCell): boolean {
  const safeActual = actual ?? { text: "" };
  if (expected.formula) {
    return typeof safeActual.formula === "string" && normalizedFormula(safeActual.formula) === normalizedFormula(expected.formula);
  }
  if (safeActual.formula) return false;
  if (expected.value === null) return safeActual.text === "";
  if (typeof expected.value === "number") {
    const number = displayedNumber(safeActual.text);
    return number !== undefined && Math.abs(number - expected.value) <= 1e-9;
  }
  return normalizedText(safeActual.text) === normalizedText(expected.value);
}

export function verifyBrowserSheetReadback(
  actual: BrowserSheetReadback,
  expectedCells: ExpectedCell[][],
  expectedMerges: BrowserSheetMerge[]
): string[] {
  const mismatches: string[] = [];
  const report = (message: string) => { if (mismatches.length < 25) mismatches.push(message); };
  const needsRichClipboard = expectedMerges.length > 0 || expectedCells.some((row) => row.some((cell) => Boolean(cell.formula)));
  if (needsRichClipboard && !actual.htmlAvailable) report("контрольное копирование не вернуло HTML с формулами/объединениями");
  for (let row = 0; row < expectedCells.length; row += 1) {
    for (let column = 0; column < expectedCells[row].length; column += 1) {
      if (!compareCell(actual.cells[row]?.[column], expectedCells[row][column])) {
        report(`${columnLetter(column + 1)}${row + 1}: значение или формула не совпали`);
      }
    }
  }
  const expectedMergeKeys = new Set(expectedMerges.map(mergeKey));
  const actualMergeKeys = new Set(actual.merges.map(mergeKey));
  for (const key of expectedMergeKeys) if (!actualMergeKeys.has(key)) report(`нет объединения ${key}`);
  for (const key of actualMergeKeys) if (!expectedMergeKeys.has(key)) report(`лишнее объединение ${key}`);
  return mismatches;
}

function readbackDimensions(readback: BrowserSheetReadback): { rows: number; columns: number } {
  const rows = readback.cells.length;
  const columns = Math.max(0, ...readback.cells.map((row) => row.length));
  return { rows, columns };
}

function hasRichState(readback: BrowserSheetReadback): boolean {
  return readback.merges.length > 0 || readback.cells.some((row) => row.some((cell) => Boolean(cell.formula)));
}

function expectedFromReadback(readback: BrowserSheetReadback): ExpectedCell[][] {
  return readback.cells.map((row) => row.map((cell) => ({ value: cell.formula ? null : cell.text, formula: cell.formula })));
}

function paddedExpected(cells: ExpectedCell[][], rows: number, columns: number): ExpectedCell[][] {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => cells[row]?.[column] ?? { value: null })
  );
}

export class BrowserSheetsPublisher {
  private readonly locale: string;
  private readonly maxAttempts: number;
  private readonly maxBackupCells: number;

  constructor(private readonly driver: SheetsUiDriver, options: BrowserSheetsPublisherOptions = {}) {
    this.locale = options.locale ?? "ru-RU";
    this.maxAttempts = Math.max(1, Math.min(2, options.maxAttempts ?? 2));
    this.maxBackupCells = options.maxBackupCells ?? 50_000;
  }

  async publish(publication: BrowserSheetPublication): Promise<BrowserSheetPublicationResult> {
    const sheetUrl = validateSheetUrl(publication.sheetUrl);
    let tabName = publication.tabName ?? RATINGS_TAB_NAME;
    const plan = buildBrowserSheetClipboardPlan(publication.document, this.locale);
    let backup = publication.preimage;
    if (!backup) {
      await this.driver.open(sheetUrl);
      await this.driver.assertEditable();
      tabName = await this.driver.ensureTab(
        tabName,
        publication.tabName ? [] : [LEGACY_RATINGS_TAB_NAME]
      );
      backup = await this.driver.captureCurrentRegion();
    } else {
      await this.driver.assertEditable();
    }
    const oldSize = readbackDimensions(backup);
    if (oldSize.rows * oldSize.columns > this.maxBackupCells) {
      throw new Error(`Текущий лист слишком велик для безопасной браузерной резервной копии: ${oldSize.rows * oldSize.columns} ячеек`);
    }
    if (hasRichState(backup) && !backup.htmlAvailable) {
      throw new Error("Браузер не смог сохранить формулы и объединения исходного листа; публикация не начата");
    }
    const cleanupRows = Math.max(oldSize.rows, publication.document.values.length, 1);
    const cleanupColumns = Math.max(oldSize.columns, publication.document.columnCount, 1);
    if (cleanupRows * cleanupColumns > this.maxBackupCells) {
      throw new Error(`Диапазон публикации слишком велик для безопасной браузерной проверки: ${cleanupRows * cleanupColumns} ячеек`);
    }
    const cleanupRange = `A1:${columnLetter(cleanupColumns)}${cleanupRows}`;
    const expected = paddedExpected(plan.cells, cleanupRows, cleanupColumns);
    let mutated = false;
    let lastMismatches: string[] = [];

    // A previous browser attempt can have reached Google successfully while
    // its state marker was not committed. Exact preimage equality lets a retry
    // finish the repository commit without touching the sheet a second time.
    const existingMismatches = verifyBrowserSheetReadback(backup, expected, plan.merges);
    if (!existingMismatches.length) {
      return {
        status: "published",
        tabName,
        range: plan.range,
        attempts: 0,
        verifiedAt: new Date().toISOString(),
        limitations: [
          "Лист уже точно соответствовал снимку запуска; повторная запись не выполнялась.",
          "Браузерный путь проверяет сохранённые значения, формулы и объединения; точное воспроизведение каждого параметра форматирования не гарантируется."
        ],
        readback: backup
      };
    }

    try {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        // readRange overwrites the browser clipboard, so reload the intended
        // publication before every attempt.
        await this.driver.writeClipboard(plan.payload);
        const existingMergesExpected = attempt === 1 ? backup.merges.length > 0 : plan.merges.length > 0;
        if (existingMergesExpected && !(await this.driver.unmergeRange(cleanupRange))) {
          throw new Error("Google Sheets не предоставил команду безопасного разъединения старых объединённых ячеек");
        }
        if (existingMergesExpected) mutated = true;
        await this.driver.clearRange(cleanupRange);
        mutated = true;
        await this.driver.pasteAt("A1");
        await this.driver.waitForSettled();
        await this.driver.open(sheetUrl);
        await this.driver.selectTab(tabName);
        await this.driver.assertEditable();
        const readback = await this.driver.readRange(cleanupRange, cleanupRows, cleanupColumns);
        lastMismatches = verifyBrowserSheetReadback(readback, expected, plan.merges);
        if (!lastMismatches.length) {
          return {
            status: "published", tabName, range: plan.range, attempts: attempt, verifiedAt: new Date().toISOString(),
            limitations: ["Браузерный путь проверяет сохранённые значения, формулы и объединения после перезагрузки; точное воспроизведение каждого параметра форматирования не гарантируется."],
            readback
          };
        }
      }
      throw new BrowserSheetVerificationError(
        `Google Sheets не подтвердил браузерную публикацию: ${lastMismatches.slice(0, 5).join("; ")}`,
        lastMismatches
      );
    } catch (publicationError) {
      if (!mutated) throw publicationError;
      const rollbackMismatches = await this.restoreBackup(
        backup, cleanupRange, cleanupRows, cleanupColumns, sheetUrl, tabName
      );
      if (rollbackMismatches.length) throw new BrowserSheetRollbackError(publicationError, rollbackMismatches);
      throw publicationError;
    }
  }

  /**
   * Compensates a failure that happened after the UI paste itself was already
   * verified (for example, while persisting evidence or registry state).
   */
  async rollbackVerifiedPublication(publication: BrowserSheetPublication, cause: unknown): Promise<void> {
    const backup = publication.preimage;
    if (!backup) throw new Error("Для компенсирующего rollback отсутствует preimage листа");
    const sheetUrl = validateSheetUrl(publication.sheetUrl);
    const tabName = publication.tabName ?? RATINGS_TAB_NAME;
    buildBrowserSheetClipboardPlan(publication.document, this.locale);
    const oldSize = readbackDimensions(backup);
    const cleanupRows = Math.max(oldSize.rows, publication.document.values.length, 1);
    const cleanupColumns = Math.max(oldSize.columns, publication.document.columnCount, 1);
    if (cleanupRows * cleanupColumns > this.maxBackupCells) {
      throw new BrowserSheetRollbackError(cause, ["диапазон восстановления превышает безопасный лимит"]);
    }
    const cleanupRange = `A1:${columnLetter(cleanupColumns)}${cleanupRows}`;
    const mismatches = await this.restoreBackup(
      backup, cleanupRange, cleanupRows, cleanupColumns, sheetUrl, tabName
    );
    if (mismatches.length) throw new BrowserSheetRollbackError(cause, mismatches);
  }

  private async restoreBackup(
    backup: BrowserSheetReadback,
    cleanupRange: string,
    cleanupRows: number,
    cleanupColumns: number,
    sheetUrl: string,
    tabName: string
  ): Promise<string[]> {
    const size = readbackDimensions(backup);
    // A failed HTML paste may have recreated only part of the target merges.
    // Best-effort unmerge makes the rollback paste rectangular again; the
    // subsequent exact readback still decides whether recovery succeeded.
    await this.driver.unmergeRange(cleanupRange);
    await this.driver.clearRange(cleanupRange);
    if (size.rows && size.columns && (backup.payload.plainText || backup.payload.htmlText)) {
      await this.driver.writeClipboard(backup.payload);
      await this.driver.pasteAt("A1");
    }
    await this.driver.waitForSettled();
    await this.driver.open(sheetUrl);
    await this.driver.selectTab(tabName);
    await this.driver.assertEditable();
    const restored = await this.driver.readRange(cleanupRange, cleanupRows, cleanupColumns);
    const expected = paddedExpected(expectedFromReadback(backup), cleanupRows, cleanupColumns);
    return verifyBrowserSheetReadback(restored, expected, backup.merges);
  }
}
