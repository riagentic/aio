// Cell composition wiring — extracts composition logic from run()
import {
  type CellEntry,
  type CircuitBreakerConfig,
  composeCells,
  type ComposedCells,
} from "../state/cell.ts";
import {
  applyCellFieldFilter,
  type CellPatchStrategy,
  type PatchFilterFields,
} from "../state/state-filter.ts";
import type { CellFieldFilter, FilterUser } from "../state/cell-types.ts";
import type { AioError, ReportErrorOpts } from "../diagnostics/error.ts";
import { reportError as reportAioError } from "../diagnostics/error.ts";
import { log } from "../diagnostics/logger.ts";
import { parseCli } from "./aio-cli.ts";
import { isCompiled } from "./paths.ts";
import { normalizeSyncConfig } from "../sync/types.ts";

/** User identity shape — matches AioUser without importing from aio.ts (avoids circular) */
type User = { id: string; role: string };

/** Inputs for cell composition — subset of CellsConfig relevant to wiring */
export type ComposeCellsInput = {
  cellEntries: CellEntry[];
  cellDefaults?: { ui?: CellFieldFilter; persist?: CellFieldFilter };
  /** Local-first execution (perfect-aio D3) — see applyLocalFirst. */
  localFirst?: boolean;
  circuitBreaker?: CircuitBreakerConfig;
  perfCheck?: "on" | "off";
  onError?: (error: AioError) => void;
  beforeReduce?: (
    action: unknown,
    state: unknown,
    user?: User,
  ) => unknown | null;
  onRestore?: (state: unknown) => unknown;
};

/** One row in the per-cell visibility report logged at startup. */
export type VisibilityRow = {
  cell: string;
  ui: CellFieldFilter | "forUser";
  persist: CellFieldFilter;
};

/** Everything produced by cell composition wiring */
export type ComposeCellsResult = {
  composed: ComposedCells;
  autoGetDBState: (s: unknown) => unknown;
  autoGetUIState: ((s: unknown, user?: unknown) => unknown) | undefined;
  cellPatchStrategies: Map<string, CellPatchStrategy>;
  cellFilterFields: Map<string, PatchFilterFields>;
  beforeReduce:
    | ((action: unknown, state: unknown, user?: User) => unknown | null)
    | undefined;
  onRestore: ((state: unknown) => unknown) | undefined;
  cellReportOpts: ReportErrorOpts;
  visibilityReport: VisibilityRow[];
};

/** Render a resolved filter as the short string used in the startup report. */
function renderFilter(filter: CellFieldFilter): string {
  if (filter === "all") return "all";
  if (filter === "none") return "none";
  if ("include" in filter) return `include(${filter.include.join(",")})`;
  if ("exclude" in filter) return `exclude(${filter.exclude.join(",")})`;
  return "all";
}

// Field names that usually hold secrets — used for the UI-exposure heuristic.
const SECRET_FIELD_RE =
  /enc|secret|priv|key|seed|mnemonic|passphrase|passwo?rd/i;
// Unambiguous CREDENTIAL names — an exposed value is almost certainly a real
// leak, so this is escalated from a warning to a boot REFUSAL in dev. Compound forms only (private_key, api_key,
// secret_key, access_token…) so feature names like "secretSanta"/"tokenList"
// don't false-fatal; bare `secret`/`key`/`token` stay soft warnings. `password`,
// `passphrase`, `mnemonic` are unambiguous on their own. (SECRET_FIELD_RE missed
// `password` entirely before this — a silent gap.)
const HARD_SECRET_RE =
  /passwo?rd|passphrase|mnemonic|private[_-]?key|api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token/i;
// …but a "public" hint (pubKey, publicKey) means it's meant to be shared.
const PUBLIC_HINT_RE = /pub(lic)?/i;
// …and these suffixes mark identifiers/metadata, not the secret itself:
// seedId, seedPathType, keyName, encMode — nav state, not a leaked secret
//.
const NONSECRET_SUFFIX_RE =
  /(Id|Ids|Type|Name|Count|Index|Idx|At|Ref|Kind|Length|Len|Path|Mode|Status|Flag|Enabled|Visible|Label|Order|Version)$/;

/** True when a field NAME looks like it holds a secret meant to stay private.
 *  Skips public-key-style names and identifier/metadata suffixes to avoid the
 *  false positives that made the old heuristic cry wolf. */
