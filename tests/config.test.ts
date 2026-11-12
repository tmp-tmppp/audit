import { describe, expect, it } from "vitest";
import { ConfigError, MAX_SHUTDOWN_DELAY_MS, loadConfig } from "../src/config.js";

const production = {
  APP_ENV: "production",
  DATABASE_URL: "postgres://audit:secret-password@db:5432/audit",
  NATS_URL: "nats://nats:4222",
  AUTH_JWKS_URL: "http://identity:8080/realms/chance/protocol/openid-connect/certs",
  AUTH_ISSUER: "http://identity:8080/realms/chance",
  AUTH_AUDIENCE: "chance",
};

function problemsOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("loadConfig", () => {
  it("accepts a full production setting and fills the defaults", () => {
    expect(loadConfig(production)).toEqual({
      appEnv: "production",
      isLocal: false,
      port: 8080,
      metricsPort: 9464,
      logLevel: "info",
      databaseUrl: production.DATABASE_URL,
      databasePoolMax: 5,
      natsUrl: production.NATS_URL,
      auth: {
        jwksUrl: production.AUTH_JWKS_URL,
        issuer: production.AUTH_ISSUER,
        audience: "chance",
        rolesClaim: "realm_access.roles",
        tenantClaim: "organization",
      },
      shutdownDelayMs: 5000,
    });
  });

  it("treats a missing APP_ENV as production and names every missing setting at once", () => {
    const problems = problemsOf({});
    expect(problems).toHaveLength(5);
    for (const name of ["DATABASE_URL", "NATS_URL", "AUTH_JWKS_URL", "AUTH_ISSUER", "AUTH_AUDIENCE"]) {
      expect(problems.some((problem) => problem.startsWith(`${name} is required`))).toBe(true);
    }
  });

  it("lets only APP_ENV=local run with nothing set: memory store, no events, local token settings, no drain delay", () => {
    const config = loadConfig({ APP_ENV: "local" });
    expect(config).toMatchObject({ isLocal: true, databaseUrl: null, natsUrl: null, shutdownDelayMs: 0 });
    expect(config.auth.audience).toBe("chance");
    expect(config.auth.jwksUrl).toContain("localhost:8081");
  });

  it("does not turn a token setting off in local mode: an own value still wins", () => {
    expect(loadConfig({ APP_ENV: "local", AUTH_AUDIENCE: "chance-test" }).auth.audience).toBe("chance-test");
  });

  it.each(["Local", "1local", "lo cal", "a".repeat(33)])("refuses the APP_ENV %j", (appEnv) => {
    expect(problemsOf({ ...production, APP_ENV: appEnv })).toEqual(["APP_ENV must be lowercase letters, digits and dashes"]);
  });

  it("checks the protocols of the URLs and never prints a value", () => {
    const problems = problemsOf({ ...production, DATABASE_URL: "mysql://u:hunter2@db/x", NATS_URL: "http://nats", AUTH_JWKS_URL: "ftp://identity/certs" });
    expect(problems).toEqual([
      "DATABASE_URL must be a URL starting with postgres:// or postgresql://",
      "NATS_URL must be a URL starting with nats:// or tls://",
      "AUTH_JWKS_URL must be a URL starting with http:// or https://",
    ]);
    expect(problems.join(" ")).not.toContain("hunter2");
    expect(problemsOf({ ...production, DATABASE_URL: "not a url" })).toEqual(["DATABASE_URL must be a URL starting with postgres:// or postgresql://"]);
  });

  it("reads numbers as integers inside their range", () => {
    expect(loadConfig({ ...production, PORT: "9090", DATABASE_POOL_MAX: "12", SHUTDOWN_DELAY_MS: "0" })).toMatchObject({ port: 9090, databasePoolMax: 12, shutdownDelayMs: 0 });
    expect(problemsOf({ ...production, PORT: "0" })).toEqual(["PORT must be an integer from 1 to 65535"]);
    expect(problemsOf({ ...production, PORT: "80.5" })).toEqual(["PORT must be an integer from 1 to 65535"]);
    expect(problemsOf({ ...production, DATABASE_POOL_MAX: "51" })).toEqual(["DATABASE_POOL_MAX must be an integer from 1 to 50"]);
    expect(problemsOf({ ...production, SHUTDOWN_DELAY_MS: String(MAX_SHUTDOWN_DELAY_MS + 1) })).toEqual([`SHUTDOWN_DELAY_MS must be an integer from 0 to ${MAX_SHUTDOWN_DELAY_MS}`]);
    expect(problemsOf({ ...production, PORT: "abc" })).toHaveLength(1);
  });

  describe("METRICS_PORT (the listener that serves GET /metrics)", () => {
    it("defaults to 9464, also in local mode", () => {
      expect(loadConfig(production).metricsPort).toBe(9464);
      expect(loadConfig({ APP_ENV: "local" }).metricsPort).toBe(9464);
    });

    it("takes a port from 1 to 65535", () => {
      expect(loadConfig({ ...production, METRICS_PORT: "9100" }).metricsPort).toBe(9100);
      expect(loadConfig({ ...production, METRICS_PORT: "1" }).metricsPort).toBe(1);
      expect(loadConfig({ ...production, METRICS_PORT: "65535" }).metricsPort).toBe(65_535);
    });

    it.each(["0", "65536", "-1", "9464.5", "abc"])("rejects %s", (value) => {
      expect(problemsOf({ ...production, METRICS_PORT: value })).toEqual(["METRICS_PORT must be an integer from 1 to 65535"]);
    });

    it("must differ from PORT: the API port never serves /metrics", () => {
      const problem = "METRICS_PORT must differ from PORT (the API port never serves /metrics)";
      expect(problemsOf({ ...production, PORT: "9000", METRICS_PORT: "9000" })).toEqual([problem]);
      expect(problemsOf({ ...production, PORT: "9464" })).toEqual([problem]);
      expect(loadConfig({ ...production, PORT: "9464", METRICS_PORT: "9465" })).toMatchObject({ port: 9464, metricsPort: 9465 });
    });
  });

  it("checks the log level", () => {
    expect(loadConfig({ ...production, LOG_LEVEL: "debug" }).logLevel).toBe("debug");
    expect(problemsOf({ ...production, LOG_LEVEL: "loud" })[0]).toMatch(/^LOG_LEVEL must be one of: fatal, error/);
  });

  it("trims values and treats a blank one as missing", () => {
    expect(loadConfig({ ...production, PORT: " 8081 " }).port).toBe(8081);
    expect(problemsOf({ ...production, DATABASE_URL: "   " })).toEqual(["DATABASE_URL is required (the connection string of the service's PostgreSQL database); only APP_ENV=local may leave it out"]);
  });

  it("takes the claim paths of the tokens from the environment", () => {
    expect(loadConfig({ ...production, AUTH_ROLES_CLAIM: "roles", AUTH_TENANT_CLAIM: "tenant" }).auth).toMatchObject({ rolesClaim: "roles", tenantClaim: "tenant" });
  });

  it("carries every problem in a ConfigError", () => {
    const error = (() => {
      try {
        return loadConfig({ APP_ENV: "x y" });
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toMatch(/^Invalid configuration:\n- APP_ENV/);
  });
});
