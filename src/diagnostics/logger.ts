// logger.ts — Barrel re-export for structured logging
//
// Split into:
//   logger-types.ts  — types, constants, pure helpers
//   logger-format.ts — plain text + ANSI console formatters
//   logger-core.ts   — AioLogger class
//   logger-api.ts    — public singleton (log, setLogger, getLogger)

export type { LogConfig, LogLevel } from "./logger-types.ts";
export type { Log } from "./logger-api.ts";
export { getLogger, log, setLogger } from "./logger-api.ts";
export { AioLogger } from "./logger-core.ts";
