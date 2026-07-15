/**
 * Ratings Collector -> Google Sheets bridge.
 *
 * Deploy as a Web App that executes as the owner and is available to Anyone.
 * The endpoint intentionally has no application secret, so every request is
 * restricted to a spreadsheet that is itself shared as public Editor and to
 * a canonical "Ratings <brand>" tab (or the legacy shared Ratings tabs).
 */

var RATINGS_TAB = "Ratings";
var LEGACY_RATINGS_TAB = "Рейтинги";
var MAX_CELLS = 50000;
var LOCK_WAIT_MS = 30000;
var ROW_KINDS = {
  brand: true,
  title: true,
  subheader: true,
  section: true,
  product: true,
  blank: true,
  summaryHeader: true,
  summary: true,
  footnote: true
};

function doGet() {
  return jsonOutput_({
    ok: true,
    service: "ratings-sheets-publisher",
    methods: ["POST"],
    tabName: RATINGS_TAB
  });
}

function doPost(event) {
  try {
    var payload = parsePayload_(event);
    if (payload.action === "read") {
      return jsonOutput_(withLock_(function () { return readAction_(payload); }));
    }
    if (payload.action === "write") {
      return jsonOutput_(withLock_(function () { return writeAction_(payload); }));
    }
    if (payload.action === "readBatch") {
      return jsonOutput_(withLock_(function () { return readBatchAction_(payload); }));
    }
    if (payload.action === "writeBatch") {
      return jsonOutput_(withLock_(function () { return writeBatchAction_(payload); }));
    }
    throw serviceError_("invalid_action", "Разрешены только операции read, write, readBatch и writeBatch", false);
  } catch (error) {
    return jsonOutput_({
      ok: false,
      code: error && error.code ? String(error.code) : "apps_script_error",
      error: safeMessage_(error),
      retryable: Boolean(error && error.retryable),
      rollbackFailed: Boolean(error && error.rollbackFailed)
    });
  }
}

function readAction_(payload) {
  var target = openTarget_(payload);
  var readback = captureSheet_(target.spreadsheetId, target.sheet);
  return { ok: true, action: "read", readback: readback };
}

function readBatchAction_(payload) {
  if (!Array.isArray(payload.tabNames) || !payload.tabNames.length) {
    throw serviceError_("invalid_request", "tabNames должен содержать хотя бы одну вкладку", false);
  }
  var seen = {};
  var readbacks = payload.tabNames.map(function (tabName) {
    var identity = tabIdentity_(tabName);
    if (seen[identity]) throw serviceError_("invalid_request", "Названия вкладок не должны повторяться", false);
    seen[identity] = true;
    var target = openTarget_({
      action: "read",
      spreadsheetId: payload.spreadsheetId,
      tabName: tabName
    });
    return captureSheet_(target.spreadsheetId, target.sheet);
  });
  return { ok: true, action: "readBatch", readbacks: readbacks };
}

