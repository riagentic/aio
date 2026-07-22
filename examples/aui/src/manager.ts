// aui manager — the aio UI manager's brain. Runs SERVER-side; the browser only
// gets synced state + a dispatch surface. Every node/Deno-only import is pulled
// via a DYNAMIC import inside a method (the graph-validator escape hatch, keeps
// it out of the browser bundle). Discovery, per-app detail (trojan API), live
// CPU/memory sampling, task running, and safe file access all live here.
import { cell } from "aio";
import type { DiscoveredProject, ProjectMeta } from "./server/scan.ts";
import type { FileNode } from "./server/proc.ts";

export type { DiscoveredProject, FileNode, ProjectMeta };

const HIST = 60; // rolling metric samples kept for the charts

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
      // Running-state or process identity changed → old chart history is stale.
      s.cpuHistory = s.detail.running && s.detail.cpuPct !== null
        ? [s.detail.cpuPct]
        : [];
      s.memHistory = s.detail.running && s.detail.memMb !== null
        ? [s.detail.memMb]
        : [];
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

export const manager = cell("manager", {
  // Live dashboard — nothing here is worth persisting, and foreign app states
  // can be large; persisting them would bloat aui's DB and slow every write.
  persist: "none",
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
    // charts
    cpuHistory: [] as number[],
    memHistory: [] as number[],
    // live state (trojan `state`) — loaded LAZILY for the State tab only, never
    // pulled on select (a 350KB foreign state on every click floods sync/render)
    detailState: null as unknown,
    detailStatePath: null as string | null,
    detailStateSize: 0,
    detailStateTruncated: false,
    detailStateLoading: false,
    detailStateError: null as string | null,
    // task runner
    taskRunning: null as string | null,
    taskOutput: "" as string,
    taskCode: null as number | null,
    // file viewer
    fileTree: null as FileNode[] | null,
    fileTreeTruncated: false,
    openFilePath: null as string | null,
    fileContent: null as string | null,
    fileTruncated: false,
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
      s.openFilePath = null;
      s.fileContent = null;
      s.fileTruncated = false;
      s.dispatchMsg = null;
      s.detailState = null;
      s.detailStatePath = null;
      s.detailStateError = null;
      s.cpuHistory = [];
      s.memHistory = [];

      // ── gather (all fetches are Result-typed + 5s-timeout bounded) ──
      const base = detailOf(proj);
      const { listFiles } = await import("./server/proc.ts");
      let files: FileNode[] = [];
      let filesTruncated = false;
      try {
        const r = await listFiles(path);
        files = r.nodes;
        filesTruncated = r.truncated;
      } catch { /* unreadable */ }

      if (proj.running) {
        const { appId, port, pid } = proj.running;
        const { trojanGet } = await import("../../../src/am/am-http.ts");
        const { psStats } = await import("./server/proc.ts");
        const [config, metrics, cells, errors, schedules, ps] = await Promise
          .all([
            trojanGet(port, "config", appId),
            trojanGet(port, "metrics", appId),
            trojanGet(port, "cells", appId),
            trojanGet(port, "errors", appId),
            trojanGet(port, "schedules", appId),
            psStats(pid),
          ]);
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
      s.cpuHistory = base.cpuPct !== null ? [base.cpuPct] : [];
      s.memHistory = base.memMb !== null ? [base.memMb] : [];
    },

    /** Load the selected running app's live state for the State tab (lazy +
     *  size-capped). Never auto-polled: the monitored app's state may churn
     *  constantly, so aui pulls it on demand only. */
    async loadState(s, path: string) {
      const proj = s.projects.find((p) => p.path === path);
      if (!proj?.running) {
        s.detailState = null;
        s.detailStatePath = path;
        s.detailStateError = "app not running";
        return;
      }
      s.detailStateLoading = true;
      s.detailStateError = null;
      const { appId, port } = proj.running;
      const { trojanGet } = await import("../../../src/am/am-http.ts");
      const r = await trojanGet(port, "state", appId);
      // Supersede guard.
      if (s.selectedPath !== path) {
        s.detailStateLoading = false;
        return;
      }
      s.detailStateLoading = false;
      s.detailStatePath = path;
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
      const { trojanGet } = await import("../../../src/am/am-http.ts");
      const { psStats } = await import("./server/proc.ts");
      const [metrics, ps] = await Promise.all([
        trojanGet(port, "metrics", appId),
        psStats(pid),
      ]);
      // Re-read AFTER the awaits — a stop()/select() may have superseded us
      // during the (up to a few second) trojan/ps round-trip. Drop this sample
      // rather than resurrecting the stale snapshot.
      const d = plain(s.detail);
      if (!d || d.path !== path || !d.running) return;
      const cpu = ps?.cpuPct ?? d.cpuPct ?? 0;
      const mem = ps?.memMb ?? d.memMb ?? 0;
      s.cpuHistory = [...s.cpuHistory, cpu].slice(-HIST);
      s.memHistory = [...s.memHistory, mem].slice(-HIST);
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
      const { trojanPost } = await import("../../../src/am/am-http.ts");
      const r = await trojanPost(
        proj.running.port,
        "dispatch",
        payload !== undefined ? { type, payload } : { type },
        proj.running.appId,
      );
      s.dispatchMsg = r.ok ? `dispatched ${type}` : `error: ${r.error}`;
    },

    /** Start a stopped project's app (browser shell, detached). Re-scans after
     *  a short boot delay so the app shows up running without a manual rescan. */
    async start(s, path: string) {
      s.actionMsg = `starting ${path.split("/").pop()}…`;
      const { startApp } = await import("./server/proc.ts");
      const r = await startApp(path, "browser");
      if (!r.ok) {
        s.actionMsg = `start failed: ${r.error}`;
        return;
      }
      s.actionMsg = `started (pid ${r.pid ?? "?"}) — waiting for boot…`;
      await new Promise((res) => setTimeout(res, 2500));
      await rescanInto(s).catch(() => {});
      s.actionMsg = `started ${path.split("/").pop()}`;
    },

    /** Stop a running app (graceful trojan shutdown, SIGTERM fallback). */
    async stop(s, path: string) {
      const proj = s.projects.find((p) => p.path === path);
      if (!proj?.running) return;
      const { appId, port, pid } = proj.running;
      s.actionMsg = `stopping ${proj.name}…`;
      const { stopApp } = await import("./server/proc.ts");
      const r = await stopApp(port, appId, pid);
      s.actionMsg = r.ok ? `stopped ${proj.name}` : `stop failed: ${r.error}`;
      if (s.detail && s.detail.path === path) {
        s.detail = { ...plain(s.detail), running: false, status: "stopping" };
        s.cpuHistory = [];
        s.memHistory = [];
      }
      // Refresh so the sidebar dot + detail agree the app is down.
      await new Promise((res) => setTimeout(res, 600));
      await rescanInto(s).catch(() => {});
    },

    /** Restart: stop (if running) then start; rescan after. */
    async restart(s, path: string) {
      const proj = s.projects.find((p) => p.path === path);
      s.actionMsg = `restarting…`;
      const { startApp, stopApp } = await import("./server/proc.ts");
      if (proj?.running) {
        const { appId, port, pid } = proj.running;
        await stopApp(port, appId, pid);
        await new Promise((r) => setTimeout(r, 800));
      }
      const r = await startApp(path, "browser");
      if (!r.ok) {
        s.actionMsg = `restart failed: ${r.error}`;
        return;
      }
      s.actionMsg = `restarted (pid ${r.pid ?? "?"}) — waiting for boot…`;
      await new Promise((res) => setTimeout(res, 2500));
      await rescanInto(s).catch(() => {});
      s.actionMsg = `restarted ${path.split("/").pop()}`;
    },

    /** Run a deno task — captures output. ALWAYS terminates: cancellable via
     *  cancelTask (aio cancelOn → s.$signal) and hard-capped at 5 min, so a
     *  long-running task (dev/watch/live) can never wedge the runner. */
    async runTask(s, path: string, task: string) {
      s.taskRunning = task;
      s.taskOutput = `$ deno task ${task}\n(running — cancellable)…`;
      s.taskCode = null;
      const { runTask } = await import("./server/proc.ts");
      const r = await runTask(path, task, s.$signal);
      s.taskRunning = null;
      s.taskCode = r.code;
      const tag = r.ended === "cancelled"
        ? "cancelled"
        : r.ended === "timeout"
        ? "timed out (5 min cap)"
        : `exit ${r.code}`;
      s.taskOutput = `$ deno task ${task}\n${r.output}\n\n[${tag}]`;
    },

    /** Cancel the running task (aborts runTask via cancelOn → s.$signal). */
    cancelTask(_s) {/* trigger only — cancelOn aborts the in-flight runTask */},

    /** Open a project file in the viewer (dev mode; read-only, traversal-safe). */
    async openFile(s, path: string, rel: string) {
      const { readFile } = await import("./server/proc.ts");
      const r = await readFile(path, rel);
      s.openFilePath = rel;
      s.fileContent = r.ok ? (r.content ?? "") : `error: ${r.error}`;
      s.fileTruncated = !!r.truncated;
    },

    closeFile(s) {
      s.openFilePath = null;
      s.fileContent = null;
      s.fileTruncated = false;
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
      let msg: string;
      try {
        const amUrl = new URL("../../../src/am.ts", import.meta.url);
        const repoUrl = new URL("../../../", import.meta.url);
        const home = Deno.env.get("HOME") ?? ".";
        const workspace = `${home}/aio-apps`;
        await Deno.mkdir(workspace, { recursive: true });
        const out = await new Deno.Command("deno", {
          args: [
            "run",
            "-A",
            amUrl.pathname,
            "create",
            name,
            `--mirror=${repoUrl.pathname}`,
          ],
          cwd: workspace,
          stdout: "piped",
          stderr: "piped",
        }).output();
        msg = out.code === 0
          ? `created ${workspace}/${name}`
          : `create failed: ${
            new TextDecoder().decode(out.stderr).slice(0, 200)
          }`;
      } catch (e) {
        msg = `create failed: ${e instanceof Error ? e.message : e}`;
      }
      s.createBusy = false;
      s.createMsg = msg;
      // Surface the freshly-scaffolded app immediately.
      await rescanInto(s).catch(() => {});
    },
  },
});
