// logger-core.ts — AioLogger class: structured file logger

import type { LogConfig, LogEntry, LogLevel } from "./logger-types.ts";

/** Default log directory — dot-dir so project watchers/scanners skip it. */
// Only reached by a logger created WITHOUT an app (a standalone script, or a
// log call before boot wires `dir: <appDirs>.logs`). An app's logs live in
// `~/.<appId>/logs` — see src/server/app-dirs.ts.
export const DEFAULT_LOG_DIR = ".aio/log";
import {
  callerFile,
  fmtUptime,
  isDevMode,
  LEVELS,
  now,
} from "./logger-types.ts";
import { formatText, printConsole } from "./logger-format.ts";
import { rotateOnStart, wipeOnStart } from "./logger-rotate.ts";
import { observeAction } from "./logger-observe.ts";
import { logPerf, logVitals, logVitalsSummary } from "./logger-vitals.ts";
/** Structured file logger — routes entries to app.log, debug.log, error.log, warning.log, and perf.log. */
export class AioLogger {
  private cfg: Required<LogConfig>;
  private dir: string;

  /** Resolved log directory (public — client-log and diagnostics share it) */
  get logDir(): string {
    return this.dir;
  }
  private appName: string;

  private lastStatus = new Map<string, string>(); // cell name → last status
  private flowStarts = new Map<string, number>(); // "cell:flow" → startMs
  private stats = { dispatched: 0, errors: 0, start: Date.now() };
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private ready = false;
  constructor(config: LogConfig & { appName?: string }) {
    this.cfg = {
      level: config.level ?? "info",
      dir: config.dir ?? DEFAULT_LOG_DIR,
      console: config.console ?? isDevMode(),
      heartbeat: config.heartbeat ?? 3600,
      suppressTypes: config.suppressTypes ?? [],
      backupLogs: config.backupLogs ?? false,
      backupKeep: config.backupKeep ?? 7,
    };
    this.dir = this.cfg.dir;
    this.appName = config.appName ?? "app";
  }

  async init(): Promise<void> {
    try {
      await Deno.mkdir(this.dir, { recursive: true });
      const pathFn = this.path.bind(this);
      if (this.cfg.backupLogs) await rotateOnStart(pathFn, this.cfg.backupKeep);
      else await wipeOnStart(pathFn);
      this.ready = true;
      if (this.cfg.heartbeat > 0) {
        this.heartbeatTimer = setInterval(
          () => this.heartbeat(),
          this.cfg.heartbeat * 1000,
        );
      }
    } catch (e) {
      console.error(`[logger] cannot create ${this.dir}: ${e}`);
    }
  }

  /** Called once after aio.run() completes boot */
  onStart(cellNames: string[], port?: number): void {
    for (const n of cellNames) this.lastStatus.set(n, "");
    this.emit("info", "app", "started", {
      cells: cellNames.join(", "),
      ...(port ? { port } : {}),
    });
  }