function writeAction_(payload) {
  var target = openTarget_(payload);
  var document = validateDocument_(payload.document);
  if (typeof payload.expectedRevision !== "string" || !/^[a-f0-9]{64}$/i.test(payload.expectedRevision)) {
    throw serviceError_("invalid_revision", "expectedRevision должна быть SHA-256 строкой", false);
  }

  var current = captureSheet_(target.spreadsheetId, target.sheet);
  if (current.revision !== payload.expectedRevision) {
    throw serviceError_(
      "revision_mismatch",
      "Таблица изменилась после чтения. Повторите публикацию с новым снимком.",
      true
    );
  }

  if (matchesDocument_(current, document)) {
    return {
      ok: true,
      action: "write",
      range: targetRange_(document.columnCount, document.values.length),
      attempts: 0,
      verifiedAt: new Date().toISOString(),
      readback: current
    };
  }

  var backup = null;
  var backupState = current;
  var mutated = false;
  try {
    backup = createBackup_(target.spreadsheet, target.sheet);
    // replaceSheet_ consists of several Google calls; any one of them can fail
    // after an earlier call already changed the target.
    mutated = true;
    replaceSheet_(target.sheet, document, current.rows, current.columns);
    SpreadsheetApp.flush();

    var readback = captureSheet_(
      target.spreadsheetId,
      target.sheet,
      document.values.length,
      document.columnCount
    );
    var mismatches = documentMismatches_(readback, document);
    if (mismatches.length) {
      throw serviceError_(
        "readback_mismatch",
        "Точная проверка записи не пройдена: " + mismatches.slice(0, 5).join("; "),
        false
      );
    }

    target.spreadsheet.deleteSheet(backup);
    backup = null;
    return {
      ok: true,
      action: "write",
      range: targetRange_(document.columnCount, document.values.length),
      attempts: 1,
      verifiedAt: new Date().toISOString(),
      readback: readback
    };
  } catch (writeError) {
    var rollbackError = null;
    if (mutated && backup) {
      try {
        restoreBackup_(target.sheet, backup, backupState, document.values.length, document.columnCount);
        SpreadsheetApp.flush();
        var restored = captureSheet_(
          target.spreadsheetId,
          target.sheet,
          backupState.rows,
          backupState.columns
        );
        if (restored.revision !== backupState.revision) {
          throw new Error("revision после rollback не совпала с исходной");
        }
      } catch (restoreError) {
        rollbackError = restoreError;
      }
    }

    if (!rollbackError && backup) {
      try {
        target.spreadsheet.deleteSheet(backup);
        backup = null;
      } catch (cleanupError) {
        throw serviceError_(
          "backup_cleanup_failed",
          "Исходный лист восстановлен, но скрытую резервную вкладку удалить не удалось: " + safeMessage_(cleanupError),
          false
        );
      }
    }
    if (rollbackError) {
      var uncertain = serviceError_(
        "rollback_failed",
        "Запись завершилась ошибкой, и исходный лист не удалось точно восстановить: " + safeMessage_(rollbackError),
        false
      );
      uncertain.rollbackFailed = true;
      throw uncertain;
    }
    throw writeError;
  }
}

