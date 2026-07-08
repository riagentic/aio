// logger-core.ts — AioLogger class: structured file logger

import type { LogConfig, LogEntry, LogLevel } from "./logger-types.ts";
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
  private appName: string;

  private lastStatus = new Map<string, string>(); // cell name → last status
  private flowStarts = new Map<string, number>(); // "cell:flow" → startMs
  private stats = { dispatched: 0, errors: 0, start: Date.now() };
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private ready = false;
  constructor(config: LogConfig & { appName?: string }) {
    this.cfg = {
      level: config.level ?? "trace",
      dir: config.dir ?? "./log",
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
  // Track in-flight writes so shutdown can flush them. Keeping promises in a
  // Set instead of awaiting lets writes stay fire-and-forget on the hot path
  // but still gives us a drain point on shutdown (F-3).
  private _pending = new Set<Promise<void>>();
  private write(path: string, entry: LogEntry): void {
    if (!this.ready) return;
    const p = Deno.writeTextFile(path, formatText(entry) + "\n", {
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

  /** Drain in-flight writes with a timeout. Safe to call multiple times. */
  async flush(timeoutMs = 500): Promise<void> {
    if (this._pending.size === 0) return;
    const snapshot = [...this._pending];
    const timeout = new Promise<void>((r) => setTimeout(r, timeoutMs));
    await Promise.race([Promise.allSettled(snapshot), timeout]);
  }
}
