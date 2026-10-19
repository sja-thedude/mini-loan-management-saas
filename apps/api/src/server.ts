import { createApp } from "./app";
import { config, initConfig } from "./lib/config";
import { prisma } from "./lib/db";
import { log } from "./lib/log";
import { startOutboxPublisher } from "./lib/outbox";

async function main() {
  await initConfig(); // Secrets Manager + SSM Parameter Store when configured
  const server = createApp().listen(config.port, () =>
    log("info", "api_started", { port: config.port, kms: Boolean(config.kmsKeyId), eventBus: config.eventBusName ?? null }),
  );
  const publisher = config.eventBusName ? startOutboxPublisher() : undefined;

  // ECS sends SIGTERM before stopping a task: stop polling, finish in-flight requests, then exit.
  process.on("SIGTERM", () => {
    log("info", "shutdown");
    publisher?.stop();
    server.close(() => void prisma.$disconnect().then(() => process.exit(0)));
  });
}

main().catch((err) => {
  log("error", "startup_failed", { err: String(err) });
  process.exit(1);
});
