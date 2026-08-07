// amui manager — the aio UI manager's brain. Runs SERVER-side; the browser only
// gets synced state + a dispatch surface. Every node/Deno-only import is pulled
// via a DYNAMIC import inside a method (the graph-validator escape hatch, keeps
// it out of the browser bundle). Discovery, per-app detail (trojan API), live
// CPU/memory sampling, task running, and safe file access all live here.
import { cell } from "aio";
import type { DiscoveredProject, ProjectMeta } from "./server/scan.ts";
import type { FileNode, LogSource, RuntimeInfo } from "./server/proc.ts";

export type {
  DiscoveredProject,
  FileNode,
  LogSource,
  ProjectMeta,
  RuntimeInfo,
};

/** cell id → state key → whether the field is persisted / exposed to the UI
 *  (trojan `fields` route). Powers the merged State overview. */
export type CellFieldFlags = Record<
  string,
  Record<string, { persisted: boolean; ui: boolean }>
>;

// ── diagnostic payloads (mined from a running app's health/vitals/trojan) ─────

/** `/__aio/health` — cell health + the framework version. */
export interface AppHealth {
  status: string;
  version: string | null; // the aio framework version the app runs
  cells: Record<
    string,
    { status: string; enabled: boolean; errors: number; lastAction?: string }
  >;
}

/** `/__aio/vitals` → server.loop — the dispatch/event-loop pulse. */
export interface LoopVitals {
  queueDepth: number;
  drainRate: number; // actions/sec
  lastReduceTime: number; // ms
  lastReduceAction: string | null;
  lastReduceCell: string | null;
  p95ReduceTime: number; // ms
  effectBacklog: number;
  circuitBreakers: string[]; // tripped (auto-disabled) cells
}

export interface Gauge {
  name: string;
  current: number;
  capacity: number;
  percent: number;
}

/** The full `/__aio/vitals` payload (normalized). */
export interface AppVitals {
  loop: LoopVitals;
  clients: { id: string; status: string; frozenFor?: number }[];
  payloadStats: Record<
    string,
    {
      lastPayloadBytes: number;
      totalBytes: number;
      count: number;
      bytesPerSec: number;
    }
  >;
  cellSizes: Record<string, number>; // bytes of each cell's JSON state
  gauges: Record<string, Gauge>;
  clientBackpressure: Record<string, number>;
}

/** A connected client (`/__aio/trojan/clients`, WS + electron UDS). */
export interface ClientRow {
  index: number;
  id: string;
  type: string;
  transport: string;
  user?: string;
  readyState?: number;
}

/** One time-travel entry (`/__aio/trojan/history`) — a processed action. */
export interface ActionEntry {
  id: number;
  type: string;
  ts: number;
  perf?: { reduce?: number; effects?: number };
  error?: { code: string; message: string };
}

/** Process memory, from the app's own `/__aio/metrics` (Prometheus). */
export interface MemInfo {
  rss: number; // bytes
  heapUsed: number;
  heapTotal: number;
}

/** One parsed log line. `ts` null = a line that didn't match the log grammar
 *  (raw stdout / stack trace) — shown verbatim. */
export interface LogLine {
  ts: string | null;
  level: string; // "" for raw lines
  scope: string;
  msg: string;
  raw: string;
}

/** The diagnostic bundle fetched for a running app (select + tick). */
interface Diag {
  health: AppHealth | null;
  vitals: AppVitals | null;
  clients: ClientRow[] | null;
  history: ActionEntry[] | null;
  mem: MemInfo | null;
  /** Why the app's control plane refused us, when it did. amui reads a running
   *  app through `/__aio/trojan/*`, and every panel here degrades to null on
   *  failure — which turned an auth refusal into a screen of empty boxes with
   *  no cause. The refusal carries its own diagnosis (see `am-http.ts`); carry
   *  it to the UI instead of dropping it. */
  controlError: string | null;
}

const HIST = 60; // rolling metric samples kept for the charts
const HISTORY_MAX = 60; // recent action entries kept

/** The first CREDENTIAL refusal among some control-plane reads, or null.
 *  Only auth-shaped failures: "app not running" is already visible elsewhere,
 *  and repeating it as an error banner would be noise. */
export function refusalOf(
  results: { ok: boolean; error?: string }[],
): string | null {
  for (const r of results) {
    if (r.ok || !r.error) continue;
    if (/unauthor|forbidden|credential|admin/i.test(r.error)) return r.error;
  }
  return null;
}

/** Parse a Result<string> JSON body, tolerating errors → null. */
function jsonOf<T>(r: { ok: boolean; data?: unknown }): T | null {
  if (!r.ok || typeof r.data !== "string") return null;
  try {
    return JSON.parse(r.data) as T;
  } catch {
    return null;
  }
}

/** Pull rss/heap from the app's Prometheus text (`aio_memory_*_bytes`). */
export function parsePromMem(text: string): MemInfo | null {
  const num = (metric: string): number | null => {
    const m = new RegExp(`^${metric}\\s+([0-9.eE+-]+)`, "m").exec(text);
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  const rss = num("aio_memory_rss_bytes");
  const heapUsed = num("aio_memory_heap_used_bytes");
  const heapTotal = num("aio_memory_heap_total_bytes");
  if (rss === null && heapUsed === null) return null;
  return { rss: rss ?? 0, heapUsed: heapUsed ?? 0, heapTotal: heapTotal ?? 0 };
}

const LOG_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s{2}(TRACE|DEBUG|INFO|WARN|ERROR|PERF)\s+(\S+)\s{2}(.*)$/;
const CLIENT_LOG_RE = /^\[([^\]]+)\]\s\[(\w+)\s*\]\s\[client:(\d+)\]\s(.*)$/;

