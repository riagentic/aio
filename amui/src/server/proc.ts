// Process + filesystem control for a project — server-side, dynamic-imported.
// Every path operation is confined to the project dir (no traversal), spawns
// are detached so a started app survives amui, and outputs are size-capped.
import { join, normalize, relative } from "@std/path";

const LOG_MAX = 200_000; // cap captured task output
const VIEW_MAX = 2_000_000; // 2 MB — files larger than this show a size notice

/** Resolve `rel` INSIDE `root`, or null if it escapes (path-traversal guard). */
function safeJoin(root: string, rel: string): string | null {
  const abs = normalize(join(root, rel));
  const r = relative(root, abs);
  if (r.startsWith("..") || r.startsWith("/")) return null;
  return abs;
}

/** Resolve a project's dev entry (src/app.ts › src/main.ts › app.ts › main.ts). */
async function resolveEntry(dir: string): Promise<string | null> {
  for (const e of ["src/app.ts", "src/main.ts", "app.ts", "main.ts"]) {
    try {
      await Deno.stat(join(dir, e));
      return e;
    } catch { /* next */ }
  }
  return null;
}

/** Start a project's app (detached — survives amui). Returns { ok, pid?, error? }.
 *  `client` picks the shell (browser is safe/instant; others as-is). */
export async function startApp(
  dir: string,
  client: "browser" | "electron" | "server-only" = "browser",
): Promise<{ ok: boolean; pid?: number; error?: string }> {
  const entry = await resolveEntry(dir);
  if (!entry) return { ok: false, error: "no entry (src/app.ts) found" };
  const logFile = join(dir, ".aio-amui-start.log");
  const esc = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const inner = `deno run -A --unstable-kv ${esc(entry)} --client=${client}`;
  const cmd = `nohup ${inner} >${esc(logFile)} 2>&1 & echo $!`;
  try {
    const out = await new Deno.Command("sh", {
      args: ["-c", cmd],
      cwd: dir,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    const pid = parseInt(new TextDecoder().decode(out.stdout).trim(), 10);
    return { ok: true, pid: Number.isFinite(pid) ? pid : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Stop a running app: trojan shutdown first (graceful), SIGTERM as fallback. */
export async function stopApp(
  port: number,
  appId: string,
  pid: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { trojanPost } = await import("../../../src/am/am-http.ts");
    const r = await trojanPost(port, "shutdown", undefined, appId);
    if (r.ok) return { ok: true };
  } catch { /* fall through to signal */ }
  try {
    Deno.kill(pid, "SIGTERM");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const TASK_TIMEOUT = 300_000; // 5 min hard cap — no task hangs amui forever

/** Run `deno task <task>` in the project; capture combined output (capped).
 *  ALWAYS terminates: killed on `signal` abort (user cancel) or after
 *  TASK_TIMEOUT. `ended` says why ("" = ran to completion). This is what keeps
 *  a long-running task (dev/watch/live) from wedging the runner forever. */
export async function runTask(
  dir: string,
  task: string,
  signal?: AbortSignal,
  timeoutMs = TASK_TIMEOUT,
): Promise<
  {
    ok: boolean;
    code: number;
    output: string;
    ended: "" | "cancelled" | "timeout";
  }
> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("deno", {
      args: ["task", task],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).spawn();
  } catch (e) {
    return {
      ok: false,
      code: -1,
      output: `failed to spawn: ${e instanceof Error ? e.message : e}`,
      ended: "",
    };
  }
  let ended: "" | "cancelled" | "timeout" = "";
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
    // Escalate if it ignores SIGTERM (timer cleared in finally once it exits).
    sigkillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* gone */ }
    }, 2000);
  };
  const onAbort = () => {
    ended = "cancelled";
    kill();
  };
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => {
    ended = "timeout";
    kill();
  }, timeoutMs);
  try {
    const out = await child.output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    return {
      ok: !ended && out.code === 0,
      code: ended ? -1 : out.code,
      output: text.length > LOG_MAX ? text.slice(-LOG_MAX) : text,
      ended,
    };
  } finally {
    clearTimeout(timer);
    if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface FileNode {
  path: string; // relative to project root
  name: string;
  dir: boolean;
}

const FILE_CAP = 1200; // max nodes surfaced (keeps the tree responsive)
const FILE_DEPTH = 6; // max recursion depth

// Directories never worth showing a developer: VCS, deps, build output, caches.
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".aio",
  ".cache",
  ".venv",
  "venv",
  "vendor",
  "dep", // aio apps mirror the framework into dep/ — huge, not their code
  "target", // rust
  "coverage",
  "cov_profile",
  "pkg-web",
  ".next",
  ".turbo",
]);
const isJunkFile = (n: string) =>
  n === "data.db" || n.endsWith(".db-wal") || n.endsWith(".db-shm") ||
  n.endsWith(".lock") || n.endsWith(".log");

