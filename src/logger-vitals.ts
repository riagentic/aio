// logger-vitals.ts — Performance violation and vitals logging

import type { LogEntry } from "./logger-types.ts";
import { now } from "./logger-types.ts";
import { printConsole } from "./logger-format.ts";

type WriteFn = (path: string, entry: LogEntry) => void;
type PathFn = (kind: "app" | "debug" | "error" | "warning" | "perf") => string;

/** Log a performance violation — all violations logged, no dedup */
export function logPerf(
  source: "reduce" | "effect",
  type: string,
  duration: number,
  budget: number,
  breakdown: {
    produce: number;
    clone: number;
    spread: number;
    routing: number;
    listeners: number;
  } | undefined,
  write: WriteFn,
  pathFn: PathFn,
  consoleEnabled: boolean,
): void {
  const entry: LogEntry = {
    ts: now(),
    lvl: "perf",
    cat: `perf:${source}`,
    msg: breakdown
      ? `${type} exceeded budget: ${
        Math.round(duration)
      }ms > ${budget}ms (produce=${Math.round(breakdown.produce)}ms clone=${
        Math.round(breakdown.clone)
      }ms spread=${Math.round(breakdown.spread)}ms routing=${
        Math.round(breakdown.routing)
      }ms listeners=${Math.round(breakdown.listeners)}ms)`
      : `${type} exceeded budget: ${Math.round(duration)}ms > ${budget}ms`,
    data: {
      type,
      duration: Math.round(duration),
      budget,
      ...(breakdown ? { breakdown } : {}),
    },
  };
  write(pathFn("perf"), entry);
  write(pathFn("debug"), entry);
  if (consoleEnabled) printConsole(entry);
}

/** Log a vital-signs measurement — render/transport/loop health */
export function logVitals(
  layer: "render" | "transport" | "loop",
  status: string,
  measured: number,
  threshold: number,
  hint: { cause: string; suggestion: string; severity: string } | undefined,
  write: WriteFn,
  pathFn: PathFn,
  consoleEnabled: boolean,
): void {
  const msg = hint
    ? `[vitals:${layer}] ${status} ${
      Math.round(measured)
    }ms (threshold: ${threshold}ms) | cause(${hint.severity}): ${hint.cause} | fix: ${hint.suggestion}`
    : `[vitals:${layer}] ${status} ${
      Math.round(measured)
    }ms (threshold: ${threshold}ms)`;
  const entry: LogEntry = {
    ts: now(),
    lvl: status === "frozen" ? "warn" : "perf",
    cat: `vitals:${layer}`,
    msg,
    data: { layer, status, measured: Math.round(measured), threshold, hint },
  };
  write(pathFn("perf"), entry);
  write(pathFn("debug"), entry);
  if (consoleEnabled) printConsole(entry);
}

/** Log a vital-signs summary line */
export function logVitalsSummary(
  summary: string,
  write: WriteFn,
  pathFn: PathFn,
  consoleEnabled: boolean,
): void {
  const entry: LogEntry = {
    ts: now(),
    lvl: "info",
    cat: "vitals:summary",
    msg: summary,
  };
  write(pathFn("app"), entry);
  write(pathFn("debug"), entry);
  if (consoleEnabled) printConsole(entry);
}