function writeBatchAction_(payload) {
  if (!Array.isArray(payload.sheets) || !payload.sheets.length) {
    throw serviceError_("invalid_request", "sheets должен содержать хотя бы одну вкладку", false);
  }
  var seen = {};
  var totalCells = 0;
  var entries = payload.sheets.map(function (item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw serviceError_("invalid_request", "Каждая публикация должна быть объектом", false);
    }
    var identity = tabIdentity_(item.tabName);
    if (seen[identity]) throw serviceError_("invalid_request", "Названия вкладок не должны повторяться", false);
    seen[identity] = true;
    var target = openTarget_({
      action: "write",
      spreadsheetId: payload.spreadsheetId,
      tabName: item.tabName
    });
    var document = validateDocument_(item.document);
    totalCells += document.values.length * document.columnCount;
    if (totalCells > MAX_CELLS) {
      throw serviceError_("sheet_too_large", "Суммарная публикация превышает лимит " + MAX_CELLS + " ячеек", false);
    }
    if (typeof item.expectedRevision !== "string" || !/^[a-f0-9]{64}$/i.test(item.expectedRevision)) {
      throw serviceError_("invalid_revision", "expectedRevision должна быть SHA-256 строкой", false);
    }
    var current = captureSheet_(target.spreadsheetId, target.sheet);
    if (current.revision !== item.expectedRevision) {
      throw serviceError_(
        "revision_mismatch",
        "Вкладка «" + item.tabName + "» изменилась после чтения. Повторите публикацию.",
        true
      );
    }
    return {
      target: target,
      document: document,
      current: current,
      changed: !matchesDocument_(current, document),
      backup: null,
      readback: null
    };
  });

  try {
    entries.forEach(function (entry) {
      if (entry.changed) entry.backup = createBackup_(entry.target.spreadsheet, entry.target.sheet);
    });
    entries.forEach(function (entry) {
      if (entry.changed) {
        replaceSheet_(entry.target.sheet, entry.document, entry.current.rows, entry.current.columns);
      }
    });
    SpreadsheetApp.flush();
    entries.forEach(function (entry) {
      entry.readback = entry.changed
        ? captureSheet_(
            entry.target.spreadsheetId,
            entry.target.sheet,
            entry.document.values.length,
            entry.document.columnCount
          )
        : entry.current;
      var mismatches = documentMismatches_(entry.readback, entry.document);
      if (mismatches.length) {
        throw serviceError_(
          "readback_mismatch",
          "Точная проверка вкладки «" + entry.target.sheet.getName() + "» не пройдена: " + mismatches.slice(0, 5).join("; "),
          false
        );
      }
    });
    entries.forEach(function (entry) {
      if (entry.backup) {
        try {
          entry.target.spreadsheet.deleteSheet(entry.backup);
          entry.backup = null;
        } catch (cleanupError) {
          // The verified target is the committed result. A hidden backup left
          // behind is safer than reporting a false publication failure after
          // every target has already passed exact readback.
        }
      }
    });
    var verifiedAt = new Date().toISOString();
    return {
      ok: true,
      action: "writeBatch",
      verifiedAt: verifiedAt,
      results: entries.map(function (entry) {
        return {
          tabName: entry.target.sheet.getName(),
          range: targetRange_(entry.document.columnCount, entry.document.values.length),
          attempts: entry.changed ? 1 : 0,
          readback: entry.readback
        };
      })
    };
  } catch (writeError) {
    var rollbackErrors = [];
    entries.forEach(function (entry) {
      if (!entry.changed || !entry.backup) return;
      try {
        restoreBackup_(
          entry.target.sheet,
          entry.backup,
          entry.current,
          entry.document.values.length,
          entry.document.columnCount
        );
      } catch (restoreError) {
        rollbackErrors.push(entry.target.sheet.getName() + ": " + safeMessage_(restoreError));
      }
    });
    SpreadsheetApp.flush();
    entries.forEach(function (entry) {
      if (!entry.backup) return;
      try {
        var restored = captureSheet_(
          entry.target.spreadsheetId,
          entry.target.sheet,
          entry.current.rows,
          entry.current.columns
        );
        if (restored.revision !== entry.current.revision) {
          rollbackErrors.push(entry.target.sheet.getName() + ": revision после rollback не совпала");
          return;
        }
        entry.target.spreadsheet.deleteSheet(entry.backup);
        entry.backup = null;
      } catch (verificationError) {
        rollbackErrors.push(entry.target.sheet.getName() + ": " + safeMessage_(verificationError));
      }
    });
    if (rollbackErrors.length) {
      var uncertain = serviceError_(
        "rollback_failed",
        "Пакетная запись завершилась ошибкой, и исходные вкладки не удалось точно восстановить: " + rollbackErrors.join("; "),
        false
      );
      uncertain.rollbackFailed = true;
      throw uncertain;
    }
    throw writeError;
  }
}

function openTarget_(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw serviceError_("invalid_request", "Тело запроса должно быть JSON-объектом", false);
  }
  if (!isRatingsTabName_(payload.tabName)) {
    throw serviceError_("invalid_tab", "Разрешены только вкладки Ratings <бренд> и прежние вкладки Ratings/Рейтинги", false);
  }
  if (typeof payload.spreadsheetId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(payload.spreadsheetId)) {
    throw serviceError_("invalid_spreadsheet_id", "Некорректный spreadsheetId", false);
  }

  var file;
  try {
    file = DriveApp.getFileById(payload.spreadsheetId);
  } catch (error) {
    throw serviceError_("spreadsheet_unavailable", "Таблица не найдена или недоступна Web App", false);
  }
  var access;
  var permission;
  try {
    access = file.getSharingAccess();
    permission = file.getSharingPermission();
  } catch (error) {
    throw serviceError_("sharing_check_failed", "Не удалось проверить публичный доступ к таблице", false);
  }
  var publicAccess = access === DriveApp.Access.ANYONE || access === DriveApp.Access.ANYONE_WITH_LINK;
  if (!publicAccess || permission !== DriveApp.Permission.EDIT) {
    throw serviceError_(
      "public_edit_required",
      "Таблица должна быть открыта как «Все» или «Все, у кого есть ссылка» с ролью «Редактор»",
      false
    );
  }

  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(payload.spreadsheetId);
  } catch (error) {
    throw serviceError_("spreadsheet_unavailable", "Не удалось открыть таблицу", false);
  }
  var sheet = spreadsheet.getSheetByName(payload.tabName);
  if (!sheet && payload.action === "read") {
    if (payload.tabName === RATINGS_TAB) {
      sheet = spreadsheet.getSheetByName(RATINGS_TAB) || spreadsheet.getSheetByName(LEGACY_RATINGS_TAB);
    }
    if (!sheet) {
      try {
        sheet = spreadsheet.insertSheet(payload.tabName);
      } catch (error) {
        // A manual edit can race with this request even though Web App calls
        // are serialized by LockService. Re-read before reporting failure.
        sheet = spreadsheet.getSheetByName(payload.tabName);
        if (!sheet) throw serviceError_("tab_create_failed", "Не удалось создать вкладку «" + payload.tabName + "»", false);
      }
    }
  }
  if (!sheet) {
    throw serviceError_("tab_changed", "Рабочая вкладка изменилась после проверки. Повторите публикацию.", true);
  }
  return { spreadsheetId: payload.spreadsheetId, spreadsheet: spreadsheet, sheet: sheet };
}