function _looksSecret(key: string): boolean {
  if (!SECRET_FIELD_RE.test(key)) return false;
  if (PUBLIC_HINT_RE.test(key)) return false;
  if (NONSECRET_SUFFIX_RE.test(key)) return false;
  return true;
}

/** Dev-safety warnings for field-level visibility config:
 *  #1 an include/exclude key that isn't a top-level state field is a silent
 *     no-op — field filters only match top-level keys; nested/array fields need
 *     `ui.forUser`. This turns a silent secret leak into a loud warning.
 *  #2 a secret-looking top-level field left exposed to the UI is likely a leak. */
function warnFieldFilters(composed: ComposedCells): void {
  for (const f of composed.cells) {
    const state = (f.__aio.state ?? {}) as Record<string, unknown>;
    const topKeys = Object.keys(state);
    const topSet = new Set(topKeys);

    // #1 — filter keys that don't match any top-level field are ignored silently
    for (
      const [kind, filter] of [
        ["ui", f.__aio.ui],
        ["persist", f.__aio.persist],
      ] as const
    ) {
      if (!filter || filter === "all" || filter === "none") continue;
      const isInclude = "include" in filter;
      const keys = isInclude
        ? filter.include
        : "exclude" in filter
        ? filter.exclude
        : [];
      for (const key of keys) {
        if (key.includes(".")) {
          // Dot-paths: supported for exclude (deep removal, arrays traversed
          // element-wise); include stays a top-level allowlist.
          if (isInclude) {
            log.warn(
              "visibility",
              `[${f.__aio.id}] ${kind} include key "${key}" — include filters ` +
                `are top-level only (an allowlist). To hide a nested field, ` +
                `use exclude: ["${key}"] (deep removal) or ui.forUser.`,
            );
          } else if (!topSet.has(key.split(".")[0]!)) {
            log.warn(
              "visibility",
              `[${f.__aio.id}] ${kind} exclude path "${key}" — its head ` +
                `segment "${key.split(".")[0]}" is not a top-level field of ` +
                `the cell, so this excludes nothing. Typo?`,
            );
          }
        } else if (!topSet.has(key)) {
          log.warn(
            "visibility",
            `[${f.__aio.id}] ${kind} filter key "${key}" is not a top-level ` +
              `field of the cell, so this is silently ignored. For a nested ` +
              `field use a dot-path exclude (e.g. "items.${key}") or ` +
              `ui.forUser.`,
          );
        }
      }
    }

    // #2 — secret-looking field exposed to the UI (skip when forUser rewrites it)
    if (!f.__aio.uiForUser) {
      const ui = f.__aio.ui;
      const publicFields = new Set(f.__aio.uiPublicFields ?? []);
      // A container whose secret sub-path is already deep-excluded is handled —
      // warning about it would penalize the *correct* fix. Collect the
      // heads that have any dot-path exclude under them.
      const uiExcludes = ui && typeof ui === "object" && "exclude" in ui
        ? ui.exclude
        : [];
      const deepExcludedHead = (key: string): boolean =>
        uiExcludes.some((p) => p.startsWith(key + "."));
      const isExposed = (key: string): boolean => {
        if (ui === "none") return false;
        if (!ui || ui === "all") return true;
        if ("include" in ui) return ui.include.includes(key);
        if ("exclude" in ui) return !ui.exclude.includes(key);
        return true;
      };
      // Use the SAME prod signal the rest of boot resolves to, not just the
      // raw `--prod` flag: a compiled binary auto-detects prod (aio.ts), so a
      // shipped release must take the prod path (log-and-continue) here too —
      // otherwise it would REFUSE to boot on this heuristic even though the
      // developer's `--prod` smoke test passed. `isCompiled()` covers the
      // shipped-binary case; a source run stays dev (dev-stricter is allowed).
      const isDev = !parseCli().prod && !isCompiled();
      // Collect ALL offending fields, then emit ONE paste-ready message per cell
      // (2026-07-24 Ugly #7) had to add six `publicFields` one
      // boot-refusal at a time because we threw on the first field. The snippets
      // below list every offending field so a single edit clears the whole cell.
      const hardKeys: string[] = []; // unambiguous credentials
      const softKeys: string[] = []; // secret-looking, ambiguous
      for (const key of topKeys) {
        // Explicit "this is public" acknowledgement, or its secret sub-paths are
        // already excluded → don't cry wolf at correctly-handled state.
        if (publicFields.has(key) || deepExcludedHead(key)) continue;
        if (!isExposed(key)) continue;
        // AIO-426: an unambiguous credential broadcast to every
        // client is a real leak, not a maybe. Guards (public-hint / metadata
        // suffix) still apply so `apiKeyName`, `publicKey` don't trip it.
        if (
          HARD_SECRET_RE.test(key) && !PUBLIC_HINT_RE.test(key) &&
          !NONSECRET_SUFFIX_RE.test(key)
        ) hardKeys.push(key);
        else if (_looksSecret(key)) softKeys.push(key);
      }
      const list = (ks: string[]) => `[${ks.map((k) => `"${k}"`).join(", ")}]`;
      // Soft warnings first (non-blocking) so they're still visible if the hard
      // refusal below aborts boot.
      if (softKeys.length) {
        const one = softKeys.length === 1;
        log.warn(
          "visibility",
          `[${f.__aio.id}] ${one ? "field" : "fields"} ${list(softKeys)} ${
            one ? "looks" : "look"
          } secret and ${
            one ? "is" : "are"
          } exposed to the UI — broadcast to every connected client. Restrict ` +
            `${one ? "it" : "them"}: ui: { exclude: ${
              list(softKeys)
            } } (or a ` +
            `nested ui.exclude of the secret sub-path, ui.forUser, or ui: "none"). ` +
            `If genuinely public, declare ${one ? "it" : "them"}: ` +
            `ui: { publicFields: ${list(softKeys)} }.`,
        );
      }
      if (hardKeys.length) {
        const one = hardKeys.length === 1;
        const msg =
          `[${f.__aio.id}] ${one ? "field" : "fields"} ${list(hardKeys)} ${
            one ? "is a credential" : "are credentials"
          } exposed to the UI — broadcast to every connected client. Hide ${
            one ? "it" : "them"
          }: ui: { exclude: ${
            list(hardKeys)
          } } (or ui.forUser / ui: "none"). ` +
          `If genuinely NOT ${one ? "a secret" : "secrets"}, declare ${
            one ? "it" : "them"
          } public: ui: { publicFields: ${list(hardKeys)} }.`;
        // REFUSE to boot in dev (a warning is too soft — you can ship it); in
        // prod, log loud (don't crash a live deployment on a heuristic).
        if (isDev) {
          throw new Error(`[aio] SECURITY — refusing to start. ${msg}`);
        }
        log.error("visibility", `SECURITY: ${msg}`);
      }
    }
  }
}

