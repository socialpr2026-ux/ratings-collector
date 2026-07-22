const PUBLIC_HOST = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/i;

/**
 * Agents can be invoked through a platform-internal origin while Cloud
 * Functions remain on the original public host. Prefer the proxy-provided
 * public host for the private Agent -> Function RPC and retain the request
 * origin for local development and platforms that do not provide it.
 */
export function agentInternalEndpoint(request: Request, pathname: string): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  const origin = host && PUBLIC_HOST.test(host)
    ? `https://${host}`
    : new URL(request.url).origin;
  return new URL(pathname, origin).toString();
}