export interface RuntimeInfo {
  kind: "dev" | "compiled" | "appimage" | "unknown";
  root: string; // the dir whose files ARE the runtime (what App Files lists)
  exe: string | null; // the running executable
  label: string; // human summary for the header
}

/** Inspect a running app's process to describe its RUNTIME (what's actually
 *  executing), from /proc on Linux: dev = deno running source (runtime = its
 *  cwd), AppImage = the mounted squashfs (unpacked contents + location), a
 *  `deno compile` binary = the binary's dir. Falls back to the project dir. */
export async function runtimeInfo(
  pid: number,
  projectDir: string,
): Promise<RuntimeInfo> {
  const readLink = async (p: string) => {
    try {
      return await Deno.readLink(p);
    } catch {
      return null;
    }
  };
  const exe = await readLink(`/proc/${pid}/exe`);
  const cwd = await readLink(`/proc/${pid}/cwd`);
  if (!exe) {
    return {
      kind: "unknown",
      root: projectDir,
      exe: null,
      label: "runtime = project dir",
    };
  }
  // AppImage: the exe lives under a /tmp/.mount_XXXX squashfs mount.
  const mount = exe.match(/^(.*\/\.mount_[^/]+)\//);
  if (mount) {
    return {
      kind: "appimage",
      root: mount[1]!,
      exe,
      label: `AppImage — unpacked at ${mount[1]}`,
    };
  }
  const base = exe.split("/").pop() ?? "";
  if (base === "deno" || base.startsWith("deno")) {
    return {
      kind: "dev",
      root: cwd ?? projectDir,
      exe,
      label: "dev — deno running from source",
    };
  }
  // Standalone compiled binary — its own directory is the runtime root.
  return {
    kind: "compiled",
    root: exe.split("/").slice(0, -1).join("/"),
    exe,
    label: `compiled binary — ${exe}`,
  };
}

/** Walk up from `dir` to the enclosing git repository root (first ancestor with
 *  a `.git`). Returns null when the app isn't inside a repo. Lets the Codebase
 *  tab show the whole repo when the app is a subdir of a larger monorepo. */
export async function findRepoRoot(dir: string): Promise<string | null> {
  let cur = dir;
  for (let i = 0; i < 12; i++) {
    try {
      const st = await Deno.stat(join(cur, ".git"));
      if (st.isDirectory || st.isFile) return cur; // .git dir or worktree file
    } catch { /* keep walking up */ }
    const parent = cur.split("/").slice(0, -1).join("/");
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return null;
}

/** List the project's source tree (whole codebase minus deps/build/VCS junk,
 *  capped). Lets a developer browse everything, not just src/. `truncated` is
 *  true when the cap was hit. */
export async function listFiles(
  dir: string,
): Promise<{ nodes: FileNode[]; truncated: boolean }> {
  const nodes: FileNode[] = [];
  let count = 0;
  let truncated = false;
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > FILE_DEPTH) return;
    const abs = join(dir, rel);
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(abs)) entries.push(e);
    } catch {
      return; // unreadable
    }
    entries.sort((a, b) =>
      (a.isDirectory === b.isDirectory)
        ? a.name.localeCompare(b.name)
        : (a.isDirectory ? -1 : 1)
    );
    for (const e of entries) {
      if (e.isDirectory && IGNORE_DIRS.has(e.name)) continue;
      if (!e.isDirectory && isJunkFile(e.name)) continue;
      if (count >= FILE_CAP) {
        truncated = true;
        return;
      }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      count++;
      nodes.push({ path: childRel, name: e.name, dir: e.isDirectory });
      if (e.isDirectory) await walk(childRel, depth + 1);
    }
  }
  await walk("", 0);
  return { nodes, truncated };
}

