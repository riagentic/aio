// `am fix` — analyze a cloned aio app and repair the common things that stop it
// building/running. Most are gitignored/uncommitted bits a fresh clone lacks
// (the framework symlink, .env, electron runtime, submodules) plus a few config
// safety nets. `deno task doctor` diagnoses config; `am fix` repairs;
// `am doctor` checks running instances against the aio on disk. `--dry-run`
// (alias `--check`) reports what it WOULD do without changing anything.
import { UI_ENTRY } from "../server/app-files.ts";
import {
  legacyStandardTasks,
  standardTasks,
  type Target,
  TARGETS,
} from "./am-cmd-create.ts";
import { fromFileUrl, join, resolve } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { refOfLink } from "../server/framework-pin.ts";
import { resolveEntryPath } from "../server/paths.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { linkDepAio, probeDepAio, resolveAioRoot } from "./am-cmd-link.ts";
import {
  compareVersions,
  ensureVersion,
  knownTags,
  latestTag,
  MAIN,
  parseVersion,
  readPin,
  sortVersions,
  versionPath,
  writePin,
} from "./am-versions.ts";
import { meetsMinDeno, MIN_DENO } from "../server/deno-version.ts";
import { parseDeclaredVersion } from "../server/app-version.ts";
import { removalMessage, removalsInSource } from "../state/removals.ts";
import { count } from "../diagnostics/fmt.ts";

// fixed/would-fix/ok = safe auto-repairs; advise = a suggestion we DON'T apply
// (it touches committed source or app logic); manual = a hard blocker am fix
// can't get past on its own.
type Outcome = "fixed" | "ok" | "would-fix" | "advise" | "manual" | "skip";
interface Res {
  name: string;
  outcome: Outcome;
  note: string;
}

const exists = (p: string) => Deno.stat(p).then(() => true).catch(() => false);

// ── Which standard tasks an app actually needs ───────────────────────────────
//
// `am fix` used to append the WHOLE standard set — `dev:android`, `dev:cli`,
// `dev:service` and the rest — to an app that ships none of them. On a curated
// task list that is noise the maintainer deletes after every repair (a field
// report), and noise is how a repair tool loses its welcome. So: add the
// universal tasks, plus the ones the app's DECLARED targets need.
//
// Still add-only. Nothing here removes or rewrites a task the app already has.

/** Tasks every aio app wants, whatever it ships (the alpha52 task diet —
 *  other shells are one flag away: `deno task dev --client=X`,
 *  `deno task build --targets=X`). */
const UNIVERSAL_TASKS = [
  "dev",
  "build",
  "compile",
  "test",
  "check",
  "fmt",
  "am",
  "doctor",
  "lint",
  // Publishing a signed release is target-independent — every app that can be
  // compiled can be published, so `am fix` restores both for all of them.
  // `publish` is the per-release command; `ship` is keygen and CI generation,
  // which docs and the CLI's own messages spell as `deno task ship`.
  "publish",
  "ship",
] as const;

/** Task keys each declared target needs, keyed by the names accepted in
 *  deno.json `build.targets` (plus the `client` default, which shares the same
 *  vocabulary — `server` is the headless one). After the alpha52 task diet the
 *  only target-specific task left is electron's install convenience; the keys
 *  stay so a declared fleet name is still "known" here.
 *
 *  Every key of `standardTasks()` must be reachable from here or from
 *  {@link UNIVERSAL_TASKS}, or `am fix` could never add it again; a test pins
 *  exactly that, so growing the task set cannot silently orphan a task. */
const TARGET_TASKS: Record<string, readonly string[]> = {
  browser: [],
  electron: ["install:electron"],
  android: ["install:android"],
  cli: [],
  server: [],
  // The exposed server that also serves its page — same tasks as `server`
  // (nothing to install), and omitting it here would report a real target as
  // unknown.
  "server-app": [],
  "electron-client": ["install:electron"],
  "android-client": ["install:android"],
  "cli-client": [],
  "ios-client": [],
};

/** Read the fleet an app declares: `client` (the default shell; `target` is
 *  its pre-alpha52 spelling, still read) plus `build.targets` in EITHER
 *  spelling — the array form `["server","browser"]` or the object form
 *  `{"server":{"entry":…}}` (per-target overrides) — where an object key may
 *  be a free LABEL whose `kind` names the actual target
 *  (`{"agent":{"kind":"electron",…}}`, two apps of one kind in one repo). All
 *  are live spellings, so reading only one would quietly under-repair the
 *  others. Pure. */
export function declaredTargets(cfg: unknown): string[] {
  const seen = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) seen.add(v.trim());
  };
  const c = (cfg ?? {}) as Record<string, unknown>;
  push(c.client);
  push(c.target); // deprecated spelling of `client` — still declares the fleet
  const raw = (c.build as Record<string, unknown> | undefined)?.targets;
  if (Array.isArray(raw)) raw.forEach(push);
  else if (raw && typeof raw === "object") {
    // The object form's key is a LABEL; `kind` names the target it builds
    // (one repo, two Electron apps). Reading the label as a target name made
    // every labelled target "unrecognized" here — a tool wrong about a layout
    // the build supports, which is how a check trains people to ignore it.
    for (const [label, o] of Object.entries(raw)) {
      const kind = (o as { kind?: unknown } | null)?.kind;
      push(typeof kind === "string" && kind.trim() ? kind : label);
    }
  }
  return [...seen];
}

/** THE decider for "which fleet targets does a legacy task-name matrix
 *  encode?" — shared by the declared-build-targets check AND `--migrate-tasks`.
 *
 *  A hand-rolled pre-alpha52 app (no `build` key) often carried its target
 *  list ONLY as `compile:*`/`dev:*` task names — an Electron wallet's four
 *  compile tasks were the one record that it ships electron. A migration that
 *  deletes those tasks without persisting what they encoded leaves
 *  `deno task build` with "no targets to build" and no task able to build the
 *  app: capability deleted, not migrated. One table, so the check can never
 *  read information the migration fails to preserve. Pure. */
