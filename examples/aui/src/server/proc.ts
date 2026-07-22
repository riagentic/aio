// Process + filesystem control for a project — server-side, dynamic-imported.
// Every path operation is confined to the project dir (no traversal), spawns
// are detached so a started app survives aui, and outputs are size-capped.
import { join, normalize, relative } from "@std/path";

const LOG_MAX = 200_000; // cap captured task output
const FILE_MAX = 400_000; // cap file viewer reads

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

/** Start a project's app (detached — survives aui). Returns { ok, pid?, error? }.
 *  `client` picks the shell (browser is safe/instant; others as-is). */
export async function startApp(
  dir: string,
  client: "browser" | "electron" | "server-only" = "browser",
): Promise<{ ok: boolean; pid?: number; error?: string }> {
  const entry = await resolveEntry(dir);
  if (!entry) return { ok: false, error: "no entry (src/app.ts) found" };
  const logFile = join(dir, ".aio-aui-start.log");
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
    const { trojanPost } = await import("../../../../src/am/am-http.ts");
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

const TASK_TIMEOUT = 300_000; // 5 min hard cap — no task hangs aui forever

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

/** Read a file's content (text, size-capped, traversal-guarded). */
export async function readFile(
  dir: string,
  rel: string,
): Promise<
  { ok: boolean; content?: string; truncated?: boolean; error?: string }
> {
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
    const bytes = await Deno.readFile(real);
    // Binary sniff: a NUL byte in the first 8KB → not a text file. Showing it
    // as garbled replacement chars helps no one.
    const probe = bytes.subarray(0, 8192);
    if (probe.includes(0)) {
      return {
        ok: false,
        error: `binary file (${
          (bytes.length / 1024).toFixed(1)
        } KB) — not shown`,
      };
    }
    const truncated = bytes.length > FILE_MAX;
    const slice = truncated ? bytes.slice(0, FILE_MAX) : bytes;
    const content = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    return { ok: true, content, truncated };
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
