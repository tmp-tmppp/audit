import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_TIMEOUT_MS, createShutdown } from "../src/shutdown.js";
import type { ShutdownSteps } from "../src/shutdown.js";
import { RecordingLogger } from "./support/harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(options: { delayMs?: number; timeoutMs?: number; failAt?: keyof ShutdownSteps; hangAt?: keyof ShutdownSteps } = {}) {
  const calls: string[] = [];
  const logger = new RecordingLogger();
  const exits: number[] = [];
  const step = (name: keyof ShutdownSteps) => (): Promise<void> => {
    calls.push(name);
    if (options.failAt === name) return Promise.reject(new Error(`${name} failed`));
    if (options.hangAt === name) return new Promise<void>(() => undefined);
    return Promise.resolve();
  };
  const steps: ShutdownSteps = {
    drain: () => {
      calls.push("drain");
    },
    closeServer: step("closeServer"),
    stopConsumers: step("stopConsumers"),
    closeDatabase: step("closeDatabase"),
  };
  const shutdown = createShutdown(steps, { logger, delayMs: options.delayMs ?? 0, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), exit: (code) => exits.push(code) });
  return { shutdown, calls, logger, exits };
}

describe("createShutdown", () => {
  it("drains first, then stops the server, the consumers, the broker and the pool, in that order, and exits with 0", async () => {
    const { shutdown, calls, exits, logger } = setup();
    await shutdown("SIGTERM");
    expect(calls).toEqual(["drain", "closeServer", "stopConsumers", "closeDatabase"]);
    expect(exits).toEqual([0]);
    expect(logger.lines.map((line) => line.message)).toEqual(["Shutting down: the readiness probe now answers 503", "Stopped"]);
  });

  it("keeps serving for the drain delay before it closes anything", async () => {
    const { shutdown, calls, exits } = setup({ delayMs: 5000 });
    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toEqual(["drain"]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(calls).toEqual(["drain", "closeServer", "stopConsumers", "closeDatabase"]);
    expect(exits).toEqual([0]);
  });

  it("ignores a second signal", async () => {
    const { shutdown, calls, exits } = setup();
    await shutdown("SIGTERM");
    await shutdown("SIGINT");
    expect(calls.filter((call) => call === "drain")).toHaveLength(1);
    expect(exits).toEqual([0]);
  });

  it("exits with 1 when a step fails, and runs none of the steps after it", async () => {
    const { shutdown, calls, exits, logger } = setup({ failAt: "stopConsumers" });
    await shutdown("SIGTERM");
    expect(calls).toEqual(["drain", "closeServer", "stopConsumers"]);
    expect(exits).toEqual([1]);
    expect(logger.lines.at(-1)).toMatchObject({ level: "error", message: "Shutdown failed" });
  });

  it("exits with 1 when the steps take longer than the delay plus the timeout", async () => {
    const { shutdown, exits, logger } = setup({ delayMs: 1000, hangAt: "closeServer" });
    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000 + SHUTDOWN_TIMEOUT_MS - 1);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([1]);
    expect(logger.lines.at(-1)?.message).toBe("Shutdown took too long; exiting");
  });

  it("takes the timeout from its options", async () => {
    const { shutdown, exits } = setup({ timeoutMs: 100, hangAt: "closeDatabase" });
    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    expect(exits).toEqual([1]);
  });
});