/** Read a file's content (text; oversized/binary files are refused with a
 *  message, not opened; traversal- and symlink-guarded). */
export async function readFile(
  dir: string,
  rel: string,
): Promise<{
  ok: boolean;
  content?: string;
  truncated?: boolean;
  tooLarge?: boolean;
  binary?: boolean;
  error?: string;
}> {
  const abs = safeJoin(dir, rel);
  if (!abs) return { ok: false, error: "path outside project" };
  try {
    // Resolve symlinks and re-check containment — safeJoin is lexical, so a
    // symlink INSIDE the project pointing at /etc/passwd would otherwise be
    // readable through the viewer.
    const real = await Deno.realPath(abs);
    const root = await Deno.realPath(dir);
    if (real !== root && !real.startsWith(root + "/")) {
      return { ok: false, error: "path outside project" };
    }
    const info = await Deno.stat(real);
    if (info.isDirectory) return { ok: false, error: "is a directory" };
    // Too large to view — refuse with a message rather than freezing the pane
    // (check size via stat, before reading the file into memory).
    if (info.size > VIEW_MAX) {
      return {
        ok: false,
        tooLarge: true,
        error: `too large to view — ${(info.size / 1_048_576).toFixed(1)} MB ` +
          `(limit ${
            (VIEW_MAX / 1_048_576).toFixed(0)
          } MB). Open it in your editor.`,
      };
    }
    const bytes = await Deno.readFile(real);
    // Binary sniff: a NUL byte in the first 8KB → not a text file. Showing it
    // as garbled replacement chars helps no one.
    const probe = bytes.subarray(0, 8192);
    if (probe.includes(0)) {
      return {
        ok: false,
        binary: true,
        error: `binary file (${
          (bytes.length / 1024).toFixed(1)
        } KB) — not shown`,
      };
    }
    const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const truncated = false;
    return { ok: true, content, truncated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Scaffold a new aio app via `am create` in ~/aio-apps/<name>. `name` must be
 *  a pre-sanitized slug. Server-only (spawns a process) — dynamic-imported from
 *  the cell so no Deno.* lands in the browser bundle. */
export async function createApp(
  name: string,
): Promise<{ ok: boolean; dir?: string; error?: string }> {
  try {
    // decodeURIComponent: a repo path with spaces arrives as %20 in .pathname;
    // passed raw as CLI args it would resolve to a non-existent path.
    const amPath = decodeURIComponent(
      new URL("../../../src/am.ts", import.meta.url).pathname,
    );
    const repoPath = decodeURIComponent(
      new URL("../../../", import.meta.url).pathname,
    );
    const home = Deno.env.get("HOME") ?? ".";
    const workspace = `${home}/aio-apps`;
    await Deno.mkdir(workspace, { recursive: true });
    const out = await new Deno.Command("deno", {
      args: [
        "run",
        "-A",
        amPath,
        "create",
        name,
        `--mirror=${repoPath}`,
      ],
      cwd: workspace,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return out.code === 0 ? { ok: true, dir: `${workspace}/${name}` } : {
      ok: false,
      error: new TextDecoder().decode(out.stderr).slice(0, 200),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** CPU% + RSS(MB) for a pid (server-side `ps`). Null on failure. */
export async function psStats(
  pid: number,
): Promise<{ cpuPct: number; memMb: number } | null> {
  try {
    const out = await new Deno.Command("ps", {
      args: ["-o", "%cpu=,rss=", "-p", String(pid)],
      stdout: "piped",
      stderr: "null",
    }).output();
    const line = new TextDecoder().decode(out.stdout).trim();
    const [cpu, rss] = line.split(/\s+/);
    const cpuPct = Number(cpu);
    const rssKb = Number(rss);
    // Reject non-finite samples — a NaN would poison the chart history
    // (peak/ceil → NaN → the whole area path blanks + "NaN %" in the header).
    if (!Number.isFinite(cpuPct) || !Number.isFinite(rssKb)) return null;
    return { cpuPct, memMb: Math.round(rssKb / 1024) };
  } catch {
    return null;
  }
}

/** Locate the file that defines `cell("<name>", …)` under `root`. Scans source
 *  files (reusing listFiles' bounded, junk-ignoring walk), returns the first
 *  match's project-relative path + 1-based line, or null when not found (e.g. a
 *  compiled binary with no source alongside it). */
export async function findCellSource(
  root: string,
  cellName: string,
): Promise<{ rel: string; line: number } | null> {
  const esc = cellName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // cell( <ws> "name" | 'name' | `name`
  const re = new RegExp("\\bcell\\s*\\(\\s*[\"'`]" + esc + "[\"'`]");
  const { nodes } = await listFiles(root);
  const srcFiles = nodes.filter((n) => !n.dir && /\.(tsx?|jsx?)$/.test(n.name));
  for (const f of srcFiles) {
    try {
      const p = join(root, f.path);
      const st = await Deno.stat(p);
      // Only regular files under the size cap — a `.ts` symlink pointing at a
      // FIFO/char-device (e.g. /dev/zero) reports size 0 and would never EOF.
      if (!st.isFile || st.size > 1_000_000) continue;
      const text = await Deno.readTextFile(p);
      const idx = text.search(re);
      if (idx >= 0) {
        return { rel: f.path, line: text.slice(0, idx).split("\n").length };
      }
    } catch { /* unreadable — next */ }
  }
  return null;
}

// ── logs ─────────────────────────────────────────────────────────────────────
// aio writes plain-text logs to <cwd>/.aio/log/{app,error,warning,client}.log
// (framework + log.* app lines). The single <cwd>/.aio.log (or amui's own
// .aio-amui-start.log) additionally captures raw stdout+stderr — cell
// console.log + stack traces — but only when the launcher redirected output.
// No streaming endpoint exists, so we tail the file (offset-free: read the last
// LOG_TAIL_MAX bytes and keep the final N lines).
export type LogSource = "combined" | "app" | "error" | "client";

export interface RawLog {
  lines: string[];
  path: string | null; // the file actually read (null = none found)
  truncated: boolean; // older lines/bytes were dropped
  missing: boolean; // no candidate file existed
}

const LOG_TAIL_MAX = 512 * 1024; // read at most the last 512 KB of a log

/** Candidate files for a source, richest-first. "combined" prefers the merged
 *  stdout capture, falling back to the always-present framework log. */
function logCandidates(source: LogSource): string[] {
  switch (source) {
    case "app":
      return [".aio/log/app.log"];
    case "error":
      return [".aio/log/error.log"];
    case "client":
      return [".aio/log/client.log"];
    default: // combined
      return [".aio.log", ".aio-amui-start.log", ".aio/log/app.log"];
  }
}

/** Tail an app's logs. `cwd` is the app's working dir (== project path for a
 *  dev app; the lock cwd for a running instance). Reads the last LOG_TAIL_MAX
 *  bytes, strips ANSI, and returns the final `tailLines` non-empty lines. */
export async function readLogs(
  cwd: string,
  source: LogSource = "combined",
  tailLines = 500,
): Promise<RawLog> {
  for (const rel of logCandidates(source)) {
    const p = join(cwd, rel);
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(p);
    } catch {
      continue; // not present — try the next candidate
    }
    if (!stat.isFile) continue;
    let text: string;
    let bytesDropped = false;
    try {
      if (stat.size > LOG_TAIL_MAX) {
        using f = await Deno.open(p, { read: true });
        await f.seek(stat.size - LOG_TAIL_MAX, Deno.SeekMode.Start);
        const buf = new Uint8Array(LOG_TAIL_MAX);
        let off = 0;
        while (off < buf.length) {
          const n = await f.read(buf.subarray(off));
          if (n === null) break;
          off += n;
        }
        text = new TextDecoder().decode(buf.subarray(0, off));
        bytesDropped = true;
      } else {
        text = await Deno.readTextFile(p);
      }
    } catch {
      continue;
    }
    // deno-lint-ignore no-control-regex -- intentional: strip ANSI SGR escapes
    const stripped = text.replace(/\x1b\[[0-9;]*m/g, ""); // drop ANSI colors
    const all = stripped.split("\n").filter((l) => l.length > 0);
    const lines = all.slice(-tailLines);
    return {
      lines,
      path: p,
      truncated: bytesDropped || all.length > tailLines,
      missing: false,
    };
  }
  return { lines: [], path: null, truncated: false, missing: true };
}
