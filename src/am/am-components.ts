/**
 * @module
 * What "this project" MEANS to `am`, when the project is more than one app.
 *
 * `am` was built around one assumption: a directory is an app. That holds for
 * most repos and breaks for the shape aio explicitly supports — several
 * runnable things in one repo, declared as labelled build targets with their
 * own entries:
 *
 * ```jsonc
 * "build": { "targets": {
 *   "relay":  { "kind": "server",   "entry": "src/relay/app.ts",  "name": "relay" },
 *   "agent":  { "kind": "electron", "entry": "src/agent/app.ts",  "name": "agent" },
 *   "control":{ "kind": "electron", "entry": "src/control/app.ts","name": "control" }
 * }}
 * ```
 *
 * There, `am start` was ambiguous in the worst way: it started whatever
 * `deno.json`'s single `entry` pointed at, said nothing about the other two,
 * and left no verb to reach them. The fix is to make the declaration `am`
 * already has — the one the BUILD reads — mean the same thing to the process
 * commands: `am start` starts the project (all of it), `am start <label>`
 * starts one component of it.
 *
 * A repo whose targets share ONE entry is not multi-component: that is one app
 * built for several shells (`["server", "electron"]`, what `am create`
 * writes), and it must keep behaving exactly as it does today.
 */
import { join, resolve } from "@std/path";
import { normalizeTargets } from "../build-all.ts";
import { readDenoJsonSync } from "../server/deno-json.ts";
import { resolveAppId } from "../server/single-instance-lock.ts";
import { DEFAULT_ENTRY } from "../server/app-files.ts";

/** One runnable thing in this repo. */
export interface Component {
  /** The target LABEL — what the user types (`am start agent`). */
  label: string;
  /** Absolute path to the module this component runs. */
  entry: string;
  /** The identity it runs under: its own lock, data dir and socket. */
  appId: string;
  /** True when the entry DECLARES its appId (`aio.run({ appId })`) rather than
   *  inheriting the project's. Two components inheriting one identity is a
   *  refusal, not a default — see {@linkcode componentConflict}. */
  declaresAppId: boolean;
  /** The port the entry declares, if any. Undefined means "am assigns one",
   *  because two components on the framework default would collide at bind. */
  port?: number;
}

/** `aio.run({ appId, port })` as WRITTEN in an entry file.
 *
 *  A regex and not an import: reading identity must not execute the app, and
 *  `am` runs before anything is booted. It matches what `readEntryConfig` has
 *  always matched, per entry instead of only the project's own. */
export function entryDeclarations(
  entryPath: string,
): { appId?: string; port?: number } {
  try {
    const src = Deno.readTextFileSync(entryPath);
    const block = src.match(/aio\.run\s*\(\s*\{([\s\S]*?)\}\s*\)/);
    if (!block?.[1]) return {};
    const b = block[1];
    const appId = b.match(/appId\s*:\s*['"]([^'"]+)['"]/)?.[1];
    const port = b.match(/port\s*:\s*(\d+)/)?.[1];
    return {
      ...(appId ? { appId } : {}),
      ...(port ? { port: parseInt(port, 10) } : {}),
    };
  } catch {
    return {}; // unreadable entry — the caller reports the real problem
  }
}

/** The components this project declares, in declaration order.
 *
 *  EMPTY for an ordinary single-app repo — including one that builds several
 *  targets from one entry — so every command keeps its current behaviour
 *  unless the repo actually says otherwise. A component list of one is also
 *  returned as empty: one entry is one app, whatever it is labelled. */
export function projectComponents(root: string): Component[] {
  const cfg = readDenoJsonSync(root)?.config as
    | { build?: { targets?: unknown }; entry?: string }
    | null;
  const raw = cfg?.build?.targets as
    | string[]
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!raw || Array.isArray(raw)) return []; // the array form is ONE app
  const targets = normalizeTargets(raw);
  // Group by entry: two shells of one app are one component. The DEFAULT entry
  // stands in for a target that declares none, so `{"server": {...}, "electron":
  // {"entry": "src/other.ts"}}` is correctly read as two.
  const byEntry = new Map<string, Component>();
  for (const t of targets) {
    const rel = t.entry ?? cfg?.entry ?? DEFAULT_ENTRY;
    const abs = resolve(join(root, rel));
    const seen = byEntry.get(abs);
    if (seen) continue; // first label wins — it is the one the user will type
    const declared = entryDeclarations(abs);
    byEntry.set(abs, {
      label: t.name,
      entry: abs,
      appId: resolveAppId(declared.appId ?? t.appName ?? t.name),
      declaresAppId: declared.appId !== undefined,
      ...(declared.port !== undefined ? { port: declared.port } : {}),
    });
  }
  const list = [...byEntry.values()];
  return list.length > 1 ? list : [];
}

