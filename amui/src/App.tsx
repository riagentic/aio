// amui — the aio UI manager. Sidebar of projects (running + on-disk) + a rich,
// tabbed detail panel: Overview · Cells · State · Metrics · Logs · Tasks ·
// Codebase. Reactive over the manager cell; live metrics + logs poll on
// intervals. Diagnostics are mined from the app's health/vitals/trojan surface.
import { onMount, signal } from "aio/air";
import { type FileNode, manager, type ProjectDetail } from "./manager.ts";
import {
  btn,
  btnGhost,
  C,
  card,
  chip,
  fmtBytes,
  fmtUptime,
  label,
  mono,
} from "./ui/style.ts";
import { resetTree } from "./ui/json-tree.tsx";
import { resetStateView, StateOverview } from "./ui/state-view.tsx";
import { highlight } from "./ui/highlight.tsx";
import { MetricsPanel } from "./ui/metrics.tsx";
import { LogView, resetLogView } from "./ui/logs.tsx";
import type { LogSource } from "./manager.ts";

type Tab =
  | "overview"
  | "cells"
  | "state"
  | "metrics"
  | "logs"
  | "tasks"
  | "codebase";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "cells", label: "Cells" },
  { id: "state", label: "State" },
  { id: "metrics", label: "Metrics" },
  { id: "logs", label: "Logs" },
  { id: "tasks", label: "Tasks" },
  { id: "codebase", label: "Codebase" },
];
const activeTab = signal<Tab>("overview");
const search = signal("");
// The file tree is EXPANDED by default (browse the whole codebase at a glance);
// `collapsedDirs` holds the dirs the user has folded away.
const collapsedDirs = signal<Set<string>>(new Set());
const fileFilter = signal("");
// Codebase source: the app's own dir (eager) vs the enclosing repo root (lazy).
// Only offered when they differ (a monorepo, or an AppImage's unpacked mount).
const codebaseSrc = signal<"app" | "repo">("app");
let _lastPath: string | null = null;
let _stateReqPath: string | null = null; // sync dedupe for StateTab auto-load

// Select a project AND clear the render-dispatch dedupe guards. select() resets
// detailStatePath/codebaseTree server-side, but on a same-path re-select (⟳
// Refresh) the path-change block below is skipped, so the guards would keep
// their stale value and the State / Git-Repo tabs would never re-fetch. Always
// route selection through here.
function reselect(path: string) {
  _stateReqPath = null;
  _codebaseReqPath = null;
  _logReqPath = null;
  manager.select(path);
}

function toggleDir(path: string) {
  const next = new Set(collapsedDirs.value);
  next.has(path) ? next.delete(path) : next.add(path);
  collapsedDirs.set(next);
}
const resetFiles = () => {
  collapsedDirs.set(new Set());
  fileFilter.set("");
};

// ── small pieces ─────────────────────────────────────────────────────────────
function Tile(
  { label: l, value, color, sub }: {
    label: string;
    value: string;
    color?: string;
    sub?: string;
  },
) {
  return (
    <div style={{ ...card, padding: "10px 14px", flex: "1", minWidth: "0" }}>
      <div style={label}>{l}</div>
      <div
        style={{
          fontSize: "19px",
          fontWeight: 700,
          color: color ?? C.text,
          fontFamily: mono,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: "11px", color: C.dim }}>{sub}</div>}
    </div>
  );
}

function StatusChip(
  { running, status }: { running: boolean; status: string | null },
) {
  const c = running ? C.green : C.dim;
  return (
    <span
      style={{
        ...chip,
        color: c,
        background: running ? "rgba(63,185,80,0.12)" : "rgba(102,115,138,0.12)",
        border: `1px solid ${running ? "rgba(63,185,80,0.3)" : C.border}`,
      }}
    >
      ● {running ? (status ?? "running") : "stopped"}
    </span>
  );
}

