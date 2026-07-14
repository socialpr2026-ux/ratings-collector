import { analyzeProductIdentity } from "../src/server/utils/product-name.js";
import { extractPageProductEvidence } from "../src/server/utils/product-evidence.js";
import { readTextBounded, safeFetch } from "../src/server/utils/safe-fetch.js";

const [url, brand, scope] = process.argv.slice(2);
if (!url || !brand) throw new Error("Использование: probe-product-page <https-url> <бренд> [family]");

const response = await safeFetch(url);
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const html = await readTextBounded(response, 10_000_000);
const evidence = extractPageProductEvidence(html, response.url || url, brand, { forceFamily: scope === "family" });
const title = evidence.signals.find((signal) => signal.source === "title")?.text ?? brand;
const identity = analyzeProductIdentity({ brand, product: title, url, evidence });
const variantLabels = evidence.variants.map((product) => analyzeProductIdentity({ brand, product }).label);

process.stdout.write(`${JSON.stringify({ identity, variantLabels, evidence }, null, 2)}\n`);