/** Parse one (ANSI-stripped) log line into {ts, level, scope, msg}. Non-matching
 *  lines (raw stdout, stack traces, repeat-summaries) pass through as raw. */
export function parseLogLine(raw: string): LogLine {
  const m = LOG_RE.exec(raw);
  if (m) {
    return {
      ts: m[1]!,
      level: m[2]!.toLowerCase(),
      scope: m[3]!,
      msg: m[4]!,
      raw,
    };
  }
  const c = CLIENT_LOG_RE.exec(raw);
  if (c) {
    return {
      ts: c[1]!,
      level: c[2]!.toLowerCase(),
      scope: `client:${c[3]}`,
      msg: c[4]!,
      raw,
    };
  }
  return { ts: null, level: "", scope: "", msg: raw, raw };
}

/** The raw `/__aio/vitals` shape — the loop nests under `server.loop`. */
interface RawVitals {
  server?: { loop?: LoopVitals };
  clients?: AppVitals["clients"];
  payloadStats?: AppVitals["payloadStats"];
  cellSizes?: AppVitals["cellSizes"];
  gauges?: AppVitals["gauges"];
  clientBackpressure?: AppVitals["clientBackpressure"];
}

/** Flatten the raw vitals to our normalized shape (loop hoisted to top level).
 *  Null unless a loop is present. Every loop field is coerced to its declared
 *  type — a foreign/older aio version can send a present-but-partial loop, and
 *  amui monitors arbitrary apps, so readers (`loop.drainRate.toFixed(…)`, the
 *  reduce/queue history samples) must never meet an `undefined`. */
function normalizeVitals(v: RawVitals | null): AppVitals | null {
  const raw = v?.server?.loop;
  if (!raw) return null;
  const num = (x: unknown): number =>
    (typeof x === "number" && isFinite(x)) ? x : 0;
  return {
    loop: {
      queueDepth: num(raw.queueDepth),
      drainRate: num(raw.drainRate),
      lastReduceTime: num(raw.lastReduceTime),
      lastReduceAction: raw.lastReduceAction ?? null,
      lastReduceCell: raw.lastReduceCell ?? null,
      p95ReduceTime: num(raw.p95ReduceTime),
      effectBacklog: num(raw.effectBacklog),
      circuitBreakers: Array.isArray(raw.circuitBreakers)
        ? raw.circuitBreakers
        : [],
    },
    clients: Array.isArray(v!.clients) ? v!.clients : [],
    payloadStats: v!.payloadStats ?? {},
    cellSizes: v!.cellSizes ?? {},
    gauges: v!.gauges ?? {},
    clientBackpressure: v!.clientBackpressure ?? {},
  };
}

/** Fetch the diagnostic bundle for a running app. All fetches are Result-typed
 *  + timeout-bounded; each degrades to null independently. */
async function fetchDiag(
  port: number,
  appId: string,
): Promise<Diag> {
  const { trojanGet, httpGet } = await import("../../src/am/am-http.ts");
  const [healthR, vitalsR, clientsR, historyR, promR] = await Promise.all([
    httpGet(port, "/__aio/health", appId),
    httpGet(port, "/__aio/vitals", appId),
    trojanGet(port, "clients", appId),
    trojanGet(port, "history", appId),
    httpGet(port, "/__aio/metrics", appId),
  ]);
  // Total reads — a foreign/older app may answer `history` with JSON `null` or
  // a non-object, and `clients` with a non-array; never deref blindly.
  const histData = historyR.ok ? historyR.data : null;
  const entries = histData && typeof histData === "object" &&
      Array.isArray((histData as { entries?: unknown }).entries)
    ? (histData as { entries: ActionEntry[] }).entries
    : null;
  const clients = clientsR.ok && Array.isArray(clientsR.data)
    ? (clientsR.data as ClientRow[])
    : null;
  return {
    health: jsonOf<AppHealth>(healthR),
    vitals: normalizeVitals(jsonOf<RawVitals>(vitalsR)),
    clients,
    history: entries ? entries.slice(-HISTORY_MAX) : null,
    mem: promR.ok ? parsePromMem(promR.data as string) : null,
    controlError: refusalOf([clientsR, historyR]),
  };
}

export interface ProjectDetail {
  path: string;
  name: string;
  running: boolean;
  appId: string | null;
  pid: number | null;
  port: number | null;
  status: string | null;
  /** dev | prod | null (from the running app's config). */
  build: "dev" | "prod" | null;
  meta: ProjectMeta;
  git: boolean;
  /** true when this IS amui — monitor freely, never manage. */
  self: boolean;
  config:
    | { title?: string; authMode?: string; port?: number; prod?: boolean }
    | null;
  /** cell id → method names (trojan `cells`). */
  cells: Record<string, string[]> | null;
  cpuPct: number | null;
  memMb: number | null;
  uptimeSec: number | null;
  connections: number | null;
  errors: unknown[] | null;
  schedules: string[] | null;
  at: string;
}

/** Plain deep snapshot — reads THROUGH live proxy state. Assigning an object
 *  that still references live cell-state proxies back into state throws deep in
 *  the async batcher ('preventExtensions on proxy'); every value we compose
 *  from `s.*` and store back must be snapshotted first. JSON round-trip works
 *  where structuredClone (can't clone a proxy) does not; all our data is
 *  JSON-safe (trojan JSON + plain construction, no Dates/functions/Maps). */