/** The refusal for components that cannot be told apart, or null when they
 *  can.
 *
 *  Two apps under one identity share a lock file, a data directory, a socket
 *  and a port — so the second one to start either refuses to bind or, worse,
 *  opens the first one's database. `am` will not guess a name for someone
 *  else's app, so it says which entries collide and what to write. */
export function componentConflict(components: Component[]): string | null {
  const byId = new Map<string, Component[]>();
  for (const c of components) {
    byId.set(c.appId, [...(byId.get(c.appId) ?? []), c]);
  }
  const clashes = [...byId.entries()].filter(([, cs]) => cs.length > 1);
  if (clashes.length === 0) return null;
  const lines = clashes.map(([id, cs]) =>
    `  "${id}" ← ${cs.map((c) => c.label).join(", ")}`
  );
  return `this project declares components that resolve to the SAME app id:\n` +
    `${lines.join("\n")}\n` +
    `They would share one lock file, one data directory and one port — the ` +
    `second to start refuses to bind, and nothing tells you why.\n` +
    `fix: give each entry its own identity — aio.run({ appId: "relay" }) — ` +
    `or a distinct "name" on its build target.`;
}

/** The port a component runs on, or undefined when it declares none.
 *
 *  `am` does not invent one. It used to hand each component a slot
 *  (`8000`, `8001`, …) so siblings could find each other at a predictable
 *  address — which reintroduced, one level up, the bug that made this whole
 *  area wrong: on a machine where something already owns 8000, the assignment
 *  is a port conflict `am` created. The runtime already has the answer for an
 *  app that declares nothing (`findFreePort()`, the same one `deno task dev`
 *  uses), so components follow it, `am status` lists what each one bound, and a
 *  component that NEEDS a fixed address declares `port` in its own
 *  `aio.run()` — the same rule as any other app. */
export function componentPort(c: Component): number | undefined {
  return c.port;
}

/** Resolve a component by label, or null. Case-sensitive: the label is a key
 *  in the app's own deno.json, and guessing at case would make `am start Agent`
 *  work in a way `--targets=Agent` does not. */
export function componentByLabel(
  components: Component[],
  label: string,
): Component | null {
  return components.find((c) => c.label === label) ?? null;
}

/** THE project root for component resolution — the directory holding the
 *  deno.json `am` was invoked against. Re-exported here so callers do not
 *  each re-derive it. */
export function componentsRoot(): string {
  return Deno.cwd();
}

/** What a process command (`start`/`stop`/`restart`/`status`) should act on.
 *
 *  `single` is the ordinary repo AND the explicitly-named case: `--app` and
 *  `--port` name one instance, so they win over any component list — a flag
 *  that says "this one" must never be widened into "all of them". */
export type ProcessPlan =
  | { kind: "single" }
  | { kind: "one"; component: Component; components: Component[] }
  | { kind: "all"; components: Component[] }
  | { kind: "error"; message: string };

/** Read the plan from the command's own arguments. Pure given the filesystem;
 *  the caller decides what to do with it. */
export function processPlan(
  args: string[],
  opts: { app?: string; port?: number },
  root = Deno.cwd(),
): ProcessPlan {
  const label = args.find((a) => !a.startsWith("-"));
  // An explicit identity is an explicit target. Asking for both a component and
  // an --app is a contradiction, not a refinement, so it is refused rather than
  // resolved by a precedence rule nobody would remember (the same rule
  // `--all` + `--app` already follows).
  if (opts.app !== undefined || opts.port !== undefined) {
    if (label) {
      return {
        kind: "error",
        message:
          `"${label}" names a component and --app/--port names an instance — ` +
          `pass one or the other`,
      };
    }
    return { kind: "single" };
  }
  const components = projectComponents(root);
  if (components.length === 0) {
    if (label) {
      return {
        kind: "error",
        message: `this project declares no components, so "${label}" names ` +
          `nothing.\nComponents come from deno.json → "build": { "targets": ` +
          `{ "<label>": { "entry": … } } } — several entries in one repo. ` +
          `Without them there is one app here, and \`am ${
            args[0] === label ? "start" : "…"
          }\` already means it.`,
      };
    }
    return { kind: "single" };
  }
  const conflict = componentConflict(components);
  if (conflict) return { kind: "error", message: conflict };
  if (label) {
    const c = componentByLabel(components, label);
    if (!c) {
      return {
        kind: "error",
        message: `no component "${label}" in this project — declared: ${
          components.map((x) => x.label).join(", ")
        }`,
      };
    }
    return { kind: "one", component: c, components };
  }
  return { kind: "all", components };
}
