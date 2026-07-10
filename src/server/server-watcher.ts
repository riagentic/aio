// Dev-only file watcher — debounced live reload on src/ changes
// Extracted from createServer() closure to keep server.ts focused on HTTP/WS

import { join } from "@std/path";
import type { GraphResult } from "./graph-validator.ts";
import { validateGraph } from "./graph-validator.ts";
import {
  clearTranspileCaches,
  normPath,
  transpile,
} from "./server-transpile.ts";
import { lockDir } from "./single-instance-lock.ts";
import { log } from "../diagnostics/logger.ts";

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
  onReload?: (signal: "__reload" | "__css") => void;
  /** Called when graph validation produces a new result — server uses this for diagnostic HTML */
  onGraphResult?: (result: GraphResult) => void;
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

/** Factory — creates a self-contained file watcher with debouncing and health monitoring */
export function createFileWatcher(deps: WatcherDeps): FileWatcher {
  const { absBaseDir, port, debug } = deps;

  // --- Debounce state ---
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let reloadIsFull = false;

  // --- Graph validation state ---
  let graphResult: GraphResult | null = null;
  let graphWasRed = false;
  let graphGeneration = 0;

  // --- Watcher state ---
  let fsWatcher: Deno.FsWatcher | null = null;
  let watcherActive = false;
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

  function scheduleReload(path: string): void {
    // Skip editor temp files, swap files, lockfiles, etc.
    const dot = path.lastIndexOf(".");
    const ext = dot >= 0 ? path.slice(dot) : "";
    if (!RELOAD_EXT.has(ext)) return;
    debug(`watch: changed ${path}`);
    // Normalize to match cache keys — resolve symlinks (e.g. /var → /private/var on macOS)
    // Clear both the transpile entry and the memoized realpath for this path.
    clearTranspileCaches(path);
    path = normPath(path);
    clearTranspileCaches(path);
    if (!path.endsWith(".css")) reloadIsFull = true;
    if (reloadTimer) clearTimeout(reloadTimer);
    // 100ms debounce — batch rapid file changes into single reload
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      const wasFullReload = reloadIsFull;
      reloadIsFull = false;

      (async () => {
        // Re-validate import graph on file change (dev mode only)
        if (fileExists(join(absBaseDir, deps.uiEntry ?? "App.tsx"))) {
          const gen = ++graphGeneration;
          const timeout = new Promise<null>((r) =>
            setTimeout(() => r(null), 2000)
          );
          const revalTranspile = (s: string, f: string) => transpile(s, f);
          const validation = validateGraph(
            join(absBaseDir, deps.uiEntry ?? "App.tsx"),
            deps.importMapObj,
            revalTranspile,
          );
          const result = await Promise.race([validation, timeout]);
          // Stale validation — a newer file change already started a new validation
          if (gen !== graphGeneration) return;
          if (result === null) {
            // AIO-280: timeout — keep previous result, don't assume valid
            debug(
              "graph: ⚠ validation timed out (>2s) — keeping previous state",
            );
            return;
          }
          graphResult = result;
          deps.onGraphResult?.(result);
        }

        if (graphResult && !graphResult.valid) {
          // Graph is red — send error info to clients, suppress normal reload
          const errJson = JSON.stringify(graphResult.errors);
          deps.broadcastWs("__graph_error:" + errJson);
          for (const err of graphResult.errors) {
            log.error(
              "graph",
              `✖ ${err.file}${err.line ? `:${err.line}` : ""} — ${err.message}`,
            );
            log.warn("graph", `FIX: ${err.fix}`);
          }
          deps.onReload?.("__reload");
          graphWasRed = true;
        } else if (graphWasRed) {
          // Was red, now green — tell clients to reload
          graphWasRed = false;
          debug("graph: ✓ all errors fixed — reloading");
          deps.broadcastWs("__graph_clear");
          deps.onReload?.("__reload");
        } else {
          // Normal reload (no graph issues)
          const signal = wasFullReload ? "__reload" : "__css";
          debug(`${signal} → broadcasting to clients`);
          deps.broadcastWs(signal);
          deps.onReload?.(signal as "__reload" | "__css");
        }
      })().catch((err) => debug(`graph: unexpected error — ${err}`));
    }, 100);
  }

  function startWatcher(): boolean {
    try {
      const paths = _sentinelOk ? [absBaseDir, SENTINEL] : [absBaseDir];
      fsWatcher = Deno.watchFs(paths, { recursive: true });
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
          console.warn(`[aio] live reload stopped: ${e}`);
        }
      })();
      return true;
    } catch (e) {
      console.warn(`[aio] live reload failed — hot reload disabled: ${e}`);
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
        console.warn(
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
    console.log(`[aio] live reload watching ${absBaseDir}`);
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
          console.warn(
            `[aio] live reload — watcher unresponsive after ${MAX_WATCHER_RESTARTS} restarts, giving up`,
          );
          if (healthTimer) {
            clearInterval(healthTimer);
            healthTimer = null;
          }
          return;
        }
        console.warn(
          `[aio] live reload — watcher unresponsive, restarting (${watcherRestarts}/${MAX_WATCHER_RESTARTS})`,
        );
        try {
          fsWatcher?.close();
        } catch { /* already closed */ }
        startWatcher();
      }
    }, 30_000);
    return true;
  }

  function shutdown(): void {
    if (reloadTimer) clearTimeout(reloadTimer);
    fsWatcher?.close();
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
