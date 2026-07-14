function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(value: string): string {
  const link = /(!?)\[([^\]]*)\]\((https:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g;
  let cursor = 0;
  let html = "";
  for (const match of value.matchAll(link)) {
    const index = match.index ?? 0;
    html += escapeHtml(value.slice(cursor, index));
    const label = escapeHtml(match[2]);
    const href = escapeHtml(match[3]);
    html += match[1] ? `<span>${label}</span>` : `<a href="${href}">${label}</a>`;
    cursor = index + match[0].length;
  }
  return html + escapeHtml(value.slice(cursor));
}

/**
 * Converts the bounded Markdown returned by the text reader into inert HTML.
 * Only absolute HTTPS links become anchors; scripts and raw HTML remain escaped.
 */
export function readerMarkdownToHtml(markdown: string, canonicalUrl: string): string {
  const title = markdown.match(/^Title:\s*(.+)$/mi)?.[1]?.trim() ?? new URL(canonicalUrl).hostname;
  const body = markdown
    .split(/\r?\n/)
    .map((line) => `<p>${renderInlineMarkdown(line)}</p>`)
    .join("\n");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><link rel="canonical" href="${escapeHtml(canonicalUrl)}"></head><body>${body}</body></html>`;
}

export function readerProxyUrl(target: URL): URL {
  return new URL(`https://r.jina.ai/${target.toString()}`);
}