function isRatingsTabName_(value) {
  return value === RATINGS_TAB || value === LEGACY_RATINGS_TAB ||
    typeof value === "string" && value.length <= 100 && /^Ratings [^\[\]*?:\\/]+$/.test(value);
}

function tabIdentity_(value) {
  var text = String(value || "");
  return (typeof text.normalize === "function" ? text.normalize("NFKC") : text).toLocaleLowerCase("ru-RU");
}

function validateDocument_(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw serviceError_("invalid_document", "document должен быть JSON-объектом", false);
  }
  var values = input.values;
  var formulas = input.formulas;
  var rowKinds = input.rowKinds;
  var columns = input.columnCount;
  if (!Array.isArray(values) || !values.length || !isInteger_(columns) || columns < 1) {
    throw serviceError_("invalid_document", "document не содержит прямоугольный диапазон", false);
  }
  if (values.length * columns > MAX_CELLS) {
    throw serviceError_("sheet_too_large", "Диапазон превышает лимит " + MAX_CELLS + " ячеек", false);
  }
  if (!Array.isArray(formulas) || formulas.length !== values.length || !Array.isArray(rowKinds) || rowKinds.length !== values.length) {
    throw serviceError_("invalid_document", "Размеры values, formulas и rowKinds не совпадают", false);
  }
  for (var row = 0; row < values.length; row += 1) {
    if (!Array.isArray(values[row]) || values[row].length !== columns || !Array.isArray(formulas[row]) || formulas[row].length !== columns) {
      throw serviceError_("invalid_document", "Строка " + (row + 1) + " имеет неверную ширину", false);
    }
    if (!ROW_KINDS[rowKinds[row]]) {
      throw serviceError_("invalid_document", "Некорректный rowKind в строке " + (row + 1), false);
    }
    for (var column = 0; column < columns; column += 1) {
      var value = values[row][column];
      if (!(value === null || typeof value === "string" || typeof value === "number" && isFinite(value))) {
        throw serviceError_("invalid_document", "Некорректное значение в строке " + (row + 1), false);
      }
      var formula = formulas[row][column];
      if (!(formula === null || typeof formula === "string" && formula.charAt(0) === "=")) {
        throw serviceError_("invalid_document", "Некорректная формула в строке " + (row + 1), false);
      }
    }
  }
  var merges = validateMerges_(input.merges, values.length, columns);
  return {
    values: values,
    formulas: formulas,
    rowKinds: rowKinds,
    columnCount: columns,
    merges: merges
  };
}

function validateMerges_(input, rows, columns) {
  if (!Array.isArray(input)) throw serviceError_("invalid_document", "merges должен быть массивом", false);
  var covered = {};
  return input.map(function (item, index) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw serviceError_("invalid_document", "Некорректное объединение " + index, false);
    }
    var merge = {
      startRow: item.startRow,
      endRow: item.endRow,
      startColumn: item.startColumn,
      endColumn: item.endColumn
    };
    if (
      !isInteger_(merge.startRow) || !isInteger_(merge.endRow) ||
      !isInteger_(merge.startColumn) || !isInteger_(merge.endColumn) ||
      merge.startRow < 0 || merge.startColumn < 0 ||
      merge.endRow <= merge.startRow || merge.endColumn <= merge.startColumn ||
      merge.endRow > rows || merge.endColumn > columns
    ) {
      throw serviceError_("invalid_document", "Объединение " + index + " выходит за границы", false);
    }
    for (var row = merge.startRow; row < merge.endRow; row += 1) {
      for (var column = merge.startColumn; column < merge.endColumn; column += 1) {
        var key = row + ":" + column;
        if (covered[key]) throw serviceError_("invalid_document", "Объединения пересекаются в " + key, false);
        covered[key] = true;
      }
    }
    return merge;
  });
}

