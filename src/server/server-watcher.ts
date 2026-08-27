// Dev-only file watcher — debounced live reload on src/ changes
// Extracted from createServer() closure to keep server.ts focused on HTTP/WS

import { UI_ENTRY } from "./app-files.ts";
import { enc } from "../protocol/envelope.ts";
import { basename, dirname, join } from "@std/path";
import { DENO_JSON_NAMES } from "./deno-json.ts";
import type { GraphResult } from "./graph-validator.ts";
import { validateGraph } from "./graph-validator.ts";
import {
  clearTranspileCaches,
  normPath,
  transpile,
} from "./server-transpile.ts";
import { lockDir } from "./single-instance-lock.ts";
import { log } from "../diagnostics/logger-api.ts";

/** File extensions that trigger live reload */
const RELOAD_EXT = new Set([".ts", ".tsx", ".css", ".html", ".svg"]);

/** Callbacks the watcher uses to interact with server internals */
export interface WatcherDeps {
  absBaseDir: string;
  uiEntry?: string; // AIO-8.1: UI entry file (default "App.tsx")
  port: number;
  importMapObj: Record<string, string>;
  debug: (msg: string) => void;
  /** Broadcast a string message to all open WS connections */
  broadcastWs: (msg: string) => void;
  /** Called on reload signal — lets aio.ts forward to UDS */
  onReload?: (signal: "reload" | "css") => void;
  /** Called when graph validation produces a new result — server uses this for diagnostic HTML */
  onGraphResult?: (result: GraphResult) => void;
  /** Called when an edited file declares a cell. Cells run in the server
   *  process and cannot hot-reload, so dev restarts the process; without a
   *  handler the watcher falls back to warning once per file. */
  onCellChange?: (path: string) => void;
  /** How long graph validation gets before the reload goes out without it.
   *  Injected only by tests — see {@link GRAPH_TIMEOUT_MS}. */
  graphTimeoutMs?: number;
}

/** Trailing-edge debounce: batch a burst of saves into one reload. */
export const DEBOUNCE_MS = 100;

/** …but never wait longer than this in total. A trailing-edge debounce with no
 *  ceiling is not a debounce, it is a cancel: a generator, a formatter, or a
 *  `git checkout` touching files every <100 ms pushed the timer forward
 *  forever, so the busiest possible moment — the one where you most want the
 *  page to catch up — was the one that never reloaded at all. */
export const DEBOUNCE_MAX_MS = 500;

/** How long import-graph validation gets before the reload goes out anyway. */
export const GRAPH_TIMEOUT_MS = 2_000;

/** The debounce delay to use, given how long the current burst has already
 *  been held. Pure — the max-wait ceiling is a unit test, not a stopwatch. */
export function _debounceDelay(waitedMs: number): number {
  return Math.max(0, Math.min(DEBOUNCE_MS, DEBOUNCE_MAX_MS - waitedMs));
}

/** The project config files this watcher looks for: both names Deno accepts,
 *  next to the app and one level up (the scaffold keeps deno.json at the
 *  project root, flat apps next to the entry). Pure. */
export function _configPaths(absBaseDir: string): string[] {
  const up = dirname(absBaseDir);
  return [absBaseDir, up].flatMap((dir) =>
    DENO_JSON_NAMES.map((name) => join(dir, name))
  );
}

/** Handle returned by createFileWatcher */
export interface FileWatcher {
  /** Start the watcher + health monitor. Returns true if watcher started. */
  start: () => boolean;
  /** Schedule a reload for a changed path (called externally too) */
  scheduleReload: (path: string) => void;
  /** Whether the watcher is currently active */
  readonly active: boolean;
  /** Clean up watcher, timers, sentinel */
  shutdown: () => void;
}

/** The changed files, as a person would name them: project-relative, and
 *  summarised once a burst gets long (a `deno fmt` or a branch switch touches
 *  dozens and the line must stay one line). */
function describeChanged(paths: string[]): string {
  if (paths.length === 0) return "the project";
  const cwd = Deno.cwd();
  const rel = paths.map((p) =>
    p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p
  );
  return rel.length <= 3
    ? rel.join(", ")
    : `${rel.slice(0, 3).join(", ")} +${rel.length - 3} more`;
}