export function targetsFromLegacyTasks(
  taskNames: Iterable<string>,
): string[] {
  const ENCODES: Record<string, readonly string[]> = {
    "dev:browser": ["browser"],
    "compile:browser": ["browser"],
    "dev:electron": ["electron"],
    "compile:electron": ["electron"],
    "dev:android": ["android"],
    "compile:android": ["android"],
    "dev:cli": ["cli"],
    "compile:cli": ["cli"],
    // `service` (and its alpha52 spelling `server`) — the headless role, whose
    // build carries `--headless` — maps to the fleet's `server` target.
    "dev:service": ["server"],
    "compile:service": ["server"],
    "dev:server": ["server"],
    "compile:server": ["server"],
    // The unified client + remote family: exposed server and/or thin client.
    "dev:client": ["electron-client"],
    "compile:client": ["electron-client"],
    "dev:remote:browser": ["server"],
    "compile:remote:browser": ["server"],
    "dev:remote:electron": ["electron-client"],
    "compile:remote:electron": ["server", "electron-client"],
    "dev:remote:android": ["server"],
    "compile:remote:android": ["server", "android-client"],
    "dev:remote:cli": ["cli-client"],
    "compile:remote:cli": ["server", "cli-client"],
    "dev:remote:service": ["server"],
    "compile:remote:service": ["server"],
    "dev:remote:server": ["server"],
    "compile:remote:server": ["server"],
  };
  const out = new Set<string>();
  for (const n of taskNames) for (const t of ENCODES[n] ?? []) out.add(t);
  return [...out];
}

// ── Old-vocabulary task migration (`am fix --migrate-tasks`) ────────────────
//
// The pre-alpha52 scaffold emitted a ~30-task dev:*/compile:* matrix; alpha52's
// "one vocabulary" replaced it with the diet above (dev flags pass through, the
// fleet build is the one way to build). `--migrate-tasks` converts an app:
// pristine old-scaffold tasks are deleted or rewritten; anything the user
// customized is KEPT (service→server renamed only) and reported for review.
// Targets the retired tasks ENCODED are persisted into `build.targets` first
// (see targetsFromLegacyTasks) — deletion must never lose a capability.

/** Old task names whose `service` spelling renames to `server`. */
const SERVICE_RENAMES: Record<string, string> = {
  "dev:service": "dev:server",
  "compile:service": "compile:server",
  "dev:remote:service": "dev:remote:server",
  "compile:remote:service": "compile:remote:server",
};

/** Version-insensitive equality for task values: an old scaffold pinned
 *  `jsr:@riagentic/aio@<its version>/…`, and a byte-compare against today's pin
 *  would misread every JSR app as "customized". Only the pin is wildcarded —
 *  any other edit still counts as a customization. */
function normTask(v: string): string {
  return v.replace(/jsr:@riagentic\/aio@[^/\s]+/g, "jsr:@riagentic/aio@*")
    .trim();
}

export interface MigrateTasksResult {
  tasks: Record<string, string>;
  /** old→new names of customized `*:service` tasks (value untouched). */
  renamed: [string, string][];
  /** pristine old-scaffold tasks the new matrix covers otherwise. */
  deleted: string[];
  /** tasks whose pristine old value was updated to the new one. */
  rewritten: string[];
  /** new-matrix tasks that were missing and got added. */
  added: string[];
  /** old-vocabulary tasks with user customizations — kept, review manually. */
  kept: string[];
}

/** Convert one app's task map to the alpha52 vocabulary. Pure — the whole
 *  contract ("never delete a customized task") is a unit test, not a claim.
 *
 *  A task is PRISTINE when some legacy scaffold table has the same name with
 *  the same command (modulo the JSR version pin). Pristine tasks the new
 *  matrix doesn't carry are deleted; pristine tasks it carries under a new
 *  value are rewritten; everything else is kept (with `*:service` names
 *  renamed to `*:server`) and reported. */
export function migrateTasks(
  current: Record<string, string>,
  expected: Record<string, string>,
  legacy: readonly Record<string, string>[],
): MigrateTasksResult {
  const res: MigrateTasksResult = {
    tasks: {},
    renamed: [],
    deleted: [],
    rewritten: [],
    added: [],
    kept: [],
  };
  const legacyNames = new Set(legacy.flatMap((t) => Object.keys(t)));
  const pristine = (k: string, v: string) =>
    legacy.some((t) => t[k] !== undefined && normTask(t[k]!) === normTask(v));
  for (const [k, v] of Object.entries(current)) {
    if (k in expected) {
      if (pristine(k, v) && v !== expected[k]) {
        res.tasks[k] = expected[k]!;
        res.rewritten.push(k);
      } else res.tasks[k] = v;
    } else if (pristine(k, v)) {
      res.deleted.push(k); // the new matrix covers it via dev flags / build
    } else if (k in SERVICE_RENAMES) {
      const nk = SERVICE_RENAMES[k]!;
      if (nk in res.tasks || nk in current) {
        // The destination name already exists and carries the user's own
        // command. Renaming onto it OVERWROTE that command — silently, in a
        // file this tool then writes back — and reported the destroyed task
        // under `kept`. "Never delete a customized task" is this function's
        // stated contract, so the old name stays put for the user to resolve.
        res.tasks[k] = v;
        res.kept.push(k);
      } else {
        res.tasks[nk] = v;
        res.renamed.push([k, nk]);
        res.kept.push(nk);
      }
    } else {
      res.tasks[k] = v;
      // A customized OLD-matrix task (a name we used to scaffold) deserves a
      // "review manually"; the user's own tasks are none of our business.
      if (legacyNames.has(k)) res.kept.push(k);
    }
  }
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in res.tasks)) {
      res.tasks[k] = v;
      res.added.push(k);
    }
  }
  return res;
}

/** The legacy scaffold tables migration recognizes pristine tasks against:
 *  every target × both consumption modes — an old app may have been scaffolded
 *  as any of them. */
