export type BrowserClipboardPayload = {
  plainText: string;
  htmlText?: string;
};

export type BrowserSheetCell = {
  text: string;
  formula?: string;
};

export type BrowserSheetMerge = {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
};

export type BrowserSheetReadback = {
  payload: BrowserClipboardPayload;
  cells: BrowserSheetCell[][];
  merges: BrowserSheetMerge[];
  htmlAvailable: boolean;
};

export interface SheetsUiDriver {
  open(sheetUrl: string): Promise<void>;
  selectTab(title: string): Promise<void>;
  assertEditable(): Promise<void>;
  captureCurrentRegion(): Promise<BrowserSheetReadback>;
  clearRange(a1Range: string): Promise<void>;
  unmergeRange(a1Range: string): Promise<boolean>;
  writeClipboard(payload: BrowserClipboardPayload): Promise<void>;
  pasteAt(a1Cell: string): Promise<void>;
  readRange(a1Range: string, rows: number, columns: number): Promise<BrowserSheetReadback>;
  waitForSettled(): Promise<void>;
}

export class BrowserSheetsUiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSheetsUiError";
  }
}

export class BrowserClipboardUnavailableError extends BrowserSheetsUiError {
  constructor(message = "Chromium не предоставил надёжный доступ к HTML-буферу обмена") {
    super(message);
    this.name = "BrowserClipboardUnavailableError";
  }
}

function canonicalEditorUrl(input: string): string {
  const source = new URL(input);
  const match = source.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (source.protocol !== "https:" || source.hostname !== "docs.google.com" || source.username || source.password || !match) {
    throw new BrowserSheetsUiError("Разрешены только публичные HTTPS-ссылки Google Sheets на docs.google.com");
  }
  const hash = new URLSearchParams(source.hash.replace(/^#/, ""));
  const gid = source.searchParams.get("gid") ?? hash.get("gid");
  const target = new URL(`https://docs.google.com/spreadsheets/d/${match[1]}/edit`);
  target.searchParams.set("hl", "ru");
  if (gid && /^\d+$/.test(gid)) {
    target.searchParams.set("gid", gid);
    target.hash = `gid=${gid}`;
  }
  return target.toString();
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

function parseTsv(input: string): BrowserSheetCell[][] {
  if (!input) return [];
  const rows: BrowserSheetCell[][] = [];
  let row: BrowserSheetCell[] = [];
  let value = "";
  let quoted = false;
  let endedWithRowBreak = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
      endedWithRowBreak = false;
    } else if (!quoted && character === "\t") {
      row.push({ text: value }); value = ""; endedWithRowBreak = false;
    } else if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push({ text: value }); rows.push(row); row = []; value = ""; endedWithRowBreak = true;
    } else {
      value += character; endedWithRowBreak = false;
    }
  }
  if (!endedWithRowBreak || row.length || value) { row.push({ text: value }); rows.push(row); }
  return rows;
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0"
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return named[code.toLocaleLowerCase("en-US")] ?? entity;
  });
}

function attribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeHtml(value);
}

function cellText(markup: string): string {
  return decodeHtml(markup
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:div|p)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "");
}