/** Factory — creates a self-contained file watcher with debouncing and health monitoring */
export function createFileWatcher(deps: WatcherDeps): FileWatcher {
  const { absBaseDir, port, debug } = deps;

  // --- Debounce state ---
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let reloadIsFull = false;
  /** When the current debounce burst started (0 = no burst in flight). */
  let debounceStartedAt = 0;
  /** The files that caused the burst in flight — named in the reload line. */
  const changedInBurst = new Set<string>();

  // --- Graph validation state ---
  let graphResult: GraphResult | null = null;
  let graphWasRed = false;
  let graphGeneration = 0;
  let _saidGraphTimeout = false;
  const graphTimeoutMs = deps.graphTimeoutMs ?? GRAPH_TIMEOUT_MS;

  // --- Watcher state ---
  let fsWatcher: Deno.FsWatcher | null = null;
  let configWatcher: Deno.FsWatcher | null = null;
  let watcherActive = false;
  const _warnedCellFiles = new Set<string>(); // a field report: warn once per cell file
  let _sentinelOk = false;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  // Sentinel lives in per-user lockDir ($XDG_RUNTIME_DIR/aio or /tmp/aio), not
  // the world-writable /tmp root. Atomic createNew on first write refuses to
  // follow a pre-existing symlink — prevents local attacker clobbering files
  // readable to the dev's UID via a planted symlink (F-2).
  const SENTINEL = join(lockDir(), `watch-${port}.tmp`);
  let lastWatcherEvent = Date.now();
  let watcherRestarts = 0;
  const MAX_WATCHER_RESTARTS = 3;

  function fileExists(path: string): boolean {
    try {
      Deno.statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  let _warnedImportMap = false;

  function scheduleReload(path: string): void {
    // A changed deno.json can't take effect in this process.
    if (path.endsWith("deno.json") || path.endsWith("deno.jsonc")) {
      if (!_warnedImportMap) {
        _warnedImportMap = true;
        log.warn(
          "watch",
          `deno.json changed — the import map was read at boot, so a NEW ` +
            `dependency will not resolve until you restart. (Edits to tasks ` +
            `or unrelated keys are harmless.) Restart: stop and re-run ` +
            `\`deno task dev\`.`,
        );
      }
      return; // never a browser reload — nothing in the served graph changed
    }
    // Skip editor temp files, swap files, lockfiles, etc.
    const dot = path.lastIndexOf(".");
    const ext = dot >= 0 ? path.slice(dot) : "";
    if (!RELOAD_EXT.has(ext)) return;
    debug(`watch: changed ${path}`);
    // a changed cell file does NOT hot-reload — cells run in the
    // server process, so the client reload shows the NEW UI reading OLD cell
    // logic. That silent mismatch sends people ghost-hunting. Warn loudly (once
    // per file per session) with the fix.
    if (!path.endsWith(".css")) {
      try {
        const src = Deno.readTextFileSync(path);
        if (/\bcell\s*\(\s*["'`]/.test(src)) {
          if (deps.onCellChange) {
            // Dev restarts the process itself — the handler
            // warns instead when it can't (prod-ish permissions, opt-out).
            deps.onCellChange(path);
          } else if (!_warnedCellFiles.has(path)) {
            _warnedCellFiles.add(path);
            log.warn(
              "watch",
              `cell file changed (${
                path.split("/").pop()
              }) — cells run in the server process and do NOT hot-reload. ` +
                `Restart to apply: stop and re-run \`deno task dev\`. ` +
                `(Client JSX hot-reloads, so you may be seeing new UI on old cell logic.)`,
            );
          }
        }
      } catch { /* unreadable — skip */ }
    }
    // Normalize to match cache keys — resolve symlinks (e.g. /var → /private/var on macOS)
    // Clear both the transpile entry and the memoized realpath for this path.
    clearTranspileCaches(path);
    path = normPath(path);
    clearTranspileCaches(path);
    if (!path.endsWith(".css")) reloadIsFull = true;
    changedInBurst.add(path);
    if (reloadTimer) clearTimeout(reloadTimer);
    // Trailing-edge debounce with a MAX WAIT — see DEBOUNCE_MAX_MS.
    if (debounceStartedAt === 0) debounceStartedAt = Date.now();
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      const startedAt = debounceStartedAt;
      debounceStartedAt = 0;
      const wasFullReload = reloadIsFull;
      reloadIsFull = false;
      const changed = [...changedInBurst];
      changedInBurst.clear();
      const burstStartedAt = startedAt;

      (async () => {
        // Re-validate import graph on file change (dev mode only)
        if (fileExists(join(absBaseDir, deps.uiEntry ?? UI_ENTRY))) {
          const gen = ++graphGeneration;
          const timeout = new Promise<null>((r) =>
            setTimeout(() => r(null), graphTimeoutMs)
          );
          const revalTranspile = (s: string, f: string) => transpile(s, f);
          const validation = validateGraph(
            join(absBaseDir, deps.uiEntry ?? UI_ENTRY),
            deps.importMapObj,
            revalTranspile,
          );
          const result = await Promise.race([validation, timeout]);
          // Stale validation — a newer file change already started a new validation
          if (gen !== graphGeneration) return;
          if (result === null) {
            // Timeout — keep the PREVIOUS graph result (a slow validation is
            // not evidence the graph broke) and carry on to the broadcast.
            //
            // This used to `return` here, before any broadcast, with the
            // explanation going to `debug` — suppressed unless someone ran
            // with --verbose. On a project big enough to exceed the budget
            // that meant every save did nothing at all, silently: no reload,
            // no error, no line. A reload the graph could not vet in time is
            // still the right thing to send; the compiler and the module-error
            // overlay catch what the pre-check would have.
            if (!_saidGraphTimeout) {
              _saidGraphTimeout = true;
              log.warn(
                "watch",
                `import-graph validation did not finish within ${
                  graphTimeoutMs / 1000
                }s, so this reload went out unchecked — you get the browser ` +
                  `reload, just not the pre-flight error overlay. Usually a ` +
                  `very large or deeply nested import graph. (said once)`,
              );
            }
          } else {
            _saidGraphTimeout = false;
            graphResult = result;
            deps.onGraphResult?.(result);
          }
        }

        if (graphResult && !graphResult.valid) {
          // Graph is red — send error info to clients, suppress normal reload
          deps.broadcastWs(enc("graph-error", graphResult.errors));
          for (const err of graphResult.errors) {
            log.error(
              "graph",
              `✖ ${err.file}${err.line ? `:${err.line}` : ""} — ${err.message}`,
            );
            log.warn("graph", `FIX: ${err.fix}`);
          }
          deps.onReload?.("reload");
          graphWasRed = true;
        } else if (graphWasRed) {
          // Was red, now green — tell clients to reload
          graphWasRed = false;
          debug("graph: ✓ all errors fixed — reloading");
          deps.broadcastWs(enc("graph-clear"));
          deps.onReload?.("reload");
        } else {
          // Normal reload (no graph issues)
          const signal = wasFullReload ? "reload" : "css";
          debug(`${signal} → broadcasting to clients`);
          deps.broadcastWs(enc(signal));
          deps.onReload?.(signal);
          // …and SAY SO. A successful hot reload was the one dev-loop event
          // with no terminal line at all: every failure printed something,
          // success printed nothing, so the only way to tell "it reloaded"
          // from "the watcher is not watching this file" was to go and look at
          // the browser. One line closes the loop.
          log.info(
            "watch",
            `${signal === "css" ? "restyled" : "reloaded"} ${
              describeChanged(changed)
            } (${Date.now() - burstStartedAt}ms)`,
          );
        }
      })().catch((err) => debug(`graph: unexpected error — ${err}`));
    }, _debounceDelay(Date.now() - debounceStartedAt));
  }

  /** Watch the project config for edits. The import map is read ONCE at boot,
   *  so adding a dependency while the server runs makes the watcher rescan
   *  against a STALE map — the new import "doesn't exist" and the module-errors
   *  page blames your code. We cannot hot-swap the map (it is baked into the
   *  served import map and the transpile cache), so scheduleReload says so,
   *  loudly and once.
   *
   *  The DIRECTORY is watched, not the file. An inotify watch is on an inode:
   *  every editor that saves atomically (write a temp file, rename it over the
   *  target — vim, VS Code, `deno fmt`, most formatters) replaces that inode,
   *  so a file watch fired for the FIRST such save and then went permanently
   *  deaf. Non-recursive, and filtered to the config names, so this cannot pull
   *  a whole project root (node_modules included) into the watch set. */
  function startConfigWatcher(): void {
    const dirs = new Set<string>();
    for (const cfg of _configPaths(absBaseDir)) {
      if (!fileExists(cfg)) continue;
      const dir = dirname(cfg);
      // Already covered by the recursive app watch — a second watch would only
      // double every event.
      if (
        dir === absBaseDir || dir.startsWith(absBaseDir + "/") ||
        dir.startsWith(absBaseDir + "\\")
      ) continue;
      dirs.add(dir);
    }
    if (dirs.size === 0) return;
    try {
      configWatcher = Deno.watchFs([...dirs], { recursive: false });
    } catch (e) {
      log.warn(
        "watch",
        `cannot watch the project config in ${
          [...dirs].join(", ")
        } (${e}) — a deno.json edit will not be reported. Restart after ` +
          `changing it.`,
      );
      return;
    }
    const names = new Set<string>(DENO_JSON_NAMES);
    (async () => {
      try {
        for await (const event of configWatcher!) {
          if (event.kind === "access") continue;
          for (const path of event.paths) {
            if (names.has(basename(path))) {
              scheduleReload(path);
            }
          }
        }
      } catch { /* closed on shutdown, or the dir went away */ }
    })();
  }

  function startWatcher(): boolean {
    try {
      const paths = _sentinelOk ? [absBaseDir, SENTINEL] : [absBaseDir];
      fsWatcher = Deno.watchFs(paths, { recursive: true });
      startConfigWatcher();
      watcherActive = true;
      (async () => {
        try {
          for await (const event of fsWatcher!) {
            if (event.kind === "access") continue;
            // Sentinel touch — update liveness timestamp, don't trigger reload
            if (event.paths.some((p) => p === SENTINEL)) {
              lastWatcherEvent = Date.now();
              if (watcherRestarts > 0) watcherRestarts = 0; // AIO-157: reset on recovery
              continue;
            }
            lastWatcherEvent = Date.now();
            if (watcherRestarts > 0) watcherRestarts = 0; // AIO-157: reset on recovery
            for (const path of event.paths) scheduleReload(path);
          }
        } catch (e) {
          watcherActive = false;
          log.warn(`[aio] live reload stopped: ${e}`);
        }
      })();
      return true;
    } catch (e) {
      log.warn(`[aio] live reload failed — hot reload disabled: ${e}`);
      return false;
    }
  }

  // Create sentinel atomically. Returns true if we own a real file at SENTINEL,
  // false if the path is hostile or dir is not writable. lstatSync avoids
  // following symlinks (F-2 defense); createNew:true is O_EXCL atomic.
  function ensureSentinel(): boolean {
    try {
      const info = Deno.lstatSync(SENTINEL);
      if (!info.isFile) {
        log.warn(
          `[aio] live reload — sentinel path ${SENTINEL} is not a regular file (symlink/dir), refusing to use`,
        );
        return false;
      }
      Deno.removeSync(SENTINEL);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) return false;
    }
    try {
      const f = Deno.openSync(SENTINEL, { createNew: true, write: true });
      f.close();
      return true;
    } catch {
      return false; // dir not writable or raced — watcher falls back to absBaseDir only
    }
  }

  function start(): boolean {
    _sentinelOk = ensureSentinel();
    if (!startWatcher()) return false;
    log.info(`[aio] live reload watching ${absBaseDir}`);
    // Health check — touch sentinel every 30s, restart watcher if no events for 60s.
    // lstatSync+open(write+truncate) instead of writeTextFileSync so we never
    // follow a symlink if one gets swapped in mid-run (F-2 defense).
    healthTimer = setInterval(() => {
      if (_sentinelOk) {
        try {
          const info = Deno.lstatSync(SENTINEL);
          if (info.isFile) {
            const f = Deno.openSync(SENTINEL, { write: true, truncate: true });
            f.writeSync(new TextEncoder().encode(String(Date.now())));
            f.close();
          } else {
            _sentinelOk = false; // something replaced it with a symlink/dir — stop touching
          }
        } catch { /* gone or hostile — skip touch */ }
      }
      if (watcherActive && Date.now() - lastWatcherEvent > 60_000) {
        watcherRestarts++;
        if (watcherRestarts > MAX_WATCHER_RESTARTS) {
          log.warn(
            `[aio] live reload — watcher unresponsive after ${MAX_WATCHER_RESTARTS} restarts, giving up`,
          );
          if (healthTimer) {
            clearInterval(healthTimer);
            healthTimer = null;
          }
          return;
        }
        log.warn(
          `[aio] live reload — watcher unresponsive, restarting (${watcherRestarts}/${MAX_WATCHER_RESTARTS})`,
        );
        try {
          fsWatcher?.close();
        } catch { /* already closed */ }
        try {
          configWatcher?.close();
        } catch { /* already closed */ }
        configWatcher = null;
        startWatcher();
      }
    }, 30_000);
    return true;
  }

  function shutdown(): void {
    if (reloadTimer) clearTimeout(reloadTimer);
    fsWatcher?.close();
    try {
      configWatcher?.close();
    } catch { /* already closed */ }
    configWatcher = null;
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    try {
      Deno.removeSync(SENTINEL);
    } catch { /* already gone */ }
  }

  return {
    start,
    scheduleReload,
    get active() {
      return watcherActive;
    },
    shutdown,
  };
}