const plain = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));

const detailOf = (p: DiscoveredProject): ProjectDetail => ({
  path: p.path,
  name: p.name,
  running: !!p.running,
  appId: p.running?.appId ?? null,
  pid: p.running?.pid ?? null,
  port: p.running?.port ?? null,
  status: p.running?.status ?? null,
  build: null,
  meta: plain(p.meta),
  git: p.git,
  self: !!p.self,
  config: null,
  cells: null,
  cpuPct: null,
  memMb: null,
  uptimeSec: null,
  connections: null,
  errors: null,
  schedules: null,
  at: new Date().toISOString(),
});

/** Pure: fold a fresh scan result's running-state into an existing detail.
 *  Returns the same reference when nothing changed (cheap identity check for
 *  callers). Metrics are cleared on the way down so a stopped app can't keep
 *  displaying its last CPU/mem reading. */
export function reconcileDetail(
  detail: ProjectDetail,
  fresh: DiscoveredProject,
): ProjectDetail {
  const up = !!fresh.running;
  const appId = fresh.running?.appId ?? null;
  const pid = fresh.running?.pid ?? null;
  const port = fresh.running?.port ?? null;
  const status = fresh.running?.status ?? null;
  // Fold when the running flag OR the process identity changed — an app
  // restarted in place (new pid/port, still running) must not leave tick()
  // polling the dead port.
  const same = up === detail.running && appId === detail.appId &&
    pid === detail.pid && port === detail.port && status === detail.status;
  if (same) return detail;
  // A new pid means a fresh process — its old metrics are meaningless.
  const sameProc = up && pid === detail.pid;
  // Down → the whole live snapshot (config/cells/build/errors/schedules) came
  // from the trojan of a now-dead process; drop it so Overview can't show the
  // config of an app that is no longer running.
  const live = up ? {} : {
    config: null,
    cells: null,
    build: null,
    errors: null,
    schedules: null,
  };
  return {
    ...detail,
    running: up,
    appId,
    pid,
    port,
    status,
    cpuPct: sameProc ? detail.cpuPct : null,
    memMb: sameProc ? detail.memMb : null,
    uptimeSec: sameProc ? detail.uptimeSec : null,
    connections: sameProc ? detail.connections : null,
    ...live,
  };
}

/** The subset of manager state the scan writes into — lets start/restart/create
 *  reuse the exact discover reconciliation without duplicating it. */
interface ScanTarget {
  projects: DiscoveredProject[];
  scanRoots: string[];
  lastScan: string | null;
  selectedPath: string | null;
  detail: ProjectDetail | null;
  cpuHistory: number[];
  memHistory: number[];
  // The live-diagnostics bundle — cleared with the histories when the app goes
  // down or its process identity changes (see clearLiveDiagnostics).
  heapHistory: number[];
  reduceHistory: number[];
  queueHistory: number[];
  health: unknown;
  vitals: unknown;
  clients: unknown;
  history: unknown;
  mem: unknown;
  aioVersion: string | null;
}

/** Drop every reading that belongs to a specific PROCESS.
 *
 *  These come from the trojan/vitals probes of one running app. When that
 *  process dies — or is replaced by a restart with a new pid — they describe
 *  something that no longer exists. `tick()` cannot clear them (it returns
 *  early once the app is not running), so whoever observes the transition must.
 *  Shared by the manual stop() and the discover path, which is where an
 *  EXTERNAL death (Ctrl-C, crash, OOM) is noticed: without it, Overview kept
 *  painting every cell of a dead process green, permanently. */
function clearLiveDiagnostics(s: ScanTarget): void {
  s.cpuHistory = [];
  s.memHistory = [];
  s.heapHistory = [];
  s.reduceHistory = [];
  s.queueHistory = [];
  s.health = null;
  s.vitals = null;
  s.clients = null;
  s.history = null;
  s.mem = null;
  s.aioVersion = null;
}

/** Fold a fresh scan into state: replace the list + reconcile the selection
 *  (drop it if it vanished; patch its running-state if it changed). */
function applyScan(
  s: ScanTarget,
  found: DiscoveredProject[],
  roots: string[],
): void {
  s.projects = found;
  s.scanRoots = roots;
  s.lastScan = new Date().toISOString();
  const sel = s.selectedPath
    ? found.find((p) => p.path === s.selectedPath)
    : undefined;
  if (s.selectedPath && !sel) {
    s.selectedPath = null;
    s.detail = null;
  } else if (sel && s.detail) {
    // Decide from the PROXY (reads only) whether anything changed, so an
    // unchanged app doesn't reassign s.detail every 9s (needless re-render).
    const d = s.detail;
    const up = !!sel.running;
    const changed = up !== d.running ||
      (sel.running?.appId ?? null) !== d.appId ||
      (sel.running?.pid ?? null) !== d.pid ||
      (sel.running?.port ?? null) !== d.port ||
      (sel.running?.status ?? null) !== d.status;
    if (changed) {
      s.detail = reconcileDetail(plain(d), plain(sel));
      // Running-state or process identity changed → every per-process reading
      // (charts AND the health/vitals/clients/history/mem bundle) belongs to a
      // process that is gone. Clear them all, then re-seed the two charts we
      // already have a fresh sample for.
      clearLiveDiagnostics(s);
      if (s.detail.running && s.detail.cpuPct !== null) {
        s.cpuHistory = [s.detail.cpuPct];
      }
      if (s.detail.running && s.detail.memMb !== null) {
        s.memHistory = [s.detail.memMb];
      }
    }
  }
}

