import { analyzeProductIdentity } from "../src/server/utils/product-name.js";

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const [sheetId, gid = "0"] = process.argv.slice(2);
if (!sheetId) throw new Error("Использование: audit-sheet-product-labels <sheetId> [gid]");

const response = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`);
if (!response.ok) throw new Error(`Google Sheets: HTTP ${response.status}`);

const productRows = parseCsv(await response.text()).filter((row) => /^https:\/\//iu.test(row[1] ?? ""));
const audited = productRows.map((row) => ({
  brand: row[0],
  url: row[1],
  before: row[2],
  identity: analyzeProductIdentity({ brand: row[0], product: row[2], url: row[1] })
}));
const counts = Object.fromEntries(
  ["variant", "family", "line", "unresolved", "not_product"].map((granularity) => [
    granularity,
    audited.filter((item) => item.identity.granularity === granularity).length
  ])
);

process.stdout.write(`${JSON.stringify({
  total: audited.length,
  counts,
  oldDraftLabels: audited.filter((item) => /вариант не определён/iu.test(item.before)).length,
  newDraftLabels: audited.filter((item) => /вариант не определён/iu.test(item.identity.label)).length,
  standaloneForms: audited.filter((item) => /^(?:таблетки|капсулы|саше|порошок|раствор|спрей|капли)$/iu.test(item.identity.label)).length,
  latinLabels: audited
    .filter((item) => /[a-z]{2}/iu.test(item.identity.label))
    .map((item) => ({ brand: item.brand, before: item.before, after: item.identity.label, url: item.url })),
  reviewExamples: audited
    .filter((item) => item.identity.granularity === "unresolved")
    .slice(0, 40)
    .map((item) => ({ brand: item.brand, before: item.before, after: item.identity.label, url: item.url }))
}, null, 2)}\n`);
