import { createCompanionServer } from "./server.js";

const server = createCompanionServer({ logger: true });
const close = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });

await server.listen({ host: "127.0.0.1", port: 8765 });
server.log.info("Локальный сборщик Ozon готов: http://127.0.0.1:8765/health");
