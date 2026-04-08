// src/diagnostics/types.ts — Shared types for the diagnostics module

import type { MemoryConfig } from "../memory-monitor.ts";
import type { VitalsConfig } from "../vitals/types.ts";

/** Top-level diagnostics config — passed to aio.run({ diagnostics: ... }) */
export type DiagnosticsConfig = false | {
  dev?: DiagnosticsOptions;
  prod?: DiagnosticsOptions;
  onDiagnostic?: (event: import("../vitals/types.ts").DiagEvent) => void;
};

/** Per-mode toggle/config for each diagnostic subsystem */
export type DiagnosticsOptions = {
  stateDiffs?: boolean;
  actionLog?: boolean | { max?: number };
  checkpoint?: boolean | { debounce?: number };
  crashHandler?: boolean;
  memoryMonitor?: boolean | MemoryConfig;
  timeTravel?: boolean;
  console?: boolean;
  vitals?: boolean | VitalsConfig;
  diagnosticBus?: boolean;
};

/** Checkpoint data written to log/checkpoint.json */
export type CheckpointData = {
  ts: number;
  state: Record<string, unknown>;
  recentActions: string[];
  cells: Record<string, { errors: number; enabled: boolean }>;
};

/** Built-in defaults per mode */
export const DEV_DEFAULTS: Required<DiagnosticsOptions> = {
  stateDiffs: true,
  actionLog: true,
  checkpoint: true,
  crashHandler: true,
  memoryMonitor: true,
  timeTravel: true,
  console: true,
  vitals: true,
  diagnosticBus: true,
};

/** Production defaults — minimal overhead, crash handler and vitals only */
export const PROD_DEFAULTS: Required<DiagnosticsOptions> = {
  stateDiffs: false,
  actionLog: false,
  checkpoint: false,
  crashHandler: true,
  memoryMonitor: false,
  timeTravel: false,
  console: true,
  vitals: { hints: false },
  diagnosticBus: false,
};

/** Resolve effective options: built-in defaults + user overrides */
export function resolveOptions(
  config: DiagnosticsConfig,
  isProd: boolean,
): DiagnosticsOptions | false {
  if (config === false) return false;
  const defaults = isProd ? PROD_DEFAULTS : DEV_DEFAULTS;
  const overrides = isProd ? config.prod : config.dev;
  if (!overrides) return { ...defaults };
  return { ...defaults, ...overrides };
}