// ── sidebar ──────────────────────────────────────────────────────────────────
function Sidebar() {
  const q = search.value.toLowerCase();
  const projects = manager.projects.filter((p) =>
    !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
  );
  const selected = manager.selectedPath;
  return (
    <div
      style={{
        width: "280px",
        borderRight: `1px solid ${C.border}`,
        display: "flex",
        flexDirection: "column",
        background: C.bg2,
        minWidth: "280px",
      }}
    >
      <div style={{ padding: "16px 16px 12px" }}>
        <div
          style={{ fontWeight: 800, fontSize: "17px", letterSpacing: "0.02em" }}
        >
          amui
        </div>
        <div style={{ color: C.dim, fontSize: "11px" }}>Aio Manager UI</div>
      </div>

      <div
        style={{
          padding: "0 12px 10px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <input
          value={search.value}
          onInput={(e: Event) =>
            search.set((e.currentTarget as HTMLInputElement).value)}
          placeholder="search projects…"
          style={{
            padding: "7px 10px",
            borderRadius: "7px",
            border: `1px solid ${C.border}`,
            background: C.panel,
            color: C.text,
            fontSize: "13px",
          }}
        />
        <div style={{ display: "flex", gap: "6px" }}>
          <button
            type="button"
            onClick={() => manager.discover()}
            disabled={manager.scanning}
            style={{ ...btn, flex: "1" }}
          >
            {manager.scanning ? "scanning…" : "⟳ Rescan"}
          </button>
          <form
            style={{ display: "flex", gap: "6px", flex: "1" }}
            onSubmit={(e: Event) => {
              e.preventDefault();
              const i = (e.currentTarget as HTMLFormElement).elements
                .namedItem("nn") as HTMLInputElement;
              if (i?.value) {
                manager.create(i.value);
                i.value = "";
              }
            }}
          >
            <input
              name="nn"
              placeholder="new app"
              disabled={manager.createBusy}
              style={{
                flex: "1",
                minWidth: "0",
                padding: "7px 8px",
                borderRadius: "7px",
                border: `1px solid ${C.border}`,
                background: C.panel,
                color: C.text,
                fontSize: "12px",
              }}
            />
            <button
              type="submit"
              disabled={manager.createBusy}
              title="Create a new aio app"
              style={{ ...btn, borderColor: C.greenDim, color: C.green }}
            >
              {manager.createBusy ? "…" : "＋"}
            </button>
          </form>
        </div>
        {manager.createMsg && (
          <div
            style={{ fontSize: "11px", color: C.text2, wordBreak: "break-all" }}
          >
            {manager.createMsg}
          </div>
        )}
      </div>

      <div style={{ overflowY: "auto", flex: "1", padding: "4px 8px" }}>
        {projects.length === 0
          ? (
            <div style={{ padding: "12px", color: C.dim, fontSize: "12px" }}>
              {manager.scanning ? "scanning…" : (
                <>
                  <div style={{ marginBottom: "8px", color: C.text2 }}>
                    {search.value
                      ? "no projects match your search."
                      : "no aio projects found."}
                  </div>
                  {!search.value && manager.scanRoots.length > 0 && (
                    <>
                      <div style={{ marginBottom: "4px" }}>searched:</div>
                      <div style={{ fontFamily: mono, fontSize: "10px" }}>
                        {manager.scanRoots.map((r) => (
                          <div
                            key={r}
                            style={{
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                            title={r}
                          >
                            {r}
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop: "8px", lineHeight: "1.5" }}>
                        add more with{" "}
                        <span style={{ fontFamily: mono, color: C.text2 }}>
                          AUI_ROOTS=/path:/path2
                        </span>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )
          : projects.map((p) => {
            const sel = selected === p.path;
            return (
              <div
                key={p.path}
                onClick={() => reselect(p.path)}
                title={p.path}
                style={{
                  padding: "9px 10px",
                  borderRadius: "8px",
                  cursor: "pointer",
                  marginBottom: "2px",
                  background: sel ? C.panel2 : "transparent",
                  border: `1px solid ${sel ? C.border : "transparent"}`,
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "999px",
                    background: p.running ? C.green : C.dim,
                    flexShrink: 0,
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "13px",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.name}
                  </div>
                  <div style={{ color: C.dim, fontSize: "10px" }}>
                    {p.running ? `:${p.running.port}` : "stopped"}
                    {p.meta.target ? ` · ${p.meta.target}` : ""}
                  </div>
                </div>
              </div>
            );
          })}
      </div>

      <div
        style={{
          padding: "8px 14px",
          borderTop: `1px solid ${C.border}`,
          color: C.dim,
          fontSize: "10px",
          fontFamily: mono,
        }}
      >
        {manager.projects.filter((p) => p.running).length} running ·{" "}
        {manager.projects.length} total
      </div>
    </div>
  );
}

// ── detail: header ───────────────────────────────────────────────────────────
function Header({ d }: { d: ProjectDetail }) {
  return (
    <div
      style={{
        padding: "18px 24px 0",
        borderBottom: `1px solid ${C.border}`,
        background: C.bg2,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "22px", fontWeight: 800 }}>{d.name}</span>
            <StatusChip running={d.running} status={d.status} />
            {d.build && (
              <span
                style={{
                  ...chip,
                  color: d.build === "prod" ? C.yellow : C.blue,
                  border: `1px solid ${C.border}`,
                }}
              >
                {d.build}
              </span>
            )}
          </div>
          <div
            style={{
              color: C.dim,
              fontSize: "12px",
              fontFamily: mono,
              marginTop: "3px",
            }}
          >
            {d.path}
            {manager.detailLoading
              ? " · loading…"
              : d.running && d.at
              ? ` · live · updated ${new Date(d.at).toLocaleTimeString()}`
              : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
          <button
            type="button"
            style={btn}
            onClick={() => reselect(d.path)}
          >
            ⟳ Refresh
          </button>
          {d.self
            ? (
              // amui monitoring itself: every diagnostic below works, but
              // starting would spawn a second manager and stopping would kill
              // the window you are reading. Managed from the shell instead.
              <span
                style={{
                  ...btnGhost,
                  borderColor: C.border,
                  color: C.dim,
                  cursor: "default",
                }}
                title="amui manages other apps — control it from the shell that launched it"
              >
                ★ this is amui
              </span>
            )
            : d.running
            ? (
              <>
                <button
                  type="button"
                  style={{ ...btnGhost, borderColor: C.blueDim, color: C.blue }}
                  onClick={() =>
                    confirm(`Restart ${d.name}?`) && manager.restart(d.path)}
                >
                  ↻ Restart
                </button>
                <button
                  type="button"
                  style={{ ...btnGhost, borderColor: C.redDim, color: C.red }}
                  onClick={() =>
                    confirm(`Stop ${d.name}?`) && manager.stop(d.path)}
                >
                  ■ Stop
                </button>
              </>
            )
            : (
              <button
                type="button"
                style={{ ...btn, borderColor: C.greenDim, color: C.green }}
                onClick={() => manager.start(d.path)}
              >
                ▶ Start
              </button>
            )}
        </div>
      </div>
      {manager.actionMsg && (
        <div style={{ color: C.text2, fontSize: "12px", padding: "6px 0 0" }}>
          {manager.actionMsg}
        </div>
      )}
      <div style={{ display: "flex", gap: "2px", marginTop: "12px" }}>
        {TABS.map(({ id, label: tabLabel }) => {
          const on = activeTab.value === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => activeTab.set(id)}
              style={{
                padding: "8px 14px",
                border: "none",
                borderBottom: `2px solid ${on ? C.blue : "transparent"}`,
                background: "transparent",
                color: on ? C.text : C.dim,
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: on ? 600 : 500,
                fontFamily: "inherit",
                whiteSpace: "nowrap",
              }}
            >
              {tabLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Build targets + dev modes, parsed from deno.json tasks — a quick map of how
// this app runs and what it compiles to. Each chip runs the task.
function TargetsCard({ d }: { d: ProjectDetail }) {
  const tasks = Object.keys(d.meta.tasks);
  const dev = tasks.filter((t) => t === "dev" || t.startsWith("dev:"));
  const compile = tasks.filter((t) =>
    t === "compile" || t.startsWith("compile:")
  );
  const nice = (t: string, p: string) =>
    t === p ? `${p} (default)` : t.slice(p.length + 1);
  const Chips = ({ items, prefix, color }: {
    items: string[];
    prefix: string;
    color: string;
  }) => (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
      {items.length === 0
        ? <span style={{ color: C.dim, fontSize: "12px" }}>—</span>
        : items.map((t) => (
          <button
            key={t}
            type="button"
            disabled={manager.taskRunning !== null}
            title={d.meta.tasks[t]}
            onClick={() => {
              activeTab.set("tasks");
              manager.runTask(d.path, t);
            }}
            style={{
              ...chip,
              cursor: "pointer",
              color,
              border: `1px solid ${C.border}`,
              background: C.panel,
            }}
          >
            {nice(t, prefix)}
          </button>
        ))}
    </div>
  );
  return (
    <div style={{ ...card, padding: "14px 16px" }}>
      <div
        style={{
          display: "flex",
          gap: "24px",
          flexWrap: "wrap",
          alignItems: "flex-start",
        }}
      >
        <div>
          <div style={{ ...label, marginBottom: "8px" }}>dev modes</div>
          <Chips items={dev} prefix="dev" color={C.blue} />
        </div>
        <div>
          <div style={{ ...label, marginBottom: "8px" }}>
            compile targets
          </div>
          <Chips items={compile} prefix="compile" color={C.green} />
        </div>
      </div>
    </div>
  );
}

// ── tabs ─────────────────────────────────────────────────────────────────────
function Overview({ d }: { d: ProjectDetail }) {
  const rt = manager.runtime;
  const health = manager.health;
  const workDir = rt?.root ?? d.path;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <Tile
          label="status"
          value={d.running ? "running" : "stopped"}
          color={d.running ? C.green : C.red}
        />
        <Tile
          label="build"
          value={d.build ?? "—"}
          color={d.build === "prod" ? C.yellow : C.blue}
        />
        <Tile label="port" value={d.port ? String(d.port) : "—"} />
        <Tile label="pid" value={d.pid ? String(d.pid) : "—"} />
        <Tile label="uptime" value={fmtUptime(d.uptimeSec)} />
        <Tile
          label="clients"
          value={d.connections !== null ? String(d.connections) : "—"}
        />
        <Tile
          label="cpu"
          value={d.cpuPct !== null ? `${d.cpuPct.toFixed(1)}%` : "—"}
        />
        <Tile label="memory" value={d.memMb !== null ? `${d.memMb} MB` : "—"} />
        <Tile
          label="heap"
          value={manager.mem ? fmtBytes(manager.mem.heapUsed) : "—"}
        />
      </div>
      {/* process + live cell health */}
      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
        <div
          style={{
            ...card,
            padding: "14px 16px",
            flex: "1",
            minWidth: "260px",
          }}
        >
          <div style={{ ...label, marginBottom: "8px" }}>process</div>
          <Row k="pid" v={d.pid ? String(d.pid) : "—"} />
          <Row k="port" v={d.port ? String(d.port) : "—"} />
          <Row k="app id" v={d.appId ?? "—"} />
          <Row
            k="runtime"
            v={rt ? `${rt.kind} — ${rt.label}` : (d.running ? "…" : "—")}
          />
          <Row k="work dir" v={workDir} />
          {rt?.exe ? <Row k="exe" v={rt.exe} /> : null}
        </div>
        <div
          style={{
            ...card,
            padding: "14px 16px",
            flex: "1",
            minWidth: "260px",
          }}
        >
          <div style={{ ...label, marginBottom: "8px" }}>cell health</div>
          {health && Object.keys(health.cells ?? {}).length
            ? Object.entries(health.cells ?? {}).map(([name, h]) => (
              <div
                key={name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "3px 0",
                  fontSize: "13px",
                }}
              >
                <span
                  style={{
                    color: h.enabled ? C.green : C.red,
                    fontSize: "10px",
                  }}
                >
                  ●
                </span>
                <span style={{ color: C.blue, minWidth: "100px" }}>{name}</span>
                <span style={{ color: C.dim, fontSize: "11px" }}>
                  {h.status}
                  {h.errors ? ` · ${h.errors} err` : ""}
                  {h.lastAction ? ` · ${h.lastAction}` : ""}
                </span>
              </div>
            ))
            : (
              <div style={{ color: C.dim, fontSize: "13px" }}>
                {d.running ? "no cell health reported" : "app not running"}
              </div>
            )}
        </div>
      </div>
      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
        <div
          style={{
            ...card,
            padding: "14px 16px",
            flex: "1",
            minWidth: "260px",
          }}
        >
          <div style={{ ...label, marginBottom: "8px" }}>project</div>
          <Row k="name" v={d.meta.name || d.name} />
          <Row k="version" v={d.meta.version ?? "—"} />
          <Row k="aio" v={manager.aioVersion ?? "—"} />
          <Row k="target" v={d.meta.target ?? "browser (default)"} />
          <Row k="git" v={d.git ? "yes" : "no"} />
          <Row k="tasks" v={String(Object.keys(d.meta.tasks).length)} />
        </div>
        <div
          style={{
            ...card,
            padding: "14px 16px",
            flex: "1",
            minWidth: "260px",
          }}
        >
          <div style={{ ...label, marginBottom: "8px" }}>runtime config</div>
          {d.config
            ? (
              <>
                <Row k="title" v={d.config.title ?? "—"} />
                <Row k="port" v={String(d.config.port ?? "—")} />
                <Row k="auth" v={d.config.authMode ?? "none"} />
                <Row k="mode" v={d.config.prod ? "prod" : "dev"} />
                <Row
                  k="cells"
                  v={d.cells ? Object.keys(d.cells).join(", ") : "—"}
                />
              </>
            )
            : (
              <div style={{ color: C.dim, fontSize: "13px" }}>
                app not running
              </div>
            )}
        </div>
      </div>
      <TargetsCard d={d} />
      {(!!d.errors?.length || !!d.schedules?.length) && (
        <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
          <div
            style={{
              ...card,
              padding: "12px 16px",
              flex: "1",
              minWidth: "260px",
            }}
          >
            <div
              style={{
                ...label,
                marginBottom: "6px",
                color: d.errors?.length ? C.red : C.dim,
              }}
            >
              errors ({d.errors?.length ?? 0})
            </div>
            {(d.errors ?? []).slice(0, 6).map((e, i) => (
              <div
                key={i}
                style={{ fontFamily: mono, fontSize: "11px", color: C.red }}
              >
                {typeof e === "string" ? e : JSON.stringify(e).slice(0, 140)}
              </div>
            ))}
            {!d.errors?.length && (
              <div style={{ color: C.dim, fontSize: "12px" }}>none</div>
            )}
          </div>
          <div
            style={{
              ...card,
              padding: "12px 16px",
              flex: "1",
              minWidth: "260px",
            }}
          >
            <div style={{ ...label, marginBottom: "6px" }}>
              schedules ({d.schedules?.length ?? 0})
            </div>
            {(d.schedules ?? []).map((sc, i) => (
              <div
                key={i}
                style={{ fontFamily: mono, fontSize: "11px", color: C.text2 }}
              >
                {sc}
              </div>
            ))}
            {!d.schedules?.length && (
              <div style={{ color: C.dim, fontSize: "12px" }}>none</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", padding: "3px 0", fontSize: "13px" }}>
      <span style={{ color: C.dim, width: "80px", flexShrink: 0 }}>{k}</span>
      <span style={{ color: C.text, wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

function CellsTab({ d }: { d: ProjectDetail }) {
  if (!d.running) return <Empty msg="start the app to inspect its cells" />;
  const cells = d.cells ?? {};
  const names = Object.keys(cells);
  // Source is browsable when there's a repo, or the runtime dir carries source.
  const hasSource = manager.repoRoot !== null ||
    (manager.fileTree ?? []).some((f) =>
      !f.dir && /\.(tsx?|jsx?)$/.test(f.name)
    );
  const openSource = (name: string) => {
    manager.openCellSource(d.path, name);
    activeTab.set("codebase");
  };
  return (
    <div>
      {manager.dispatchMsg && (
        <div
          style={{
            fontSize: "12px",
            color: C.text2,
            marginBottom: "10px",
            fontFamily: mono,
          }}
        >
          {manager.dispatchMsg}
        </div>
      )}
      {names.length === 0 ? <Empty msg="no cells" /> : names.map((name) => (
        <div
          key={name}
          style={{ ...card, padding: "12px 14px", marginBottom: "8px" }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontWeight: 700,
                color: C.blue,
                minWidth: "120px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              {name}
              {hasSource && (
                <button
                  type="button"
                  title={`Open ${name}'s source code`}
                  onClick={() => openSource(name)}
                  style={{
                    ...btnGhost,
                    padding: "2px 7px",
                    fontSize: "11px",
                    fontWeight: 500,
                    color: C.dim,
                  }}
                >
                  {"</> source"}
                </button>
              )}
            </span>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {(cells[name] ?? []).length === 0
                ? (
                  <span style={{ color: C.dim, fontSize: "12px" }}>
                    state-only cell
                  </span>
                )
                : (cells[name] ?? []).map((m) => (
                  <button
                    key={m}
                    type="button"
                    title={`Run ${name}:${m}()`}
                    onClick={() => manager.dispatch(d.path, `${name}:${m}`, "")}
                    style={{ ...btn, padding: "4px 10px", fontSize: "12px" }}
                  >
                    ▶ {m}
                  </button>
                ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function StateTab({ d }: { d: ProjectDetail }) {
  if (!d.running) return <Empty msg="start the app to view its live state" />;
  // Lazy-load this app's live state on first view of the tab. `detailStateLoading`
  // is a buffered write (commits at loadState's first await), so guard on a
  // SYNCHRONOUS module flag too — otherwise a re-render in that window
  // re-dispatches. Never auto-polled; pulled on demand only.
  if (
    typeof document !== "undefined" &&
    manager.detailStatePath !== d.path && _stateReqPath !== d.path
  ) {
    _stateReqPath = d.path;
    manager.loadState(d.path);
  }
  const loading = manager.detailStateLoading;
  const loaded = manager.detailStatePath === d.path;
  const err = manager.detailStateError;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <button
          type="button"
          style={btn}
          disabled={loading}
          onClick={() => manager.loadState(d.path)}
        >
          {loading ? "loading…" : "⟳ Reload"}
        </button>
        {loaded && manager.detailStateSize > 0 && (
          <span style={{ color: C.dim, fontSize: "12px", fontFamily: mono }}>
            {(manager.detailStateSize / 1024).toFixed(1)} KB
          </span>
        )}
      </div>
      {err
        ? (
          <div style={{ color: C.red, fontSize: "13px" }}>
            state error: {err}
          </div>
        )
        : manager.detailStateTruncated
        ? (
          <div style={{ color: C.yellow, fontSize: "13px", lineHeight: "1.5" }}>
            state is too large to render safely (
            {(manager.detailStateSize / 1e6).toFixed(1)}{" "}
            MB). Inspect it directly via the app's trojan{" "}
            <span style={{ fontFamily: mono }}>state</span>
            {" / "}
            <span style={{ fontFamily: mono }}>sql</span> routes.
          </div>
        )
        : loading && !loaded
        ? (
          <div style={{ color: C.dim, fontSize: "13px", padding: "12px" }}>
            loading state…
          </div>
        )
        : (
          <StateOverview
            state={manager.detailState}
            fields={manager.detailFields}
          />
        )}
    </div>
  );
}

function MetricsTab({ d }: { d: ProjectDetail }) {
  if (!d.running && manager.cpuHistory.length === 0) {
    return <Empty msg="metrics stream once the app is running & selected" />;
  }
  return (
    <MetricsPanel
      vitals={manager.vitals}
      mem={manager.mem}
      clients={manager.clients}
      history={manager.history}
      cpu={manager.cpuHistory}
      memMb={manager.memHistory}
      heap={manager.heapHistory}
      reduce={manager.reduceHistory}
      queue={manager.queueHistory}
      connections={d.connections}
    />
  );
}

// Logs — tails the app's .aio/log (framework + app lines) / combined stdout.
let _logReqPath: string | null = null;
function LogsTab({ d }: { d: ProjectDetail }) {
  // Lazy first load on tab view (sync guard mirrors StateTab's pattern).
  if (
    typeof document !== "undefined" && manager.logs === null &&
    !manager.logLoading && _logReqPath !== d.path
  ) {
    _logReqPath = d.path;
    manager.loadLogs(d.path);
  }
  return (
    <LogView
      logs={manager.logs}
      loading={manager.logLoading}
      error={manager.logError}
      source={manager.logSource}
      path={manager.logPath}
      truncated={manager.logTruncated}
      follow={manager.logFollow}
      onReload={() => manager.loadLogs(d.path)}
      onSource={(src: LogSource) => manager.loadLogs(d.path, src)}
      onToggleFollow={() => manager.setLogFollow(!manager.logFollow)}
    />
  );
}

function TasksTab({ d }: { d: ProjectDetail }) {
  const tasks = Object.keys(d.meta.tasks);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ ...card, padding: "14px 16px" }}>
        <div style={{ ...label, marginBottom: "10px" }}>deno tasks</div>
        {tasks.length === 0
          ? (
            <div style={{ color: C.dim, fontSize: "13px" }}>
              no tasks in deno.json
            </div>
          )
          : (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {tasks.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={manager.taskRunning !== null}
                  title={d.meta.tasks[t]}
                  onClick={() => manager.runTask(d.path, t)}
                  style={{
                    ...btn,
                    borderColor: manager.taskRunning === t ? C.blue : C.border,
                    color: manager.taskRunning === t ? C.blue : C.text,
                  }}
                >
                  {manager.taskRunning === t ? "◇ " : "▷ "}
                  {t}
                </button>
              ))}
            </div>
          )}
        {manager.taskRunning && (
          <div
            style={{
              marginTop: "10px",
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}
          >
            <button
              type="button"
              onClick={() => manager.cancelTask()}
              style={{ ...btnGhost, borderColor: C.redDim, color: C.red }}
            >
              ■ Stop task
            </button>
            <span style={{ color: C.dim, fontSize: "11px" }}>
              long-running tasks (dev/watch) are safe — cancel any time, 5 min
              cap
            </span>
          </div>
        )}
      </div>
      {(manager.taskOutput || manager.taskRunning) && (
        <div style={{ ...card, padding: "0", overflow: "hidden" }}>
          <div
            style={{
              ...label,
              padding: "10px 16px",
              borderBottom: `1px solid ${C.border}`,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>output</span>
            {manager.taskRunning
              ? (
                <span style={{ color: C.blue }}>
                  running {manager.taskRunning}…
                </span>
              )
              : manager.taskCode !== null
              ? (
                <span
                  style={{ color: manager.taskCode === 0 ? C.green : C.red }}
                >
                  {manager.taskCode >= 0
                    ? `exit ${manager.taskCode}`
                    : "stopped"}
                </span>
              )
              : ""}
          </div>
          <pre
            style={{
              margin: 0,
              padding: "12px 16px",
              fontFamily: mono,
              fontSize: "12px",
              color: C.text2,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: "420px",
              overflow: "auto",
              background: C.bg,
            }}
          >
            {manager.taskOutput || "…"}
          </pre>
        </div>
      )}
    </div>
  );
}

const ROOT = " root"; // collapse key for the synthetic root row
function FileBrowser(
  { nodes, truncated, baseDir, rootName }: {
    nodes: FileNode[];
    truncated: boolean;
    baseDir: string;
    rootName: string;
  },
) {
  const tree = nodes;
  const q = fileFilter.value.trim().toLowerCase();
  const collapsed = collapsedDirs.value;
  const fileCount = tree.filter((f) => !f.dir).length;
  const rootCollapsed = collapsed.has(ROOT) && !q;

  let visible: typeof tree;
  if (q) {
    // Filtering: show every file matching the query + its ancestor dirs (for
    // context). Collapse state is ignored so nothing hides a match.
    const keep = new Set<string>();
    for (const f of tree) {
      if (!f.dir && f.path.toLowerCase().includes(q)) {
        keep.add(f.path);
        const parts = f.path.split("/");
        for (let i = 1; i < parts.length; i++) {
          keep.add(parts.slice(0, i).join("/"));
        }
      }
    }
    visible = tree.filter((f) => keep.has(f.path));
  } else if (rootCollapsed) {
    visible = [];
  } else {
    // Default: expanded — a node hides only when an ancestor dir is collapsed.
    visible = tree.filter((f) => {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        if (collapsed.has(parts.slice(0, i).join("/"))) return false;
      }
      return true;
    });
  }
  const collapseAll = () => collapsedDirs.set(new Set([ROOT]));
  const expandAll = () => collapsedDirs.set(new Set());

  return (
    <div
      style={{
        display: "flex",
        gap: "14px",
        height: "100%",
        minHeight: "300px",
      }}
    >
      <div
        style={{
          ...card,
          padding: "0",
          width: "320px",
          minWidth: "320px",
          display: "flex",
          flexDirection: "column",
          maxHeight: "72vh",
        }}
      >
        <div
          style={{
            padding: "8px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          <input
            value={fileFilter.value}
            onInput={(e: Event) =>
              fileFilter.set((e.currentTarget as HTMLInputElement).value)}
            placeholder="filter files…"
            style={{
              padding: "6px 9px",
              borderRadius: "6px",
              border: `1px solid ${C.border}`,
              background: C.panel,
              color: C.text,
              fontSize: "12px",
              fontFamily: mono,
            }}
          />
          <div
            style={{
              display: "flex",
              gap: "6px",
              alignItems: "center",
              fontSize: "11px",
              color: C.dim,
            }}
          >
            <span
              onClick={expandAll}
              style={{ cursor: "pointer", color: C.blue }}
            >
              expand all
            </span>
            <span>·</span>
            <span
              onClick={collapseAll}
              style={{ cursor: "pointer", color: C.blue }}
            >
              collapse all
            </span>
            <span style={{ marginLeft: "auto" }}>{fileCount} files</span>
          </div>
        </div>
        <div style={{ overflowY: "auto", flex: 1, padding: "6px" }}>
          {tree.length === 0
            ? (
              <div style={{ color: C.dim, fontSize: "12px", padding: "6px" }}>
                no files
              </div>
            )
            : (
              <>
                {
                  /* Single foldable ROOT row — collapse it to fold the whole
                    tree into one item. Hidden while filtering. */
                }
                {!q && (
                  <div
                    onClick={() => toggleDir(ROOT)}
                    title={baseDir}
                    style={{
                      padding: "3px 6px",
                      fontFamily: mono,
                      fontSize: "12px",
                      cursor: "pointer",
                      color: C.text2,
                      fontWeight: 700,
                    }}
                  >
                    <span style={{ color: C.dim }}>
                      {rootCollapsed ? "▸ " : "▾ "}
                    </span>
                    📂 {rootName}
                  </div>
                )}
                {visible.length === 0 && q
                  ? (
                    <div
                      style={{ color: C.dim, fontSize: "12px", padding: "6px" }}
                    >
                      no files match “{q}”
                    </div>
                  )
                  : visible.map((f) => {
                    const depth = f.path.split("/").length - 1 + (q ? 0 : 1);
                    const open = f.dir && (q !== "" || !collapsed.has(f.path));
                    return (
                      <div
                        key={f.path}
                        onClick={() =>
                          f.dir
                            ? toggleDir(f.path)
                            : manager.openFile(baseDir, f.path)}
                        title={f.path}
                        style={{
                          padding: "3px 6px",
                          paddingLeft: `${6 + depth * 12}px`,
                          fontFamily: mono,
                          fontSize: "12px",
                          cursor: "pointer",
                          color: f.dir
                            ? C.text2
                            : (manager.openFilePath === f.path
                              ? C.blue
                              : C.text),
                          borderRadius: "5px",
                          background: manager.openFilePath === f.path
                            ? C.panel2
                            : "transparent",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        <span style={{ color: C.dim }}>
                          {f.dir ? (open ? "▾ " : "▸ ") : "  "}
                        </span>
                        {f.dir ? "📁 " : "📄 "}
                        {f.name}
                      </div>
                    );
                  })}
                {truncated && (
                  <div
                    style={{ color: C.dim, fontSize: "10px", padding: "6px" }}
                  >
                    … tree truncated (very large project)
                  </div>
                )}
              </>
            )}
        </div>
      </div>
      <div
        style={{
          ...card,
          flex: "1",
          minWidth: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          maxHeight: "70vh",
        }}
      >
        {manager.openFilePath
          ? (
            <>
              <div
                style={{
                  ...label,
                  padding: "10px 14px",
                  borderBottom: `1px solid ${C.border}`,
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span
                  style={{
                    color: C.text2,
                    textTransform: "none",
                    fontFamily: mono,
                  }}
                >
                  {manager.openFilePath}
                  {manager.fileTruncated ? " (truncated)" : ""}
                  {manager.openFileHint && (
                    <span style={{ color: C.blue, marginLeft: "10px" }}>
                      {manager.openFileHint}
                    </span>
                  )}
                </span>
                <span
                  onClick={() => manager.closeFile()}
                  style={{ cursor: "pointer" }}
                >
                  ✕
                </span>
              </div>
              {manager.fileNotice
                ? (
                  <div
                    style={{
                      padding: "24px",
                      color: C.yellow,
                      fontSize: "13px",
                      fontFamily: mono,
                    }}
                  >
                    ⓘ {manager.fileNotice}
                  </div>
                )
                : (
                  <pre
                    style={{
                      margin: 0,
                      padding: "12px 14px",
                      fontFamily: mono,
                      fontSize: "12px",
                      color: C.text2,
                      whiteSpace: "pre",
                      overflow: "auto",
                      flex: 1,
                      background: C.bg,
                    }}
                  >
                {highlight(manager.fileContent ?? "", manager.openFilePath)}
                  </pre>
                )}
            </>
          )
          : (
            <div style={{ color: C.dim, padding: "24px", fontSize: "13px" }}>
              select a file to view (read-only)
            </div>
          )}
      </div>
    </div>
  );
}

// Codebase — the app's files. Default source is the app's own runtime dir
// (source dir for dev, the unpacked mount for an AppImage, the binary's dir for
// a compiled build; eager-loaded by select). When the app lives inside a larger
// git repo (a monorepo) OR its runtime dir differs from the repo (an AppImage),
// a toggle switches to the whole repo tree (lazy-loaded). This is the merge of
// the old App-Files + Git-Repo tabs — one browser, source-aware.
let _codebaseReqPath: string | null = null;
function CodebaseTab({ d }: { d: ProjectDetail }) {
  const rt = manager.runtime;
  const appDir = rt?.root ?? d.path;
  const repoRoot = manager.repoRoot;
  // Offer the repo toggle only when it adds something (a different, broader root).
  const canRepo = repoRoot !== null && repoRoot !== appDir;
  const src = canRepo ? codebaseSrc.value : "app";

  if (src === "repo" && repoRoot) {
    if (
      typeof document !== "undefined" && manager.codebaseTree === null &&
      !manager.codebaseLoading && _codebaseReqPath !== d.path
    ) {
      _codebaseReqPath = d.path;
      manager.loadCodebase(d.path);
    }
  }

  const useRepo = src === "repo" && repoRoot !== null;
  const base = useRepo ? repoRoot! : appDir;
  const nodes = useRepo ? manager.codebaseTree : manager.fileTree;
  const truncated = useRepo
    ? manager.codebaseTruncated
    : manager.fileTreeTruncated;
  const kindColor = rt?.kind === "appimage" || rt?.kind === "compiled"
    ? C.yellow
    : C.blue;

  const srcPill = (id: "app" | "repo", text: string) => (
    <span
      onClick={() => codebaseSrc.set(id)}
      style={{
        ...chip,
        cursor: "pointer",
        border: `1px solid ${src === id ? C.blue : C.border}`,
        color: src === id ? C.blue : C.dim,
        background: src === id ? "rgba(88,166,255,0.10)" : C.panel,
      }}
    >
      {text}
    </span>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div
        style={{
          fontSize: "11px",
          fontFamily: mono,
          color: C.dim,
          display: "flex",
          gap: "8px",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {rt && (
          <span
            style={{
              ...chip,
              color: kindColor,
              border: `1px solid ${C.border}`,
            }}
          >
            {rt.kind}
          </span>
        )}
        <span style={{ color: repoRoot ? C.green : C.dim }}>
          {repoRoot ? "git" : "no git"}
        </span>
        {canRepo && (
          <span style={{ display: "flex", gap: "6px", marginLeft: "4px" }}>
            {srcPill("app", "app dir")}
            {srcPill("repo", "repo root")}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: C.text2 }}>{base}</span>
      </div>
      {useRepo && nodes === null
        ? <Empty msg="loading codebase…" />
        : (
          <FileBrowser
            nodes={nodes ?? []}
            truncated={truncated}
            baseDir={base}
            rootName={base.split("/").pop() || base}
          />
        )}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div style={{ color: C.dim, padding: "20px", fontSize: "13px" }}>{msg}</div>
  );
}

function Detail({ d }: { d: ProjectDetail }) {
  const t = activeTab.value;
  return (
    <div
      style={{
        flex: "1",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <Header d={d} />
      <div style={{ padding: "20px 24px", overflowY: "auto", flex: "1" }}>
        {t === "overview" && <Overview d={d} />}
        {t === "cells" && <CellsTab d={d} />}
        {t === "state" && <StateTab d={d} />}
        {t === "metrics" && <MetricsTab d={d} />}
        {t === "logs" && <LogsTab d={d} />}
        {t === "tasks" && <TasksTab d={d} />}
        {t === "codebase" && <CodebaseTab d={d} />}
      </div>
    </div>
  );
}

// ── app ──────────────────────────────────────────────────────────────────────
export default function App() {
  onMount(() => {
    if (typeof document === "undefined") return;
    // Live metric poll for the selected running app.
    const tick = setInterval(() => {
      if (manager.selectedPath && manager.detail?.running) manager.tick();
    }, 2500);
    // Periodic rescan to catch apps starting/stopping.
    const scan = setInterval(() => {
      if (!manager.scanning && manager.taskRunning === null) manager.discover();
    }, 9000);
    // Log follow — re-tail while the Logs tab is open, following is on, and the
    // app is running (a stopped app's log is static — no point re-reading).
    const logs = setInterval(() => {
      if (
        activeTab.value === "logs" && manager.logFollow &&
        manager.selectedPath && manager.detail?.running && !manager.logLoading
      ) {
        manager.loadLogs(manager.selectedPath);
      }
    }, 2000);
    return () => {
      clearInterval(tick);
      clearInterval(scan);
      clearInterval(logs);
    };
  });

  const d = manager.detail;
  // Reset the JSON tree expansion when switching projects.
  if (d && d.path !== _lastPath) {
    _lastPath = d.path;
    resetTree();
    resetStateView();
    resetFiles();
    resetLogView();
    codebaseSrc.set("app");
    _stateReqPath = null;
    _codebaseReqPath = null;
    _logReqPath = null;
  }
  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        margin: 0,
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: C.bg,
        color: C.text,
        overflow: "hidden",
      }}
    >
      <Sidebar />
      {d ? <Detail d={d} /> : (
        <div
          style={{
            flex: "1",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: "8px",
            color: C.dim,
          }}
        >
          <div style={{ fontSize: "15px" }}>select a project</div>
          <div style={{ fontSize: "13px" }}>
            {manager.projects.length} found ·{" "}
            {manager.projects.filter((p) => p.running).length} running
          </div>
        </div>
      )}
    </div>
  );
}
