// Project discovery — server-side. Finds aio projects two ways:
//  1. running instances (lock registry) → their `cwd` is the project folder
//  2. an on-disk scan of root dirs for folders whose deno.json imports aio
// Merged by absolute path. Dynamic-imported by the manager cell (keeps
// node/Deno bits out of the browser bundle).
import { join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";

export interface ProjectMeta {
  name: string;
  version: string | null;
  /** aio build target from deno.json ("browser"|"electron"|…) or null. */
  target: string | null;
  /** deno.json task name → command. */
  tasks: Record<string, string>;
  /** Whether the deno.json imports the aio framework. */
  isAio: boolean;
}

export interface DiscoveredProject {
  /** Absolute project directory — the stable identity. */
  path: string;
  /** Display name (deno.json title/name, else folder name). */
  name: string;
  meta: ProjectMeta;
  /** Running instance info (present when the app is up). */
  running: {
    appId: string;
    pid: number;
    port: number;
    status: "starting" | "started" | "stopping";
  } | null;
  /** true when a `.git` dir is present. */
  git: boolean;
  /** true for amui itself. amui is an aio app like any other, so it appears in
   *  its own list and every monitoring surface works on it — but it must never
   *  offer to start/stop/restart itself (that would spawn a second manager or
   *  kill the one you're looking at), so the UI and the lifecycle methods both
   *  refuse. */
  self?: boolean;
}

/** amui's own project directory, from the module path. Correct while running
 *  from source; inside a compiled binary this points into the compile VFS, so
 *  it is only ONE of the signals `selfPaths()` uses. */
export function selfDir(): string {
  return decodeURIComponent(new URL("../..", import.meta.url).pathname).replace(
    /\/$/,
    "",
  );
}

/** Every path that IS this amui process. The authoritative signal is the lock
 *  registry entry whose pid is ours — that holds in every mode (source, compiled
 *  binary, AppImage), where the module path does not. Getting this wrong is not
 *  cosmetic: an unmarked self entry offers a Stop button that kills the manager
 *  you are clicking in. */
export async function selfPaths(): Promise<Set<string>> {
  const paths = new Set<string>([selfDir()]);
  try {
    const { instances } = await import(
      "../../../src/server/single-instance-lock.ts"
    );
    for (const i of instances()) {
      if (i.pid === Deno.pid && i.cwd) paths.add(i.cwd);
    }
  } catch { /* registry unreadable — fall back to the module path */ }
  return paths;
}

const EMPTY_META: ProjectMeta = {
  name: "",
  version: null,
  target: null,
  tasks: {},
  isAio: false,
};

/** Parse a project's deno.json (or deno.jsonc). Never throws. */
export async function readProjectMeta(dir: string): Promise<ProjectMeta> {
  for (const f of ["deno.json", "deno.jsonc"]) {
    try {
      const raw = await Deno.readTextFile(join(dir, f));
      // Proper JSONC parse — a regex stripper mishandles trailing `//` comments
      // and `//` inside string values, silently dropping the project.
      const j = parseJsonc(raw) as {
        title?: string;
        name?: string;
        version?: string;
        target?: string;
        tasks?: Record<string, string>;
        imports?: Record<string, string>;
      };
      const imports = j.imports ?? {};
      const isAio = "aio" in imports ||
        Object.values(imports).some((v) => /\baio\b/.test(v)) ||
        !!j.target;
      return {
        name: j.title ?? j.name ?? "",
        version: j.version ?? null,
        target: j.target ?? null,
        tasks: j.tasks ?? {},
        isAio,
      };
    } catch { /* try next / not present */ }
  }
  return { ...EMPTY_META };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

/** Scan `roots` (each up to `depth` levels) for aio project folders. */
async function scanDisk(
  roots: string[],
  depth: number,
): Promise<Map<string, DiscoveredProject>> {
  const out = new Map<string, DiscoveredProject>();
  const seenRoots = new Set<string>();

  async function walk(dir: string, left: number): Promise<void> {
    if (left < 0) return;
    // A dir with a deno.json is a candidate project — check it, don't recurse in.
    const meta = await readProjectMeta(dir);
    if (meta.isAio) {
      out.set(dir, {
        path: dir,
        name: meta.name || dir.split("/").filter(Boolean).pop() || dir,
        meta,
        running: null,
        git: await isDir(join(dir, ".git")),
      });
      return; // don't descend into a project's own subdirs
    }
    if (left === 0) return;
    try {
      for await (const e of Deno.readDir(dir)) {
        if (!e.isDirectory) continue;
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const child = join(dir, e.name);
        if (NEVER_WALK.has(child)) continue;
        await walk(child, left - 1);
      }
    } catch { /* unreadable dir */ }
  }

  for (const root of roots) {
    const abs = root;
    if (seenRoots.has(abs) || !(await isDir(abs))) continue;
    seenRoots.add(abs);
    await walk(abs, depth);
  }
  return out;
}

const seg = (p: string) => p.split("/").filter(Boolean).length;

/** Directories a project can never live in, skipped during traversal however we
 *  got there. Pseudo-filesystems (`/proc`, `/sys`, `/dev`) are infinite or
 *  meaningless to walk; `/run`, `/tmp`, `/var` are machine state; `/mnt` and
 *  `/media` can be network mounts whose readDir blocks for seconds.
 *
 *  This is a TRAVERSAL filter, not a veto on configuration: an explicit
 *  `AMUI_ROOTS=/mnt/projects` is honoured exactly as given. */
const NEVER_WALK = new Set([
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/boot",
  "/tmp",
  "/var",
  "/etc",
  "/usr",
  "/lib",
  "/lib64",
  "/bin",
  "/sbin",
  "/snap",
  "/mnt",
  "/media",
  "/lost+found",
]);

/** Default scan roots, most-specific first:
 *  - $AMUI_ROOTS (colon-separated, explicit override — used verbatim)
 *  - ~/aio-apps (where `am create` scaffolds)
 *  - $HOME itself, so a project is found wherever the developer actually keeps
 *    it (`~/code/gen/wallet`, `~/work/clients/x`) without any configuration.
 *    That is affordable because the walk stops at the first `deno.json`, skips
 *    dot-dirs and `node_modules`, is depth-capped, and never enters the
 *    system paths above — not because the tree is small.
 *  - the parent dir of any running app (its siblings are usually projects too)
 *
 *  Running apps themselves are never scanned for: their lock files carry pid,
 *  port and cwd, so they are found instantly wherever they live. The scan only
 *  exists to list projects that are NOT currently running. */
function defaultRoots(runningCwds: string[]): string[] {
  const home = Deno.env.get("HOME") ?? ".";
  const roots = new Set<string>();

  for (const r of (Deno.env.get("AMUI_ROOTS") ?? "").split(":")) {
    if (r.trim()) roots.add(r.trim());
  }
  roots.add(`${home}/aio-apps`);
  roots.add(home);

  for (const cwd of runningCwds) {
    const parent = cwd.split("/").slice(0, -1).join("/");
    if (parent && parent.startsWith(home) && seg(parent) >= 3) {
      roots.add(parent);
    }
  }
  return [...roots];
}

/** Discover every aio project: running instances (with cwd) ∪ on-disk scan.
 *  Returns the projects plus the roots searched (surfaced in the empty state so
 *  "found nothing" is diagnosable, not a mystery). */
export async function discoverProjects(): Promise<
  { projects: DiscoveredProject[]; roots: string[] }
> {
  const { instances } = await import(
    "../../../src/server/single-instance-lock.ts"
  );
  // amui is itself an aio app — it stays in the list so it can monitor its own
  // cells, state, metrics and logs like any other app. Only its LIFECYCLE is
  // special (no start/stop/restart on yourself), which `self` marks below.
  const running = instances().filter((i) => i.alive);
  const roots = defaultRoots(running.map((i) => i.cwd));
  // Depth 3 from each root: `~/code/gen/wallet` is three levels under $HOME,
  // which is where projects actually sit. The walk stops at the first project it
  // finds, so depth buys reach without multiplying work inside a monorepo.
  const byPath = await scanDisk(roots, 3);

  // Drop the aio framework repo root (amui lives inside it) — the framework is
  // not an app. decodeURIComponent so a path with spaces still matches the
  // decoded disk-path keys.
  const dirOf = (rel: string) =>
    decodeURIComponent(new URL(rel, import.meta.url).pathname).replace(
      /\/$/,
      "",
    );
  const self = await selfPaths();
  byPath.delete(dirOf("../../..")); // repo root — the framework

  // amui's own project dir is never reached by the disk walk: the framework
  // repo root is itself an aio project, and the walk deliberately does not
  // descend into a project's subdirs. Add it explicitly so amui lists itself
  // whether or not the registry happens to know about this process.
  for (const p of self) {
    if (byPath.has(p)) continue;
    const meta = await readProjectMeta(p);
    if (!meta.isAio) continue;
    byPath.set(p, {
      path: p,
      name: meta.name || p.split("/").filter(Boolean).pop() || p,
      meta,
      running: null,
      git: await isDir(join(p, ".git")),
    });
  }

  // Overlay running instances (authoritative for their path).
  for (const i of running) {
    const existing = byPath.get(i.cwd);
    const meta = existing?.meta ?? await readProjectMeta(i.cwd);
    byPath.set(i.cwd, {
      path: i.cwd,
      name: existing?.name || meta.name || i.appId,
      meta,
      running: { appId: i.appId, pid: i.pid, port: i.port, status: i.status },
      git: existing?.git ?? await isDir(join(i.cwd, ".git")),
    });
  }

  for (const p of self) {
    const entry = byPath.get(p);
    if (entry) entry.self = true;
  }

  const projects = [...byPath.values()].sort((a, b) => {
    // running first, then by name
    if (!!a.running !== !!b.running) return a.running ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { projects, roots };
}

/** Exported for tests — the root set and the traversal denylist are the two
 *  things that decide whether discovery is both complete and cheap. */
export const _internals = { defaultRoots, NEVER_WALK } as const;
