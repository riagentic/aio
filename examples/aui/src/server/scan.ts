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
        await walk(join(dir, e.name), left - 1);
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

/** Default scan roots, most-specific first:
 *  - $AUI_ROOTS (colon-separated, explicit override)
 *  - ~/aio-apps (where `create` scaffolds)
 *  - the launch dir and a few parents (bounded to $HOME) — projects usually sit
 *    as siblings under a shared parent, so walking up finds them without config
 *    (e.g. examples/aui → examples → repo → repo-parent where sibling apps live)
 *  - the parent dir of any running app (siblings of what's live) */
function defaultRoots(runningCwds: string[]): string[] {
  const home = Deno.env.get("HOME") ?? ".";
  const roots = new Set<string>();

  for (const r of (Deno.env.get("AUI_ROOTS") ?? "").split(":")) {
    if (r.trim()) roots.add(r.trim());
  }
  roots.add(`${home}/aio-apps`);

  // Walk up from the launch dir. Stay inside $HOME and never add a shallow
  // system root (≥3 path segments) — scanning "/" or "$HOME" would be ruinous.
  let dir = Deno.cwd();
  for (let i = 0; i < 4; i++) {
    if (dir.startsWith(home) && seg(dir) >= 3) roots.add(dir);
    const parent = dir.split("/").slice(0, -1).join("/");
    if (!parent || parent === dir || !parent.startsWith(home)) break;
    dir = parent;
  }

  // Parents of running apps — but under the SAME guard as the walk-up: an app
  // living at $HOME/myapp must not turn its parent ($HOME) into a scan root
  // (scanning all of $HOME every rescan would be ruinous).
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
    "../../../../src/server/single-instance-lock.ts"
  );
  const running = instances().filter((i) => i.alive && i.appId !== "aui");
  const roots = defaultRoots(running.map((i) => i.cwd));
  const byPath = await scanDisk(roots, 2);

  // Drop aui's own project dir (it manages OTHER apps — self-listing it as a
  // stopped app is confusing, and Start would spawn a second aui) and the aio
  // framework repo root (aui lives at <repo>/examples/aui). decodeURIComponent
  // so a path with spaces still matches the decoded disk-path keys.
  const dirOf = (rel: string) =>
    decodeURIComponent(new URL(rel, import.meta.url).pathname).replace(
      /\/$/,
      "",
    );
  byPath.delete(dirOf("../..")); // examples/aui — aui itself
  byPath.delete(dirOf("../../../..")); // repo root — the framework

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

  const projects = [...byPath.values()].sort((a, b) => {
    // running first, then by name
    if (!!a.running !== !!b.running) return a.running ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { projects, roots };
}
