/**
 * @module
 * `am create` — scaffold a new aio project (onboard kata). Non-interactive,
 * single command: `am create <name> [--template=counter|todo] [--target=…]`.
 * Produces a minimal, immediately runnable app pinned to this am's aio
 * version (JSR), so `am@X create` and the app's `aio@X` stay in lockstep.
 *
 *   am create my-app                          # counter, browser target
 *   am create my-app --template=todo          # todo list
 *   am create my-app --target=electron        # desktop app (electron auto-install)
 *   am create my-app --target=android         # android (needs SDK + Gradle)
 *   am create my-app --mirror                 # framework-dev: import aio from the repo
 */

import { VERSION } from "../server/aio.ts";
import {
  AIO_ENTRY_PATHS,
  AIO_LIBRARY_ENTRIES,
  entrySubpath,
} from "../entries.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, out } from "./am-output.ts";
import { resolve } from "@std/path";
import { colorEnabled } from "../diagnostics/color.ts";
import {
  ensureVersion,
  latestTag,
  MAIN,
  syncFrameworkDeps,
  writePin,
} from "./am-versions.ts";

const PKG = "@riagentic/aio";
const TEMPLATES = ["counter", "todo"] as const;
export type Template = (typeof TEMPLATES)[number];

/** Build target — what `deno task dev` / `deno task compile` produce by
 *  default. Other shells stay one flag away (`deno task dev --client=X`,
 *  `deno task build --targets=X`); `--target` only picks the default.
 *  `browser` is the zero-toolchain default (instant, no download); `electron`
 *  auto-installs Electron on first run; `android` needs the Android SDK +
 *  Gradle (the one toolchain aio can't fetch for you); `cli`/`server` are
 *  headless (`server` was spelled `service` before alpha52). */
export const TARGETS = [
  "browser",
  "electron",
  "android",
  "cli",
  "server",
] as const;
export type Target = (typeof TARGETS)[number];

const DEFAULT_TARGET: Target = "browser";

/** CLI `--client=X` value for a target (the flag aio.run() reads). `server` →
 *  `server-only` (aio's name for "no client UI"); the others map 1:1.
 *  `android` is excluded: it has no client flag — its dev flow runs the
 *  emulator orchestrator (see `dev:android`), not `src/app.ts`. */
function clientFlagFor(
  t: Exclude<Target, "android">,
): "browser" | "electron" | "cli" | "server-only" {
  return t === "server" ? "server-only" : t;
}

/** Parsed `am create` options. */
export type CreateOpts = {
  name?: string;
  template: Template;
  /** Default build target — `deno task dev` / `deno task compile` use it. */
  target: Target;
  force: boolean;
  /** Explicit path to an aio checkout to import from (overrides the default,
   *  which is the checkout `am` itself runs from). */
  mirror?: string;
  /** Opt into JSR-pinned imports instead of the source default. */
  jsr?: boolean;
  /** Which framework version the app is pinned to: a release tag, or "main" for
   *  the branch tip. Default: the newest release the install knows. The app
   *  records it in its own deno.json so a clone builds against the same aio. */
  aioVersion?: string;
};

/** Parse positional name + create-scoped flags out of the raw args. Unknown
 *  `--flags` are ignored (am's global parser already handled the shared ones). */
export function parseCreateArgs(args: string[]): CreateOpts {
  const opts: CreateOpts = {
    template: "counter",
    target: DEFAULT_TARGET,
    force: false,
  };
  for (const a of args) {
    if (a === "--force") opts.force = true;
    else if (a === "--jsr") opts.jsr = true;
    else if (a === "--mirror" || a === "--dev") opts.mirror = "";
    else if (a.startsWith("--mirror=")) opts.mirror = a.slice(9);
    else if (a.startsWith("--aio-version=")) opts.aioVersion = a.slice(14);
    else if (a.startsWith("--template=")) {
      opts.template = a.slice(11) as Template;
    } else if (a.startsWith("--target=")) {
      let v = a.slice(9) as Target;
      // One vocabulary: the headless role is spelled `server` everywhere.
      // `service` is the deprecated alias — accepted, loudly renamed.
      if ((v as string) === "service") {
        console.error(
          "am create: warning: --target=service is now --target=server (one " +
            "vocabulary — the headless role is `server`); scaffolding a " +
            "server app.",
        );
        v = "server";
      }
      // Loud on a typo — silently falling back to browser would ship the
      // wrong default and the user wouldn't know until `deno task dev`.
      if (!TARGETS.includes(v)) {
        throw new Error(
          `am create: unknown --target=${v} (valid: ${TARGETS.join(", ")})`,
        );
      }
      opts.target = v;
    } else if (!a.startsWith("-") && opts.name === undefined) opts.name = a;
  }
  return opts;
}