export function parseBrowserClipboardPayload(payload: BrowserClipboardPayload): BrowserSheetReadback {
  let cells = parseTsv(payload.plainText);
  const merges: BrowserSheetMerge[] = [];
  const table = payload.htmlText?.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  const htmlAvailable = table !== undefined;
  if (table !== undefined) {
    const parsed: BrowserSheetCell[][] = [];
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    let rowIndex = 0;
    while ((rowMatch = rowPattern.exec(table)) !== null) {
      parsed[rowIndex] ??= [];
      let columnIndex = 0;
      const cellPattern = /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
        while (parsed[rowIndex][columnIndex] !== undefined) columnIndex += 1;
        const rowSpan = Math.max(1, Number(attribute(cellMatch[1], "rowspan") ?? 1));
        const columnSpan = Math.max(1, Number(attribute(cellMatch[1], "colspan") ?? 1));
        const formula = attribute(cellMatch[1], "data-sheets-formula");
        const text = cellText(cellMatch[2]);
        parsed[rowIndex][columnIndex] = formula ? { text, formula } : { text };
        for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
          parsed[rowIndex + rowOffset] ??= [];
          for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
            if (rowOffset || columnOffset) parsed[rowIndex + rowOffset][columnIndex + columnOffset] = { text: "" };
          }
        }
        if (rowSpan > 1 || columnSpan > 1) merges.push({
          startRow: rowIndex, endRow: rowIndex + rowSpan,
          startColumn: columnIndex, endColumn: columnIndex + columnSpan
        });
        columnIndex += columnSpan;
      }
      rowIndex += 1;
    }
    if (parsed.length) cells = parsed;
  }
  return { payload, cells, merges, htmlAvailable };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tsvCell(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formulaAwareHtml(source: string, cells: BrowserSheetCell[][]): string {
  let rowIndex = 0;
  const occupied = new Set<string>();
  return source.replace(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi, (rowMarkup, rowAttributes: string, rowContent: string) => {
    let columnIndex = 0;
    const rewritten = rowContent.replace(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
      (cellMarkup, tag: string, attributes: string, content: string) => {
        while (occupied.has(`${rowIndex}:${columnIndex}`)) columnIndex += 1;
        const rowSpan = Math.max(1, Number(attribute(attributes, "rowspan") ?? 1));
        const columnSpan = Math.max(1, Number(attribute(attributes, "colspan") ?? 1));
        for (let rowOffset = 1; rowOffset < rowSpan; rowOffset += 1) {
          for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
            occupied.add(`${rowIndex + rowOffset}:${columnIndex + columnOffset}`);
          }
        }
        const formula = cells[rowIndex]?.[columnIndex]?.formula;
        columnIndex += columnSpan;
        if (!formula) return cellMarkup;
        const withoutFormula = attributes.replace(/\sdata-sheets-formula\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
        return `<${tag}${withoutFormula} data-sheets-formula="${escapeHtml(formula)}">${escapeHtml(formula)}</${tag}>`;
      });
    rowIndex += 1;
    return `<tr${rowAttributes}>${rewritten}</tr>`;
  });
}

export function buildFormulaAwareClipboardPayload(readback: BrowserSheetReadback): BrowserClipboardPayload {
  const plainText = readback.cells.map((row) => row.map((cell) => tsvCell(cell.formula ?? cell.text)).join("\t")).join("\r\n");
  const htmlText = readback.payload.htmlText ? formulaAwareHtml(readback.payload.htmlText, readback.cells) : undefined;
  return { plainText, htmlText };
}

export type LocatorLike = {
  count(): Promise<number>;
  first(): LocatorLike;
  nth(index: number): LocatorLike;
  filter(options: { hasText: string }): LocatorLike;
  click(options?: { timeout?: number; force?: boolean }): Promise<void>;
  hover(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: "visible"; timeout?: number }): Promise<void>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
};

export type PlaywrightPageLike = {
  goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
  locator(selector: string): LocatorLike;
  keyboard: {
    press(key: string): Promise<void>;
    type(text: string): Promise<void>;
  };
  evaluate<Result, Argument>(fn: (argument: Argument) => Result | Promise<Result>, argument: Argument): Promise<Result>;
  waitForTimeout(milliseconds: number): Promise<void>;
  context(): { grantPermissions(permissions: string[], options?: { origin?: string }): Promise<void> };
  url(): string;
};

export type PlaywrightSheetsUiDriverOptions = {
  timeoutMs?: number;
  settleMs?: number;
  modifier?: "Control" | "Meta";
  fetch?: typeof globalThis.fetch;
  formulaShortcut?: string;
};

export class PlaywrightSheetsUiDriver implements SheetsUiDriver {
  private readonly timeoutMs: number;
  private readonly settleMs: number;
  private readonly modifier: "Control" | "Meta";
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly formulaShortcut: string;
  private origin = "https://docs.google.com";
  private sheetUrl?: string;
  private activeGid?: string;

  constructor(private readonly page: PlaywrightPageLike, options: PlaywrightSheetsUiDriverOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.settleMs = options.settleMs ?? 900;
    this.modifier = options.modifier ?? "Control";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.formulaShortcut = options.formulaShortcut ?? `${this.modifier}+Backquote`;
  }

