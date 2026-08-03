const COLLECTOR_PUBLIC_ORIGIN = "https://ratings-collector.edgeone.cool";

/** Cloud Functions are served from the canonical public project origin. */
export function collectorPublicEndpoint(pathname: string): string {
  return new URL(pathname, COLLECTOR_PUBLIC_ORIGIN).toString();
}