function captureSheet_(spreadsheetId, sheet, forcedRows, forcedColumns) {
  var rows = typeof forcedRows === "number" ? forcedRows : sheet.getLastRow();
  var columns = typeof forcedColumns === "number" ? forcedColumns : sheet.getLastColumn();
  if (rows < 0 || columns < 0 || rows * columns > MAX_CELLS) {
    throw serviceError_("sheet_too_large", "Лист превышает лимит " + MAX_CELLS + " ячеек", false);
  }
  var values = [];
  var formulas = [];
  var displayValues = [];
  var merges = [];
  if (rows && columns) {
    var range = sheet.getRange(1, 1, rows, columns);
    values = range.getValues().map(function (row) {
      return row.map(normalizeScalar_);
    });
    formulas = range.getFormulas().map(function (row) {
      return row.map(function (formula) { return formula ? String(formula) : null; });
    });
    displayValues = range.getDisplayValues();
    merges = range.getMergedRanges().map(function (merged) {
      return {
        startRow: merged.getRow() - 1,
        endRow: merged.getRow() - 1 + merged.getNumRows(),
        startColumn: merged.getColumn() - 1,
        endColumn: merged.getColumn() - 1 + merged.getNumColumns()
      };
    }).sort(function (left, right) {
      return left.startRow - right.startRow || left.startColumn - right.startColumn ||
        left.endRow - right.endRow || left.endColumn - right.endColumn;
    });
  }
  var revisionPayload = { rows: rows, columns: columns, values: values, formulas: formulas, merges: merges };
  return {
    spreadsheetId: spreadsheetId,
    tabName: sheet.getName(),
    values: values,
    formulas: formulas,
    displayValues: displayValues,
    merges: merges,
    revision: sha256_(JSON.stringify(revisionPayload)),
    rows: rows,
    columns: columns
  };
}

function createBackup_(spreadsheet, source) {
  var backup = source.copyTo(spreadsheet);
  var name = "__ratings_backup_" + Date.now() + "_" + Utilities.getUuid().slice(0, 8);
  backup.setName(name.slice(0, 99));
  backup.hideSheet();
  SpreadsheetApp.flush();
  return backup;
}

function replaceSheet_(sheet, document, previousRows, previousColumns) {
  var rows = document.values.length;
  var columns = document.columnCount;
  var cleanupRows = Math.max(rows, previousRows, 1);
  var cleanupColumns = Math.max(columns, previousColumns, 1);
  ensureGrid_(sheet, cleanupRows, cleanupColumns);
  var cleanup = sheet.getRange(1, 1, cleanupRows, cleanupColumns);
  cleanup.breakApart();
  cleanup.clear();

  writeCells_(sheet, document.values, document.formulas, rows, columns);
  applyFormatting_(sheet, document.rowKinds, rows, columns);
  applyMerges_(sheet, document.merges);
  applyLayout_(sheet, document.rowKinds, rows, columns);
}

function restoreBackup_(target, backup, backupState, writtenRows, writtenColumns) {
  var cleanupRows = Math.max(backupState.rows, writtenRows, 1);
  var cleanupColumns = Math.max(backupState.columns, writtenColumns, 1);
  ensureGrid_(target, cleanupRows, cleanupColumns);
  var cleanup = target.getRange(1, 1, cleanupRows, cleanupColumns);
  cleanup.breakApart();
  cleanup.clear();

  if (!backupState.rows || !backupState.columns) return;
  var source = backup.getRange(1, 1, backupState.rows, backupState.columns);
  var destination = target.getRange(1, 1, backupState.rows, backupState.columns);
  source.copyTo(destination);
  destination.breakApart();
  destination.clearContent();
  writeCells_(target, backupState.values, backupState.formulas, backupState.rows, backupState.columns);
  applyMerges_(target, backupState.merges);
}