/** Scan the disk + registry and fold the result into state (shared by discover
 *  and the post-action refreshes). Throws only if the scan import fails. */
async function rescanInto(s: ScanTarget): Promise<void> {
  const { discoverProjects } = await import("./server/scan.ts");
  const { projects, roots } = await discoverProjects();
  applyScan(s, projects, roots);
}

/** amui must never start/stop/restart ITSELF: starting spawns a second manager,
 *  stopping kills the one you are looking at. The UI hides those actions on the
 *  self entry; this is the enforcement (methods are also reachable by dispatch
 *  — `am` and the trojan route — so the UI alone is not a guard). Returns a
 *  refusal message, or null when the path is some other app. */
async function refuseSelf(path: string): Promise<string | null> {
  const { selfPaths } = await import("./server/scan.ts");
  return (await selfPaths()).has(path)
    ? "that's amui itself — manage it from the shell that launched it"
    : null;
}

export const manager = cell("manager", {
  // Live dashboard — nothing here is worth persisting, and foreign app states
  // can be large; persisting them would bloat amui's DB and slow every write.
  persist: "none",
  // alpha52: transaction became the async default. This cell is the
  // incremental-commit shape on purpose — a 1s tick RMW-ing rolling histories
  // CONCURRENTLY with user-triggered loads, and a dozen `s.xLoading = true`
  // spinner writes that must publish before their awaits. Pinned rather than
  // sprinkled with $commit.
  transaction: false,
  // cancelTask aborts an in-flight runTask (the method sees it via s.$signal).
  cancelOn: { runTask: [{ type: "manager:cancelTask" }] },
  state: {
    projects: [] as DiscoveredProject[],
    selectedPath: null as string | null,
    detail: null as ProjectDetail | null,
    detailLoading: false,
    scanning: false,
    lastScan: null as string | null,
    scanRoots: [] as string[],
    // charts (rolling, cap HIST)
    cpuHistory: [] as number[],
    memHistory: [] as number[], // process RSS, MB
    heapHistory: [] as number[], // V8 heap used, MB
    reduceHistory: [] as number[], // p95 reducer time, ms
    queueHistory: [] as number[], // dispatch queue depth
    // diagnostics for the selected running app (health/vitals/clients/history/
    // memory) — loaded on select, refreshed on tick; the monitoring goldmine
    health: null as AppHealth | null,
    vitals: null as AppVitals | null,
    clients: null as ClientRow[] | null,
    history: null as ActionEntry[] | null,
    mem: null as MemInfo | null,
    aioVersion: null as string | null, // framework version the app runs
    /** Set when the running app refused amui's control-plane reads — shown
     *  instead of leaving every panel mysteriously empty. */
    controlError: null as string | null,
    // logs (tailed from the app's ~/.<appId>/logs — no streaming endpoint)
    logs: null as LogLine[] | null,
    logPath: null as string | null,
    logSource: "combined" as LogSource,
    logFollow: false,
    logLoading: false,
    logError: null as string | null,
    logTruncated: false,
    // live state (trojan `state`) — loaded LAZILY for the State tab only, never
    // pulled on select (a 350KB foreign state on every click floods sync/render)
    detailState: null as unknown,
    detailFields: null as CellFieldFlags | null,
    detailStatePath: null as string | null,
    detailStateSize: 0,
    detailStateTruncated: false,
    detailStateLoading: false,
    detailStateError: null as string | null,
    // task runner
    taskRunning: null as string | null,
    taskOutput: "" as string,
    taskCode: null as number | null,
    // file viewer — App Files (the RUNTIME tree) + the enclosing repo (Codebase)
    fileTree: null as FileNode[] | null,
    fileTreeTruncated: false,
    runtime: null as RuntimeInfo | null, // what's actually running (App Files)
    repoRoot: null as string | null, // git repo containing the app (or null)
    codebaseTree: null as FileNode[] | null, // lazy — loaded on Codebase tab
    codebaseTruncated: false,
    codebaseLoading: false,
    openFilePath: null as string | null,
    openFileBase: null as string | null, // dir openFilePath is relative to
    fileContent: null as string | null,
    fileNotice: null as string | null,
    fileTruncated: false,
    openFileHint: null as string | null, // e.g. "cell X defined at line N"
    // feedback
    createBusy: false,
    createMsg: null as string | null,
    actionMsg: null as string | null,
    dispatchMsg: null as string | null,
  },

  methods: {
    /** Discover every aio project on this machine (running + on-disk). */
    async discover(s) {
      s.scanning = true;
      try {
        await rescanInto(s);
      } catch (e) {
        s.actionMsg = `discover failed: ${e instanceof Error ? e.message : e}`;
      }
      s.scanning = false;
    },

    /** Select a project and load its detail (trojan if running + files). The
     *  heavy live `state` is NOT fetched here — it loads lazily for the State
     *  tab (see loadState). Gives INSTANT feedback: the skeleton + spinner land
     *  synchronously, real data merges when the (timeout-bounded) fetches return. */
    async select(s, path: string) {
      const proj = s.projects.find((p) => p.path === path);
      if (!proj) return;

      // ── instant feedback (committed before any await) ──
      s.selectedPath = path;
      s.detail = detailOf(proj);
      s.detailLoading = true;
      s.fileTree = null;
      s.runtime = null;
      s.repoRoot = null;
      s.codebaseTree = null;
      s.codebaseTruncated = false;
      s.openFilePath = null;
      s.openFileBase = null;
      s.fileContent = null;
      s.fileNotice = null;
      s.fileTruncated = false;
      s.openFileHint = null;
      s.dispatchMsg = null;
      s.detailState = null;
      s.detailFields = null;
      s.detailStatePath = null;
      s.detailStateError = null;
      s.cpuHistory = [];
      s.memHistory = [];
      s.heapHistory = [];
      s.reduceHistory = [];
      s.queueHistory = [];
      s.health = null;
      s.vitals = null;
      s.clients = null;
      s.history = null;
      s.mem = null;
      s.aioVersion = null;
      s.logs = null;
      s.logPath = null;
      s.logError = null;
      s.logFollow = false;

      // ── gather (all fetches are Result-typed + 5s-timeout bounded) ──
      // Snapshot `running` BEFORE any await: `proj` is a live draft proxy and a
      // concurrent discover() can reassign s.projects mid-await, revoking it.
      const base = detailOf(proj);
      const running = proj.running
        ? { ...(proj.running as NonNullable<DiscoveredProject["running"]>) }
        : null;
      const { listFiles, findRepoRoot, runtimeInfo } = await import(
        "./server/proc.ts"
      );
      // App Files = the RUNTIME tree. For a running app, inspect its process
      // (dev → source dir, AppImage → the unpacked mount, binary → its dir);
      // stopped apps fall back to the project source (the dev-runtime).
      let runtime: RuntimeInfo = {
        kind: running ? "unknown" : "dev",
        root: path,
        exe: null,
        label: running ? "runtime" : "not running — project source",
      };
      if (running) {
        try {
          runtime = await runtimeInfo(running.pid, path);
        } catch { /* /proc unavailable — keep fallback */ }
      }
      let files: FileNode[] = [];
      let filesTruncated = false;
      let repoRoot: string | null = null;
      try {
        const r = await listFiles(runtime.root);
        files = r.nodes;
        filesTruncated = r.truncated;
        repoRoot = await findRepoRoot(path);
      } catch { /* unreadable */ }

      let diag: Diag = {
        health: null,
        vitals: null,
        clients: null,
        history: null,
        mem: null,
        controlError: null,
      };
      if (running) {
        const { appId, port, pid } = running;
        const { trojanGet } = await import("../../src/am/am-http.ts");
        const { psStats } = await import("./server/proc.ts");
        const [config, metrics, cells, errors, schedules, ps, d] = await Promise
          .all([
            trojanGet(port, "config", appId),
            trojanGet(port, "metrics", appId),
            trojanGet(port, "cells", appId),
            trojanGet(port, "errors", appId),
            trojanGet(port, "schedules", appId),
            psStats(pid),
            fetchDiag(port, appId),
          ]);
        diag = d;
        diag.controlError ??= refusalOf([config, metrics, cells, errors]);
        base.config = config.ok
          ? (config.data as ProjectDetail["config"])
          : null;
        base.build = config.ok
          ? ((config.data as { prod?: boolean }).prod ? "prod" : "dev")
          : null;
        base.cells = cells.ok ? (cells.data as Record<string, string[]>) : null;
        base.uptimeSec = metrics.ok
          ? (metrics.data as { uptime: number }).uptime
          : null;
        base.connections = metrics.ok
          ? (metrics.data as { connections: number }).connections
          : null;
        base.errors = errors.ok
          ? ((errors.data as { errors?: unknown[] }).errors ?? [])
          : null;
        base.schedules = schedules.ok ? (schedules.data as string[]) : null;
        base.cpuPct = ps?.cpuPct ?? null;
        base.memMb = ps?.memMb ?? null;
      }

      // Supersede guard: if the user clicked another project mid-fetch, drop
      // this result rather than overwriting the newer selection.
      if (s.selectedPath !== path) return;
      s.detail = base;
      s.detailLoading = false;
      s.fileTree = files;
      s.fileTreeTruncated = filesTruncated;
      s.runtime = runtime;
      s.repoRoot = repoRoot;
      s.health = diag.health;
      s.vitals = diag.vitals;
      s.clients = diag.clients;
      s.history = diag.history;
      s.mem = diag.mem;
      s.controlError = diag.controlError;
      s.aioVersion = diag.health?.version ?? null;
      const heapMb0 = diag.mem
        ? Math.round(diag.mem.heapUsed / 1_048_576)
        : null;
      s.cpuHistory = base.cpuPct !== null ? [base.cpuPct] : [];
      s.memHistory = base.memMb !== null ? [base.memMb] : [];
      s.heapHistory = heapMb0 !== null ? [heapMb0] : [];
      s.reduceHistory = diag.vitals ? [diag.vitals.loop.p95ReduceTime] : [];
      s.queueHistory = diag.vitals ? [diag.vitals.loop.queueDepth] : [];
    },

    /** Load the enclosing repo's full file tree for the Codebase tab (lazy —
     *  the app dir's tree is already loaded by select). */
    async loadCodebase(s, path: string) {
      const proj = s.projects.find((p) => p.path === path);
      if (!proj || s.repoRoot === null) return;
      const root = s.repoRoot;
      s.codebaseLoading = true;
      const { listFiles } = await import("./server/proc.ts");
      let nodes: FileNode[] = [];
      let truncated = false;
      try {
        const r = await listFiles(root);
        nodes = r.nodes;
        truncated = r.truncated;
      } catch { /* unreadable */ }
      // Superseded by a newer selection → drop this result without touching the
      // spinner (a newer loadCodebase owns it now).
      if (s.selectedPath !== path) return;
      s.codebaseLoading = false;
      s.codebaseTree = nodes;
      s.codebaseTruncated = truncated;
    },

    /** Load the selected running app's live state for the State tab (lazy +
     *  size-capped). Never auto-polled: the monitored app's state may churn
     *  constantly, so amui pulls it on demand only. */
    async loadState(s, path: string) {
      const proj = s.projects.find((p) => p.path === path);
      if (!proj?.running) {
        s.detailState = null;
        s.detailFields = null;
        s.detailStatePath = path;
        s.detailStateError = "app not running";
        return;
      }
      s.detailStateLoading = true;
      s.detailStateError = null;
      const { appId, port } = proj.running;
      const { trojanGet } = await import("../../src/am/am-http.ts");
      // Full merged state (every cell) + per-field persist/ui flags in parallel.
      const [r, f] = await Promise.all([
        trojanGet(port, "state", appId),
        trojanGet(port, "fields", appId),
      ]);
      // Supersede guard.
      if (s.selectedPath !== path) {
        s.detailStateLoading = false;
        return;
      }
      s.detailStateLoading = false;
      s.detailStatePath = path;
      s.detailFields = f.ok ? (f.data as CellFieldFlags) : null;
      if (!r.ok) {
        s.detailState = null;
        s.detailStateError = r.error ?? "failed to load state";
        s.detailStateSize = 0;
        s.detailStateTruncated = false;
        return;
      }
      // Size guard — a multi-MB state would freeze the tree render; refuse it
      // with a clear message instead of hanging the UI.
      const size = JSON.stringify(r.data ?? null).length;
      const STATE_MAX = 2_000_000;
      if (size > STATE_MAX) {
        s.detailState = null;
        s.detailStateTruncated = true;
        s.detailStateSize = size;
        s.detailStateError = null;
      } else {
        s.detailState = r.data;
        s.detailStateTruncated = false;
        s.detailStateSize = size;
        s.detailStateError = null;
      }
    },

    /** Tail the selected app's logs for the Logs tab. `cwd` is the project path
     *  (== the app's working dir). Re-reads on demand + on the follow poll. No
     *  streaming endpoint exists, so this is a file tail (last ~500 lines). */
    async loadLogs(s, path: string, source?: LogSource) {
      const proj = s.projects.find((p) => p.path === path);
      if (!proj) return;
      const src = (source ?? s.logSource) as LogSource;
      s.logSource = src;
      s.logLoading = true;
      s.logError = null;
      try {
        const { readLogs } = await import("./server/proc.ts");
        // appId unlocks the app's own `~/.<appId>/logs/` (alpha38 layout).
        const r = await readLogs(path, src, 500, proj.running?.appId ?? null);
        if (s.selectedPath !== path) return;
        s.logPath = r.path;
        s.logTruncated = r.truncated;
        s.logs = r.missing ? [] : r.lines.map(parseLogLine);
        s.logError = r.missing
          ? `no ${src} log found (app may not have written one yet)`
          : null;
      } catch (e) {
        if (s.selectedPath === path) {
          s.logError = `failed to read logs: ${
            e instanceof Error ? e.message : String(e)
          }`;
        }
      } finally {
        // Always clear — a stuck logLoading would disable the reload button,
        // the follow poll, AND the lazy-load render guard (tab wedged).
        s.logLoading = false;
      }
    },

    /** Toggle the Logs tab live-follow poll (the UI interval reads this flag). */
    setLogFollow(s, on: boolean) {
      s.logFollow = !!on;
    },

    /** Lightweight live poll for the SELECTED running app — feeds the charts +
     *  live fields without re-fetching everything (called on an interval). */
    async tick(s) {
      const before = s.detail;
      if (
        !before || !before.running || before.pid === null ||
        before.port === null
      ) return;
      const { pid, port, path } = before;
      const appId = before.appId!;
      // Snapshot the histories to PLAIN arrays. The async method's `s` exposes
      // array state as a proxy whose spread iterator throws ("not iterable")
      // even though Array.isArray() passes; plain() (JSON round-trip) reads it
      // via index access instead. Same proxy hazard as detail — see plain().
      const snap = (v: unknown): number[] => Array.isArray(v) ? plain(v) : [];
      const cpuHist = snap(s.cpuHistory);
      const memHist = snap(s.memHistory);
      const heapHist = snap(s.heapHistory);
      const reduceHist = snap(s.reduceHistory);
      const queueHist = snap(s.queueHistory);
      const { trojanGet } = await import("../../src/am/am-http.ts");
      const { psStats } = await import("./server/proc.ts");
      const [metrics, ps, diag] = await Promise.all([
        trojanGet(port, "metrics", appId),
        psStats(pid),
        fetchDiag(port, appId),
      ]);
      // Re-read AFTER the awaits — a stop()/select() may have superseded us
      // during the (up to a few second) trojan/ps round-trip. Drop this sample
      // rather than resurrecting the stale snapshot.
      const d = plain(s.detail);
      if (!d || d.path !== path || !d.running) return;
      const cpu = ps?.cpuPct ?? d.cpuPct ?? 0;
      const mem = ps?.memMb ?? d.memMb ?? 0;
      const heapMb = diag.mem
        ? Math.round(diag.mem.heapUsed / 1_048_576)
        : null;
      s.cpuHistory = [...cpuHist, cpu].slice(-HIST);
      s.memHistory = [...memHist, mem].slice(-HIST);
      if (heapMb !== null) s.heapHistory = [...heapHist, heapMb].slice(-HIST);
      if (diag.vitals) {
        s.reduceHistory = [...reduceHist, diag.vitals.loop.p95ReduceTime]
          .slice(-HIST);
        s.queueHistory = [...queueHist, diag.vitals.loop.queueDepth].slice(
          -HIST,
        );
      }
      // Diagnostics degrade independently: keep the last good bundle if a probe
      // momentarily fails, so the panels don't flicker to empty.
      if (diag.health) s.health = diag.health;
      if (diag.vitals) s.vitals = diag.vitals;
      if (diag.clients) s.clients = diag.clients;
      if (diag.history) s.history = diag.history;
      if (diag.mem) s.mem = diag.mem;
      s.controlError = diag.controlError;
      if (diag.health?.version) s.aioVersion = diag.health.version;
      s.detail = {
        ...d,
        cpuPct: ps?.cpuPct ?? d.cpuPct,
        memMb: ps?.memMb ?? d.memMb,
        uptimeSec: metrics.ok
          ? (metrics.data as { uptime: number }).uptime
          : d.uptimeSec,
        connections: metrics.ok
          ? (metrics.data as { connections: number }).connections
          : d.connections,
        at: new Date().toISOString(),
      };
    },

    /** Run a method on a running app (trojan dispatch — the "run method" button). */
    async dispatch(s, path: string, type: string, payloadJson: string) {
      const proj = s.projects.find((p) => p.path === path);
      if (!proj?.running) return;
      let payload: unknown;
      const trimmed = (payloadJson ?? "").trim();
      if (trimmed) {
        try {
          payload = JSON.parse(trimmed);
        } catch {
          s.dispatchMsg = "payload is not valid JSON";
          return;
        }
      }
      const { trojanPost } = await import("../../src/am/am-http.ts");
      // ONE decider for the wire envelope. A cell method is called with
      // POSITIONAL arguments and its payload form is `{args:[…]}` (the reducer
      // reads `payload.args`); a plain redux-style action carries its payload
      // verbatim. amui used to re-derive that as a bare `{type, payload}`, so a
      // named payload reached a `cell:method` as NO arguments at all — and the
      // trojan still answered ok, so amui reported "dispatched". Use `am`'s
      // rule instead of a second copy of it.
      const { envelopePayload } = await import("../../src/am/am-cmd-state.ts");
      const r = await trojanPost(
        proj.running.port,
        "dispatch",
        payload !== undefined
          ? {
            type,
            payload: envelopePayload(type, payload as Record<string, unknown>),
          }
          : { type },
        proj.running.appId,
      );
      s.dispatchMsg = r.ok ? `dispatched ${type}` : `error: ${r.error}`;
    },

    /** Start a stopped project's app (browser shell, detached). Waits for the
     *  app to REGISTER as running before claiming it started — see awaitBoot. */
    async start(s, path: string) {
      const refusal = await refuseSelf(path);
      if (refusal) {
        s.actionMsg = refusal;
        return;
      }
      const name = path.split("/").pop();
      s.actionMsg = `starting ${name}…`;
      const { startApp, awaitBoot } = await import("./server/proc.ts");
      const r = await startApp(path, "browser");
      if (!r.ok) {
        s.actionMsg = `start failed: ${r.error}`;
        return;
      }
      s.actionMsg = `started (pid ${r.pid ?? "?"}) — waiting for boot…`;
      const boot = await awaitBoot(path, r.pid);
      await rescanInto(s).catch(() => {});
      s.actionMsg = boot.up
        ? `started ${name}`
        : `${name} failed to start: ${boot.reason}`;
    },

    /** Stop a running app (graceful trojan shutdown, SIGTERM fallback). */
    async stop(s, path: string) {
      const refusal = await refuseSelf(path);
      if (refusal) {
        s.actionMsg = refusal;
        return;
      }
      const proj = s.projects.find((p) => p.path === path);
      if (!proj?.running) return;
      const { appId, port, pid } = proj.running;
      const name = proj.name;
      s.actionMsg = `stopping ${name}…`;
      const { stopApp, awaitDown } = await import("./server/proc.ts");
      const r = await stopApp(port, appId, pid);
      if (s.detail && s.detail.path === path) {
        s.detail = { ...plain(s.detail), running: false, status: "stopping" };
        clearLiveDiagnostics(s);
      }
      // `stopApp` only reports that the request/signal was DELIVERED. Wait for
      // the app to actually deregister before saying it stopped — an app that
      // ignores SIGTERM would otherwise read as "stopped" while still serving.
      const down = r.ok && await awaitDown(path);
      // Refresh so the sidebar dot + detail agree with the verdict.
      await rescanInto(s).catch(() => {});
      s.actionMsg = !r.ok
        ? `stop failed: ${r.error}`
        : down
        ? `stopped ${name}`
        : `${name} did not stop — still running (pid ${pid})`;
    },

    /** Restart: stop (if running) then start; rescan after. */
    async restart(s, path: string) {
      const refusal = await refuseSelf(path);
      if (refusal) {
        s.actionMsg = refusal;
        return;
      }
      const proj = s.projects.find((p) => p.path === path);
      const name = path.split("/").pop();
      s.actionMsg = `restarting…`;
      const { startApp, stopApp, awaitBoot, awaitDown } = await import(
        "./server/proc.ts"
      );
      if (proj?.running) {
        const { appId, port, pid } = proj.running;
        await stopApp(port, appId, pid);
        // Wait for the port/singleton to be genuinely free — starting on top of
        // a still-live instance is how a restart "succeeds" into the OLD app.
        if (!await awaitDown(path)) {
          s.actionMsg = `restart failed: ${name} did not stop (pid ${pid})`;
          await rescanInto(s).catch(() => {});
          return;
        }
      }
      const r = await startApp(path, "browser");
      if (!r.ok) {
        s.actionMsg = `restart failed: ${r.error}`;
        return;
      }
      s.actionMsg = `restarted (pid ${r.pid ?? "?"}) — waiting for boot…`;
      const boot = await awaitBoot(path, r.pid);
      await rescanInto(s).catch(() => {});
      s.actionMsg = boot.up
        ? `restarted ${name}`
        : `${name} failed to restart: ${boot.reason}`;
    },

    /** Run a deno task — captures output. ALWAYS terminates: cancellable via
     *  cancelTask (aio cancelOn → s.$signal) and hard-capped at 5 min, so a
     *  long-running task (dev/watch/live) can never wedge the runner. */
    async runTask(s, path: string, task: string) {
      s.taskRunning = task;
      s.taskOutput = `$ deno task ${task}\n(running — cancellable)…`;
      s.taskCode = null;
      const { runTask } = await import("./server/proc.ts");
      try {
        const r = await runTask(path, task, s.$signal);
        s.taskCode = r.code;
        const tag = r.ended === "cancelled"
          ? "cancelled"
          : r.ended === "timeout"
          ? "timed out (5 min cap)"
          : `exit ${r.code}`;
        s.taskOutput = `$ deno task ${task}\n${r.output}\n\n[${tag}]`;
      } catch (e) {
        s.taskOutput = `$ deno task ${task}\n\n[failed to run: ${
          e instanceof Error ? e.message : String(e)
        }]`;
      } finally {
        // Always clear — a throw here would otherwise leave every task button
        // disabled forever (taskRunning stuck).
        s.taskRunning = null;
      }
    },

    /** Cancel the running task (aborts runTask via cancelOn → s.$signal). */
    cancelTask(_s) {/* trigger only — cancelOn aborts the in-flight runTask */},

    /** Open a file in the viewer (read-only, traversal-safe). `base` is the dir
     *  `rel` is relative to (the app dir for App Files, the repo root for the
     *  Codebase tab). Oversized/binary files are refused with a message. */
    async openFile(s, base: string, rel: string) {
      const { readFile } = await import("./server/proc.ts");
      const r = await readFile(base, rel);
      s.openFilePath = rel;
      s.openFileBase = base;
      s.fileContent = r.ok ? (r.content ?? "") : null;
      s.fileNotice = r.ok ? null : (r.error ?? "could not open file");
      s.fileTruncated = !!r.truncated;
    },

    /** Open a cell's source in the viewer — locate `cell("<name>")` in the app's
     *  source tree (the repo if present, else the runtime/app dir) and load it.
     *  A compiled app with no source alongside it reports "not found". */
    async openCellSource(s, path: string, cellName: string) {
      const base = s.repoRoot ?? s.runtime?.root ?? path;
      // reset the viewer up front (committed before the await)
      s.openFilePath = null;
      s.openFileBase = base;
      s.fileContent = null;
      s.fileNotice = null;
      s.fileTruncated = false;
      s.openFileHint = null;
      const { findCellSource, readFile } = await import("./server/proc.ts");
      const found = await findCellSource(base, cellName);
      if (s.selectedPath !== path) return;
      if (!found) {
        s.openFilePath = `cell "${cellName}"`;
        s.fileNotice =
          `couldn't find where cell "${cellName}" is defined in the source tree`;
        return;
      }
      const r = await readFile(base, found.rel);
      if (s.selectedPath !== path) return;
      s.openFilePath = found.rel;
      s.openFileBase = base;
      s.fileContent = r.ok ? (r.content ?? "") : null;
      s.fileNotice = r.ok ? null : (r.error ?? "could not open file");
      s.fileTruncated = !!r.truncated;
      s.openFileHint = `cell "${cellName}" defined at line ${found.line}`;
    },

    closeFile(s) {
      s.openFilePath = null;
      s.openFileBase = null;
      s.fileContent = null;
      s.fileNotice = null;
      s.fileTruncated = false;
      s.openFileHint = null;
    },

    /** Scaffold a brand-new aio app via `am create` in ~/aio-apps/<name>. */
    async create(s, rawName: string) {
      // Slugify, then trim leading/trailing dashes — a name like "@" would
      // otherwise become "-" and be mis-parsed as a flag by `am create`.
      const name = (rawName ?? "").trim().toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!name) {
        s.createMsg = "enter a name";
        return;
      }
      s.createBusy = true;
      s.createMsg = null;
      const { createApp } = await import("./server/proc.ts");
      const r = await createApp(name);
      s.createBusy = false;
      s.createMsg = r.ok ? `created ${r.dir}` : `create failed: ${r.error}`;
      // Surface the freshly-scaffolded app immediately.
      await rescanInto(s).catch(() => {});
    },
  },
});
