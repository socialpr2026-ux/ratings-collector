export function shouldUseHardenedBrowser(request: Request): boolean {
  if (request.method !== "GET") return false;
  return request.headers.get("x-ratings-browser") === "1";
}