function writeCells_(sheet, values, formulas, rows, columns) {
  if (!rows || !columns) return;
  var matrix = [];
  for (var row = 0; row < rows; row += 1) {
    var output = [];
    for (var column = 0; column < columns; column += 1) {
      var formula = formulas[row][column];
      if (formula) {
        output.push(normalizeFormulaForWrite_(formula));
      } else {
        var value = values[row][column];
        output.push(typeof value === "string" && /^[=+\-@]/.test(value) ? "'" + value : value === null ? "" : value);
      }
    }
    matrix.push(output);
  }
  sheet.getRange(1, 1, rows, columns).setValues(matrix);
}

function applyMerges_(sheet, merges) {
  merges.forEach(function (merge) {
    sheet.getRange(
      merge.startRow + 1,
      merge.startColumn + 1,
      merge.endRow - merge.startRow,
      merge.endColumn - merge.startColumn
    ).merge();
  });
}

function applyFormatting_(sheet, rowKinds, rows, columns) {
  var whole = sheet.getRange(1, 1, rows, columns);
  whole
    .setFontFamily("Inter")
    .setFontSize(10)
    .setFontColor("#241f35")
    .setFontWeight("normal")
    .setFontStyle("normal")
    .setFontLine("none")
    .setBackground("#ffffff")
    .setVerticalAlignment("middle")
    .setHorizontalAlignment("left")
    .setWrap(true);

  // Product rows form one contiguous block inside each of the three report
  // sections. Format those blocks in batches so a long monthly history does
  // not turn into thousands of remote Apps Script calls.
  var productBlockStart = -1;
  for (var productCursor = 0; productCursor <= rows; productCursor += 1) {
    if (productCursor < rows && rowKinds[productCursor] === "product") {
      if (productBlockStart < 0) productBlockStart = productCursor;
      continue;
    }
    if (productBlockStart >= 0) {
      var productCount = productCursor - productBlockStart;
      var productRange = sheet.getRange(productBlockStart + 1, 1, productCount, columns);
      productRange.setBackground("#ffffff")
        .setBorder(null, null, true, null, null, true, "#ebe9f4", SpreadsheetApp.BorderStyle.SOLID);
      sheet.getRange(productBlockStart + 1, 1, productCount, 1).setFontColor("#4932a8").setFontLine("underline");
      sheet.getRange(productBlockStart + 1, 3, productCount, 1).setFontWeight("bold").setFontColor("#120755");
      if (columns > 4) {
        sheet.getRange(productBlockStart + 1, 5, productCount, columns - 4)
          .setBackground("#fbfaff").setHorizontalAlignment("center");
      }
      productBlockStart = -1;
    }
  }

  for (var row = 0; row < rows; row += 1) {
    var kind = rowKinds[row];
    if (kind === "product") continue;
    var rowRange = sheet.getRange(row + 1, 1, 1, columns);
    if (kind === "brand") {
      rowRange.setBackground("#120755").setFontColor("#ffffff").setFontWeight("bold");
      rowRange.setBorder(null, null, true, null, null, null, "#ff4d00", SpreadsheetApp.BorderStyle.SOLID_THICK);
      sheet.getRange(row + 1, 1).setFontSize(16);
      if (columns > 4) {
        sheet.getRange(row + 1, 5, 1, columns - 4).setFontColor("#aeade5").setHorizontalAlignment("right");
      }
    } else if (kind === "title") {
      rowRange.setBackground("#120755").setFontColor("#ffffff").setFontWeight("bold").setFontSize(10);
    } else if (kind === "subheader" && columns > 4) {
      sheet.getRange(row + 1, 5, 1, columns - 4)
        .setBackground("#120755").setFontColor("#ffffff").setFontWeight("bold").setFontSize(10);
    } else if (kind === "section") {
      rowRange.setBackground("#f0effa").setFontWeight("bold").setFontColor("#625b85");
      rowRange.setBorder(true, null, true, null, null, null, "#aeade5", SpreadsheetApp.BorderStyle.SOLID);
      sheet.getRange(row + 1, 1).setFontSize(12).setFontColor("#120755")
        .setBorder(null, true, null, null, null, null, "#ff4d00", SpreadsheetApp.BorderStyle.SOLID_THICK);
    } else if (kind === "summaryHeader") {
      rowRange.setBackground("#e7e5f7").setFontWeight("bold").setFontColor("#120755");
      rowRange.setBorder(true, null, null, null, null, null, "#ff4d00", SpreadsheetApp.BorderStyle.SOLID_THICK);
    } else if (kind === "summary") {
      rowRange.setBackground("#fbfaff").setBorder(null, null, true, null, null, null, "#e3e0f1", SpreadsheetApp.BorderStyle.SOLID);
      sheet.getRange(row + 1, 1).setFontWeight("bold").setFontColor("#120755");
    } else if (kind === "footnote") {
      rowRange.setBackground("#fbfaff").setFontStyle("italic").setFontColor("#746f86").setFontSize(9);
    }
    if (columns > 4 && ["title", "subheader", "section", "product", "summaryHeader", "summary"].indexOf(kind) >= 0) {
      sheet.getRange(row + 1, 5, 1, columns - 4).setHorizontalAlignment("center");
    }
  }

  var formats = [];
  for (var formatRow = 0; formatRow < rows; formatRow += 1) {
    var rowFormats = [];
    for (var column = 0; column < columns; column += 1) {
      var rowKind = rowKinds[formatRow];
      if ((rowKind === "product" || rowKind === "summary") && column >= 4) {
        if (rowKind === "summary" && (column - 4) % 2 === 1) rowFormats.push("0%");
        else if (rowKind === "product" && (column - 4) % 2 === 1) rowFormats.push("0.0");
        else rowFormats.push("#,##0");
      } else {
        rowFormats.push("@");
      }
    }
    formats.push(rowFormats);
  }
  whole.setNumberFormats(formats);

  if (columns > 4) {
    sheet.getRange(1, 5, rows, columns - 4).setBorder(
      null, true, null, true, true, null, "#e3e0f1", SpreadsheetApp.BorderStyle.SOLID
    );
  }

}

