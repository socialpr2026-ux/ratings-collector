import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { ResidentialOzonCollector, type CompanionOzonResult } from "./ozon-residential.js";
import { AdapterBlockedError } from "../src/server/adapters/errors.js";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://ratings-collector.edgeone.cool",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
] as const;

const requestSchema = z.object({
  brands: z.array(z.string().trim().min(2).max(160)).min(1).max(50)
    .transform((brands) => [...new Set(brands.map((brand) => brand.normalize("NFKC").trim()))]),
  region: z.string().trim().min(2).max(100).default("Москва")
}).strict();

export type CompanionCollector = {
  collect(brands: readonly string[], region: string): Promise<CompanionOzonResult[]>;
  close?(): Promise<void>;
};

export type CompanionServerOptions = {
  collector?: CompanionCollector;
  allowedOrigins?: readonly string[];
  logger?: boolean;
};

function originOf(request: FastifyRequest): string | undefined {
  const origin = request.headers.origin?.trim();
  return origin || undefined;
}

export function createCompanionServer(options: CompanionServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 });
  const collector = options.collector ?? new ResidentialOzonCollector();
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);

  server.addHook("onRequest", async (request, reply) => {
    const origin = originOf(request);
    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: "Этот сайт не может обращаться к локальному сборщику" });
    }
    if (origin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
    }
    reply.header("access-control-allow-private-network", "true");
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    reply.header("access-control-allow-headers", "content-type");
    if (request.method === "OPTIONS") return reply.code(204).send();
  });

  server.get("/health", async () => ({
    ok: true,
    service: "ratings-collector-local-companion",
    capabilities: ["ozon"]
  }));

  server.post("/v1/ozon/discover", async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Проверьте список брендов и регион" });
    }
    const observations = await collector.collect(parsed.data.brands, parsed.data.region);
    return { observations };
  });

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof AdapterBlockedError && /Ozon blocked.*403/i.test(error.message)) {
      return reply.code(409).send({
        code: "ozon_challenge",
        error: "В открывшемся Chrome пройдите проверку Ozon, затем нажмите «Повторить сбор» в веб-интерфейсе."
      });
    }
    server.log.error(error);
    return reply.code(500).send({ error: error instanceof Error ? error.message : "Локальный сбор не завершён" });
  });

  server.addHook("onClose", async () => collector.close?.());
  return server;
}
