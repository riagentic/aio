// logger-core.ts — AioLogger class: structured file logger

import { dirname } from "@std/path";
import type { LogConfig, LogEntry, LogLevel } from "./logger-types.ts";

// DEFAULT_LOG_DIR lives in logger-types.ts (which imports nothing) and is
// re-exported here for the call sites that have always read it from the core.
export { DEFAULT_LOG_DIR } from "./logger-types.ts";
import { DEFAULT_LOG_DIR } from "./logger-types.ts";
import {
  callerFile,
  fmtUptime,
  isDevMode,
  LEVELS,
  now,
} from "./logger-types.ts";
import { formatText, printConsole } from "./logger-format.ts";
import {
  DEFAULT_BACKUP_KEEP,
  DEFAULT_LOG_BUDGET,
  enforceBudget,
  type LogKind,
  rotateOnStart,
  wipeOnStart,
} from "./logger-rotate.ts";
import { observeAction } from "./logger-observe.ts";
import { noRedaction } from "./redact.ts";
import type { Redactor } from "./redact.ts";
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
  /** The app's `redactActions`, as the shared predicate. debug.log retains
   *  action payloads on disk, so it obeys the SAME list as the journal, the
   *  timeline, the action log and the checkpoint — it is not a public
   *  `LogConfig` field because it is not the logger's list to own: it is the
   *  app's, handed over at boot by `initLogger`. */
  private redact: Redactor;

  private lastStatus = new Map<string, string>(); // cell name → last status
  private stats = { dispatched: 0, errors: 0, start: Date.now() };
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private ready = false;
  constructor(
    config: LogConfig & { appName?: string; redact?: Redactor },
  ) {
    this.cfg = {
      level: config.level ?? "info",
      dir: config.dir ?? DEFAULT_LOG_DIR,
      console: config.console ?? isDevMode(),
      heartbeat: config.heartbeat ?? 3600,
      suppressTypes: config.suppressTypes ?? [],
      backupLogs: config.backupLogs ?? true,
      backupKeep: config.backupKeep ?? DEFAULT_BACKUP_KEEP,
      logBudget: config.logBudget ?? DEFAULT_LOG_BUDGET,
    };
    this.dir = this.cfg.dir;
    this.appName = config.appName ?? "app";
    this.redact = config.redact ?? noRedaction;
  }

  async init(): Promise<void> {
    try {
      await Deno.mkdir(this.dir, { recursive: true });
      const pathFn = this.path.bind(this);
      const rotated = this.cfg.backupLogs
        ? await rotateOnStart(pathFn, this.cfg.backupKeep)
        : (await wipeOnStart(pathFn), []);
      // AFTER rotation, so the run that just ended is inside the bound like
      // every other, and BEFORE `ready` — the first line of this run must not
      // be written into a directory that is still over budget.
      const budget = await enforceBudget(this.dir, this.cfg.logBudget);
      this.ready = true;
      // Everything said while the files did not yet exist, in the order it was
      // said, before this run's first "real" line.
      const held = this._preInit;
      this._preInit = [];
      for (const h of held) this.write(h.path, h.entry);
      if (this._preInitDropped > 0) {
        const dropped = this._preInitDropped;
        this._preInitDropped = 0;
        this.emit("warn", "logger", "early log lines were dropped", {
          dropped,
          kept: AioLogger.MAX_PREINIT,
          why: "more than the pre-init buffer holds were emitted before the " +
            "log files were ready",
        });
      }
      // The retention default changed (wipe → keep), and a default whose effect
      // is only observable by watching the filesystem must not change silently
      // (`.katana/_aio.md`). So the first thing this run says is what happened
      // to the last run's logs, and how to get the old behaviour. Only when
      // something was really archived — on a first boot there is nothing to say.
      if (rotated.length > 0) {
        this.emit("info", "logger", "kept the previous run's logs", {
          archived: rotated.map((k) => `${k}.log.1`).join(", "),
          keep: this.cfg.backupKeep === 0 ? "unlimited" : this.cfg.backupKeep,
          wipeInstead: "--no-backup-logs",
        });
      }
      // Reported, never silent (`.katana` rule: no silent caps). A deleted log
      // the developer expected to find is exactly the surprise this project
      // treats as a defect.
      if (budget && budget.removed.length > 0) {
        this.emit("info", "logger", "log budget: dropped oldest archives", {
          removed: budget.removed.join(", "),
          freedKB: Math.round(budget.freed / 1024),
          budgetMB: Math.round(this.cfg.logBudget / 1024 / 1024),
        });
      }
      if (budget?.over) {
        this.emit(
          "warn",
          "logger",
          "log budget exceeded by the live logs alone — nothing left to evict",
          {
            liveMB: Math.round(budget.live / 1024 / 1024),
            budgetMB: Math.round(this.cfg.logBudget / 1024 / 1024),
            dir: this.dir,
            fix:
              "raise logging.logBudget, lower logging.level, or delete the " +
              "directory between runs",
          },
        );
      }
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
        lastStatus: this.lastStatus,
        redact: this.redact,
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
    // ONE gate, every sink. `level` gated debug.log ALONE, so an app that
    // asked for `level: "warn"` still had every info line printed to the
    // console and appended to app.log — a setting that visibly did nothing,
    // which is worse than not offering it. The docs describe it as the log
    // level (docs/debugging/errors.md), so that is what it is. At the default
    // ("info") nothing changes: debug/trace never reached app.log anyway.
    if (LEVELS[lvl] < LEVELS[this.cfg.level]) return;
    this.write(this.path("debug"), e);
    if (lvl === "info" || lvl === "warn" || lvl === "error") {
      this.write(this.path("app"), e);
      if (this.cfg.console) printConsole(e);
    }
    if (lvl === "error") this.write(this.path("error"), e);
    if (lvl === "warn") this.write(this.path("warning"), e);
  }

  /** Every kind is simply `<dir>/<kind>.log`. This was an if-chain whose
   *  final `return` made error.log the answer for ANY unlisted kind — so
   *  adding one would have silently aliased it onto error.log rather than
   *  failing. One expression, and `LogKind` now decides the set. */
  path(kind: LogKind): string {
    return `${this.dir}/${kind}.log`;
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

  /** Lines emitted BEFORE `init()` finished, kept so they can be written when
   *  it does. Bounded: a logger that never initializes must not grow a queue
   *  forever, and the lines that matter on a failed boot are the FIRST ones. */
  private _preInit: Array<{ path: string; entry: LogEntry }> = [];
  private _preInitDropped = 0;
  private static readonly MAX_PREINIT = 256;

  private write(path: string, entry: LogEntry): void {
    if (!this.ready) {
      // Dropping these outright is a silent failure in the subsystem whose job
      // is to leave a record: `init()` is async (rotation, budget enforcement),
      // and every line a boot emits before it resolves — the config it read,
      // the port it chose, the first error — vanished from app.log with nothing
      // to show that anything was missing. They are held here and replayed in
      // order once the files exist. (The console half was never affected, which
      // is exactly why this was invisible: the developer watching a terminal
      // saw everything, and only the FILE — the thing you read after a crash —
      // was short.)
      if (this._preInit.length < AioLogger.MAX_PREINIT) {
        this._preInit.push({ path, entry });
      } else {
        this._preInitDropped++;
      }
      return;
    }
    const line = formatText(entry);
    // Guarded like formatText's safeStringify: entry.data can carry live
    // state (REDUCE_ERROR's snapshot), and a BigInt/cycle in it would throw
    // HERE and lose the very line reporting the error.
    let dataKey = "";
    if (entry.data) {
      try {
        dataKey = JSON.stringify(entry.data) ?? "";
      } catch {
        dataKey = line; // dedupe on the rendered line instead
      }
    }
    const key = `${entry.lvl}|${entry.cat}|${entry.msg}|${dataKey}`;
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
          this._noteWriteSuccess();
        },
        async (e) => {
          // The log directory vanished under a running app: someone cleaned up
          // `/tmp`, a deploy replaced the tree, a test removed its sandbox. The
          // right response is to put it back and carry on — an app must not
          // start emitting an endless error stream because LOGGING broke, and
          // an operator who deletes a log directory expects it to reappear, not
          // to lose the app's voice until restart. Recreate once, then retry.
          if (e instanceof Deno.errors.NotFound) {
            try {
              await Deno.mkdir(dirname(path), { recursive: true });
              await Deno.writeTextFile(path, lines.join("\n") + "\n", {
                append: true,
              });
              this._noteWriteSuccess();
              return;
            } catch { /* still unwritable — fall through and report */ }
          }
          this._noteWriteFailure(path, lines.length, e);
        },
      ).finally(() => {
        this._pending.delete(p);
      });
      this._pending.add(p);
    }
  }

  // Consecutive failed writes, and how many LINES they took with them. A
  // failed batch is already out of `_buffers` (it was taken before the write),
  // so those lines are gone — the only honest thing left is to say so.
  private _writeErrorsSuppressed = 0;
  private _linesLost = 0;
  private static readonly REPORT_FIRST = 3; // then every REPORT_EVERY
  private static readonly REPORT_EVERY = 100;

  /** A batch never reached disk. Reports the first few, then periodically —
   *  never NOTHING. It used to stop after three console lines and stay silent
   *  for the life of the process: a full disk or a revoked permission meant the
   *  app's entire log went to nowhere, while the app looked perfectly healthy
   *  and nothing anywhere said the record had stopped. Rate-limited (a broken
   *  sink fails on every flush), never off. */
  private _noteWriteFailure(path: string, lines: number, e: unknown): void {
    this._writeErrors++;
    this._linesLost += lines;
    const n = this._writeErrors;
    if (
      n <= AioLogger.REPORT_FIRST || n % AioLogger.REPORT_EVERY === 0
    ) {
      console.error(
        `[logger] write failed for ${path}: ${e} — ${n} consecutive failure(s), ` +
          `${this._linesLost} log line(s) lost (reported every ${AioLogger.REPORT_EVERY} after the first ${AioLogger.REPORT_FIRST})`,
      );
    } else {
      this._writeErrorsSuppressed++;
    }
  }

  /** A write landed. If the sink had been failing, say that it recovered and
   *  what the outage cost — otherwise the suppressed failures would be the
   *  last word on a log nobody knew had holes in it. */
  private _noteWriteSuccess(): void {
    if (this._writeErrors > 0) {
      console.error(
        `[logger] file logging recovered after ${this._writeErrors} failed ` +
          `write(s) (${this._writeErrorsSuppressed} report(s) suppressed) — ` +
          `${this._linesLost} log line(s) were lost and cannot be recovered`,
      );
    }
    this._writeErrors = 0;
    this._writeErrorsSuppressed = 0;
    this._linesLost = 0;
  }

  /** Flush buffered lines + drain in-flight writes. Safe to call repeatedly.
   *
   *  The timeout bounds shutdown (the caller's phase budget is finite), but it
   *  used to win SILENTLY: the last lines of a slow or wedged filesystem — the
   *  crash report, the "stopped" line — simply were not there, and the log gave
   *  no hint that anything was missing. A deadline that is allowed to lose data
   *  has to announce it. */
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const TIMED_OUT = Symbol("logger-flush-timeout");
    const timeout = new Promise<typeof TIMED_OUT>((r) => {
      timer = setTimeout(() => r(TIMED_OUT), timeoutMs);
    });
    const outcome = await Promise.race([
      Promise.allSettled(snapshot).then(() => undefined),
      timeout,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === TIMED_OUT) {
      console.error(
        `[logger] flush timed out after ${timeoutMs}ms with ${snapshot.length} ` +
          `write(s) still in flight — the tail of ${this.dir} may be missing ` +
          `(the log files are the record; this is what is NOT in them)`,
      );
    }
  }
}