function applyLayout_(sheet, rowKinds, rows, columns) {
  // Apply sizing after merges: Google Sheets can otherwise retain dimensions
  // from the previous three-column layout during an in-place migration.
  sheet.setHiddenGridlines(true);
  sheet.setFrozenRows(Math.min(3, rows));
  // The report header merges A:D, so the freeze boundary must sit after D.
  // Freezing only A:C cuts that merged cell and Google rejects the entire
  // publication even though the spreadsheet is editable.
  sheet.setFrozenColumns(Math.min(4, columns));
  sheet.setTabColor("#ff4d00");
  sheet.setColumnWidth(1, 320);
  if (columns >= 2) sheet.setColumnWidth(2, 150);
  if (columns >= 3) sheet.setColumnWidth(3, 310);
  if (columns >= 4) sheet.setColumnWidth(4, 24);
  // The first column in every monthly pair is the combined public counter
  // "Отзывы / оценки"; keep it wider than the compact rating column.
  for (var metricColumn = 5; metricColumn <= columns; metricColumn += 2) {
    sheet.setColumnWidth(metricColumn, 110);
    if (metricColumn + 1 <= columns) sheet.setColumnWidth(metricColumn + 1, 82);
  }
  if (rows > 0) sheet.autoResizeRows(1, rows);
  var heightStart = 0;
  var activeHeight = rowKinds[0] === "brand" ? 44 : 30;
  for (var row = 1; row <= rowKinds.length; row += 1) {
    var height = row < rowKinds.length ?
      (rowKinds[row] === "brand" ? 44 : rowKinds[row] === "section" ? 36 : rowKinds[row] === "blank" ? 16 : rowKinds[row] === "product" ? 32 : 30) :
      -1;
    if (height !== activeHeight) {
      sheet.setRowHeights(heightStart + 1, row - heightStart, activeHeight);
      heightStart = row;
      activeHeight = height;
    }
  }
}

