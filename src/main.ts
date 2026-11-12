import { createRemoteJWKSet } from "jose";
import type pg from "pg";
import { MemoryStore } from "./adapters/memory/memory-store.js";
import { createMetrics, startMetricsServer } from "./adapters/metrics/metrics.js";
import { tenantOfRequest } from "./web/auth.js";
import { NatsEventConsumer } from "./adapters/nats/nats-event-consumer.js";
import { runMigrations } from "./adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { systemClock } from "./adapters/system.js";
import { createShutdown } from "./shutdown.js";
import { createUseCases } from "./usecases/application.js";
import type { Store } from "./usecases/ports.js";
import { streamHandlers } from "./usecases/record-event.js";
import { buildApp } from "./web/app.js";

// Composition root: configuration -> adapters -> use cases -> web application. Nothing else wires things together.

const MIGRATION_ATTEMPTS = 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  logger.info({ appEnv: config.appEnv }, "Starting audit");

  // Adapters. Without a setting, only APP_ENV=local falls back to memory; loadConfig has refused anything else.
  let store: Store;
  let pool: pg.Pool | null = null;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl, config.databasePoolMax);
    pool.on("error", (error) => logger.error({ err: error }, "An idle database connection failed"));
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runMigrations(pool, logger);
        break;
      } catch (error) {
        if (attempt >= MIGRATION_ATTEMPTS) throw error;
        logger.warn({ attempt, err: error }, "The database is not ready for migrations, trying again");
        await sleep(3000);
      }
    }
    store = new PostgresStore(pool, logger);
  } else {
    logger.warn({}, "DATABASE_URL is not set: keeping all data in memory (APP_ENV=local)");
    store = new MemoryStore();
  }

  const deps = { store, clock: systemClock, logger };

  // One durable consumer per stream (TENANTS, PAYMENTS, MARKETS, TRADING). start() returns at once and never throws: a
  // stream that does not exist yet, or a broker that is away, is logged and retried while the service serves its log.
  let consumer: NatsEventConsumer | null = null;
  if (config.natsUrl) {
    consumer = new NatsEventConsumer(
      config.natsUrl,
      logger,
      streamHandlers(deps).map(({ stream, handler }) => ({ stream: stream.stream, durable: stream.consumer, filterSubject: stream.subjects, handler })),
    );
  } else {
    logger.warn({}, "NATS_URL is not set: no events are consumed (APP_ENV=local)");
  }

  // True from the first SIGTERM on; the readiness probe reads it.
  let shuttingDown = false;

  // Request metrics; the tenant label is the tenant of the verified token (request.auth is set only after the check).
  const metrics = createMetrics({ tenantOf: tenantOfRequest });

  const app = buildApp({
    logger,
    metrics,
    auth: {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      getKey: createRemoteJWKSet(new URL(config.auth.jwksUrl), { timeoutDuration: 3000 }),
      rolesClaim: config.auth.rolesClaim,
      tenantClaim: config.auth.tenantClaim,
    },
    health: { ping: () => store.ping(), isDraining: () => shuttingDown },
    useCases: createUseCases(deps),
  });

  // GET /metrics has a listener of its own: the API port never serves it, so the gateway can never route it.
  const metricsServer = await startMetricsServer(metrics.registry, { port: config.metricsPort });
  logger.info({ port: metricsServer.port }, "Serving metrics");
  await app.listen({ host: "0.0.0.0", port: config.port });
  consumer?.start();

  // Graceful shutdown (SIGTERM from Kubernetes, SIGINT from a terminal): src/shutdown.ts has the order and the timing.
  const shutdown = createShutdown(
    {
      drain: () => {
        shuttingDown = true;
      },
      closeServer: async () => {
        await app.close();
        await metricsServer.close();
      },
      // Each consumer finishes the message it is working on (commit, then ack or nak) and the connection is closed with it.
      stopConsumers: async () => {
        await consumer?.stop();
      },
      closeDatabase: async () => {
        await pool?.end();
      },
    },
    { logger, delayMs: config.shutdownDelayMs, exit: (code) => process.exit(code) },
  );
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("audit failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
