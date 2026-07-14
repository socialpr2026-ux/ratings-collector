import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { registerApi } from "./api.js";
import { createRuntime } from "./runtime.js";
import { safeErrorMessage } from "./utils/error-message.js";

const server = Fastify({ logger: true, bodyLimit: 6 * 1024 * 1024 });
const runtime = await createRuntime();
await registerApi(server, runtime);
const dist = resolve("dist");
if (existsSync(dist)) {
  await server.register(fastifyStatic, { root: dist, wildcard: false });
  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "API route not found" });
    return reply.sendFile("index.html");
  });
}
server.setErrorHandler((error, _request, reply) => {
  const failure = error as Error & { statusCode?: number };
  server.log.error(failure);
  reply.code(failure.statusCode && failure.statusCode >= 400 ? failure.statusCode : 500).send({ error: safeErrorMessage(failure) });
});
const unauthenticated = process.env.RATINGS_ALLOW_UNAUTHENTICATED === "true";
const host = unauthenticated ? "127.0.0.1" : (process.env.HOST?.trim() || "0.0.0.0");
await server.listen({ host, port: Number(process.env.PORT ?? 8787) });