export function legacyTaskTables(): Record<string, string>[] {
  return (TARGETS as readonly Target[]).flatMap((
    t,
  ) => [legacyStandardTasks(true, t), legacyStandardTasks(false, t)]);
}

/** Narrow the standard task set to what this app's targets need.
 *
 *  `unknown` names targets we have no task mapping for — reported, never
 *  silently dropped: a name that isn't a real target also makes
 *  `deno task build` fail, and the author should hear it from the repair tool.
 *  An empty fleet falls back to the framework default (`browser`) and says so.
 *  Pure. */
export function tasksForTargets(
  all: Record<string, string>,
  targets: readonly string[],
): { tasks: Record<string, string>; unknown: string[]; assumed: boolean } {
  const unknown = targets.filter((t) => !(t in TARGET_TASKS));
  const known = targets.filter((t) => t in TARGET_TASKS);
  const assumed = known.length === 0;
  const wanted = new Set<string>(UNIVERSAL_TASKS);
  for (const t of assumed ? ["browser"] : known) {
    for (const k of TARGET_TASKS[t]!) wanted.add(k);
  }
  const tasks: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (wanted.has(k)) tasks[k] = v;
  return { tasks, unknown, assumed };
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; err: string }> {
  try {
    const o = await new Deno.Command(cmd, {
      args,
      cwd,
      stdout: "null",
      stderr: "piped",
    }).output();
    return {
      ok: o.code === 0,
      err: new TextDecoder().decode(o.stderr).trim().split("\n").pop() ?? "",
    };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

async function resolveEntry(dir: string): Promise<string | null> {
  // THE rule, not a probe list. `src/main.ts` / `main.ts` used to count here
  // and nowhere else, so `am fix` could pronounce a project fine on the
  // strength of a file the build would never compile.
  let cfg: Record<string, unknown> | null = null;
  // `parseJsonc`, and both filenames — the same reader `cmdFix` itself uses.
  // A single `//` comment (Deno accepts them in deno.json) made JSON.parse
  // throw, `cfg` fall back to null, and the entry resolve to the default
  // `src/app.ts`; for an app whose entry is anywhere else that meant the
  // `dependencies cached` repair — the main reason to run `am fix` on a fresh
  // clone — was skipped with no line of output at all, and the banner still
  // said "Now run: deno task dev".
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      cfg = parseJsonc(await Deno.readTextFile(join(dir, name))) as Record<
        string,
        unknown
      >;
      break;
    } catch { /* try the next name; the default below still applies */ }
  }
  const entry = resolveEntryPath(cfg);
  return (await exists(join(dir, entry))) ? entry : null;
}

