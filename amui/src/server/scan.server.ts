// Project discovery — server-side. Finds aio projects two ways:
//  1. running instances (lock registry) → their `cwd` is the project folder
//  2. an on-disk scan of root dirs for folders whose deno.json imports aio
// Merged by absolute path. Dynamic-imported by the manager cell (keeps
// node/Deno bits out of the browser bundle).
import { basename, fromFileUrl, join } from "@std/path";
import * as posixPath from "@std/path/posix";
import * as windowsPath from "@std/path/windows";
// THE home rule ($HOME, else $USERPROFILE) — the framework's, not a second one.
import { homedir } from "../../../src/server/paths.ts";
import { parse as parseJsonc } from "@std/jsonc";
import type { LockData } from "../../../src/server/single-instance-lock.ts";

type OS = typeof Deno.build.os;

/** The path rules of `os` — so every path decision below is a pure function of
 *  the OS it is asked about, testable on any host. */
export const pathOf = (os: OS) => os === "windows" ? windowsPath : posixPath;

/** What two spellings of one directory share: normalized, no trailing
 *  separator, and caseless on Windows (where `C:\Users` is `c:\users`). */
export function pathKey(os: OS, p: string): string {
  const P = pathOf(os);
  const n = P.normalize(p);
  const bare = n.length > P.parse(n).root.length
    ? n.replace(os === "windows" ? /[\\/]+$/ : /\/+$/, "")
    : n;
  return os === "windows" ? bare.toLowerCase() : bare;
}

export interface ProjectMeta {
  name: string;
  version: string | null;
  /** aio build target from deno.json ("browser"|"electron"|…) or null. */
  target: string | null;
  /** deno.json task name → command. */
  tasks: Record<string, string>;
  /** Whether the deno.json imports the aio framework. */
  isAio: boolean;
  /** The app's DECLARED entry point (deno.json `"entry"`), or null when it uses
   *  the convention. This is the field `am start` resolves first
   *  (src/am/am-utils.ts `resolveEntry`) — parsed HERE, once, so amui's start
   *  button and `am start` can never pick different files. */
  entry: string | null;
}

