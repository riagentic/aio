// `am fix` — analyze a cloned aio app and repair the common things that stop it
// building/running. Most are gitignored/uncommitted bits a fresh clone lacks
// (the framework symlink, .env, electron runtime, submodules) plus a few config
// safety nets. `am doctor` diagnoses config; `am fix` repairs. `--dry-run`
// (alias `--check`) reports what it WOULD do without changing anything.
import { standardTasks, type Target, TARGETS } from "./am-cmd-create.ts";
import { join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
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

/** Tasks every aio app wants, whatever it ships. */
const UNIVERSAL_TASKS = [
  "dev",
  "build",
  "compile",
  "test",
  "am",
  "doctor",
  "lint",
] as const;

/** Task keys each declared target needs, keyed by the names accepted in
 *  deno.json `build.targets` (plus the `target` defaults, which share the same
 *  vocabulary — `server` is the headless one, spelled `service` in tasks).
 *
 *  Every key of `standardTasks()` must be reachable from here or from
 *  {@link UNIVERSAL_TASKS}, or `am fix` could never add it again; a test pins
 *  exactly that, so growing the task set cannot silently orphan a task. */
const TARGET_TASKS: Record<string, readonly string[]> = {
  browser: [
    "dev:browser",
    "compile:browser",
    "dev:remote:browser",
    "compile:remote:browser",
  ],
  electron: [
    "dev:electron",
    "compile:electron",
    "dev:remote:electron",
    "compile:remote:electron",
    "install:electron",
  ],
  android: [
    "dev:android",
    "compile:android",
    "dev:remote:android",
    "compile:remote:android",
  ],
  cli: ["dev:cli", "compile:cli", "dev:remote:cli", "compile:remote:cli"],
  server: [
    "dev:service",
    "compile:service",
    "dev:remote:service",
    "compile:remote:service",
  ],
  "electron-client": ["dev:client", "compile:client", "install:electron"],
  "android-client": [
    "dev:android",
    "compile:android",
    "compile:remote:android",
  ],
  "cli-client": ["dev:remote:cli", "compile:remote:cli"],
};

/** Read the fleet an app declares: `target` (the default one) plus
 *  `build.targets` in EITHER spelling — the array form `["server","browser"]`
 *  or the object form `{"server":{"entry":…}}` (per-target overrides). Both are
 *  live spellings, so reading only one would quietly under-repair the other.
 *  Pure. */
export function declaredTargets(cfg: unknown): string[] {
  const seen = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) seen.add(v.trim());
  };
  const c = (cfg ?? {}) as Record<string, unknown>;
  push(c.target);
  const raw = (c.build as Record<string, unknown> | undefined)?.targets;
  if (Array.isArray(raw)) raw.forEach(push);
  else if (raw && typeof raw === "object") Object.keys(raw).forEach(push);
  return [...seen];
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
  for (const e of ["src/app.ts", "src/main.ts", "app.ts", "main.ts"]) {
    if (await exists(join(dir, e))) return e;
  }
  return null;
}

export async function cmdFix(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const dry = args.includes("--dry-run") || args.includes("--check");
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
  const usesElectron =
    Object.values(imports).some((v) => v.includes("electron")) ||
    Object.keys(tasks).some((t) => t.includes("electron"));
  const hasTsx = await exists(join(dir, "src", "App.tsx")) ||
    await exists(join(dir, "App.tsx"));

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
            `was unpinned — recorded "aioVersion": "${res.ref}" in deno.json ` +
              `so every future clone rebuilds against this exact framework ` +
              `(change it with \`am pin <version>\`)`,
          );
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
            `${behind} release(s) behind ${await latestTag(install)} — ` +
              `\`am pin --latest\` moves it (it checks for removed APIs first)`,
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
    } else if (dry) {
      const p = await probeDepAio(dir); // read-only
      add(
        "dep/aio framework link",
        p === "ok" || p === "vendored"
          ? "ok"
          : p === "blocked"
          ? "manual"
          : "would-fix",
        p === "vendored"
          ? "vendored copy — untouched"
          : p === "blocked"
          ? "dep/aio isn't a usable aio"
          : p === "would-link"
          ? `→ ${root}`
          : "",
      );
    } else {
      const r = await linkDepAio(dir, root);
      add(
        "dep/aio framework link",
        r === "linked" ? "fixed" : r === "blocked" ? "manual" : "ok",
        r === "vendored"
          ? "vendored copy — untouched"
          : r === "blocked"
          ? "dep/aio exists but isn't a usable aio — inspect it by hand"
          : r === "linked"
          ? `→ ${root}`
          : "",
      );
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
  if (usesElectron) {
    const have = await exists(join(dir, "node_modules", "electron"));
    await repair(
      "electron runtime installed",
      !have,
      async () => {
        const r = await run(
          "deno",
          ["install", "--allow-scripts=npm:electron", "npm:electron"],
          dir,
        );
        if (!r.ok) throw new Error(r.err || "deno install failed");
      },
      "installed npm:electron",
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
    const all = standardTasks(
      aioMode === "dep",
      (TARGETS as readonly string[]).includes(cfg.target as string)
        ? cfg.target as Target
        : undefined,
    );
    // The app's declared fleet decides which of them apply. Electron is also
    // inferred from imports/tasks: an app already running Electron ships it,
    // whether or not it says so in `target`/`build.targets`.
    const declared = declaredTargets(cfg);
    if (usesElectron && !declared.includes("electron")) {
      declared.push("electron");
    }
    const { tasks: expected, unknown, assumed } = tasksForTargets(
      all,
      declared,
    );
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
  if (entry && !dry) {
    const r = await run("deno", ["cache", entry], dir);
    add(
      "dependencies cached",
      r.ok ? "fixed" : "advise",
      r.ok ? entry : `deno cache failed: ${r.err}`,
    );
  } else if (entry) {
    add("dependencies cached", "would-fix", `deno cache ${entry}`);
  }

  // Advisory: appId present (source — never auto-edited).
  if (entry) {
    const src = await Deno.readTextFile(join(dir, entry)).catch(() => "");
    if (/aio\.run\s*\(/.test(src)) {
      cfgAdvise(
        !/appId\s*:/.test(src),
        "appId set in aio.run()",
        "add appId to aio.run() — the app won't start without it",
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
      ? `\n${would} safe fix(es) available, ${advise.length} suggestion(s), ` +
        `${manual.length} blocker(s). Run \`am fix\` to apply the safe ones.`
      : `\n${fixed} fixed, ${advise.length} suggestion(s), ${manual.length} ` +
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