  async open(sheetUrl: string): Promise<void> {
    this.sheetUrl = canonicalEditorUrl(sheetUrl);
    this.origin = new URL(this.sheetUrl).origin;
    try {
      await this.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: this.origin });
    } catch (error) {
      throw new BrowserClipboardUnavailableError(`Не удалось выдать Chromium разрешения буфера обмена: ${(error as Error).message}`);
    }
    await this.page.goto(this.sheetUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    await this.page.locator("#waffle-grid-container, .waffle-grid-container").first().waitFor({ state: "visible", timeout: this.timeoutMs });
  }

  async selectTab(title: string): Promise<void> {
    const selectors = [".docs-sheet-tab-name", "[role='tab']"];
    for (const selector of selectors) {
      const candidates = this.page.locator(selector).filter({ hasText: title });
      for (let index = 0; index < await candidates.count(); index += 1) {
        const candidate = candidates.nth(index);
        if ((await candidate.textContent())?.trim() !== title) continue;
        await candidate.click({ timeout: this.timeoutMs });
        this.activeGid = await this.resolveActiveGid();
        if (!this.activeGid) throw new BrowserSheetsUiError("Не удалось определить gid активного листа для безопасной резервной копии");
        return;
      }
    }
    throw new BrowserSheetsUiError(`В Google Sheets не найден лист «${title}»`);
  }

  async assertEditable(): Promise<void> {
    const readOnly = this.page.locator([
      "[aria-label*='View only']", "[aria-label*='Только просмотр']",
      "[data-tooltip*='View only']", "[data-tooltip*='Только просмотр']"
    ].join(","));
    for (let index = 0; index < await readOnly.count(); index += 1) {
      if (await readOnly.nth(index).isVisible({ timeout: 250 }).catch(() => false)) {
        throw new BrowserSheetsUiError("Таблица открылась только для просмотра; анонимное редактирование недоступно");
      }
    }
    if (!(await this.page.locator("#waffle-grid-container, .waffle-grid-container").first().isVisible({ timeout: this.timeoutMs }))) {
      throw new BrowserSheetsUiError("Редактируемая сетка Google Sheets не загрузилась");
    }
    const editingToolbar = this.page.locator("#t-merge-menu, #t-undo, #docs-toolbar").first();
    if (!(await editingToolbar.count()) || !(await editingToolbar.isVisible({ timeout: 500 }).catch(() => false))) {
      throw new BrowserSheetsUiError("Google Sheets не показал инструменты редактирования; публикация не начата");
    }
  }

  async captureCurrentRegion(): Promise<BrowserSheetReadback> {
    const size = await this.exportedUsedSize();
    if (!size.rows || !size.columns) {
      return { payload: { plainText: "" }, cells: [], merges: [], htmlAvailable: false };
    }
    const range = `A1:${columnLetter(size.columns)}${size.rows}`;
    return this.copyRangeWithFormulas(range, size.rows, size.columns);
  }

  async clearRange(a1Range: string): Promise<void> {
    await this.selectRange(a1Range);
    await this.page.keyboard.press("Delete");
    await this.page.waitForTimeout(100);
  }

  async unmergeRange(a1Range: string): Promise<boolean> {
    await this.selectRange(a1Range);
    const menu = this.page.locator("#t-merge-menu").first();
    if (!(await menu.count()) || !(await menu.isVisible({ timeout: 500 }).catch(() => false))) return false;
    await menu.click({ timeout: this.timeoutMs });
    for (const label of ["Отменить объединение ячеек", "Unmerge cells", "Unmerge", "Разъединить"]) {
      const candidates = this.page.locator(".goog-menuitem, [role='menuitem']").filter({ hasText: label });
      for (let index = 0; index < await candidates.count(); index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible({ timeout: 300 }).catch(() => false)) {
          await candidate.click({ timeout: this.timeoutMs });
          return true;
        }
      }
    }
    await this.page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  async writeClipboard(payload: BrowserClipboardPayload): Promise<void> {
    try {
      await this.page.evaluate(async (input) => {
        if (!navigator.clipboard) throw new Error("Clipboard API отсутствует");
        if (input.htmlText) {
          if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard.write !== "function") {
            throw new Error("HTML ClipboardItem недоступен");
          }
          await navigator.clipboard.write([new ClipboardItem({
            "text/plain": new Blob([input.plainText], { type: "text/plain" }),
            "text/html": new Blob([input.htmlText], { type: "text/html" })
          })]);
          return;
        }
        await navigator.clipboard.writeText(input.plainText);
      }, payload);
    } catch (error) {
      throw new BrowserClipboardUnavailableError(`Не удалось записать публикацию в буфер Chromium: ${(error as Error).message}`);
    }
  }

  async pasteAt(a1Cell: string): Promise<void> {
    await this.selectRange(a1Cell);
    await this.page.keyboard.press(`${this.modifier}+V`);
  }

  async readRange(a1Range: string, rows: number, columns: number): Promise<BrowserSheetReadback> {
    return this.copyRangeWithFormulas(a1Range, rows, columns);
  }

  async waitForSettled(): Promise<void> {
    await this.page.waitForTimeout(this.settleMs);
    const badge = this.page.locator("#docs-save-indicator-badge").first();
    if (!(await badge.count())) throw new BrowserSheetsUiError("Индикатор сохранения Google Sheets не найден");
    const deadline = Date.now() + this.timeoutMs;
    do {
      const state = `${await badge.getAttribute("aria-label") ?? ""} ${await badge.textContent() ?? ""}`;
      if (/сохранено|saved/i.test(state)) return;
      await this.page.waitForTimeout(Math.min(250, this.settleMs));
    } while (Date.now() < deadline);
    throw new BrowserSheetsUiError("Google Sheets не подтвердил сохранение изменений на Диске");
  }

  private async copyRangeWithFormulas(a1Range: string, rows: number, columns: number): Promise<BrowserSheetReadback> {
    await this.selectRange(a1Range);
    await this.page.keyboard.press(`${this.modifier}+C`);
    await this.page.waitForTimeout(150);
    const normal = await this.readClipboard();
    let formulasShown = false;
    try {
      await this.page.keyboard.press(this.formulaShortcut);
      formulasShown = true;
      await this.page.waitForTimeout(300);
      await this.assertFormulaMode(true);
      await this.selectRange(a1Range);
      await this.page.keyboard.press(`${this.modifier}+C`);
      await this.page.waitForTimeout(150);
      const formulaCopy = await this.readClipboard();
      normal.cells = Array.from({ length: rows }, (_, row) =>
        Array.from({ length: columns }, (_, column) => normal.cells[row]?.[column] ?? { text: "" })
      );
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const shown = formulaCopy.cells[row]?.[column]?.text ?? "";
          if (shown.startsWith("=") && shown !== normal.cells[row][column].text) normal.cells[row][column].formula = shown;
        }
      }
      normal.payload = buildFormulaAwareClipboardPayload(normal);
      return normal;
    } finally {
      if (formulasShown) {
        await this.page.keyboard.press(this.formulaShortcut);
        await this.page.waitForTimeout(200);
        await this.assertFormulaMode(false);
      }
    }
  }

  private async assertFormulaMode(expected: boolean): Promise<void> {
    const view = this.page.locator("#docs-view-menu").first();
    if (!(await view.count()) || !(await view.isVisible({ timeout: 500 }).catch(() => false))) {
      throw new BrowserSheetsUiError("Не удалось проверить режим отображения формул Google Sheets");
    }
    try {
      await view.click({ timeout: this.timeoutMs });
      let showMenu: LocatorLike | undefined;
      for (const label of ["Показать", "Show"]) {
        const candidate = this.page.locator(".goog-menuitem, [role='menuitem']").filter({ hasText: label }).first();
        if (await candidate.count() && await candidate.isVisible({ timeout: 300 }).catch(() => false)) {
          showMenu = candidate;
          break;
        }
      }
      if (!showMenu) throw new BrowserSheetsUiError("В меню Google Sheets не найден раздел показа формул");
      await showMenu.hover({ timeout: this.timeoutMs });
      await this.page.waitForTimeout(200);
      const candidates = this.page.locator("[role='menuitemcheckbox'], .goog-menuitem");
      let actual: boolean | undefined;
      for (let index = 0; index < await candidates.count(); index += 1) {
        const candidate = candidates.nth(index);
        if (!(await candidate.isVisible({ timeout: 100 }).catch(() => false))) continue;
        const text = (await candidate.textContent())?.trim() ?? "";
        if (!/^(?:Формулы|Formulas)(?:\s|\()/i.test(text)) continue;
        actual = (await candidate.getAttribute("aria-checked")) === "true" || /goog-option-selected/.test(await candidate.getAttribute("class") ?? "");
        break;
      }
      if (actual !== expected) throw new BrowserSheetsUiError("Google Sheets не подтвердил переключение режима формул");
    } finally {
      await this.page.keyboard.press("Escape").catch(() => undefined);
      await this.page.keyboard.press("Escape").catch(() => undefined);
    }
  }

  private async resolveActiveGid(): Promise<string | undefined> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const url = new URL(this.page.url());
      const fromUrl = url.searchParams.get("gid") ?? new URLSearchParams(url.hash.replace(/^#/, "")).get("gid");
      if (fromUrl && /^\d+$/.test(fromUrl)) return fromUrl;
      const active = this.page.locator(".docs-sheet-active-tab, [role='tab'][aria-selected='true']").first();
      if (await active.count()) {
        for (const name of ["data-sheet-id", "data-gid", "id"]) {
          const value = await active.getAttribute(name);
          const digits = value?.match(/\d+/)?.[0];
          if (digits) return digits;
        }
      }
      await this.page.waitForTimeout(100);
    }
    return undefined;
  }

  private async exportedUsedSize(): Promise<{ rows: number; columns: number }> {
    if (!this.sheetUrl || !this.activeGid) throw new BrowserSheetsUiError("Нет sheet URL/gid для определения полного диапазона");
    const spreadsheetId = new URL(this.sheetUrl).pathname.match(/^\/spreadsheets\/d\/([^/]+)/)?.[1];
    if (!spreadsheetId) throw new BrowserSheetsUiError("Не удалось извлечь ID Google-таблицы");
    const exportUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=tsv&gid=${encodeURIComponent(this.activeGid)}`;
    const response = await this.fetchImpl(exportUrl, { redirect: "follow" });
    if (!response.ok) throw new BrowserSheetsUiError(`Анонимный TSV-export недоступен (${response.status}); публикация не начата`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/tab-separated-values|text\/plain/i.test(contentType)) {
      throw new BrowserSheetsUiError(`Google вернул неожиданный формат TSV-export: ${contentType || "без Content-Type"}`);
    }
    const body = await response.text();
    if (body.length > 10_000_000) throw new BrowserSheetsUiError("TSV-export слишком велик для безопасной браузерной публикации");
    const grid = parseTsv(body);
    return { rows: grid.length, columns: Math.max(0, ...grid.map((row) => row.length)) };
  }

  private async selectRange(a1Range: string): Promise<void> {
    const nameBox = this.page.locator("#t-name-box, input.waffle-name-box, .waffle-name-box input").first();
    if (!(await nameBox.count())) throw new BrowserSheetsUiError("Поле диапазона Google Sheets не найдено; DOM интерфейса изменился");
    await nameBox.click({ timeout: this.timeoutMs });
    await this.page.keyboard.press(`${this.modifier}+A`);
    await this.page.keyboard.type(a1Range);
    await nameBox.press("Enter", { timeout: this.timeoutMs });
    await this.page.waitForTimeout(50);
    const selected = await nameBox.inputValue().catch(() => "");
    if (selected.toLocaleUpperCase("en-US") !== a1Range.toLocaleUpperCase("en-US")) {
      throw new BrowserSheetsUiError(`Google Sheets не подтвердил выбранный диапазон ${a1Range}`);
    }
  }

  private async readClipboard(): Promise<BrowserSheetReadback> {
    try {
      const payload = await this.page.evaluate(async () => {
        if (!navigator.clipboard) throw new Error("Clipboard API отсутствует");
        let plainText = "";
        let htmlText = "";
        if (typeof navigator.clipboard.read === "function") {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            if (item.types.includes("text/plain")) plainText = await (await item.getType("text/plain")).text();
            if (item.types.includes("text/html")) htmlText = await (await item.getType("text/html")).text();
          }
        } else {
          plainText = await navigator.clipboard.readText();
        }
        return { plainText, htmlText: htmlText || undefined };
      }, undefined);
      // Parse outside docs.google.com. That page enforces Trusted Types and
      // rejects DOMParser.parseFromString with an ordinary clipboard string.
      return parseBrowserClipboardPayload(payload);
    } catch (error) {
      throw new BrowserClipboardUnavailableError(`Не удалось прочитать контрольную копию из Chromium: ${(error as Error).message}`);
    }
  }
}
