// src/diagnostics/types.ts — Shared types for the diagnostics module

import type { MemoryConfig } from "./memory-monitor.ts";
import type { VitalsConfig } from "../vitals/types.ts";

/** Top-level diagnostics config — passed to aio.run({ diagnostics: ... }).
 *  `true` (or omitted) = defaults on; `false` = off; object = tuned. The
 *  `boolean | Config` shape matches every other toggle-or-configure field
 *  (sessions, auth, logging, dispatchStorm). */
export type DiagnosticsConfig = boolean | {
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
  /** Action types omitted from the time-travel history (exact match, e.g.
   *  ["game:tick"]) — a high-frequency action otherwise floods the bounded
   *  window until it holds seconds instead of a session. */
  skipActions?: string[];
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
  skipActions: [],
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
  skipActions: [],
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
  // `true` = defaults on, no overrides.
  const overrides = config === true
    ? undefined
    : (isProd ? config.prod : config.dev);
  if (!overrides) return { ...defaults };
  return { ...defaults, ...overrides };
}

/** Is time-travel on, given the mode and the RESOLVED diagnostics options?
 *
 *  Extracted and exported so the rule is testable without booting an app —
 *  and because it used not to exist at all: `diagnostics.dev.timeTravel` was
 *  declared, defaulted and documented while TT was created purely on `!prod`,
 *  so an app that turned it off still kept a full state history in memory and
 *  broadcast it on every dispatch.
 *
 *  `false` means diagnostics are off wholesale, which historically still ran
 *  TT in dev; that is preserved, so only an explicit `timeTravel: false`
 *  turns it off. */
export function timeTravelEnabled(
  prod: boolean,
  resolved: DiagnosticsOptions | false,
): boolean {
  if (prod) return false;
  if (typeof resolved !== "object") return true;
  return resolved.timeTravel !== false;
}