/** Compose cells, apply defaults, build state filters + middleware chain */
export function composeCellsWiring(
  input: ComposeCellsInput,
): ComposeCellsResult {
  const cellReportOpts: ReportErrorOpts = { onError: input.onError };
  const perfEnabled = input.perfCheck !== "off";

  // AIO-5.1: client-scoped cells never register with the server store — one
  // `cells` array can hold both scopes; client cells are skipped here, not errored.
  const serverEntries = input.cellEntries.filter((entry) => {
    const def =
      (entry as { cell?: { __aio?: { scope?: string; id?: string } } })
        .cell ?? (entry as { __aio?: { scope?: string; id?: string } });
    if (def.__aio?.scope === "client") {
      log.debug(`skipping client-scoped cell '${def.__aio.id}' on server`);
      return false;
    }
    return true;
  });

  const composed = composeCells(serverEntries, {
    onCellError: (err) => reportAioError(err, cellReportOpts),
    circuitBreaker: input.circuitBreaker,
    perfCheck: perfEnabled,
  });

  applyCellDefaults(composed, input.cellDefaults);
  applyLocalFirst(composed, input.localFirst === true);
  warnFieldFilters(composed);
  // AIO-3.1: validate cross-cell selector deps against the known cell list.
  // Throws here so the user gets a clear error at aio.run() time, not at
  // first use.
  for (const f of composed.cells) {
    const deps = f.__aio.selectorDeps as Record<string, readonly string[]>;
    for (const [key, depList] of Object.entries(deps)) {
      for (const dep of depList) {
        if (!composed.cellNames.includes(dep)) {
          throw new Error(
            `[${f.__aio.id}] selector '${key}' depends on unknown cell '${dep}' — known cells: ${
              composed.cellNames.join(", ")
            }`,
          );
        }
      }
    }
  }
  const autoGetDBState = buildDBStateGetter(composed);
  const { autoGetUIState, cellPatchStrategies, cellFilterFields } =
    buildUIStateGetter(composed);
  const beforeReduce = input.beforeReduce;
  const onRestore = input.onRestore as
    | ((state: unknown) => unknown)
    | undefined;

  const visibilityReport = buildVisibilityReport(composed);
  logComposition(composed, visibilityReport);

  return {
    composed,
    autoGetDBState,
    autoGetUIState,
    cellPatchStrategies,
    cellFilterFields,
    beforeReduce,
    onRestore,
    cellReportOpts,
    visibilityReport,
  };
}