/** Framework import specifiers. SOURCE mode (default) points at a `dep/aio`
 *  SYMLINK → the aio checkout, so the app's deno.json is portable (relative);
 *  the symlink is the only machine-specific bit. JSR mode (`--jsr`) pins to the
 *  published version. `source=false` selects JSR. */
export function frameworkSpecs(source: boolean): {
  imports: Record<string, string>;
  build: string;
  buildAll: string;
  devAndroid: string;
  androidInstall: string;
  am: string;
  doctor: string;
  aiol: string;
} {
  // EVERY public entry point, not just the ones the template happens to use:
  // the docs tell people to `import { createDB } from "aio/db"` (or aio/ui,
  // aio/server, `dbWorkerInclude` from aio/build, …), and a specifier the app
  // can't resolve is the "docs lie" class of failure — the app author has no
  // way to know the mapping was simply missing from their deno.json. Derived
  // from THE entry list (src/entries.ts) rather than retyped, because a
  // hand-kept second copy is exactly how `aio/build` went missing here.
  const spec = (s: string) =>
    source
      ? `./dep/aio/${AIO_ENTRY_PATHS[s]}`
      : `jsr:${PKG}@${VERSION}${entrySubpath(s)}`;
  const imports: Record<string, string> = {};
  for (const s of Object.keys(AIO_LIBRARY_ENTRIES)) imports[s] = spec(s);
  if (source) {
    // Consuming framework SOURCE via the `dep/aio` symlink — the app's map must
    // also carry the source's own bare deps (esbuild/immer/@std), which JSR
    // would otherwise resolve transitively.
    Object.assign(imports, {
      "esbuild": "npm:esbuild@^0.24",
      "immer": "npm:immer@^10",
      "happy-dom": "npm:happy-dom@^17",
      "@std/path": "jsr:@std/path@^1",
      "@std/assert": "jsr:@std/assert@^1",
    });
  }
  return {
    imports,
    build: spec("aio/build"),
    buildAll: spec("aio/build-all"),
    devAndroid: spec("aio/dev-android"),
    androidInstall: spec("aio/android-install"),
    am: spec("aio/am"),
    doctor: spec("aio/doctor"),
    aiol: spec("aio/aiol"),
  };
}

/** Build the app's `deno.json`. Every target works OUT OF THE BOX:
 *  - `browser` (default): zero toolchain, instant.
 *  - `electron`: auto-installs Electron on first `deno task dev` / `compile`
 *    (the framework fetches it; no `install:electron` step required).
 *  - `android`: needs the Android SDK + Gradle (the one toolchain aio can't
 *    fetch for you — fails loud with guidance if absent).
 *  - `cli`/`server`: headless.
 *
 *  `--target` picks the DEFAULT for `dev` / `compile`. Every other target
 *  stays one flag away: `deno task dev --client=X` (flags pass through) and
 *  `deno task build --targets=X` / deno.json `build.targets`.
 *
 *  The chosen target is also written to deno.json as `client` so `aio.run()`
 *  can read it (the framework's own client default falls back to it). */
/** THE standard task set for an aio app — one producer, used by `am create`
 *  (scaffold) AND `am fix` (add-only repair for apps missing them: hand-rolled
 *  or pre-dating the tasks). Values depend on how the app consumes the
 *  framework (`source` = dep/aio layout) and its default `target`. */
