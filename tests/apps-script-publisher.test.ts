import { describe, expect, it, vi } from "vitest";
import type { SheetDocument } from "../src/server/sheets/model.js";
import {
  AppsScriptPublisherError,
  AppsScriptSheetRollbackError,
  AppsScriptSheetsPublisher,
  validateAppsScriptDocument,
  validateAppsScriptEndpoint,
  verifyAppsScriptReadback,
  type AppsScriptSheetReadback
} from "../src/server/sheets/apps-script-publisher.js";

const endpoint = "https://script.google.com/macros/s/deployment_123/exec";
const sheetUrl = "https://docs.google.com/spreadsheets/d/test_sheet/edit";
const revision = "a".repeat(64);

function document(): SheetDocument {
  return {
    values: [["Заголовок", null], ["Строка", null]],
    formulas: [[null, null], [null, "=SUM(A2:A2)"]],
    rowKinds: ["title", "summary"],
    months: [],
    productStartRow: 2,
    productEndRow: 2,
    summaryStartRow: 2,
    columnCount: 2,
    merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }]
  };
}

function readback(overrides: Partial<AppsScriptSheetReadback> = {}): AppsScriptSheetReadback {
  return {
    spreadsheetId: "test_sheet",
    tabName: "Ratings",
    values: [["Заголовок", null], ["Строка", 1]],
    formulas: [[null, null], [null, "=SUM(A2:A2)"]],
    merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
    revision,
    rows: 2,
    columns: 2,
    ...overrides
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("Apps Script Sheets publisher", () => {
  it("accepts only a canonical Google Apps Script Web App URL", () => {
    expect(validateAppsScriptEndpoint(endpoint)).toBe(endpoint);
    expect(() => validateAppsScriptEndpoint("https://example.com/macros/s/id/exec")).toThrow(/script.google.com/);
    expect(() => validateAppsScriptEndpoint(`${endpoint}?token=secret`)).toThrow(/должен иметь вид/);
  });

  it("requests the canonical tab and validates the server response", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toEqual({ action: "read", spreadsheetId: "test_sheet", tabName: "Ratings" });
      return jsonResponse({ ok: true, action: "read", readback: readback() });
    }) as unknown as typeof fetch;
    const publisher = new AppsScriptSheetsPublisher(endpoint, { fetchImpl });

    const result = await publisher.read(sheetUrl);

    expect(result.revision).toBe(revision);
    expect(result.tabName).toBe("Ratings");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("writes with optimistic revision and performs its own exact readback", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.action).toBe("write");
      expect(request.expectedRevision).toBe(revision);
      expect(request.tabName).toBe("Ratings");
      expect(request.document.rowKinds).toEqual(["title", "summary"]);
      return jsonResponse({
        ok: true,
        action: "write",
        range: "A1:B2",
        attempts: 1,
        verifiedAt: "2026-07-14T01:02:03.000Z",
        readback: readback({ revision: "b".repeat(64) })
      });
    }) as unknown as typeof fetch;
    const publisher = new AppsScriptSheetsPublisher(endpoint, { fetchImpl });

    const result = await publisher.publish({ sheetUrl, document: document(), expectedRevision: revision });

    expect(result.status).toBe("published");
    expect(result.range).toBe("A1:B2");
    expect(result.attempts).toBe(1);
    expect(result.revision).toBe("b".repeat(64));
  });

  it("keeps publishing to a legacy tab returned by preflight", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.tabName).toBe("Рейтинги");
      return jsonResponse({
        ok: true,
        action: "write",
        range: "A1:B2",
        attempts: 1,
        verifiedAt: "2026-07-14T01:02:03.000Z",
        readback: readback({ tabName: "Рейтинги", revision: "b".repeat(64) })
      });
    }) as unknown as typeof fetch;
    const publisher = new AppsScriptSheetsPublisher(endpoint, { fetchImpl });

    const result = await publisher.publish({
      sheetUrl,
      document: document(),
      expectedRevision: revision,
      tabName: "Рейтинги"
    });

    expect(result.readback.tabName).toBe("Рейтинги");
  });

  it("rejects a response for an unrelated tab", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: true,
      action: "read",
      readback: { ...readback(), tabName: "Лист1" }
    })) as unknown as typeof fetch;
    const publisher = new AppsScriptSheetsPublisher(endpoint, { fetchImpl });

    await expect(publisher.read(sheetUrl)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("normalizes localized formula separators during verification", () => {
    const localized = readback({
      formulas: [[null, null], [null, " = СУММ ( A2:A2 ) "]]
    });
    expect(verifyAppsScriptReadback(localized, document())).toEqual([]);
  });

  it("fails closed when the endpoint reports a failed rollback", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: false,
      code: "rollback_failed",
      error: "исходный лист не восстановлен",
      rollbackFailed: true
    })) as unknown as typeof fetch;
    const publisher = new AppsScriptSheetsPublisher(endpoint, { fetchImpl });

    await expect(publisher.publish({ sheetUrl, document: document(), expectedRevision: revision }))
      .rejects.toBeInstanceOf(AppsScriptSheetRollbackError);
  });

  it("surfaces a revision conflict as a retryable error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: false,
      code: "revision_mismatch",
      error: "Таблица изменилась",
      retryable: true
    })) as unknown as typeof fetch;
    const publisher = new AppsScriptSheetsPublisher(endpoint, { fetchImpl });

    await expect(publisher.publish({ sheetUrl, document: document(), expectedRevision: revision }))
      .rejects.toMatchObject({ code: "revision_mismatch", retryable: true } satisfies Partial<AppsScriptPublisherError>);
  });

  it("rejects a document with overlapping merges before network access", () => {
    const invalid = document();
    invalid.merges.push({ startRow: 0, endRow: 2, startColumn: 1, endColumn: 2 });
    expect(() => validateAppsScriptDocument(invalid)).toThrow(/пересекаются/i);
  });

  it("fails closed on a syntactically valid but inexact server readback", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: true,
      action: "write",
      range: "A1:B2",
      attempts: 1,
      verifiedAt: "2026-07-14T01:02:03.000Z",
      readback: readback({ values: [["Другое", null], ["Строка", 1]] })
    })) as unknown as typeof fetch;
    const publisher = new AppsScriptSheetsPublisher(endpoint, { fetchImpl });

    await expect(publisher.publish({ sheetUrl, document: document(), expectedRevision: revision }))
      .rejects.toBeInstanceOf(AppsScriptSheetRollbackError);
  });
});