/** Apply cellDefaults to cells missing explicit persist/ui config */
function applyCellDefaults(
  composed: ComposedCells,
  cellDefaults?: { ui?: CellFieldFilter; persist?: CellFieldFilter },
): void {
  if (!cellDefaults) return;
  for (const f of composed.cells) {
    if (!f.__aio.persist && cellDefaults.persist) {
      f.__aio.persist = cellDefaults.persist;
    }
    if (!f.__aio.ui && cellDefaults.ui) {
      f.__aio.ui = cellDefaults.ui;
    }
  }
}

/** `localFirst: true` — every SERVER cell syncs unless it said otherwise, which
 *  is what moves method execution to the caller (perfect-aio D3,
 *  docs/specs/2026-07-22-local-first.md). Per-cell resolution:
 *
 *    cell.sync = anything   → the cell decided; never touched here
 *    cell.sync = false      → explicit opt-out; keeps round-tripping
 *    (absent)               → adopted into local-first
 *
 *  Client-scoped cells never reach this function (they are filtered out of the
 *  server entries above) and have nothing to sync anyway.
 *
 *  Adoption is LOGGED per cell, not assumed: a flag that silently changes where
 *  every method in the app runs is exactly the kind of quiet, load-bearing
 *  decision this framework refuses to make invisibly. */
function applyLocalFirst(composed: ComposedCells, enabled: boolean): void {
  if (!enabled) return;
  const adopted: string[] = [];
  const kept: string[] = [];
  const unable: string[] = [];
  for (const f of composed.cells) {
    if (f.__aio.syncConfig) continue; // the cell already asked for sync
    if (f.__aio.syncOptOut) {
      kept.push(f.__aio.id);
      continue;
    }
    // Only methods-style cells replay as CRDT ops (the browser stub builds
    // its rebase reducer from the sync methods — `asyncMethods` marks that
    // factory). Adopting an actions-style cell would EXCLUDE it from KV
    // persistence while the client warns and keeps round-tripping: all cost,
    // no local-first, and its post-flip writes would not survive a restart.
    if (!f.__aio.asyncMethods) {
      unable.push(f.__aio.id);
      continue;
    }
    f.__aio.syncConfig = normalizeSyncConfig(true);
    adopted.push(f.__aio.id);
  }
  log.info(
    `localFirst: ${adopted.length} cell(s) run locally and sync — ` +
      `${adopted.join(", ") || "none"}` +
      (kept.length ? `; server-only by opt-out: ${kept.join(", ")}` : "") +
      (unable.length
        ? `; server-only (actions-style cells cannot replay locally): ${
          unable.join(", ")
        }`
        : ""),
  );
}

/** Build getDBState from per-cell persist filters.
 *  Default resolution: cell.persist > cellDefaults.persist > "all".
 *  Every cell always gets an entry; "all" persists the full slice, "none" is filtered out. */
function buildDBStateGetter(composed: ComposedCells): (s: unknown) => unknown {
  const cellPersistFilters = new Map<string, CellFieldFilter>();
  for (const f of composed.cells) {
    const resolved: CellFieldFilter = f.__aio.persist ?? "all";
    if (resolved !== "none") {
      cellPersistFilters.set(f.__aio.id, resolved);
    }
  }
  return (s: unknown) => {
    const full = s as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [cellName, filter] of cellPersistFilters) {
      const cellState = full[cellName];
      if (!cellState || typeof cellState !== "object") continue;
      const filtered = applyCellFieldFilter(
        filter,
        cellState as Record<string, unknown>,
      );
      if (filtered) result[cellName] = filtered;
    }
    return result;
  };
}

type UiEntry = {
  filter: CellFieldFilter;
  forUser?: (
    exposed: Record<string, unknown>,
    user?: FilterUser,
  ) => Record<string, unknown>;
};

type UIStateResult = {
  autoGetUIState: ((s: unknown, user?: unknown) => unknown) | undefined;
  cellPatchStrategies: Map<string, CellPatchStrategy>;
  cellFilterFields: Map<string, PatchFilterFields>;
};