function documentMismatches_(readback, document) {
  var mismatches = [];
  if (readback.rows !== document.values.length || readback.columns !== document.columnCount) {
    return ["размер листа не совпал"];
  }
  for (var row = 0; row < readback.rows; row += 1) {
    for (var column = 0; column < readback.columns; column += 1) {
      var expectedFormula = document.formulas[row][column];
      var actualFormula = readback.formulas[row][column];
      if (expectedFormula) {
        if (!actualFormula || normalizeFormula_(actualFormula) !== normalizeFormula_(expectedFormula)) {
          mismatches.push(a1_(row, column) + ": формула");
        } else {
          var displayed = readback.displayValues && readback.displayValues[row]
            ? readback.displayValues[row][column]
            : "";
          if (typeof displayed === "string" && /^\s*#/u.test(displayed)) {
            mismatches.push(a1_(row, column) + ": ошибка вычисления " + displayed.slice(0, 40));
          }
        }
      } else if (actualFormula) {
        mismatches.push(a1_(row, column) + ": лишняя формула");
      } else if (!sameScalar_(readback.values[row][column], document.values[row][column])) {
        mismatches.push(a1_(row, column) + ": значение");
      }
      if (mismatches.length >= 20) return mismatches;
    }
  }
  var expectedMerges = {};
  var actualMerges = {};
  document.merges.forEach(function (merge) { expectedMerges[mergeKey_(merge)] = true; });
  readback.merges.forEach(function (merge) { actualMerges[mergeKey_(merge)] = true; });
  Object.keys(expectedMerges).forEach(function (key) {
    if (!actualMerges[key]) mismatches.push("нет объединения " + key);
  });
  Object.keys(actualMerges).forEach(function (key) {
    if (!expectedMerges[key]) mismatches.push("лишнее объединение " + key);
  });
  return mismatches.slice(0, 20);
}

function matchesDocument_(readback, document) {
  return documentMismatches_(readback, document).length === 0;
}

function ensureGrid_(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < columns) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
}

function parsePayload_(event) {
  if (!event || !event.postData || typeof event.postData.contents !== "string") {
    throw serviceError_("invalid_request", "Отсутствует JSON-тело запроса", false);
  }
  try {
    var payload = JSON.parse(event.postData.contents);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not an object");
    return payload;
  } catch (error) {
    throw serviceError_("invalid_json", "Некорректный JSON", false);
  }
}

function withLock_(action) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    throw serviceError_("publisher_busy", "Другой вызов публикации ещё выполняется", true);
  }
  try {
    return action();
  } finally {
    lock.releaseLock();
  }
}

function jsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function serviceError_(code, message, retryable) {
  var error = new Error(message);
  error.code = code;
  error.retryable = Boolean(retryable);
  return error;
}

function safeMessage_(error) {
  if (error && typeof error.message === "string") return error.message.slice(0, 1000);
  return String(error || "Неизвестная ошибка").slice(0, 1000);
}

function normalizeScalar_(value) {
  if (value === "" || value === null || typeof value === "undefined") return null;
  if (Object.prototype.toString.call(value) === "[object Date]") return value.toISOString();
  if (typeof value === "number") return isFinite(value) ? value : String(value);
  if (typeof value === "string") return value;
  return String(value);
}

function normalizeFormulaForWrite_(formula) {
  // setValues parses formulas according to the spreadsheet locale. The
  // document intentionally uses semicolons for the ru-RU target sheet.
  return String(formula);
}

function normalizeFormula_(formula) {
  return String(formula)
    .replace(/\s+/g, "")
    .replace(/СЧ[ЕЁ]ТЕСЛИМН(?=\()/gi, "COUNTIFS")
    .replace(/ЕСЛИОШИБКА(?=\()/gi, "IFERROR")
    .replace(/СУММ(?=\()/gi, "SUM")
    .replace(/;/g, ",")
    .toUpperCase();
}

function sameScalar_(left, right) {
  if (left === right) return true;
  return typeof left === "number" && typeof right === "number" && Math.abs(left - right) < 0.000000001;
}

function mergeKey_(merge) {
  return merge.startRow + ":" + merge.endRow + ":" + merge.startColumn + ":" + merge.endColumn;
}

function targetRange_(columns, rows) {
  return "A1:" + columnLetter_(columns) + rows;
}

function a1_(row, column) {
  return columnLetter_(column + 1) + (row + 1);
}

function columnLetter_(oneBased) {
  var result = "";
  var value = oneBased;
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function sha256_(text) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    text,
    Utilities.Charset.UTF_8
  );
  return digest.map(function (byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return ("0" + value.toString(16)).slice(-2);
  }).join("");
}

function isInteger_(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
}
