const PUBLIC_HOST = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/i;

function headerValue(request: Request, name: string): string | undefined {
  const headers = request.headers as unknown;
  if (headers && typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  if (!headers || typeof headers !== "object") return undefined;
  const entry = Object.entries(headers as Record<string, unknown>)
    .find(([key]) => key.toLocaleLowerCase("en-US") === name);
  const value = entry?.[1];
  return typeof value === "string" ? value : undefined;
}

/**
 * Agents can be invoked through a platform-internal origin while Cloud
 * Functions remain on the original public host. Prefer the proxy-provided
 * public host for the private Agent -> Function RPC and retain the request
 * origin for local development and platforms that do not provide it.
 */
export function agentInternalEndpoint(request: Request, pathname: string): string {
  const forwardedHost = headerValue(request, "x-forwarded-host")?.split(",", 1)[0]?.trim();
  const host = forwardedHost || headerValue(request, "host")?.trim();
  const origin = host && PUBLIC_HOST.test(host)
    ? `https://${host}`
    : new URL(request.url).origin;
  return new URL(pathname, origin).toString();
}
