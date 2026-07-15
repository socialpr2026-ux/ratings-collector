import type { FastifyInstance, FastifyRequest } from "fastify";
import { COMPANY_BRANDS, INITIAL_BRANDS, INITIAL_DOMAINS } from "../shared/constants.js";
import { authenticate, authConfig } from "./auth.js";
import type { Runtime } from "./runtime.js";
import { safeErrorMessage } from "./utils/error-message.js";
import { importOzonCompanionResult, issueOzonCompanionSession } from "./companion-import.js";

function webHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
    else if (value !== undefined) headers.set(key, String(value));
  }
  return headers;
}

export async function registerApi(server: FastifyInstance, runtime: Runtime) {
  server.get("/api/config", async () => ({
    domains: INITIAL_DOMAINS, brands: INITIAL_BRANDS, companyBrands: COMPANY_BRANDS,
    googleClientId: authConfig().clientId ?? null, authRequired: !authConfig().allowUnauthenticated, agentMode: false
  }));

  server.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.url.startsWith("/api/config") || request.url.startsWith("/api/health")) return;
    try { await authenticate(webHeaders(request)); }
    catch (error) { return reply.code(401).send({ error: safeErrorMessage(error) }); }
  });

  server.get("/api/health", async () => ({ ok: true, service: "ratings-collector", now: new Date().toISOString() }));
  server.post("/api/runs", async (request, reply) => {
    const run = await runtime.service.createRun(request.body);
    void runtime.service.executeRun(run.id).catch(async (error) => {
      const failed = await runtime.service.getRun(run.id);
      if (!failed) return;
      failed.status = "failed"; failed.updatedAt = new Date().toISOString();
      failed.errors.push({ partition: "orchestrator", message: safeErrorMessage(error) });
      await runtime.repository.saveRun(failed);
    });
    return reply.code(202).send(run);
  });
  server.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    const run = await runtime.service.getRun(request.params.runId);
    return run ?? reply.code(404).send({ error: "Запуск не найден" });
  });
  server.post<{ Params: { runId: string } }>("/api/runs/:runId/retry", async (request, reply) => {
    const run = await runtime.service.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    // Local development has no long-lived Agent endpoint. Await the same
    // selective executeRun path so retry semantics match production exactly.
    return runtime.service.executeRun(run.id);
  });
  server.post<{ Params: { runId: string }; Body: { acceptedKeys?: string[] } }>("/api/runs/:runId/review", async (request) =>
    runtime.service.approveObservations(request.params.runId, request.body?.acceptedKeys ?? [])
  );
  server.post<{ Params: { runId: string } }>("/api/runs/:runId/companion/ozon/session", async (request) => {
    const user = await authenticate(webHeaders(request));
    return issueOzonCompanionSession(runtime.repository, request.params.runId, user.email);
  });
  server.post<{ Params: { runId: string } }>("/api/runs/:runId/companion/ozon", async (request) => {
    const user = await authenticate(webHeaders(request));
    return importOzonCompanionResult(runtime.repository, request.params.runId, user.email, request.body);
  });
  server.get<{ Params: { domain: string } }>("/api/site-profiles/:domain", async (request, reply) => {
    const profile = await runtime.repository.getProfile(decodeURIComponent(request.params.domain));
    return profile ?? reply.code(404).send({ error: "Профиль площадки не найден" });
  });
  server.post<{ Params: { runId: string } }>("/api/runs/:runId/publish", async (request, reply) => {
    const run = await runtime.service.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: "Запуск не найден" });
    return reply.code(501).send({
      error: "Анонимная публикация выполняется браузерным Agent в EdgeOne; локальный API не использует Google-ключи"
    });
  });
  server.post<{ Params: { domain: string }; Body: { examples?: Array<{ url: string; title?: string }>; reviewCountMeaning?: "reviews" | "ratings" | "feedback" | "unknown" } }>("/api/site-profiles/:domain/approve", async (request) =>
    runtime.service.approveProfile(
      decodeURIComponent(request.params.domain),
      request.body?.examples ?? [],
      request.body?.reviewCountMeaning ?? "unknown"
    )
  );
}