export function standardTasks(
  source: boolean,
  target: Target = DEFAULT_TARGET,
): Record<string, string> {
  const fw = frameworkSpecs(source);
  // The `--client=X` arg is omitted for the default browser target (matches
  // the framework default). Other targets/flags are a PASS-THROUGH, not a task
  // matrix: `deno task dev --client=electron`, `deno task dev --expose` — the
  // 30-task dev:*/compile:* matrix this replaced was noise nobody could scan
  // (alpha52 "one vocabulary" diet).
  // `android` has no client flag — its dev default IS the emulator
  // orchestrator (boots an AVD, builds+installs+launches; needs the SDK).
  const devDefault = target === "android"
    ? `deno run -A ${fw.devAndroid}`
    : `deno run -A src/app.ts${
      target === "browser" ? "" : ` --client=${clientFlagFor(target)}`
    }`;
  // ONE way to build: the fleet pipeline (`build-all` reading deno.json
  // `build.targets`). `compile` is the same pipeline narrowed to the default
  // target — not a second flag table that can drift from the first (the old
  // per-target COMPILE_FLAGS copy shipped exactly that drift).
  const fleet = `deno run -A ${fw.buildAll} --build-spec=${fw.build}`;
  return {
    // dev runs the configured default; flags pass through:
    //   deno task dev --client=electron   (any shell)
    //   deno task dev --expose            (LAN server side)
    dev: devDefault,
    // build = every target in deno.json `build.targets` → dist/ + manifest.
    build: fleet,
    // compile = build, narrowed to the default target.
    compile: `${fleet} --targets=${target}`,
    test: "deno test -A",
    check: "deno check src/",
    fmt: "deno fmt",
    lint: `deno run -A ${fw.aiol}`,
    doctor: `deno run -A ${fw.doctor}`,
    am: `deno run -A ${fw.am}`,
    // Convenience: pre-fetch the Electron binary without launching. Not
    // required — dev/compile auto-install on demand. Scaffolded only for
    // electron apps (see denoJson()).
    "install:electron": "deno install --allow-scripts=npm:electron",
    // …and the android twin: the built APK onto the connected phone.
    //
    // `install:<target>`, never `<target>:install`. Every qualified task in
    // this scaffold reads verb-first with a TARGET as the qualifier —
    // dev:electron, compile:android, install:electron — so the suffix is one
    // closed vocabulary (the target names) rather than two. A reversed name is
    // a second grammar, and a second grammar is something to remember.
    // Scaffolded only for android apps (see denoJson()).
    "install:android": `deno run -A ${fw.androidInstall}`,
  };
}

/** The task set the PRE-alpha52 scaffold emitted — kept only so
 *  `am fix --migrate-tasks` can recognize a pristine old-scaffold task (and
 *  delete/rewrite it) versus a user-customized one (never touched). The live
 *  producer is {@link standardTasks}; nothing scaffolds from this table. */
export function legacyStandardTasks(
  source: boolean,
  target: Target = DEFAULT_TARGET,
): Record<string, string> {
  const fw = frameworkSpecs(source);
  const devDefault = target === "android"
    ? `deno run -A ${fw.devAndroid}`
    : `deno run -A src/app.ts${
      target === "browser" ? "" : ` --client=${clientFlagFor(target)}`
    }`;
  const COMPILE_FLAGS: Record<Target, string> = {
    browser: "--compile",
    electron: "--compile --electron",
    android: "--android",
    cli: "--compile --cli",
    server: "--compile --service --headless",
  };
  const compileFor = (t: Target) =>
    `deno run -A ${fw.build} ${COMPILE_FLAGS[t]}`;
  return {
    dev: devDefault,
    "dev:browser": "deno run -A src/app.ts --client=browser",
    "dev:electron": "deno run -A src/app.ts --client=electron",
    "dev:android": `deno run -A ${fw.devAndroid}`,
    "dev:cli": "deno run -A src/app.ts --client=cli",
    "dev:service": "deno run -A src/app.ts --client=server-only",
    "dev:client": "deno run -A src/app.ts --server-url",
    "dev:remote:browser": "deno run -A src/app.ts --client=browser --expose",
    "dev:remote:electron": "deno run -A src/app.ts --server-url",
    "dev:remote:android": "deno run -A src/app.ts --client=browser --expose",
    "dev:remote:cli": "deno run -A src/client.ts",
    "dev:remote:service":
      "deno run -A src/app.ts --client=server-only --expose",
    build: `deno run -A ${fw.buildAll} --build-spec=${fw.build}`,
    compile: compileFor(target),
    "compile:browser": compileFor("browser"),
    "compile:electron": compileFor("electron"),
    "compile:android": compileFor("android"),
    "compile:cli": compileFor("cli"),
    "compile:service": compileFor("server"),
    "compile:client": `deno run -A ${fw.build} --client`,
    "compile:remote:browser":
      `deno run -A ${fw.build} --compile --service --remote`,
    "compile:remote:electron":
      `deno run -A ${fw.build} --compile --service --remote && deno run -A ${fw.build} --client`,
    "compile:remote:android":
      `deno run -A ${fw.build} --compile --service --remote && deno run -A ${fw.build} --android --remote`,
    "compile:remote:cli":
      `deno run -A ${fw.build} --compile --service --headless --remote && deno run -A ${fw.build} --compile --cli --remote`,
    "compile:remote:service":
      `deno run -A ${fw.build} --compile --service --headless --remote`,
    "install:electron": "deno install --allow-scripts=npm:electron",
    test: "deno test -A",
    am: `deno run -A ${fw.am}`,
    doctor: `deno run -A ${fw.doctor}`,
    lint: `deno run -A ${fw.aiol}`,
  };
}

