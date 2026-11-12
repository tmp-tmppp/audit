// Typed configuration from environment variables, validated once at startup. A bad or missing setting stops the
// start with a message that names every problem; values are never printed (they may hold passwords).

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

export interface AuthConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
  rolesClaim: string;
  tenantClaim: string;
}

export interface Config {
  /** "local" allows in-memory fallbacks; any other value (default "production") requires every setting. */
  appEnv: string;
  isLocal: boolean;
  port: number;
  /** The port of the separate listener that serves GET /metrics; never the API port. */
  metricsPort: number;
  logLevel: string;
  /** Null only in local mode: the service then keeps its data in memory. */
  databaseUrl: string | null;
  databasePoolMax: number;
  /** Null only in local mode: the service then consumes no events. */
  natsUrl: string | null;
  auth: AuthConfig;
  /**
   * After SIGTERM the service first answers 503 on the readiness probe and keeps serving for this long, so that the
   * load balancer and the endpoints stop sending requests; only then does it close the server, the consumers and the pool.
   */
  shutdownDelayMs: number;
}

/** The longest drain delay: with the 10 seconds a shutdown may then take, it ends inside the chart's 30 seconds. */
export const MAX_SHUTDOWN_DELAY_MS = 15_000;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

// Local defaults of the token settings, matching a Keycloak on port 8081 (see README). Tokens are always verified.
const LOCAL_AUTH = {
  jwksUrl: "http://localhost:8081/realms/chance/protocol/openid-connect/certs",
  issuer: "http://localhost:8081/realms/chance",
  audience: "chance",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const text = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return fallback;
    }
    return value;
  };
  const url = (name: string, protocols: readonly string[], value: string | undefined): string | null => {
    if (value === undefined) return null;
    try {
      if (protocols.includes(new URL(value).protocol)) return value;
    } catch {
      // Reported below.
    }
    problems.push(`${name} must be a URL starting with ${protocols.map((p) => `${p}//`).join(" or ")}`);
    return null;
  };

  const appEnv = text("APP_ENV") ?? "production";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(appEnv)) problems.push("APP_ENV must be lowercase letters, digits and dashes");
  const isLocal = appEnv === "local";
  const required = (name: string, hint: string): string | undefined => {
    const value = text(name);
    if (value === undefined && !isLocal) problems.push(`${name} is required (${hint}); only APP_ENV=local may leave it out`);
    return value;
  };

  const logLevel = text("LOG_LEVEL") ?? "info";
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);

  const databaseUrl = url("DATABASE_URL", ["postgres:", "postgresql:"], required("DATABASE_URL", "the connection string of the service's PostgreSQL database"));
  const natsUrl = url("NATS_URL", ["nats:", "tls:"], required("NATS_URL", "the NATS server"));

  const authText = (name: string, local: string, hint: string): string => required(name, hint) ?? local;
  const jwksUrl = url("AUTH_JWKS_URL", ["http:", "https:"], authText("AUTH_JWKS_URL", LOCAL_AUTH.jwksUrl, "the JWKS URL of the identity provider"));
  const auth: AuthConfig = {
    jwksUrl: jwksUrl ?? LOCAL_AUTH.jwksUrl,
    issuer: authText("AUTH_ISSUER", LOCAL_AUTH.issuer, "the issuer (iss) of the tokens"),
    audience: authText("AUTH_AUDIENCE", LOCAL_AUTH.audience, "the audience (aud) of the tokens"),
    rolesClaim: text("AUTH_ROLES_CLAIM") ?? "realm_access.roles",
    tenantClaim: text("AUTH_TENANT_CLAIM") ?? "organization",
  };

  const port = integer("PORT", 8080, 1, 65535);
  const metricsPort = integer("METRICS_PORT", 9464, 1, 65535);
  // The API port never serves /metrics (so the gateway can never route it): the two listeners need two ports.
  if (metricsPort === port) problems.push("METRICS_PORT must differ from PORT (the API port never serves /metrics)");

  const config: Config = {
    appEnv,
    isLocal,
    port,
    metricsPort,
    logLevel,
    databaseUrl,
    databasePoolMax: integer("DATABASE_POOL_MAX", 5, 1, 50),
    natsUrl,
    auth,
    // Nobody routes traffic to a local run, so it does not wait.
    shutdownDelayMs: integer("SHUTDOWN_DELAY_MS", isLocal ? 0 : 5000, 0, MAX_SHUTDOWN_DELAY_MS),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
