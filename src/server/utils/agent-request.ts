/**
 * Makers Agent currently exposes a parsed `context.request.body`, while the
 * Cloud Functions request follows the standard Web Request `json()` API.
 * Accept both shapes so the Agent entry points also remain usable in local
 * and unit-test Web Request environments.
 */
export async function readAgentJson<T>(request: Request): Promise<T> {
  const body = (request as unknown as { body?: unknown }).body;

  if (typeof body === "string") return JSON.parse(body) as T;
  if (
    body !== null &&
    typeof body === "object" &&
    typeof (body as { getReader?: unknown }).getReader !== "function"
  ) {
    return body as T;
  }
  if (typeof request.json === "function") return await request.json() as T;
  throw new Error("Agent request body is not valid JSON");
}