export interface DiscoveredProject {
  /** THE list identity — what select/stop/restart address. The directory
   *  alone is not one: two instances can run from one directory (profiles,
   *  two components, two binaries in one `dist/`), and keying by path folded
   *  them into one entry, so one vanished and Stop could hit the other. A
   *  running instance is `path#appId#home` (unique: the lock allows one live
   *  holder per appId+home); a project that is not running is its `path`. */
  id: string;
  /** Absolute project directory — what the files/logs/tasks views read. */
  path: string;
  /** Display name (deno.json title/name, else folder name). */
  name: string;
  meta: ProjectMeta;
  /** Running instance info (present when the app is up). */
  running: {
    appId: string;
    pid: number;
    port: number;
    /** THE lock's status union. One decider: never a hand-copied subset. */
    status: LockData["status"];
    /** Set when the holder is `am backup`/`am restore`, not the app — read
     *  it BEFORE `status` (which then says "starting" for older readers). */
    maintenance?: LockData["maintenance"];
    /** The instance's data home and profile — what tells two instances of
     *  one appId apart, and what a restart must boot again. */
    home?: string;
    profile?: string;
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
  return decodeURIComponent(fromFileUrl(new URL("../..", import.meta.url)))
    // The host's separator: on Windows the path ends in `\`, and left on it
    // matched no lock cwd — amui did not recognise itself.
    .replace(/[\\/]$/, "");
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
      "./control.server.ts"
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
  entry: null,
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
        client?: string;
        target?: string;
        entry?: string;
        tasks?: Record<string, string>;
        imports?: Record<string, string>;
      };
      const imports = j.imports ?? {};
      // `client` is the key since alpha52 (what `am create` writes and the
      // runtime reads); `target` is its old spelling, still read.
      const shell = j.client ?? j.target ?? null;
      const isAio = "aio" in imports ||
        Object.values(imports).some((v) => /\baio\b/.test(v)) ||
        !!shell;
      return {
        name: j.title ?? j.name ?? "",
        version: j.version ?? null,
        target: shell,
        tasks: j.tasks ?? {},
        isAio,
        entry: typeof j.entry === "string" && j.entry ? j.entry : null,
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
  const never = neverWalk(Deno.build.os, homedir(), (k) => Deno.env.get(k));

  async function walk(dir: string, left: number): Promise<void> {
    if (left < 0) return;
    // A dir with a deno.json is a candidate project — check it, don't recurse in.
    const meta = await readProjectMeta(dir);
    if (meta.isAio) {
      out.set(dir, {
        id: dir,
        path: dir,
        name: meta.name || basename(dir) || dir,
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
        if (never.has(pathKey(Deno.build.os, child))) continue;
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

/** Directories a project can never live in, skipped during traversal however we
 *  got there. Pseudo-filesystems (`/proc`, `/sys`, `/dev`) are infinite or
 *  meaningless to walk; `/run`, `/tmp`, `/var` are machine state; `/mnt` and
 *  `/media` can be network mounts whose readDir blocks for seconds.
 *
 *  Windows and macOS get what those protect THERE. System and machine state:
 *  `%SystemRoot%`, both `Program Files`, `%ProgramData%`, the volume's own
 *  bookkeeping; `/System`, `/Library`, `/private` (where `/tmp`, `/var` and
 *  `/etc` really are), `/Volumes` (the mounts). And the user's app state:
 *  on Linux that is dot-dirs (`~/.config`, `~/.ssh`), which the walk skips by
 *  name; `%USERPROFILE%\AppData` and `~/Library` are the same thing without
 *  the dot — browser profiles, keychains, credential stores, and enormous.
 *
 *  This is a TRAVERSAL filter, not a veto on configuration: an explicit
 *  `AMUI_ROOTS=/mnt/projects` is honoured exactly as given.
 *
 *  Keys are {@linkcode pathKey}s. Pure: the OS, the home and the environment
 *  are arguments. */
function neverWalk(
  os: OS,
  home: string,
  env: (k: string) => string | undefined,
): Set<string> {
  if (os === "windows") {
    const drive = env("SystemDrive") ?? "C:";
    return new Set(
      [
        env("SystemRoot") ?? `${drive}\\Windows`,
        env("ProgramFiles") ?? `${drive}\\Program Files`,
        env("ProgramFiles(x86)") ?? `${drive}\\Program Files (x86)`,
        env("ProgramData") ?? `${drive}\\ProgramData`,
        `${drive}\\$Recycle.Bin`,
        `${drive}\\System Volume Information`,
        `${drive}\\Recovery`,
        `${home}\\AppData`,
      ].map((p) => pathKey(os, p)),
    );
  }
  return new Set([
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
    ...(os === "darwin"
      ? [
        "/System",
        "/Library",
        "/private",
        "/Volumes",
        "/cores",
        pathKey(os, `${home}/Library`),
      ]
      : []),
  ]);
}

/** Default scan roots, most-specific first:
 *  - $AMUI_ROOTS (separated like PATH: `:`, `;` on Windows where a path
 *    holds a colon — explicit override, used verbatim)
 *  - ~/aio-apps (where `am create` scaffolds)
 *  - the home directory itself, so a project is found wherever the developer
 *    actually keeps it (`~/code/gen/wallet`, `~/work/clients/x`) without any
 *    configuration.
 *    That is affordable because the walk stops at the first `deno.json`, skips
 *    dot-dirs and `node_modules`, is depth-capped, and never enters the
 *    system paths above — not because the tree is small.
 *  - the parent dir of any running app (its siblings are usually projects too)
 *
 *  Running apps themselves are never scanned for: their lock files carry pid,
 *  port and cwd, so they are found instantly wherever they live. The scan only
 *  exists to list projects that are NOT currently running.
 *
 *  Pure — the OS, the home and `$AMUI_ROOTS` are arguments. */
function rootsFor(
  os: OS,
  home: string,
  amuiRoots: string,
  runningCwds: string[],
): string[] {
  const P = pathOf(os);
  const roots = new Set<string>();

  for (const r of amuiRoots.split(P.DELIMITER)) {
    if (r.trim()) roots.add(r.trim());
  }
  roots.add(P.join(home, "aio-apps"));
  roots.add(home);

  // Directories below the filesystem root (a drive is not one of them).
  const depth = (p: string) =>
    p.slice(P.parse(p).root.length).split(P.SEPARATOR_PATTERN).filter(Boolean)
      .length;
  for (const cwd of runningCwds) {
    const parent = P.dirname(cwd);
    if (
      parent !== cwd && pathKey(os, parent).startsWith(pathKey(os, home)) &&
      depth(parent) >= 3
    ) {
      roots.add(parent);
    }
  }
  return [...roots];
}

const defaultRoots = (runningCwds: string[]): string[] =>
  rootsFor(
    Deno.build.os,
    homedir(),
    Deno.env.get("AMUI_ROOTS") ?? "",
    runningCwds,
  );

/** How to name more roots, in the spelling of the OS the SERVER runs on — the
 *  hint is read in a browser, which cannot know. */
export const rootsExample = (os: OS): string =>
  os === "windows"
    ? "AMUI_ROOTS=C:\\path;D:\\path2"
    : "AMUI_ROOTS=/path:/path2";

/** Discover every aio project: running instances (with cwd) ∪ on-disk scan.
 *  Returns the projects plus the roots searched (surfaced in the empty state so
 *  "found nothing" is diagnosable, not a mystery). */
export async function discoverProjects(): Promise<
  { projects: DiscoveredProject[]; roots: string[]; rootsExample: string }
> {
  const { instances } = await import(
    "./control.server.ts"
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
    decodeURIComponent(fromFileUrl(new URL(rel, import.meta.url))).replace(
      /[\\/]$/,
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
      id: p,
      path: p,
      name: meta.name || basename(p) || p,
      meta,
      running: null,
      git: await isDir(join(p, ".git")),
    });
  }

  // Overlay running instances (authoritative for their path). EVERY instance
  // is its own entry: a directory with two live instances lists two, and the
  // idle on-disk entry for that directory gives way to them.
  const byId = new Map<string, DiscoveredProject>();
  const ran = new Set<string>();
  for (const i of running) {
    const existing = byPath.get(i.cwd);
    const meta = existing?.meta ?? await readProjectMeta(i.cwd);
    const git = existing?.git ?? await isDir(join(i.cwd, ".git"));
    ran.add(i.cwd);
    const entry: DiscoveredProject = {
      id: instanceId(i.cwd, i.appId, i.home),
      path: i.cwd,
      name: existing?.name || meta.name || i.appId,
      meta,
      running: {
        appId: i.appId,
        pid: i.pid,
        port: i.port,
        status: i.status,
        ...(i.maintenance ? { maintenance: i.maintenance } : {}),
        ...(i.home ? { home: i.home } : {}),
        ...(i.profile ? { profile: i.profile } : {}),
      },
      git,
    };
    if (i.pid === Deno.pid || self.has(i.cwd)) entry.self = true;
    byId.set(entry.id, entry);
  }
  for (const p of ran) byPath.delete(p);
  for (const [p, entry] of byPath) {
    if (self.has(p)) entry.self = true;
    byId.set(entry.id, entry);
  }
  // Two instances sharing a directory (and so a name) read apart by what
  // differs: the profile, else the appId.
  const names = new Map<string, number>();
  for (const e of byId.values()) {
    names.set(e.name, (names.get(e.name) ?? 0) + 1);
  }
  for (const e of byId.values()) {
    if ((names.get(e.name) ?? 0) > 1 && e.running) {
      e.name = `${e.name} (${e.running.profile ?? e.running.appId})`;
    }
  }

  const projects = [...byId.values()].sort((a, b) => {
    // running first, then by name
    if (!!a.running !== !!b.running) return a.running ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { projects, roots, rootsExample: rootsExample(Deno.build.os) };
}

/** A running instance's list identity — see {@linkcode DiscoveredProject.id}. */
export const instanceId = (cwd: string, appId: string, home?: string): string =>
  `${cwd}#${appId}#${home ?? ""}`;

/** Exported for tests — the root set and the traversal denylist are the two
 *  things that decide whether discovery is both complete and cheap. */
export const _internals = {
  defaultRoots,
  neverWalk,
  rootsFor,
} as const;