export async function cmdFix(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const dry = args.includes("--dry-run") || args.includes("--check");
  // `--no-download`: repair everything that is local, and skip the steps that
  // reach the network — the Electron runtime (~334 MB) and the dependency
  // cache. For an offline or metered machine, and for a repair you want to
  // finish in a second. The skipped steps are REPORTED, never silently
  // dropped: a repair that quietly did less than it said is the failure mode
  // this whole command exists to avoid.
  const noDownload = args.includes("--no-download");
  // `--migrate-tasks`: convert a pre-alpha52 task matrix to the one vocabulary
  // (see migrateTasks). Opt-in because it DELETES pristine old-scaffold tasks.
  const migrate = args.includes("--migrate-tasks");
  const dir = Deno.cwd();
  const res: Res[] = [];
  const add = (name: string, outcome: Outcome, note = "") =>
    res.push({ name, outcome, note });
  // Register a repairable check: broken → fixed (or would-fix in dry mode).
  const repair = async (
    name: string,
    broken: boolean,
    fix: () => Promise<void> | void,
    note = "",
  ) => {
    if (!broken) return add(name, "ok");
    if (dry) return add(name, "would-fix", note);
    try {
      await fix();
      add(name, "fixed", note);
    } catch (e) {
      add(name, "manual", e instanceof Error ? e.message : String(e));
    }
  };

  const jsonPath = (await exists(join(dir, "deno.json")))
    ? join(dir, "deno.json")
    : (await exists(join(dir, "deno.jsonc")))
    ? join(dir, "deno.jsonc")
    : null;
  if (!jsonPath) {
    outError(
      "no deno.json here — run `am fix` from a cloned aio app root.",
      mode,
    );
    Deno.exit(1);
  }
  const raw = await Deno.readTextFile(jsonPath);
  // deno-lint-ignore no-explicit-any
  let cfg: any;
  try {
    cfg = parseJsonc(raw);
  } catch {
    outError("deno.json is not valid JSON/JSONC — fix it by hand first.", mode);
    Deno.exit(1);
  }
  const imports: Record<string, string> = cfg.imports ?? {};
  const tasks: Record<string, string> = cfg.tasks ?? {};

  // deno.json `target` → `client` (alpha52 rename: the key names the default
  // client SHELL, and "target" collided with build.targets — a different
  // axis). Mechanical key rename, value untouched; `client` wins if both
  // exist. Since alpha70 the runtime REFUSES `target` in dev and logs it in
  // prod (src/state/removals.ts) — this is the fix it names.
  if (typeof cfg.target === "string") {
    if (jsonPath.endsWith(".jsonc")) {
      add(
        'deno.json "target" → "client"',
        "advise",
        'deno.jsonc — rename the "target" key to "client" by hand ' +
          "(comments would be lost in a rewrite)",
      );
    } else {
      await repair(
        'deno.json "target" → "client"',
        true,
        async () => {
          const raw = JSON.parse(await Deno.readTextFile(jsonPath)) as Record<
            string,
            unknown
          >;
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(raw)) {
            if (k === "target") {
              if (!("client" in raw)) out.client = v; // rename in place
            } else out[k] = v;
          }
          await Deno.writeTextFile(
            jsonPath,
            JSON.stringify(out, null, 2) + "\n",
          );
        },
        `"target": "${cfg.target}" is the removed spelling of "client"`,
      );
      if (!dry) {
        cfg.client ??= cfg.target;
        delete cfg.target;
      }
    }
  }
  // Does this app actually SHIP Electron?
  //
  // What the app DECLARES decides it: `client`, `build.targets` — the same
  // fleet every other part of the toolchain reads. Two weaker signals still
  // count, because an app can be running Electron before it says so: a task
  // that drives it (`install:electron` excluded — it is the optional pre-fetch
  // convenience, and counting it made it self-keeping), and an import of
  // Electron under the APP's own specifier.
  //
  // What must NOT count is aio's own import map. The scaffold writes every
  // public entry point plus `"electron": "npm:electron"` into deno.json for
  // EVERY app, browser-only included — so `imports` mentioned electron
  // always, `am fix` on a plain browser app concluded it was an Electron app,
  // and downloaded 334 MB of runtime nobody had asked for (and advised
  // electron-shaped tasks and nodeModulesDir on top).
  const usesElectron =
    declaredTargets(cfg).some((t) => t.includes("electron")) ||
    Object.entries(imports).some(([k, v]) =>
      k !== "electron" && !k.startsWith("aio") && v.includes("electron")
    ) ||
    Object.keys(tasks).some((t) =>
      t.includes("electron") && t !== "install:electron"
    );
  const hasTsx = await exists(join(dir, "src", UI_ENTRY)) ||
    await exists(join(dir, UI_ENTRY));

  // Recognize HOW the app consumes aio, so we only take actions that fit it.
  const aioSpec = imports["aio"] ?? "";
  const isPath = aioSpec.startsWith(".") || aioSpec.startsWith("/");
  const aioMode = /^(jsr:|npm:|https?:)/.test(aioSpec)
    ? "registry" // JSR/npm/URL pin — no symlink, nothing to link
    : isPath
    // Anchored to a path segment: a substring test would misread a sibling
    // vendoring like "../vendor-dep/aio-core/mod.ts" as the dep/aio layout.
    ? (/(^|\/)dep\/aio(\/|$)/.test(aioSpec)
      ? "dep" // the dep/aio layout (am create default, or a linked clone)
      : "custom") // some other relative/absolute path — user's own vendoring
    : "unknown";
  add(
    "aio consumption mode",
    aioMode === "unknown" ? "manual" : "ok",
    aioMode === "registry"
      ? `registry pin (${aioSpec}) — no framework link needed`
      : aioMode === "custom"
      ? `custom path (${aioSpec}) — left as the app declares it`
      : aioMode === "dep"
      ? "dep/aio layout"
      : 'no "aio" import — is this an aio app?',
  );

  // 1 — dep/aio framework link — ONLY for the dep/aio layout, and only ever
  //     creates/repairs a symlink; a real vendored copy is never touched.
  if (aioMode === "dep") {
    const install = resolveAioRoot(args);
    // The app's `aioVersion` pin decides WHICH framework this links to — that is
    // what makes a fresh clone build against the version the app was written
    // for. `--aio=<path>` overrides it (framework development).
    let root = install;
    let pin: string | null = null;
    let sealed = false;
    const honorPin = install && !args.some((a) => a.startsWith("--aio="));
    if (honorPin) {
      pin = await readPin(dir);
      if (pin && !dry) {
        const res = await ensureVersion(install, pin);
        if (res.ok) root = res.path;
        else {
          add("aio version pin", "manual", res.error);
          pin = null;
        }
      } else if (pin) {
        root = versionPath(pin); // dry run: report, provision nothing
      }
    }
    // SEAL an unpinned app. Until a version is recorded, "it built last month"
    // is not a fact anyone can reproduce — the next clone links to whatever aio
    // happens to be installed, which is how an app that shipped fine dies on a
    // framework it never asked for. So `am fix` does not merely advise here: it
    // writes down the version it is about to link, and says so. That single
    // committed string is what makes "this app runs forever" true rather than
    // aspirational. It is the one committed-source edit am fix makes, it is
    // additive, and `am pin` overrides it whenever the author disagrees.
    if (!pin && honorPin && install) {
      // Where does dep/aio ALREADY point? A WORKING link to a checkout
      // outside the versions store means the developer linked a local working
      // tree (`am create --mirror`, `am link <path>`) — and linkDepAio keeps
      // a working link. Sealing THAT with a version string is
      // self-contradictory: the pin would claim a store worktree while the
      // link names a working tree, so aiol/doctor (via linkSatisfiesPin, THE
      // decider) warn "pin does not match dep/aio" forever. The local-dev pin
      // (`path:<target>`) exists for exactly this — seal with it, and pin and
      // link agree by construction.
      const linkTarget = await Deno.readLink(join(dir, "dep", "aio"))
        .then((t) => resolve(dir, "dep", t))
        .catch(() => null);
      const localTree = linkTarget !== null &&
        refOfLink(linkTarget) === null &&
        await exists(join(linkTarget, "mod.ts"));
      if (localTree) {
        const ref = `path:${linkTarget}`;
        if (dry) {
          add(
            "aio version pin",
            "would-fix",
            `unpinned — dep/aio links a local checkout (${linkTarget}); ` +
              `would record "aioVersion": "${ref}" (local-dev pin)`,
          );
        } else {
          await writePin(dir, ref);
          root = linkTarget;
          pin = ref;
          sealed = true;
          add(
            "aio version pin",
            "fixed",
            `was unpinned — recorded "aioVersion": "${ref}" (dep/aio links a ` +
              `local checkout, so a version pin would contradict the link). ` +
              `Machine-specific by design — pin a release with ` +
              `\`am pin latest\` before sharing the app`,
          );
        }
      } else {
        const want = await latestTag(install) ?? MAIN;
        if (dry) {
          add(
            "aio version pin",
            "would-fix",
            `unpinned — would record "aioVersion": "${want}" in deno.json`,
          );
        } else {
          const res = await ensureVersion(install, want);
          if (!res.ok) add("aio version pin", "manual", res.error);
          else {
            await writePin(dir, res.ref);
            root = res.path;
            pin = res.ref;
            sealed = true;
            add(
              "aio version pin",
              "fixed",
              `was unpinned — recorded "aioVersion": "${res.ref}" in ` +
                `deno.json so every future clone rebuilds against this ` +
                `exact framework (change it with \`am pin <version>\`)`,
            );
          }
        }
      }
    }
    if (pin && !sealed) {
      add("aio version pin", "ok", `${pin} (deno.json aioVersion)`);
    }
    // How far behind the pin is — reported, never acted on. The app builds
    // exactly as pinned; staleness the author cannot SEE is the only part of
    // that which is a problem.
    if (pin && install) {
      const cur = parseVersion(pin);
      if (cur) {
        const behind = sortVersions(await knownTags(install))
          .filter((t) => compareVersions(t, cur) > 0).length;
        if (behind > 0) {
          add(
            "aio version freshness",
            "advise",
            `${count(behind, "release")} behind ${await latestTag(
              install,
            )} — ` +
              `\`am pin latest\` moves it (it checks for removed APIs first)`,
          );
        }
      }
    }
    if (!root) {
      add(
        "dep/aio framework link",
        "manual",
        "framework not found — install via install.sh, or pass --aio=<path>",
      );
    } else {
      // A link that WORKS is not a link that is RIGHT. `root` is the path the
      // app's pin resolves to; a link pointing anywhere else is the pin
      // silently not applied — `am pin main` (or editing aioVersion by hand)
      // followed by `am fix` used to report "ok" and build against whatever
      // the link happened to say. That is one fact (the framework version)
      // decided in two places, and the second one won without saying so.
      const current = await Deno.readLink(join(dir, "dep", "aio"))
        .then((t) => resolve(dir, "dep", t))
        .catch(() => null);
      const stale = current !== null && resolve(current) !== resolve(root) &&
        (await probeDepAio(dir)) === "ok";
      const was = stale ? ` (was ${current})` : "";
      if (dry) {
        const p = await probeDepAio(dir); // read-only
        add(
          "dep/aio framework link",
          p === "vendored" || (p === "ok" && !stale)
            ? "ok"
            : p === "blocked"
            ? "manual"
            : "would-fix",
          p === "vendored"
            ? "vendored copy — untouched"
            : p === "blocked"
            ? "dep/aio isn't a usable aio"
            : p === "would-link" || stale
            ? `→ ${root}${was}`
            : "",
        );
      } else {
        const r = await linkDepAio(dir, root, stale);
        add(
          "dep/aio framework link",
          r === "linked" ? "fixed" : r === "blocked" ? "manual" : "ok",
          r === "vendored"
            ? "vendored copy — untouched"
            : r === "blocked"
            ? "dep/aio exists but isn't a usable aio — inspect it by hand"
            : r === "linked"
            ? `→ ${root}${was}`
            : "",
        );
      }
    }
  }

  // 2 — .env from .env.example (gitignored; app may need it to boot)
  if (
    await exists(join(dir, ".env.example")) &&
    !(await exists(join(dir, ".env")))
  ) {
    await repair(
      ".env from .env.example",
      true,
      async () =>
        await Deno.copyFile(join(dir, ".env.example"), join(dir, ".env")),
      "copied (review its values)",
    );
  } else add(".env from .env.example", "ok");

  // 3 — electron runtime (node_modules is gitignored)
  //
  // Both halves go through the framework's installer, which is the ONE thing
  // that knows where the runtime lives and how to get it. This step used to
  // (a) test `node_modules/electron` EXISTS — true after any `deno install`,
  // with or without the ~100MB `dist/` the lifecycle script downloads — and
  // (b) repair with the bare `deno install --allow-scripts=npm:electron`, the
  // command that exits 0 having skipped that script. Net effect on the
  // one-liner: `am fix` printed "fixed · installed npm:electron", the build one
  // second later said "electron is not installed — run deno task
  // install:electron", and every later `am fix` said "ok" because the empty
  // package was there. A repair that reports success on the wrong question is
  // worse than no repair; this one asks "is the BINARY there?" on both sides.
  if (usesElectron && noDownload) {
    add(
      "electron runtime installed",
      "advise",
      "skipped (--no-download) — run `deno task install:electron` when online",
    );
  } else if (usesElectron) {
    const installer = fromFileUrl(
      new URL("../electron-install.ts", import.meta.url),
    );
    const have =
      (await run("deno", ["run", "-A", installer, "--check"], dir)).ok;
    await repair(
      "electron runtime installed",
      !have,
      async () => {
        const r = await run("deno", ["run", "-A", installer], dir);
        if (!r.ok) throw new Error(r.err || "electron install failed");
        const now = await run("deno", ["run", "-A", installer, "--check"], dir);
        if (!now.ok) {
          throw new Error(
            "the installer exited 0 but no Electron runtime is present",
          );
        }
      },
      "downloaded the Electron runtime (npm:electron)",
    );
  }

  // 4 — git submodules (uninitialized on a shallow/plain clone)
  if (await exists(join(dir, ".gitmodules"))) {
    // Only act when a submodule is genuinely uninitialized (status line
    // prefixed '-'). Running update unconditionally could reset a submodule the
    // developer deliberately checked out to a different commit.
    let uninit = false;
    try {
      const o = await new Deno.Command("git", {
        args: ["submodule", "status", "--recursive"],
        cwd: dir,
        stdout: "piped",
        stderr: "null",
      }).output();
      uninit = o.code === 0 &&
        new TextDecoder().decode(o.stdout).split("\n").some((l) =>
          l.startsWith("-")
        );
    } catch { /* git absent — repair() surfaces it if we still try */ }
    await repair(
      "git submodules initialized",
      uninit,
      async () => {
        const r = await run("git", [
          "submodule",
          "update",
          "--init",
          "--recursive",
        ], dir);
        if (!r.ok) throw new Error(r.err || "git submodule failed");
      },
    );
  }

  // 5 — executable bit on shell scripts referenced by tasks
  const scripts = new Set<string>();
  for (const c of Object.values(tasks)) {
    for (const m of c.matchAll(/([\w./-]+\.sh)\b/g)) {
      const rel = m[1]!;
      // Only app-relative scripts: a leading "/" (absolute or a URL tail like
      // "//host/install.sh") or a ".." segment could chmod a file outside dir.
      if (rel.startsWith("/") || rel.split("/").includes("..")) continue;
      scripts.add(rel);
    }
  }
  const notExec: string[] = [];
  for (const s of scripts) {
    const p = join(dir, s);
    try {
      const st = await Deno.stat(p);
      if (st.isFile && !((st.mode ?? 0) & 0o111)) notExec.push(s);
    } catch { /* referenced but absent — leave it */ }
  }
  if (scripts.size > 0) {
    await repair(
      "shell scripts executable",
      notExec.length > 0,
      async () => {
        for (const s of notExec) await Deno.chmod(join(dir, s), 0o755);
      },
      notExec.join(", "),
    );
  }

  // deno.json config — ADVISE only; never rewrite the user's committed config.
  const co = cfg.compilerOptions ?? {};
  const cfgAdvise = (broken: boolean, name: string, suggest: string) =>
    add(name, broken ? "advise" : "ok", broken ? suggest : "");
  if (hasTsx) {
    cfgAdvise(
      co.jsx !== "react-jsx",
      "compilerOptions.jsx",
      'set compilerOptions.jsx to "react-jsx"',
    );
    cfgAdvise(
      co.jsxImportSource !== "aio",
      "compilerOptions.jsxImportSource",
      'set compilerOptions.jsxImportSource to "aio"',
    );
  }
  if (usesElectron) {
    cfgAdvise(
      cfg.nodeModulesDir !== "auto" && cfg.nodeModulesDir !== true,
      'nodeModulesDir "auto"',
      'set nodeModulesDir to "auto" — electron needs node_modules on disk',
    );
  }

  // Standard deno tasks — ADD-ONLY. Hand-rolled apps and apps predating the
  // scaffold miss tasks the docs assume (`deno task compile:electron`, the
  // dev:*/compile:* matrix). Missing tasks are appended with mode-correct
  // values from the ONE producer (`standardTasks`, shared with `am create`);
  // an existing task is NEVER overwritten — user customization wins. Skipped
  // for custom framework vendoring (unknowable paths) and for deno.jsonc
  // (a rewrite would destroy comments).
  if (jsonPath.endsWith(".jsonc")) {
    add(
      "standard deno tasks",
      "advise",
      "deno.jsonc — not auto-edited (comments would be lost); compare with `am create` output",
    );
  } else if (aioMode === "dep" || aioMode === "registry") {
    // Targets the app's LEGACY task names encode — the same decider the
    // migration persists from, so this check can never see information the
    // migration would delete.
    const taskTargets = targetsFromLegacyTasks(Object.keys(tasks));
    // Does the app declare a fleet of its own? (`build.targets`, either
    // spelling.) If so, it is authoritative and never derived over.
    const rawFleet = (cfg.build as Record<string, unknown> | undefined)
      ?.targets;
    const hasFleet = Array.isArray(rawFleet)
      ? rawFleet.length > 0
      : !!rawFleet && typeof rawFleet === "object" &&
        Object.keys(rawFleet).length > 0;
    // The app's PRIMARY target — what `deno task dev`/`compile` default to.
    // `client` (or the deprecated `target`) wins, then the declared fleet's
    // first buildable app target, then the one the legacy tasks encode. Never
    // a hardcoded browser while the app says otherwise (an Electron app whose
    // only record was its compile:electron task must not migrate to a
    // browser-building `compile`).
    const primaryTarget = [
      cfg.client as string,
      cfg.target as string,
      ...declaredTargets(cfg),
      ...taskTargets,
    ].find((t) => (TARGETS as readonly string[]).includes(t)) as
      | Target
      | undefined;
    const all = standardTasks(aioMode === "dep", primaryTarget);
    // The app's declared fleet decides which of them apply. Electron is also
    // inferred from imports/tasks: an app already running Electron ships it,
    // whether or not it says so in `client`/`build.targets`.
    // The fleet the app STATES (config + what its legacy tasks encode) —
    // kept apart from the electron-imports inference below, because a
    // migration treats the fleet as authoritative.
    const fleetDeclared = declaredTargets(cfg);
    for (const t of taskTargets) {
      if (!fleetDeclared.includes(t)) fleetDeclared.push(t);
    }
    const declared = [...fleetDeclared];
    if (usesElectron && !declared.includes("electron")) {
      declared.push("electron");
    }
    const { tasks: expected, unknown, assumed } = tasksForTargets(
      all,
      declared,
    );
    // A fleet whose only shape is a CLIENT target (a cli-client-only repo has
    // no `client`/app target at all): `compile` still must not hardcode
    // browser — narrow it to the fleet's head instead.
    if (primaryTarget === undefined && taskTargets.length > 0) {
      expected["compile"] = `${all["build"]} --targets=${taskTargets[0]}`;
    }
    // An unrecognized target name is louder than a missing one: `deno task
    // build` fails on it too, and a silent "no tasks added" would read as
    // am fix having nothing to do.
    const notes = [
      unknown.length
        ? `unknown target(s): ${unknown.join(", ")} — no standard tasks for ` +
          `them, and \`deno task build\` will fail on them too`
        : "",
      assumed
        ? "no `target`/`build.targets` declared — repaired the browser + " +
          "universal task set only; declare build.targets to get the rest"
        : "",
    ].filter(Boolean);
    if (notes.length) {
      add("declared build targets", "advise", notes.join("; "));
    } else {
      add("declared build targets", "ok", declared.join(", "));
    }
    if (migrate) {
      // Full conversion to the alpha52 vocabulary — see migrateTasks for the
      // contract (pristine old-scaffold tasks deleted/rewritten, customized
      // ones kept and reported).
      const m = migrateTasks(tasks, expected, legacyTaskTables());
      // PRESERVE what the retired tasks encoded: an app with no `build.targets`
      // carried its fleet only as task names, and deleting those without
      // writing the list down would leave `deno task build` with "no targets
      // to build" and no way to build the app at all. Written in the same
      // atomic rewrite as the deletion — never delete first. The primary
      // target leads the list, so `compile` (--targets=build.targets[0])
      // builds what the app IS, not a hardcoded browser. An existing
      // `build.targets` is the author's word and is never touched.
      const deriveFleet = !hasFleet && taskTargets.length > 0;
      const derivedTargets = primaryTarget !== undefined
        ? [
          primaryTarget as string,
          ...taskTargets.filter((t) => t !== primaryTarget),
        ]
        : taskTargets;
      // The PERSISTED fleet is authoritative for install:electron: when
      // neither `electron` nor `electron-client` is in what deno.json will
      // say after this run, the electron install convenience is matrix
      // residue, not a capability — drop it (pristine only; a customized
      // command is the user's and stays). Persisted, not ephemeral: deciding
      // from a task-derived signal that this same migration deletes made run
      // 1 add the task and run 2 remove it. Without the drop, the electron
      // import mapping every old scaffold carries kept install:electron
      // alive on pure browser/cli/server apps.
      const persistedFleet = new Set<string>([
        ...(hasFleet
          ? declaredTargets({ build: cfg.build })
          : (deriveFleet ? derivedTargets : [])),
        ...(typeof cfg.client === "string" ? [cfg.client as string] : []),
        ...(typeof cfg.target === "string" ? [cfg.target as string] : []),
      ]);
      const fleetHasElectron = persistedFleet.has("electron") ||
        persistedFleet.has("electron-client");
      if (!fleetHasElectron && m.tasks["install:electron"] !== undefined) {
        const v = m.tasks["install:electron"]!;
        const added = m.added.indexOf("install:electron");
        const pristine = legacyTaskTables().some((t) =>
          t["install:electron"] !== undefined &&
          normTask(t["install:electron"]!) === normTask(v)
        );
        if (added >= 0) {
          m.added.splice(added, 1);
          delete m.tasks["install:electron"];
        } else if (pristine) {
          delete m.tasks["install:electron"];
          m.deleted.push("install:electron");
        }
      }
      const changed = m.renamed.length + m.deleted.length +
        m.rewritten.length + m.added.length + (deriveFleet ? 1 : 0);
      await repair(
        "task vocabulary migration",
        changed > 0,
        async () => {
          const raw = JSON.parse(await Deno.readTextFile(jsonPath)) as Record<
            string,
            unknown
          >;
          if (deriveFleet) {
            const build = (raw.build ?? {}) as Record<string, unknown>;
            build.targets = derivedTargets;
            raw.build = build;
          }
          raw.tasks = m.tasks;
          await Deno.writeTextFile(
            jsonPath,
            JSON.stringify(raw, null, 2) + "\n",
          );
        },
        [
          deriveFleet
            ? `recorded "build": { "targets": [${
              derivedTargets.map((t) => `"${t}"`).join(", ")
            }] } (derived from the retired tasks — review the list)`
            : "",
          m.deleted.length
            ? `deleted ${m.deleted.length} old scaffold task(s): ${
              m.deleted.join(", ")
            }`
            : "",
          m.renamed.length
            ? `renamed: ${m.renamed.map(([o, n]) => `${o}→${n}`).join(", ")}`
            : "",
          m.rewritten.length ? `rewrote: ${m.rewritten.join(", ")}` : "",
          m.added.length ? `added: ${m.added.join(", ")}` : "",
        ].filter(Boolean).join("; ") || "already on the one vocabulary",
      );
      if (m.kept.length) {
        add(
          "customized old-matrix tasks",
          "advise",
          `kept, review manually (their commands were user-edited): ${
            m.kept.join(", ")
          }`,
        );
      }
    } else {
      const missingTasks = Object.keys(expected).filter((k) => !(k in tasks));
      await repair(
        "standard deno tasks",
        missingTasks.length > 0,
        async () => {
          const raw = JSON.parse(await Deno.readTextFile(jsonPath)) as Record<
            string,
            unknown
          >;
          const cur = (raw.tasks ?? {}) as Record<string, string>;
          for (const k of missingTasks) cur[k] = expected[k]!;
          raw.tasks = cur;
          await Deno.writeTextFile(
            jsonPath,
            JSON.stringify(raw, null, 2) + "\n",
          );
        },
        missingTasks.length
          ? `added ${missingTasks.length} missing task(s): ${
            missingTasks.slice(0, 5).join(", ")
          }${missingTasks.length > 5 ? ", …" : ""}`
          : "",
      );
      // Old task vocabulary present? Point at the migration — plain fix stays
      // add-only, so it will never delete/rename these itself.
      const legacyNames = new Set(
        legacyTaskTables().flatMap((t) => Object.keys(t)),
      );
      const oldVocab = Object.keys(tasks).filter((k) =>
        (legacyNames.has(k) && !(k in expected)) || k in SERVICE_RENAMES
      );
      if (oldVocab.length) {
        add(
          "task vocabulary",
          "advise",
          `${oldVocab.length} pre-alpha52 task(s) (${
            oldVocab.slice(0, 4).join(", ")
          }${oldVocab.length > 4 ? ", …" : ""}) — run \`am fix ` +
            "--migrate-tasks` to convert them to the one vocabulary",
        );
      }
    }
  } else {
    add(
      "standard deno tasks",
      "advise",
      "custom framework path — task values are unknowable; compare with `am create` output",
    );
  }

  // Warm the dependency cache (safe — populates the local cache, surfaces any
  // remaining resolution error). Advises rather than fails on error.
  const entry = await resolveEntry(dir);
  if (entry && noDownload) {
    add(
      "dependencies cached",
      "advise",
      `skipped (--no-download) — run \`deno cache ${entry}\` when online`,
    );
  } else if (entry && !dry) {
    const r = await run("deno", ["cache", entry], dir);
    add(
      "dependencies cached",
      r.ok ? "fixed" : "advise",
      r.ok ? entry : `deno cache failed: ${r.err}`,
    );
  } else if (entry) {
    add("dependencies cached", "would-fix", `deno cache ${entry}`);
  }

  // Advisory: the app's IDENTITY is pinned somewhere (source — never
  // auto-edited).
  //
  // Not "appId is in aio.run()". `resolveAppId` infers from `deno.json`'s
  // `appId > title > name` and only falls back to the entry's directory name
  // when a project declares none of the three — so an app whose deno.json has
  // a `name` is already stable, and renaming its directory moves nothing. The
  // advisory used to ignore that and fired on EVERY app scaffolded by
  // `am create`, which writes exactly such a deno.json: the framework's own
  // repair tool telling you to change what the framework had just generated,
  // one command earlier. An advisory that fires on its own output is noise,
  // and noise is how the ones that matter get skipped.
  if (entry) {
    const src = await Deno.readTextFile(join(dir, entry)).catch(() => "");
    const pinnedInConfig = ["appId", "title", "name"].some((k) =>
      typeof cfg?.[k] === "string" && String(cfg[k]).trim() !== ""
    );
    // Retired `appVersion` in aio.run() — the runtime refuses it in dev and
    // ignores it in prod (src/state/removals.ts); say so where the fix is.
    for (const hit of removalsInSource(src)) {
      if (hit.removal.key !== "aio.run({ appVersion })") continue;
      add(
        "app version in aio.run()",
        "advise",
        `${entry}:${hit.line} — ${removalMessage(hit.removal, "aio.run")}`,
      );
    }
    if (/aio\.run\s*\(/.test(src)) {
      cfgAdvise(
        !/appId\s*:/.test(src) && !pinnedInConfig,
        "app identity is pinned",
        "nothing declares this app's identity — add `appId` to aio.run(), or " +
          "a `name` to deno.json. Without either it is inferred from the " +
          "entry's DIRECTORY name, so moving or renaming the folder orphans " +
          "the app's stored state",
      );
    }
  }

  // ── app version: "major.minor", numbered from commits ──
  // A three-part `"version": "1.0.0"` is a PINNED version — accepted, used
  // verbatim, and every build says so. The repair writes the `major.minor`
  // that lets aio number builds from commits (docs/build/versioning.md).
  {
    let declared: unknown;
    let raw = "";
    try {
      raw = await Deno.readTextFile(join(dir, "deno.json"));
      declared = (parseJsonc(raw) as { version?: unknown } | null)?.version;
    } catch {
      /* aio-ok: no deno.json — the checks above already reported it */
    }
    let pinnedBase: string | null = null;
    let refusal: string | null = null;
    try {
      const d = parseDeclaredVersion(declared);
      if (d.kind === "pinned") pinnedBase = d.base;
    } catch (e) {
      refusal = e instanceof Error ? e.message : String(e);
    }
    if (refusal) add("app version", "manual", refusal);
    else {
      await repair(
        "app version",
        pinnedBase !== null,
        async () => {
          const line = /^(\s*"version"\s*:\s*)"[^"]*"/m;
          if (!line.test(raw)) {
            throw new Error(`no "version" line in deno.json`);
          }
          await Deno.writeTextFile(
            join(dir, "deno.json"),
            raw.replace(line, `$1${JSON.stringify(pinnedBase)}`),
          );
        },
        pinnedBase !== null
          ? `version ${
            String(declared)
          } is pinned by deno.json — the build number is not derived; ` +
            `writing "${pinnedBase}" lets aio number builds from commits`
          : "",
      );
    }
  }

  // Advisory: Deno version floor.
  cfgAdvise(
    !meetsMinDeno(Deno.version.deno),
    `Deno ≥ ${MIN_DENO}`,
    `running ${Deno.version.deno} — run: deno upgrade`,
  );

  // ── report ──
  const fixed = res.filter((r) => r.outcome === "fixed").length;
  const would = res.filter((r) => r.outcome === "would-fix").length;
  const advise = res.filter((r) => r.outcome === "advise");
  const manual = res.filter((r) => r.outcome === "manual");
  if (mode === "json") {
    out({
      dir,
      dryRun: dry,
      fixed,
      wouldFix: would,
      advise: advise.length,
      manual: manual.length,
      results: res,
    }, "json");
    if (manual.length) Deno.exit(1);
    return;
  }
  const icon = (o: Outcome) =>
    o === "fixed"
      ? "✓"
      : o === "ok"
      ? "·"
      : o === "would-fix"
      ? "»"
      : o === "advise"
      ? "→"
      : o === "manual"
      ? "✗"
      : "–";
  for (const r of res) {
    console.log(
      `  ${icon(r.outcome)} ${r.name}${r.note ? `  — ${r.note}` : ""}`,
    );
  }
  console.log(
    dry
      ? `\n${would} safe fix(es) available, ${
        count(advise.length, "suggestion")
      }, ` +
        `${
          count(manual.length, "blocker")
        }. Run \`am fix\` to apply the safe ones.`
      : `\n${fixed} fixed, ${
        count(advise.length, "suggestion")
      }, ${manual.length} ` +
        `blocker(s).` + (manual.length ? "" : " Now run: deno task dev"),
  );
  if (advise.length) {
    // Code-level issues (deprecated APIs, older-version patterns) aren't safe
    // to auto-fix — point at the linter rather than touching source.
    console.log(
      "  suggestions above aren't auto-applied (they touch your source/config). " +
        "For code-level checks run the aio linter: `deno task lint:aio` (aiol).",
    );
  }
  if (manual.length) Deno.exit(1);
}