/** Build getUIState from per-cell ui filters + patch strategy map (with memoization).
 *  Default resolution: cell.ui > cellDefaults.ui > "all".
 *  Every cell always gets a UiEntry; "all" exposes the full slice, "none" is filtered out. */
function buildUIStateGetter(composed: ComposedCells): UIStateResult {
  const cellPatchStrategies = new Map<string, CellPatchStrategy>();
  const cellFilterFields = new Map<string, PatchFilterFields>();
  const cellUiEntries = new Map<string, UiEntry>();

  for (const f of composed.cells) {
    const resolved: CellFieldFilter = f.__aio.ui ?? "all";
    if (resolved === "all") {
      cellPatchStrategies.set(f.__aio.id, "raw");
    } else if (resolved === "none") {
      cellPatchStrategies.set(f.__aio.id, "skip");
    } else if (f.__aio.uiForUser) {
      cellPatchStrategies.set(f.__aio.id, "full");
    } else {
      cellPatchStrategies.set(f.__aio.id, "filter");
      if ("include" in resolved) {
        cellFilterFields.set(f.__aio.id, {
          mode: "include",
          fields: new Set(resolved.include),
        });
      } else if ("exclude" in resolved) {
        const plain = resolved.exclude.filter((k) => !k.includes("."));
        const deep = resolved.exclude
          .filter((k) => k.includes("."))
          .map((k) => k.split("."));
        cellFilterFields.set(f.__aio.id, {
          mode: "exclude",
          fields: new Set(plain),
          ...(deep.length > 0 ? { deepExcludes: deep } : {}),
        });
      }
    }
    cellUiEntries.set(f.__aio.id, {
      filter: resolved,
      forUser: f.__aio.uiForUser,
    });
  }

  // Memoization state — closure-captured, preserved across calls
  let _structCache: Record<string, unknown> | null = null;
  let _structStateRef: unknown = null;

  const getStructural = (s: unknown): Record<string, unknown> => {
    if (s === _structStateRef && _structCache) return _structCache;
    _structStateRef = s;
    const full = s as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [cellName, entry] of cellUiEntries) {
      const cellState = full[cellName];
      if (!cellState || typeof cellState !== "object") continue;
      const filtered = applyCellFieldFilter(
        entry.filter,
        cellState as Record<string, unknown>,
      );
      if (filtered) result[cellName] = filtered;
    }
    _structCache = result;
    return result;
  };

  const hasForUser = [...cellUiEntries.values()].some((e) => e.forUser);
  let autoGetUIState: (s: unknown, user?: unknown) => unknown;

  if (hasForUser) {
    autoGetUIState = (s: unknown, user?: unknown) => {
      const structural = getStructural(s);
      const result: Record<string, unknown> = { ...structural };
      for (const [cellName, entry] of cellUiEntries) {
        if (!entry.forUser || !result[cellName]) continue;
        try {
          result[cellName] = entry.forUser(
            structuredClone(result[cellName] as Record<string, unknown>),
            user as Record<string, unknown> | undefined,
          );
        } catch (e) {
          log.error(
            `[${cellName}] ui.forUser threw — using structural filter: ${e}`,
          );
        }
      }
      return result;
    };
  } else {
    autoGetUIState = (s: unknown) => getStructural(s);
  }

  return { autoGetUIState, cellPatchStrategies, cellFilterFields };
}

/** Build the per-cell visibility report — one row per cell with resolved ui/persist filters. */
function buildVisibilityReport(composed: ComposedCells): VisibilityRow[] {
  const rows: VisibilityRow[] = [];
  for (const f of composed.cells) {
    const uiResolved: CellFieldFilter | "forUser" = f.__aio.uiForUser
      ? "forUser"
      : (f.__aio.ui ?? "all");
    rows.push({
      cell: f.__aio.id,
      ui: uiResolved,
      persist: f.__aio.persist ?? "all",
    });
  }
  return rows;
}

/** Log cell composition info */
function logComposition(
  composed: ComposedCells,
  report: VisibilityRow[],
): void {
  log.info(`cells: ${composed.cellNames.join(", ")}`);
  for (const row of report) {
    const uiStr = row.ui === "forUser" ? "forUser" : renderFilter(row.ui);
    log.info(
      `cells: ${row.cell} ui=${uiStr} persist=${renderFilter(row.persist)}`,
    );
  }
  for (const f of composed.cells) {
    if (f.__aio.foreignActions.length) {
      for (const fa of f.__aio.foreignActions) {
        log.info(`${f.__aio.id}: listens to ${fa}`);
      }
    }
  }
}
