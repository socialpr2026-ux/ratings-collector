/**
 * Playwright 1.51 appends `/json/version/` by string concatenation. When an
 * EdgeOne CDP URL contains `?access_token=...`, that produces a malformed
 * request path. Authentication is carried by X-Access-Token, so the browser
 * base URL passed to Playwright must not contain the query string.
 */
export function playwrightCdpBaseUrl(cdpUrl: string): string {
  const endpoint = new URL(cdpUrl);
  if (endpoint.protocol !== "https:") {
    throw new Error("EdgeOne returned a non-HTTPS CDP endpoint");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("EdgeOne returned a credential-bearing CDP authority");
  }
  if ([...endpoint.searchParams.keys()].some((key) => key !== "access_token")) {
    throw new Error("EdgeOne returned an unexpected CDP query parameter");
  }
  endpoint.search = "";
  endpoint.hash = "";
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  return endpoint.toString();
}