  /** Called during aio shutdown */
  onStop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const uptime = fmtUptime(Date.now() - this.stats.start);
    this.emit("info", "app", "stopped", {
      uptime,
      dispatched: this.stats.dispatched,
      errors: this.stats.errors,
    });
  }

  observe(
    action: { type: string; payload?: unknown },
    state: Record<string, unknown>,
  ): void {
    observeAction(
      {
        suppressTypes: this.cfg.suppressTypes,
        stats: this.stats,
        flowStarts: this.flowStarts,
        lastStatus: this.lastStatus,
        emit: this.emit.bind(this),
      },
      action,
      state,
    );
  }

  pub(
    lvl: LogLevel,
    cat: string,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    const src = callerFile();
    this.emit(lvl, cat, msg, data ?? null, undefined, src);
  }

  /** Log a performance violation */
  perf(
    source: "reduce" | "effect",
    type: string,
    duration: number,
    budget: number,
    breakdown?: {
      produce: number;
      clone: number;
      spread: number;
      routing: number;
      listeners: number;
    },
  ): void {
    logPerf(
      source,
      type,
      duration,
      budget,
      breakdown,
      this.write.bind(this),
      this.path.bind(this),
      this.cfg.console,
    );
  }

  /** Log a vital-signs measurement */
  vitals(
    layer: "render" | "transport" | "loop",
    status: string,
    measured: number,
    threshold: number,
    hint?: { cause: string; suggestion: string; severity: string },
  ): void {
    logVitals(
      layer,
      status,
      measured,
      threshold,
      hint,
      this.write.bind(this),
      this.path.bind(this),
      this.cfg.console,
    );
  }

  /** Log a vital-signs summary line */
  vitalsSummary(summary: string): void {
    logVitalsSummary(
      summary,
      this.write.bind(this),
      this.path.bind(this),
      this.cfg.console,
    );
  }

  private heartbeat(): void {
    const uptime = fmtUptime(Date.now() - this.stats.start);
    this.emit("info", "app", "heartbeat", {
      uptime,
      dispatched: this.stats.dispatched,
      errors: this.stats.errors,
    });
  }

  private emit(
    lvl: LogLevel,
    cat: string,
    msg: string,
    data?: Record<string, unknown> | null,
    dur?: number,
    src?: string,
  ): void {
    const e: LogEntry = {
      ts: now(),
      lvl,
      cat,
      msg,
      ...(src ? { src } : {}),
      ...(data ? { data } : {}),
      ...(dur !== undefined ? { dur } : {}),
    };
    if (LEVELS[this.cfg.level] <= LEVELS[lvl]) {
      this.write(this.path("debug"), e);
    }
    if (lvl === "info" || lvl === "warn" || lvl === "error") {
      this.write(this.path("app"), e);
      if (this.cfg.console) printConsole(e);
    }
    if (lvl === "error") this.write(this.path("error"), e);
    if (lvl === "warn") this.write(this.path("warning"), e);
  }

  path(kind: "app" | "debug" | "error" | "warning" | "perf"): string {
    if (kind === "app") return `${this.dir}/app.log`;
    if (kind === "debug") return `${this.dir}/debug.log`;
    if (kind === "warning") return `${this.dir}/warning.log`;
    if (kind === "perf") return `${this.dir}/perf.log`;
    return `${this.dir}/error.log`;
  }

  private _writeErrors = 0;
  // Buffered sink (watcher-loop field report #3): entries accumulate per file and
  // flush on a short timer instead of one fs write per entry — during a
  // dispatch storm the log writes themselves were the loop's fuel (~480KB/s).
  private _buffers = new Map<string, string[]>();
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _pending = new Set<Promise<void>>();
  // Repeat suppression: identical consecutive lines per file collapse into
  // one line + "last message repeated N times".
  private _lastLine = new Map<string, { key: string; count: number }>();
  private static readonly FLUSH_MS = 250;
  private static readonly MAX_BUFFERED = 512; // lines per file before forced flush

  private write(path: string, entry: LogEntry): void {
    if (!this.ready) return;
    const line = formatText(entry);
    const key = `${entry.lvl}|${entry.cat}|${entry.msg}|${
      entry.data ? JSON.stringify(entry.data) : ""
    }`;
    const last = this._lastLine.get(path);
    if (last && last.key === key) {
      last.count++;
      return; // suppressed — surfaced as a summary line on next change/flush
    }
    const buf = this._buffers.get(path) ?? [];
    if (last && last.count > 1) {
      buf.push(`  … last message repeated ${last.count - 1} times`);
    }
    this._lastLine.set(path, { key, count: 1 });
    buf.push(line);
    this._buffers.set(path, buf);
    if (buf.length >= AioLogger.MAX_BUFFERED) {
      this._flushBuffers();
      return;
    }
    if (this._flushTimer === null) {
      this._flushTimer = setTimeout(
        () => this._flushBuffers(),
        AioLogger.FLUSH_MS,
      );
      // Don't hold the process open just to flush logs
      Deno.unrefTimer?.(this._flushTimer as unknown as number);
    }
  }

  private _flushBuffers(): void {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    for (const [path, lines] of this._buffers) {
      if (lines.length === 0) continue;
      this._buffers.set(path, []);
      const p = Deno.writeTextFile(path, lines.join("\n") + "\n", {
        append: true,
      }).then(
        () => {
          this._writeErrors = 0;
        },
        (e) => {
          if (this._writeErrors < 3) {
            this._writeErrors++;
            console.error(`[logger] write failed for ${path}: ${e}`);
          }
        },
      ).finally(() => {
        this._pending.delete(p);
      });
      this._pending.add(p);
    }
  }

  /** Flush buffered lines + drain in-flight writes. Safe to call repeatedly. */
  async flush(timeoutMs = 500): Promise<void> {
    // Surface trailing "repeated N times" summaries before the final write
    for (const [path, last] of this._lastLine) {
      if (last.count > 1) {
        const buf = this._buffers.get(path) ?? [];
        buf.push(`  … last message repeated ${last.count - 1} times`);
        this._buffers.set(path, buf);
        last.count = 1;
      }
    }
    this._flushBuffers();
    if (this._pending.size === 0) return;
    const snapshot = [...this._pending];
    const timeout = new Promise<void>((r) => setTimeout(r, timeoutMs));
    await Promise.race([Promise.allSettled(snapshot), timeout]);
  }
}
