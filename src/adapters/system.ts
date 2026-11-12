import type { Clock } from "../usecases/ports.js";

export const systemClock: Clock = { now: () => new Date() };
