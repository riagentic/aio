// logger.ts — Structured logging for aio
//
// Five outputs, all plain text:
//   app.log     — narrative: lifecycle, flow events, errors (info + error only)
//   debug.log   — everything: all levels + perf violations (the firehose)
//   error.log   — errors only (ops/alerting)
//   warning.log — warnings only
//   perf.log    — performance violations only
//
// Default: logs are wiped on each app start (clean slate).
// With backupLogs: true (or --backup-logs), old logs are rotated instead.

/** Log severity levels */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Logger configuration — passed to aio.run({ logging: {...} }) */
export type LogConfig = {
  /** Minimum level written to debug.log (default: 'trace' — everything) */
  level?: LogLevel;
  /** Log directory (default: './log') */
  dir?: string;
  /** Pretty console output in dev (default: auto-detected) */
  console?: boolean;
  /** app.log heartbeat interval in seconds — 0 to disable (default: 3600 = 1h) */
  heartbeat?: number;
  /** Action types to suppress entirely — even from debug.log */
  suppressTypes?: string[];
  /** Keep previous logs on restart — rotates to .1, .2, etc. (default: false — wipe on start) */
  backupLogs?: boolean;
  /** How many backup archives to keep when backupLogs is enabled (default: 7, 0 = unlimited) */
  backupKeep?: number;
};

type LogEntry = {
  ts: string;
  lvl: LogLevel | "perf";
  cat: string;
  msg: string;
  src?: string;
  data?: Record<string, unknown>;
  dur?: number;
};

const LEVELS: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// Pure framework internals — never logged anywhere
const SKIP_SUFFIXES = [":__FlowState", ":__exec", ":__flow"];
const SKIP_CONTAINS = [":__set"];

// Flow steps — debug.log only (not app.log)
const FLOW_STEP_RE = /:__flow:(?!done|failed|error)/;

// ── Public singleton ──────────────────────────────────────────────────

let _active: AioLogger | null = null;

/** Wire the framework logger instance into the public singleton */
export function setLogger(l: AioLogger | null): void {
  _active = l;
}

/** Get the active logger instance (null if not configured) */
export function getLogger(): AioLogger | null {
  return _active;
}

/** Public log API — falls back to console when AioLogger is not active.
 *  Supports both `log.info('cat', 'msg')` and `log.info('msg')` (defaults to 'aio' category). */
export interface Log {
  /** Log at trace level — `log.trace('msg')` or `log.trace('category', 'msg', data?)`. */
  trace(msg: string, data?: Record<string, unknown>): void;
  /** Log at trace level with explicit category. */
  trace(cat: string, msg: string, data?: Record<string, unknown>): void;
  /** Log at debug level — `log.debug('msg')` or `log.debug('category', 'msg', data?)`. */
  debug(msg: string, data?: Record<string, unknown>): void;
  /** Log at debug level with explicit category. */
  debug(cat: string, msg: string, data?: Record<string, unknown>): void;
  /** Log at info level — `log.info('msg')` or `log.info('category', 'msg', data?)`. */
  info(msg: string, data?: Record<string, unknown>): void;
  /** Log at info level with explicit category. */
  info(cat: string, msg: string, data?: Record<string, unknown>): void;
  /** Log at warn level — `log.warn('msg')` or `log.warn('category', 'msg', data?)`. */
  warn(msg: string, data?: Record<string, unknown>): void;
  /** Log at warn level with explicit category. */
  warn(cat: string, msg: string, data?: Record<string, unknown>): void;
  /** Log at error level — `log.error('msg')` or `log.error('category', 'msg', data?)`. */
  error(msg: string, data?: Record<string, unknown>): void;
  /** Log at error level with explicit category. */
  error(cat: string, msg: string, data?: Record<string, unknown>): void;
}

/** Resolve overloaded args: (msg) or (cat, msg) or (cat, msg, data) */
function resolveArgs(
  a: string,
  b?: string | Record<string, unknown>,
  c?: Record<string, unknown>,
): [string, string, Record<string, unknown> | undefined] {
  if (typeof b === "string") return [a, b, c];
  return ["aio", a, b as Record<string, unknown> | undefined];
}

