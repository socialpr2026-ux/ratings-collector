const GROUP_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const MISSING_MESSAGE = /^queryResolver\.Group: catalog\.Manager\.Group: rpc error: code = NotFound desc = group\.group: catalog\.group by code ([a-z0-9-]+): group not found$/u;

export const ZDRAVCITY_GROUP_BFF_URL = "https://zdravcity.ru/bff/query";
export const ZDRAVCITY_GROUP_BFF_MAX_BYTES = 32_000;
export const ZDRAVCITY_GROUP_BFF_QUERY =
  "query ExactGroupPresence($regionID: ID!, $code: ID!) { group(regionID: $regionID, code: $code) { code name } }";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function zdravcityGroupSlugFromUrl(value: string | URL): string | undefined {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "zdravcity.ru" || url.port || url.username ||
      url.password || url.search || url.hash) return undefined;
    return url.pathname.match(/^\/g_([a-z0-9][a-z0-9-]{0,79})\/$/u)?.[1];
  } catch { return undefined; }
}

export function zdravcityGroupBffRequest(slug: string): {
  operationName: "ExactGroupPresence";
  query: string;
  variables: { regionID: "moscowregion"; code: string };
} {
  if (!GROUP_SLUG.test(slug)) throw new TypeError("invalid_zdravcity_group_slug");
  return {
    operationName: "ExactGroupPresence",
    query: ZDRAVCITY_GROUP_BFF_QUERY,
    variables: { regionID: "moscowregion", code: slug }
  };
}

/**
 * Classifies only an exact brand-group presence proof. A missing result is
 * accepted solely from Zdravcity's first-party GraphQL NotFound envelope with
 * the requested slug repeated in the bound error message. Any drift remains
 * unknown and therefore blocked by the caller.
 */
export function proveExactZdravcityGroupBff(
  value: unknown,
  expectedSlug: string
): "missing" | "present" | undefined {
  if (!GROUP_SLUG.test(expectedSlug)) return undefined;
  const root = object(value);
  if (!root) return undefined;

  if (root.data === null && Array.isArray(root.errors) && root.errors.length === 1) {
    const error = object(root.errors[0]);
    const extensions = object(error?.extensions);
    const path = error?.path;
    const match = typeof error?.message === "string" ? error.message.match(MISSING_MESSAGE) : undefined;
    if (Array.isArray(path) && path.length === 1 && path[0] === "group" &&
      extensions?.code === 404 && match?.[1] === expectedSlug) return "missing";
    return undefined;
  }

  if (root.errors !== undefined) return undefined;
  const group = object(object(root.data)?.group);
  return group?.code === expectedSlug && typeof group.name === "string" && group.name.trim()
    ? "present"
    : undefined;
}