export function denoJson(
  name: string,
  source: boolean,
  target: Target = DEFAULT_TARGET,
): string {
  const fw = frameworkSpecs(source);
  // The task diet keeps `install:electron` an electron-only convenience —
  // scaffolding it into a browser/cli/server app is the noise the diet removed.
  const tasks = standardTasks(source, target);
  if (target !== "electron") delete tasks["install:electron"];
  if (target !== "android") delete tasks["install:android"];
  const obj = {
    title: name,
    version: "0.1.0",
    // `client` is read by aio.run() to pick the default client shell when no
    // --client flag is passed (it was called `target` before alpha52 — same
    // meaning, renamed because deno.json also has build.targets, a DIFFERENT
    // axis). Editable by hand; `am` regenerates only on `am create` /
    // `am update` (never silently).
    client: target,
    // `deno task build` builds every target listed here into `out`/ (with a
    // manifest.json). Edit `targets` to fan out — e.g. for a LAN app:
    //   "targets": ["server", "electron-client", "android-client"],
    //   "server": "192.168.1.50:8000"
    // Target names: server · browser · electron · android · cli ·
    // electron-client · android-client · cli-client (run `deno task build --list`).
    //
    // Per-target overrides use the OBJECT form, which the array form above
    // hides completely — nothing in a scaffolded project hints it exists:
    //   "targets": { "electron": { "platforms": ["host"] },
    //                "server":   { "platforms": ["linux"], "entry": "src/svc.ts" } }
    //
    // `platforms` is the OTHER axis — which OS each target is built FOR.
    // Default is just this machine; add more to ship from one command:
    //   "platforms": ["host", "windows", "macos-arm64"]
    // (server · browser · cli · cli-client cross-compile; electron/android
    // package with per-OS tooling and build on their own OS.)
    build: { targets: [target], platforms: ["host"], out: "dist" },
    nodeModulesDir: "auto",
    compilerOptions: {
      lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      jsx: "react-jsx",
      jsxImportSource: "aio",
    },
    imports: { ...fw.imports, electron: "npm:electron" },
    tasks,
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

const GITIGNORE = `.aio/
dist/
node_modules/
dep/
*.sqlite
`;

/** Full file set for a new project — pure (path → content), no disk I/O.
 *  `source` selects the framework mode (dep/aio symlink vs JSR pins).
 *  `target` selects the default for `deno task dev` / `deno task compile`. */
export function scaffold(
  name: string,
  template: Template,
  source: boolean,
  target: Target = DEFAULT_TARGET,
): Record<string, string> {
  // `src/`-based layout: aio infers baseDir from the entry (so `dev` finds
  // src/App.tsx), and the compile pipeline (build.ts) expects src/App.tsx too —
  // one layout that satisfies both `deno task dev` and `deno task compile`.
  const files: Record<string, string> = {
    "deno.json": denoJson(name, source, target),
    ".gitignore": GITIGNORE,
    "src/app.ts": template === "todo" ? TODO_APP : COUNTER_APP,
    "src/cell.ts": template === "todo" ? TODO_CELL : COUNTER_CELL,
    "src/App.tsx": template === "todo" ? TODO_UI : COUNTER_UI,
    // Thin CLI client — `deno run -A src/client.ts` in dev; the `cli-client`
    // fleet target compiles it (build-cli.ts's conventional --cli --remote
    // entry is src/client.ts).
    "src/client.ts": CLIENT_TS,
    "src/cell.test.ts": template === "todo" ? TODO_TEST : COUNTER_TEST,
    "README.md": readme(name, template, target),
  };
  return files;
}

export async function cmdCreate(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const opts = parseCreateArgs(args);

  if (!opts.name) {
    fail(
      "usage: am create <name> [--template=counter|todo] [--target=browser|electron|android|cli|server]",
      mode,
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(opts.name)) {
    fail(
      `invalid project name '${opts.name}' — start with a letter/digit, then letters, digits, '-', '_', '.'`,
      mode,
    );
  }
  if (!TEMPLATES.includes(opts.template)) {
    fail(
      `unknown template '${opts.template}' — choose: ${TEMPLATES.join(", ")}`,
      mode,
    );
  }

  const dir = resolve(Deno.cwd(), opts.name);
  // Refuse a non-empty target — never clobber existing work silently. The
  // refusal is issued OUTSIDE the try: `fail()` does not return, and the
  // catch-all that absorbs "directory doesn't exist" would absorb it too.
  let occupied = false;
  try {
    occupied = [...Deno.readDirSync(dir)].length > 0 && !opts.force;
  } catch { /* doesn't exist — good */ }
  if (occupied) {
    fail(
      `'${opts.name}' already exists and is not empty — pick another name or pass --force`,
      mode,
    );
  }

  // DEFAULT is SOURCE mode: the app imports aio through a `dep/aio` SYMLINK to
  // the checkout `am` runs from (the clone install.sh made, or this repo in
  // dev) — no JSR, no publish. `--mirror=<path>` overrides the source location;
  // `--jsr` opts into JSR pins.
  const source = !opts.jsr;
  let aioPath: string | undefined; // symlink target (source mode only)
  let pinnedVersion: string | undefined; // recorded in the app's deno.json
  if (source) {
    const root = opts.mirror ? resolve(Deno.cwd(), opts.mirror) : repoRoot();
    if (!root) {
      fail(
        "can't locate the aio source am runs from — reinstall via install.sh, " +
          "pass --mirror=<path-to-aio>, or use --jsr to pin from JSR.",
        mode,
      );
    }
    // Pin a VERSION, not "whatever is installed". `dep/aio` points at a
    // provisioned worktree of the requested release, and the app records which
    // one in its deno.json — so `git clone && am fix && deno task dev` builds
    // against the same framework next month, on another machine. Default: the
    // newest release (never the branch tip, which is WIP by definition).
    // `--aio-version=main` opts into the moving target; `--mirror=<path>` still
    // wins for framework development, where the whole point is the live tree.
    if (!opts.mirror) {
      const want = opts.aioVersion ?? await latestTag(root) ?? MAIN;
      const res = await ensureVersion(root, want);
      if (!res.ok) fail(res.error, mode);
      aioPath = res.path;
      // The RESOLVED ref: `--aio-version=main` records `main-<sha>`, so the pin
      // committed with the app is always exact (see am-versions.ts).
      pinnedVersion = res.ref;
    } else {
      aioPath = root;
    }
  } else if (repoRoot() && !flags.json) {
    // --jsr from a source checkout: the pinned version must actually be on JSR.
    console.error(
      `⚠ --jsr pins jsr:${PKG}@${VERSION} — make sure that version is published, ` +
        `or the app's deno task dev won't resolve.`,
    );
  }

  // opts.target was parsed, validated and echoed — but never passed, so every
  // app scaffolded as the DEFAULT target regardless of --target=X.
  const files = scaffold(opts.name, opts.template, source, opts.target);
  await Deno.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = resolve(dir, rel);
    // Nested paths (src/app.ts) need their parent dir created first.
    await Deno.mkdir(resolve(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }

  // Source mode: link dep/aio → the aio checkout. The app's deno.json is
  // relative (./dep/aio/…), so only this symlink is machine-specific (gitignored
  // — re-created by `am link` or re-running create on another machine).
  if (aioPath) {
    await Deno.mkdir(resolve(dir, "dep"), { recursive: true });
    await Deno.symlink(aioPath, resolve(dir, "dep/aio")).catch(async (e) => {
      // Already exists (e.g. --force re-run): replace it.
      if (e instanceof Deno.errors.AlreadyExists) {
        await Deno.remove(resolve(dir, "dep/aio")).catch(() => {});
        await Deno.symlink(aioPath!, resolve(dir, "dep/aio"));
      } else throw e;
    });
  }

  // Record the pin IN the app, committed with the code — the whole point.
  if (pinnedVersion) {
    await writePin(dir, pinnedVersion);
    // …and pin the framework's OWN dependencies to what that version declares.
    // The scaffold writes ranges (`immer@^10`); the framework pins exact
    // (`immer@10.2.0`), and `dep/aio/**` resolves through THIS map — so without
    // this a brand-new app would be half-pinned from birth (see
    // syncFrameworkDeps in am-versions.ts).
    if (aioPath) await syncFrameworkDeps(dir, aioPath);
  }

  // Make it a real project from second one — best-effort, never fatal.
  const gitInit = await tryGitInit(dir);

  if (flags.json) {
    out({
      created: opts.name,
      template: opts.template,
      target: opts.target,
      aioVersion: pinnedVersion ?? null,
      files: Object.keys(files),
      git: gitInit,
    }, "json");
    return;
  }

  const C = mode === "pretty" && colorEnabled; // NO_COLOR, and pipes
  const b = (s: string) => C ? `\x1b[1m${s}\x1b[0m` : s;
  const dim = (s: string) => C ? `\x1b[2m${s}\x1b[0m` : s;
  const cyan = (s: string) => C ? `\x1b[36m${s}\x1b[0m` : s;
  const grn = (s: string) => C ? `\x1b[32m${s}\x1b[0m` : s;
  // Show the chosen target's dev command + a hint about other targets.
  const devHint = opts.target === "browser"
    ? `→ ${opts.target} (others: --client=electron|cli|server-only)`
    : `→ ${opts.target}`;
  out(
    [
      "",
      `  ${grn("✓")} ${b(opts.name)} ${
        dim(`— aio ${opts.template} app · target=${opts.target}`)
      }${gitInit ? dim("  ·  git initialized") : ""}`,
      "",
      `  ${dim("run it")}`,
      `    cd ${opts.name}`,
      `    ${cyan("deno task dev")}            ${dim(devHint)}`,
      ...(opts.target === "browser"
        ? [
          "",
          `  ${dim("ship it")}`,
          `    ${cyan("deno task compile")}        ${dim("→ a single binary")}`,
          `    ${cyan("deno task build --targets=electron")} ${
            dim("→ desktop AppImage")
          }`,
          `    ${cyan("deno task build --targets=android")}  ${
            dim("→ Android APK")
          }`,
        ]
        : []),
      "",
      `  ${dim("also:")} ${cyan("deno task test")} ${dim("·")} ${
        cyan("deno task am status")
      } ${dim("·")} ${cyan("deno task lint")}`,
      "",
    ].join("\n"),
    mode,
  );
}

/** `git init` + first commit so the new project has history from minute one.
 *  Best-effort: no git, or an existing repo, is fine — never fails the create. */
async function tryGitInit(dir: string): Promise<boolean> {
  try {
    // Already inside a repo? Don't nest one.
    const inside = await new Deno.Command("git", {
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
    if (inside.success) return false;
    const run = (args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd: dir,
        stdout: "null",
        stderr: "null",
      })
        .output();
    if (!(await run(["init"])).success) return false;
    await run(["add", "-A"]);
    await run(["commit", "-m", "initial commit — scaffolded with am"]);
    return true;
  } catch {
    return false; // git not installed — fine.
  }
}

/** The aio checkout `am` runs from (the clone install.sh made, or the repo in
 *  dev); undefined when am is a JSR-installed global. */
export function repoRoot(): string | undefined {
  // src/am/am-cmd-create.ts → repo root is three levels up.
  const dir = import.meta.dirname;
  if (!dir) return undefined;
  const root = resolve(dir, "..", "..");
  try {
    Deno.statSync(resolve(root, "mod.ts"));
    return root;
  } catch {
    return undefined;
  }
}

function readme(name: string, template: Template, target: Target): string {
  return `# ${name}

An [aio](https://github.com/riagentic/aio) app (${template} template).

> **Cloned this repo?** The framework link, \`.env\`, and \`node_modules\` are
> gitignored — run \`am fix\` once (after installing \`am\` via the aio install
> script) to repair them, then \`deno task dev\` works.

\`\`\`sh
deno task dev              # run — ${target} (flags pass through, see below)
deno task test             # run the starter test
deno task compile          # build the default target (${target})
deno task build            # build every target in deno.json build.targets → dist/
deno task check            # type-check src/
\`\`\`

**\`dev\` flags pass through** — one task, any shell:

\`\`\`sh
deno task dev --client=electron     # desktop window (auto-installs Electron)
deno task dev --client=cli          # terminal client
deno task dev --client=server-only  # headless server
deno task dev --expose              # reachable on the LAN (prints pair PIN)
\`\`\`

**Ship more targets** by listing them in deno.json —
\`"build": { "targets": ["${target}", "electron", "android"] }\` — then
\`deno task build\` (or one-off: \`deno task build --targets=electron\`).
Run \`deno task build --list\` for every target name.

State lives in \`src/cell.ts\`, UI in \`src/App.tsx\`, entry in \`src/app.ts\`.
Manage a running app with \`deno task am\` (status, state, logs, …).
`;
}

// ── Templates ──────────────────────────────────────────────────────────────
// Kept in lockstep with examples/counter and examples/todo — the two apps aio
// ships out of the box.

const COUNTER_CELL =
  `// Cell — pure state + methods; UI and server both import from here.
import { cell } from "aio";

// Persists by default — restart and the count survives.
export const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    decrement(s, by = 1) {
      s.count -= by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});
`;

const COUNTER_APP =
  `// Entry — zero-config: cells self-register on import; appId/version/baseDir
// are inferred from deno.json + this file's location.
import "./cell.ts";
import { aio } from "aio";

await aio.run();
`;

const CLIENT_TS =
  `// Thin CLI client — live view of a running server's state over WebSocket.
// Run it against a dev server (\`deno run -A src/client.ts\`); the
// \`cli-client\` build target compiles it into a standalone client binary
// (add "cli-client" to build.targets, then \`deno task build\`). No local server.
import { connectCli } from "aio/server";

const url = Deno.args[0] || "ws://localhost:8000/ws";
console.log(\`connecting to \${url} ...\`);
const app = connectCli(url);
await app.ready;
console.log("state:", JSON.stringify(app.state, null, 2));
app.subscribe(() => console.log("state:", JSON.stringify(app.state)));
`;

const COUNTER_UI = `// UI — export default; the framework mounts it.
import { counter } from "./cell.ts";

const btn: Record<string, string> = {
  padding: "0.75rem 1.5rem",
  fontSize: "1.25rem",
  cursor: "pointer",
};

export default function App() {
  return (
    <div style={{ padding: "3rem", fontFamily: "system-ui, sans-serif", textAlign: "center" }}>
      <h1>AIO Counter</h1>
      <div style={{ fontSize: "4rem", margin: "1rem 0", color: "#00a6cc" }}>
        {counter.count}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
        <button type="button" onClick={() => counter.decrement()} style={btn}>−</button>
        <button type="button" onClick={() => counter.reset()} style={btn}>Reset</button>
        <button type="button" onClick={() => counter.increment()} style={btn}>+</button>
      </div>
    </div>
  );
}
`;

const COUNTER_TEST =
  `// A starter test — \`deno task test\`. Cells are pure, so they test in isolation
// (no server, no DOM) with the testCell harness.
import { testCell } from "aio/testing";
import { counter } from "./cell.ts";

testCell(counter, "increments, adds, and resets", (t) => {
  t.send.increment();
  t.send.increment(5);
  t.expect.state((s) => s.count === 6);
  t.send.reset();
  t.expect.state((s) => s.count === 0);
});
`;

const TODO_CELL =
  `// Cells — pure state + methods; UI and server both import from here.
import { cell } from "aio";

export type Todo = { id: number; text: string; done: boolean };
export type Filter = "all" | "active" | "done";

export const todo = cell("todo", {
  state: {
    items: [] as Todo[],
    nextId: 1,
  },
  methods: {
    add(s, text: string) {
      s.items.push({ id: s.nextId++, text, done: false });
    },
    toggle(s, id: number) {
      const item = s.items.find((t) => t.id === id);
      if (item) item.done = !item.done;
    },
    remove(s, id: number) {
      s.items = s.items.filter((t) => t.id !== id);
    },
    clearDone(s) {
      s.items = s.items.filter((t) => !t.done);
    },
  },
});

// Per-tab UI state — client-scoped: never syncs, never persists.
export const view = cell("view", {
  scope: "client",
  state: { filter: "all" as Filter },
  methods: {
    setFilter(s, filter: Filter) {
      s.filter = filter;
    },
  },
});
`;

const TODO_TEST =
  `// A starter test — \`deno task test\`. Cells are pure, so they test in isolation
// (no server, no DOM) with the testCell harness.
import { testCell } from "aio/testing";
import { todo, view } from "./cell.ts";

testCell(todo, "adds, toggles, and clears items", (t) => {
  t.send.add("write a test");
  t.send.add("ship it");
  t.expect.state((s) => s.items.length === 2);
  t.send.toggle(1);
  t.expect.state((s) => s.items[0].done === true);
  t.send.clearDone();
  t.expect.state((s) => s.items.length === 1);
});

// A client-scoped cell is a cell — same harness, no browser needed.
testCell(view, "switches the filter", (t) => {
  t.send.setFilter("done");
  t.expect.state((s) => s.filter === "done");
});
`;

const TODO_APP = `// Entry — zero-config: cells self-register on import.
import "./cell.ts";
import { aio } from "aio";

export type { Filter, Todo } from "./cell.ts";

await aio.run();
`;

const TODO_UI = `// UI — a filterable todo list.
import { useLocal } from "aio/air";
import { type Filter, type Todo, todo, view } from "./cell.ts";

const FILTERS: Filter[] = ["all", "active", "done"];

export default function App() {
  const { local: input, set: setInput } = useLocal("");

  const filtered: Todo[] = todo.items.filter((t: Todo) =>
    view.filter === "all" ? true: view.filter === "done" ? t.done: !t.done
  );
  const remaining = todo.items.filter((t: Todo) => !t.done).length;

  return (
    <div style={{ maxWidth: 480, margin: "2rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ textAlign: "center", color: "#c77" }}>todos</h1>

      <form
        onSubmit={() => {
          if (input.trim()) {
            todo.add(input.trim());
            setInput("");
          }
        }}
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          placeholder="What needs to be done?"
          style={{ flex: 1, padding: "0.5rem", fontSize: "1rem" }}
        />
        <button type="submit" style={{ padding: "0.5rem 1rem" }}>Add</button>
      </form>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {filtered.map((t) => (
          <li
            key={t.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.5rem 0",
              borderBottom: "1px solid #eee",
            }}
          >
            <input type="checkbox" checked={t.done} onChange={() => todo.toggle(t.id)} />
            <span
              style={{
                flex: 1,
                textDecoration: t.done ? "line-through": "none",
                color: t.done ? "#999": "inherit",
              }}
            >
              {t.text}
            </span>
            <button
              type="button"
              onClick={() => todo.remove(t.id)}
              style={{ color: "#c44", border: "none", background: "none", cursor: "pointer" }}
            >
              x
            </button>
          </li>
        ))}
      </ul>

      {todo.items.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: "0.5rem",
            fontSize: "0.85rem",
            color: "#888",
          }}
        >
          <span>{remaining} item{remaining !== 1 ? "s": ""} left</span>
          <div style={{ display: "flex", gap: "0.25rem" }}>
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => view.setFilter(f)}
                style={{
                  padding: "0.2rem 0.5rem",
                  border: view.filter === f ? "1px solid #c77": "1px solid transparent",
                  background: "none",
                  cursor: "pointer",
                  borderRadius: 3,
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => todo.clearDone()}
            style={{ border: "none", background: "none", cursor: "pointer", color: "#888" }}
          >
            Clear done
          </button>
        </div>
      )}
    </div>
  );
}
`;