function emit(
  lvl: LogLevel,
  a: string,
  b?: string | Record<string, unknown>,
  c?: Record<string, unknown>,
): void {
  const [cat, msg, data] = resolveArgs(a, b, c);
  if (_active) {
    _active.pub(lvl, cat, msg, data);
    return;
  }
  // Fallback: console mirrors app.log — info, warn + error only
  if (lvl === "info" || lvl === "warn" || lvl === "error") {
    printConsole({ ts: now(), lvl, cat, msg, ...(data ? { data } : {}) });
  }
}

/** Public log singleton — routes to AioLogger when active, console fallback otherwise */
export const log: Log = {
  trace(
    a: string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): void {
    emit("trace", a, b, c);
  },
  debug(
    a: string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): void {
    emit("debug", a, b, c);
  },
  info(
    a: string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): void {
    emit("info", a, b, c);
  },
  warn(
    a: string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): void {
    emit("warn", a, b, c);
  },
  error(
    a: string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): void {
    emit("error", a, b, c);
  },
};

export class AioLogger {
  private cfg: Required<LogConfig>;
  private dir: string;
  private appName: string;

  // Flow tracking
  private lastStatus = new Map<string, string>();
  private flowStarts = new Map<string, number>(); // "feature:flowName" → startMs

  // Aggregation counters
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
      if (this.cfg.backupLogs) await this.rotateOnStart();
      else await this.wipeOnStart();
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

  /** Wipe all log files — clean slate for new run (default behavior) */
  private async wipeOnStart(): Promise<void> {
    for (const kind of ["app", "debug", "error", "warning", "perf"] as const) {
      try {
        await Deno.remove(this.path(kind));
      } catch { /* absent — fine */ }
    }
  }

  /** Rotate existing logs to .1, .2, etc. — used with backupLogs: true */
  private async rotateOnStart(): Promise<void> {
    const keep = this.cfg.backupKeep;
    for (const kind of ["app", "debug", "error", "warning", "perf"] as const) {
      const base = this.path(kind);
      try {
        await Deno.stat(base);
      } catch {
        continue;
      }

      let n = 1;
      while (true) {
        try {
          await Deno.stat(`${base}.${n}`);
          n++;
        } catch {
          break;
        }
      }

      try {
        await Deno.rename(base, `${base}.${n}`);
      } catch { /* best-effort */ }

      if (keep > 0) {
        for (let i = n - keep; i >= 1; i--) {
          try {
            await Deno.remove(`${base}.${i}`);
          } catch { /* already gone */ }
        }
      }
    }
  }

  /** Called once after aio.run() completes boot */
  onStart(featureNames: string[], port?: number): void {
    for (const n of featureNames) this.lastStatus.set(n, "");
    this.emit("info", "app", "started", {
      features: featureNames.join(", "),
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

  // ── Main observer — wire into onAction hook ──────────────────────

  observe(
    action: { type: string; payload?: unknown },
    state: Record<string, unknown>,
  ): void {
    const type = action.type;
    const payload = (action.payload ?? {}) as Record<string, unknown>;

    this.stats.dispatched++;

    // Skip pure internals entirely
    if (SKIP_SUFFIXES.some((s) => type.endsWith(s))) return;
    if (SKIP_CONTAINS.some((s) => type.includes(s))) return;
    if (this.cfg.suppressTypes.includes(type)) return;

    const prefix = type.split(":")[0]?.toLowerCase() ?? "unknown";

    // ── Feature lifecycle ─────────────────────────────────────────
    if (type.endsWith(":__init")) {
      this.emit("info", `feature:${prefix}`, "ready");
      return;
    }
    if (type.endsWith(":__destroy")) {
      this.emit("info", `feature:${prefix}`, "stopped");
      return;
    }

    // ── Flow events ───────────────────────────────────────────────
    if (FLOW_STEP_RE.test(type)) {
      const flowName = payload._flow as string | undefined;
      if (flowName) {
        const key = `${prefix}:${flowName}`;
        if (!this.flowStarts.has(key)) this.flowStarts.set(key, Date.now());
      }
      this.emit(
        "debug",
        `flow:${prefix}`,
        stripFlowPrefix(type),
        filterInternal(payload),
      );
      return;
    }

    if (type.endsWith(":__flow:done")) {
      const flowName = payload._flow as string ?? "?";
      const key = `${prefix}:${flowName}`;
      const dur = elapsed(this.flowStarts.get(key));
      this.flowStarts.delete(key);
      this.emit(
        "info",
        `flow:${prefix}`,
        `${flowName} done`,
        filterInternal(payload),
        dur,
      );
      return;
    }

    if (type.endsWith(":__flow:failed")) {
      const flowName = payload._flow as string ?? "?";
      this.flowStarts.delete(`${prefix}:${flowName}`);
      this.stats.errors++;
      this.emit("error", `flow:${prefix}`, `${flowName} failed`, {
        reason: payload.reason ?? "unknown",
      });
      return;
    }

    if (type.endsWith(":__flow:error")) {
      this.stats.errors++;
      this.emit("error", `flow:${prefix}`, `${payload.flow ?? "?"} error`, {
        error: String(payload.error ?? "?"),
      });
      return;
    }

    // ── Async method error ────────────────────────────────────────
    if (type.endsWith(":__error")) {
      this.stats.errors++;
      this.emit(
        "error",
        `feature:${prefix}`,
        `${payload._method ?? "?"} failed`,
        { error: String(payload.error ?? "?") },
      );
      return;
    }

    // ── Everything else → debug.log only, then check machine state ─
    this.emit(
      "debug",
      `feature:${prefix}`,
      type.slice(prefix.length + 1),
      filterInternal(payload),
    );

    // Check machine state transitions (any action may cause a status change)
    this.checkTransitions(state);
  }

  // ── Public write API ──────────────────────────────────────────────

  pub(
    lvl: LogLevel,
    cat: string,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    const src = callerFile();
    this.emit(lvl, cat, msg, data ?? null, undefined, src);
  }

  /** Log a performance violation — all violations logged, no dedup */
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
    this.write(this.path("perf"), entry); // perf.log
    this.write(this.path("debug"), entry); // debug.log gets everything
    if (this.cfg.console) printConsole(entry);
  }

  /** Log a vital-signs measurement — render/transport/loop health */
  vitals(
    layer: "render" | "transport" | "loop",
    status: string,
    measured: number,
    threshold: number,
    hint?: { cause: string; suggestion: string; severity: string },
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
    this.write(this.path("perf"), entry);
    this.write(this.path("debug"), entry);
    if (this.cfg.console) printConsole(entry);
  }

  /** Log a vital-signs summary line */
  vitalsSummary(summary: string): void {
    const entry: LogEntry = {
      ts: now(),
      lvl: "info",
      cat: "vitals:summary",
      msg: summary,
    };
    this.write(this.path("app"), entry);
    this.write(this.path("debug"), entry);
    if (this.cfg.console) printConsole(entry);
  }

  // ── Private ───────────────────────────────────────────────────────

  private checkTransitions(state: Record<string, unknown>): void {
    for (const [name, last] of this.lastStatus) {
      const newStatus = (state[name] as Record<string, unknown> | undefined)
        ?.__aio_status as string | undefined;
      if (newStatus !== undefined && newStatus !== last) {
        this.lastStatus.set(name, newStatus);
        if (newStatus) this.emit("info", `feature:${name}`, newStatus);
      }
    }
  }

  private heartbeat(): void {
    const uptime = fmtUptime(Date.now() - this.stats.start);
    this.emit("info", "app", "heartbeat", {
      uptime,
      dispatched: this.stats.dispatched,
      errors: this.stats.errors,
    });
  }

  // ── Unified emit — routes entry to the right files ──────────────

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

    // debug.log gets EVERYTHING
    if (LEVELS[this.cfg.level] <= LEVELS[lvl]) {
      this.write(this.path("debug"), e);
    }

    // app.log: info, warn + error; console: same (AIO-233)
    if (lvl === "info" || lvl === "warn" || lvl === "error") {
      this.write(this.path("app"), e);
      if (this.cfg.console) printConsole(e);
    }

    // error.log: errors only
    if (lvl === "error") this.write(this.path("error"), e);

    // warning.log: warnings only
    if (lvl === "warn") this.write(this.path("warning"), e);
  }

  // ── Write ───────────────────────────────────────────────────────────

  private path(kind: "app" | "debug" | "error" | "warning" | "perf"): string {
    if (kind === "app") return `${this.dir}/app.log`;
    if (kind === "debug") return `${this.dir}/debug.log`;
    if (kind === "warning") return `${this.dir}/warning.log`;
    if (kind === "perf") return `${this.dir}/perf.log`;
    return `${this.dir}/error.log`;
  }

  private _writeErrors = 0;
  private write(path: string, entry: LogEntry): void {
    if (!this.ready) return;
    Deno.writeTextFile(path, formatText(entry) + "\n", { append: true }).catch(
      (e) => {
        if (this._writeErrors < 3) {
          this._writeErrors++;
          console.error(`[logger] write failed for ${path}: ${e}`);
        }
      },
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function callerFile(): string | undefined {
  const frames = new Error().stack?.split("\n") ?? [];
  for (const f of frames) {
    if (f.includes("logger.ts")) continue;
    const m = f.match(/[/\\]([\w.-]+\.ts):(\d+):\d+/);
    if (m) return `${m[1]}:${m[2]}`;
  }
}

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function elapsed(start?: number): number | undefined {
  return start !== undefined ? Date.now() - start : undefined;
}

function fmtUptime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function stripFlowPrefix(type: string): string {
  const m = type.match(/:__flow:(.+)$/);
  return m ? m[1] ?? type : type;
}

function filterInternal(
  p: Record<string, unknown>,
): Record<string, unknown> | null {
  const out = Object.fromEntries(
    Object.entries(p).filter(([k]) => !k.startsWith("_")),
  );
  return Object.keys(out).length ? out : null;
}

function isDevMode(): boolean {
  return import.meta.url.startsWith("file:///");
}

// ── Plain text formatter ──────────────────────────────────────────────

function formatText(e: LogEntry): string {
  const lvl = (typeof e.lvl === "string" ? e.lvl : "debug").toUpperCase()
    .padEnd(5);
  const cat = e.cat.padEnd(10);
  const data = e.data
    ? "  " +
      Object.entries(e.data).map(([k, v]) =>
        `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`
      ).join(" ")
    : "";
  const dur = e.dur !== undefined ? `  ${e.dur}ms` : "";
  const src = e.src ? `  (${e.src})` : "";
  return `${e.ts}  ${lvl}  ${cat}  ${e.msg}${data}${dur}${src}`;
}

// ── Console pretty-printer (ANSI colors) ──────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  lime: "\x1b[92m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  lightGray: "\x1b[37m",
  magenta: "\x1b[35m",
  white: "\x1b[97m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
} as const;

const LEVEL_COLOR: Record<string, string> = {
  trace: C.gray,
  debug: C.cyan,
  info: C.lime,
  warn: C.yellow,
  error: C.red,
  perf: C.magenta,
};

// Keyword colorization for console output
const KEYWORD_COLORS: [RegExp, string][] = [
  [/\bstarted\b/i, C.green],
  [/\bready\b/i, C.green],
  [/\bdone\b/i, C.green],
  [/\brecovered\b/i, C.green],
  [/\bstopped\b/i, C.yellow],
  [/\bfailed\b/i, C.red],
  [/\berror\b/i, C.red],
  [/\btimeout\b/i, C.red],
  [/\bexceeded\b/i, C.magenta],
  [/\bheartbeat\b/i, C.cyan],
];

function colorizeMsg(msg: string, lvl: string): string {
  // Error messages: entire message in red+bold
  if (lvl === "error") return `${C.red}${C.bold}${msg}${C.reset}`;
  // Apply keyword highlighting
  let out = msg;
  for (const [re, color] of KEYWORD_COLORS) {
    out = out.replace(re, (m) => `${color}${m}${C.reset}`);
  }
  return out;
}

function printConsole(e: LogEntry): void {
  const lvlStr = (typeof e.lvl === "string" ? e.lvl : "debug").toUpperCase()
    .padEnd(5);
  const color = LEVEL_COLOR[e.lvl] ?? C.gray;
  const ts = `${C.lightGray}${e.ts}${C.reset}`;
  const lvl = `${color}${C.bold}${lvlStr}${C.reset}`;
  const cat = `${C.white}${e.cat.padEnd(10)}${C.reset}`;
  const msg = colorizeMsg(e.msg, e.lvl);
  const data = e.data
    ? "  " +
      Object.entries(e.data).map(([k, v]) =>
        `${C.dim}${k}${C.reset}=${C.cyan}${
          typeof v === "object" ? JSON.stringify(v) : v
        }${C.reset}`
      ).join(" ")
    : "";
  const dur = e.dur !== undefined ? `  ${C.magenta}${e.dur}ms${C.reset}` : "";
  console.log(`${ts}  ${lvl}  ${cat}  ${msg}${data}${dur}`);
}
