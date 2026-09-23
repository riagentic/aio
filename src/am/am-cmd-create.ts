/**
 * @module
 * `am create` — scaffold a new aio project (onboard kata). Non-interactive,
 * single command: `am create <name> [--template=counter|todo|cli] [--target=…]`.
 * Produces a minimal, immediately runnable app pinned to this am's aio
 * version (JSR), so `am@X create` and the app's `aio@X` stay in lockstep.
 *
 *   am create my-app                          # counter, browser target
 *   am create my-app --template=todo          # todo list
 *   am create my-tool --template=cli          # a scriptable CLI (server + commands)
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
import { detectMode, fail, out, sayErr } from "./am-output.ts";
import { reservedAppNameError } from "./am-utils.ts";
import { resolve } from "@std/path";
import { colorEnabled } from "../diagnostics/color.ts";
import { styleWith } from "../diagnostics/fmt.ts";
import { PATH_PIN_PREFIX } from "../server/framework-pin.ts";
import { LOCAL_PIN_FILE } from "../server/deno-json.ts";
import { appHome, type AppMeta } from "../server/app-dirs.ts";
import { resolveAppId } from "../server/single-instance-lock.ts";
import { GIT_NO_PROMPT_ENV } from "../server/git-noninteractive.ts";
import {
  ensureVersion,
  latestTag,
  MAIN,
  syncFrameworkDeps,
  writePin,
} from "./am-versions.ts";
import { type Template, TEMPLATES } from "./am-help-text.ts";
import { agentsMdScaffold, CLAUDE_MD_SCAFFOLD } from "./am-agent-text.ts";
import { DEFAULT_ELECTRON_VERSION } from "../build/electron-runtime.ts";

/** The scaffold's `electron` import spec — the framework's ONE Electron
 *  version, pinned EXACTLY.
 *
 *  It used to be the bare `npm:electron`, which resolves to whatever is latest
 *  at INSTALL time. That is not a pin: two apps scaffolded a month apart ran
 *  different Chromiums, and neither matched `DEFAULT_ELECTRON_VERSION` — the
 *  floor a build uses when nothing is installed — so the same source could ship
 *  one Electron in dev and another in the artifact.
 *
 *  Exact, not a `^`-range, for the same reason `esbuild` is pinned exactly and
 *  is checked by `tests/esbuild-version-pin.test.ts`: the framework tests ONE
 *  Electron, and a scaffolded app must run that one. A range re-opens the drift
 *  — an app installing 44.4.2 while the framework's floor is 44.4.1 — and the
 *  whole point of this round was that there is one version. To move it, `aio`
 *  moves `DEFAULT_ELECTRON_VERSION` and every app follows in one change. */
function electronImportSpec(): string {
  return `npm:electron@${DEFAULT_ELECTRON_VERSION}`;
}

const PKG = "@riagentic/aio";
/** THE scaffold templates — declared once in `am-help-text.ts`, which is also
 *  where `am help` reads them, and re-exported here because this is the
 *  command that accepts them. */
export { TEMPLATES };
export type { Template };

/** Build target — what `deno task dev` / `deno task compile` produce by
 *  default. Other shells stay one flag away (`deno task dev --client=X`,
 *  `deno task build --targets=X`); `--target` only picks the default.
 *  `browser` is the zero-toolchain default (instant, no download); `electron`
 *  auto-installs Electron on first run; `android` needs the Android SDK +
 *  Gradle (the one toolchain aio can't fetch for you); `cli`/`server` are
 *  headless (`server` was spelled `service` before alpha52). */
// Imported AND re-exported: a bare `export … from` re-export does not bind the
// names in THIS module's scope, and this file uses both (`--target=` parsing,
// the CreateArgs field). Callers keep importing them from here as before.
import { CREATE_FLAGS, type Target, TARGETS } from "./am-help-text.ts";
export { type Target, TARGETS };

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
  /** A CSS toolchain to wire up (`--css=tailwind`). Absent means the generated
   *  theme, which is what most apps want. Wiring it here rather than in a doc
   *  matters because the three pieces have to agree: the npm import, the
   *  `build.css` command, and a `src/app.css` for the tool to read. Getting one
   *  of the three wrong is the failure a recipe produces and a scaffold does
   *  not. */
  css?: "tailwind";
};

/** Parse positional name + create-scoped flags out of the raw args. Unknown
 *  `--flags` are ignored (am's global parser already handled the shared ones). */
export function parseCreateArgs(args: string[]): CreateOpts {
  const opts: CreateOpts = {
    template: "counter",
    target: DEFAULT_TARGET,
    force: false,
  };
  let targetGiven = false;
  for (const a of args) {
    if (a === "--force") opts.force = true;
    else if (a === "--jsr") opts.jsr = true;
    else if (a === "--mirror" || a === "--dev") opts.mirror = "";
    else if (a.startsWith("--mirror=")) opts.mirror = a.slice(9);
    else if (a.startsWith("--aio-version=")) opts.aioVersion = a.slice(14);
    else if (a.startsWith("--template=")) {
      opts.template = a.slice(11) as Template;
    } else if (a.startsWith("--css=")) {
      const v = a.slice(6);
      if (v !== "tailwind") {
        throw new Error(
          `am create: unknown --css=${v} (valid: tailwind). Any other tool ` +
            `works too — set \`build.css\` in deno.json by hand; see ` +
            `docs/ui/css-toolchain.md.`,
        );
      }
      opts.css = v;
    } else if (a.startsWith("--target=")) {
      let v = a.slice(9) as Target;
      // One vocabulary: the headless role is spelled `server` everywhere.
      // `service` is the deprecated alias — accepted, loudly renamed.
      if ((v as string) === "service") {
        sayErr(
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
      targetGiven = true;
    } else if (a.startsWith("-")) {
      // AN UNKNOWN FLAG IS AN ERROR, not a no-op.
      //
      // This loop used to end at the name branch, so anything it did not
      // recognise fell off the end in silence. `am create app --dir=/tmp/x`
      // therefore scaffolded into the CURRENT directory and reported success,
      // naming a path the user had not asked for — measured: it created an app
      // inside the framework repo itself. The project's own words, in
      // `server/config.ts` about deno.json keys: "silently ignoring input is
      // the worst available behaviour". `am log` has refused unknown flags
      // since alpha70; this is the same rule, in the verb people run first.
      throw new Error(
        `am create: unknown flag ${a.split("=")[0]}\n` +
          `  accepted: ${CREATE_FLAGS.join(", ")}\n` +
          `  the app is created in ./<name> — there is no --dir; cd where you ` +
          `want it first.`,
      );
    } else if (opts.name === undefined) opts.name = a;
    else {
      // One name, one directory. `am create my app` scaffolded `my` and
      // dropped `app` without a word — and `--template counter` (space, not
      // `=`) lost the template the same way, creating the default one.
      throw new Error(
        `am create: unexpected argument "${a}" — the app name is ` +
          `"${opts.name}", and create takes exactly one\n` +
          `  a name is one word (my-app, my_app); flags take their value ` +
          `with '=' (--template=todo)`,
      );
    }
  }
  // A CLI template is a CLI: with no `--target`, its default is `cli`, not
  // the browser — a scaffold whose `deno task compile` built a browser shell
  // for a tool with no UI would be the wrong default, silently.
  if (opts.template === "cli" && !targetGiven) opts.target = "cli";
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
  ship: string;
  electronInstall: string;
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
    ship: spec("aio/ship"),
    electronInstall: spec("aio/electron-install"),
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
  /** The scaffold this task set is for. Only `cli` changes anything: its
   *  `src/app.ts` is ONE binary with two roles and demands a command word, so
   *  `deno run -A src/app.ts --client=cli` — which is what the target alone
   *  produces — exited with "missing command" on the very first
   *  `deno task dev` of a fresh `--template=cli` scaffold. */
  template: Template = "counter",
): Record<string, string> {
  const fw = frameworkSpecs(source);
  // The `--client=X` arg is omitted for the default browser target (matches
  // the framework default). Other targets/flags are a PASS-THROUGH, not a task
  // matrix: `deno task dev --client=electron`, `deno task dev --expose` — the
  // 30-task dev:*/compile:* matrix this replaced was noise nobody could scan
  // (alpha52 "one vocabulary" diet).
  // `android` has no client flag — its dev default IS the emulator
  // orchestrator (boots an AVD, builds+installs+launches; needs the SDK).
  const devDefault = template === "cli"
    // The cli scaffold's dev loop IS its server: `todo serve`. Its app.ts
    // routes on the command word, and `--client=cli` is not one.
    ? "deno run -A src/app.ts serve"
    : target === "android"
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
    // The release pair. They are two tasks because they answer two different
    // questions, at two different frequencies:
    //
    //   publish — EVERY release. Build, sign, and lay out the channel
    //     directory a client actually fetches, in one step. `aio ship` signs
    //     ONE artifact and stops; the layout that makes those two files
    //     reachable lived only in prose, and both documented flows got it
    //     wrong (one wrote a manifest with no data contract, the other wrote
    //     it to a path no client requests). Both fail the same way: silently,
    //     permanently, on the users' machines, weeks later.
    //   ship — ONCE, ever, plus the corners. `deno task ship keygen` makes the
    //     signing key `publish` needs; `deno task ship github` writes the CI
    //     workflow. Docs and the CLI's own messages spell both of those as
    //     `ship`, so the task has to exist for those instructions to be true.
    //
    // Both are scaffolded because publishing was otherwise undiscoverable: an
    // app author with neither task has no reason to know either command
    // exists, and the alternative they reach for — copying a binary somewhere
    // — produces an app that can never update itself.
    publish: `deno run -A ${fw.am} publish`,
    ship: `deno run -A ${fw.ship}`,
    test: "deno test -A",
    // BOTH halves, in one task — the same reasoning as `lint` below.
    // `deno check` type-checks; it does not bundle, and in aio those have
    // different answers: `"aio"` resolves to mod.ts for the type-checker and
    // browser-air.ts for the browser bundle, so TypeScript checks the UNION
    // while the bundle gets the INTERSECTION. Anything server-only imported
    // into a cell type-checks cleanly and then fails to build. A field report
    // called that the only defect in its whole write-up — not because the
    // failure is obscure (dev boot names file, line, column and fix) but
    // because it arrives AFTER the tool the author trusts, and the one CI
    // runs, has said the code is fine. A task called `check` has to be true.
    //
    // `tests/` too, because every template scaffolds one: replace the cell and
    // the starter test still imports `counter`, so `deno check src/` passed
    // and the break waited for `deno task test` — not the gate an agent runs
    // first (report 9b §7).
    check: `deno check src/ tests/ && deno run -A ${fw.am} check`,
    fmt: "deno fmt",
    // BOTH linters, in one task. `aiol` knows the aio rules and NOTHING about
    // the language: a scaffolded app whose `lint` ran aiol alone was never
    // checked for an unused import, an `any`, an unawaited promise or a
    // shadowed name — the whole `deno lint` rule set, silently absent from
    // every app aio scaffolds while the task's name promised it. The framework
    // repo runs both (`lint` = deno lint, `lint:aio` = aiol); an app gets one
    // task that does the same, because two tasks is one more to remember.
    lint: `deno lint src/ && deno run -A ${fw.aiol}`,
    doctor: `deno run -A ${fw.doctor}`,
    am: `deno run -A ${fw.am}`,
    // Convenience: pre-fetch the Electron binary without launching. Not
    // required — dev/compile auto-install on demand. Scaffolded only for
    // electron apps (see denoJson()).
    // NOT `deno install --allow-scripts=npm:electron`. That command exits 0
    // having SKIPPED the lifecycle script whenever deno decides the package is
    // not newly added — leaving no `dist/`, so the build then advises running
    // the very task that just did nothing. A field report went round that loop
    // and escaped only by finding `node_modules/electron/install.js` by hand.
    // The framework's launcher already falls back to that installer; this is
    // the same code, so the task and the launcher cannot disagree.
    "install:electron": `deno run -A ${fw.electronInstall}`,
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
    // NOT `deno install --allow-scripts=npm:electron`. That command exits 0
    // having SKIPPED the lifecycle script whenever deno decides the package is
    // not newly added — leaving no `dist/`, so the build then advises running
    // the very task that just did nothing. A field report went round that loop
    // and escaped only by finding `node_modules/electron/install.js` by hand.
    // The framework's launcher already falls back to that installer; this is
    // the same code, so the task and the launcher cannot disagree.
    "install:electron": `deno run -A ${fw.electronInstall}`,
    // `deno task ship dist/<artifact>` — turn a built artifact into a signed,
    // channel-bound release manifest (and the channel directory to publish).
    // Scaffolded because publishing was otherwise undiscoverable: an app author
    // with no `ship` task has no reason to know the command exists, and the
    // alternative they reach for — copying a binary somewhere — produces an app
    // that can never update itself. Run with no argument, it prints its usage.
    publish: `deno run -A ${fw.am} publish`,
    ship: `deno run -A ${fw.ship}`,
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
  template: Template = "counter",
  css?: "tailwind",
): string {
  const fw = frameworkSpecs(source);
  // The task diet keeps `install:electron` an electron-only convenience —
  // scaffolding it into a browser/cli/server app is the noise the diet removed.
  const tasks = standardTasks(source, target, template);
  if (target !== "electron") delete tasks["install:electron"];
  if (target !== "android") delete tasks["install:android"];
  const obj = {
    title: name,
    // `major.minor` only — aio numbers builds from commits: every artifact
    // is `<name>-0.1.<commit count>…` and reports that version. Bump this by
    // hand; never write a third part (that pins it). docs/build/versioning.md
    version: "0.1",
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
    // `.katana/` is a SPECIFICATION the author wrote, not prose to normalise.
    // The scaffold owned `deno fmt` with no exclude, so a mid-session
    // `deno task fmt` rewrapped the app's own quality spec — two field
    // reports, one of which had an exact-match edit against a kata break
    // underneath it. A tool that edits the file you are writing the rules in
    // is a tool you stop running.
    fmt: { exclude: [".katana/", "feedback/", "dist/", "node_modules/"] },
    nodeModulesDir: "auto",
    compilerOptions: {
      lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      jsx: "react-jsx",
      jsxImportSource: "aio",
    },
    // `electron` is scaffolded ONLY for a desktop app. Mapping it
    // unconditionally cost every browser/cli/server app the whole Electron
    // npm tree — the installer plus @electron/get, extract-zip, undici,
    // sumchecker, @types/node: ~9 MB downloaded and materialised into
    // node_modules for a counter that never opens a window. Nothing is lost:
    // `deno task dev --client=electron` from a browser app still works,
    // because the launcher auto-installs Electron on demand
    // (electron-spawn.ts `autoInstallElectron`, "even when the app didn't
    // declare electron as a dep") and the version resolver falls back to the
    // framework default (electron-runtime.ts `resolveElectronVersion`).
    imports: {
      ...(target === "electron"
        ? { ...fw.imports, electron: electronImportSpec() }
        : fw.imports),
      // Tailwind v4's CLI resolves `tailwindcss` as a node package from the
      // project, so the import must be here AND `nodeModulesDir` on (it is,
      // above). Measured: without the mapping the CLI fails with
      // "Can't resolve 'tailwindcss'" and nothing points at the cause.
      ...(css === "tailwind" ? { tailwindcss: "npm:tailwindcss@^4" } : {}),
    },
    tasks,
  };
  if (template === "assets") {
    // BOTH halves, together. A mount with no directory is a 404; a directory
    // with no mount is a 404 that looks like a build problem. The scaffold
    // writes `media/hello.txt` beside this, and the build reads THIS key to
    // decide what to embed in the binary — so there is nothing to keep in
    // sync with a `compile.include` entry.
    // The BUILD reads this to decide what to embed. The SERVER reads its own
    // copy from `aio.run({ assets })` in the entry — see ASSETS_APP. The
    // scaffold used to write only this one, so the template's own feature
    // 404'd in dev AND in the compiled binary: the directory was embedded and
    // nothing mounted it, while every gate (`check`, `lint`, `doctor`,
    // `am fix`) reported the app fine and only the runtime warned.
    (obj as Record<string, unknown>).assets = { "/media": "./media" };
  }
  if (css === "tailwind") {
    // The generated theme steps fully aside the moment `src/style.css` exists,
    // and this command's output IS that file — which is why Tailwind needs no
    // adapter here, only wiring. Runs before every dev reload and every build.
    (obj.build as Record<string, unknown>).css =
      "deno run -A npm:@tailwindcss/cli -i src/app.css -o src/style.css";
  }
  return JSON.stringify(obj, null, 2) + "\n";
}

// A release SIGNING key committed to the repo is the worst thing in this list:
// whoever has it can publish an update every install of this app will accept,
// signed, and the app itself pins the matching public key. `aio ship keygen`
// writes outside the work tree by default and refuses a path inside one, but
// the name is also ignored here — belt and braces, because a key restored from
// a backup or written by hand must not ride out on a `git add -A`.
/** The Tailwind SOURCE sheet. Its output is `src/style.css`, which the
 *  generated theme steps aside for — that contract is why this needs no
 *  adapter, only wiring. */
const TAILWIND_SOURCE = `@import "tailwindcss";

/* Your own CSS goes here too — this file is the source, and
   src/style.css is what the build writes from it (gitignored).

   Tailwind scans src/ for classes automatically. Point it somewhere
   else with @source "../elsewhere";

   aio's theme tokens are still available if you want them:
     @theme { --color-accent: var(--aio-accent); } */
`;

const GITIGNORE = `.aio/
dist/
node_modules/
dep/
*.sqlite

# Secrets — "am fix" writes .env; .env.example is the committed template
.env
!.env.example

# Release signing keys — NEVER commit these (see \`aio ship keygen\`)
release-key.json
*-release-key.json
*.release-key.json
`;

/** Full file set for a new project — pure (path → content), no disk I/O.
 *  `source` selects the framework mode (dep/aio symlink vs JSR pins).
 *  `target` selects the default for `deno task dev` / `deno task compile`. */

// ── `--template=canvas` ─────────────────────────────────────────────────────
//
// The 3D/2D half of an app has no framework test: under happy-dom there is no
// WebGL context, so `testUI` cannot drive a canvas at all. A report found the
// answer unaided (report 6 §6) and it is worth scaffolding rather than only
// writing down: pull the DECISIONS out of the imperative shell, so "what did
// the ray hit" and "where is everything now" are pure functions of what the
// renderer knows, and only the drawing calls stay untestable.
//
// The scaffolded app is a bouncing-ball loop, which is the smallest thing that
// has both halves: `step()` is pure and tested, `draw()` is four canvas calls
// with no branches worth covering.

const CANVAS_CELL = `import { cell } from "aio";

/** One body in the world. Plain data — the renderer reads it, nothing more. */
export type Ball = { x: number; y: number; dx: number; dy: number };

export type World = { balls: Ball[]; paused: boolean; width: number; height: number };

/** THE DECISION, and the whole reason this template exists: advancing the
 *  world is a PURE FUNCTION of the world. No canvas, no context, no globals —
 *  so \`tests/cell.test.ts\` can assert about bouncing without a GPU.
 *
 *  Exported on its own (not only as a method) so a test can call it directly
 *  with a hand-built world, which is how you test the edge cases a running app
 *  reaches once an hour. */
export function step(w: World): Ball[] {
  return w.balls.map((b) => {
    let { x, y, dx, dy } = b;
    x += dx;
    y += dy;
    if (x < 0 || x > w.width) dx = -dx;
    if (y < 0 || y > w.height) dy = -dy;
    return { x, y, dx, dy };
  });
}

export const world = cell("world", {
  state: {
    width: 640,
    height: 360,
    paused: false,
    balls: [
      { x: 40, y: 40, dx: 2.5, dy: 1.7 },
      { x: 300, y: 120, dx: -1.9, dy: 2.2 },
      { x: 500, y: 260, dx: 1.3, dy: -2.6 },
    ] as Ball[],
  },
  methods: {
    tick(s: World) {
      if (s.paused) return;
      s.balls = step(s);
    },
    toggle(s: World) {
      s.paused = !s.paused;
    },
    resize(s: World, size: { width: number; height: number }) {
      s.width = size.width;
      s.height = size.height;
    },
  },
});
`;

const CANVAS_UI = `// UI — the imperative shell, and nothing else.
//
// Every decision lives in src/cell.ts as a pure function. What is left here is
// four canvas calls with no branches, which is the part a screenshot check
// covers (\`am shot --check\`) and a unit test never could.
//
// See docs/testing/canvas-and-3d.md for the whole pattern.
import type { JSX } from "aio";
import { onCleanup, onMount, useRaf } from "aio/air";
import { world } from "./cell.ts";

export default function App(): JSX.Element {
  let canvas: HTMLCanvasElement | null = null;

  // The loop drives the CELL, not the canvas: state lives on the server and
  // survives a reload, so the simulation does too.
  useRaf(() => world.tick());

  onMount(() => {
    const ctx = canvas?.getContext("2d") ?? null;
    if (!ctx) return; // no context (a test, SSR) — nothing to draw on
    let alive = true;
    const draw = () => {
      if (!alive || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "var(--aio-accent, #3b82f6)";
      for (const b of world.balls) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, 12, 0, Math.PI * 2);
        ctx.fill();
      }
      requestAnimationFrame(draw);
    };
    draw();
    onCleanup(() => {
      alive = false;
    });
  });

  return (
    <main>
      <h1>Canvas</h1>
      <div class="card stack">
        <canvas
          ref={(el) => {
            canvas = el as HTMLCanvasElement | null;
          }}
          width={world.width}
          height={world.height}
          style={{ width: "100%", background: "var(--aio-surface)" }}
        />
        <div class="row">
          <button type="button" t="toggle" onClick={() => world.toggle()}>
            {world.paused ? "Play" : "Pause"}
          </button>
          <span class="muted">{world.balls.length} bodies</span>
        </div>
      </div>
      <p class="muted">
        The decisions are in <code>src/cell.ts</code> and are pure, so
        <code>tests/cell.test.ts</code> covers them with no GPU. Only the four
        drawing calls above are untestable.
      </p>
    </main>
  );
}
`;

const CANVAS_TEST =
  `// Starter for THIS canvas cell only. Replace the cell → delete or rewrite
// this file in the same step (\`deno task check\` reads tests/, so a stale
// import fails there first). The half that CAN be tested — nearly all of it —
// is below: \`step()\` is pure, so bouncing is an ordinary assertion. See
// docs/testing/canvas-and-3d.md.
import { assertEquals } from "@std/assert";
import { testCell } from "aio/testing";
import { step, world } from "../src/cell.ts";

const w = (over: Partial<Parameters<typeof step>[0]> = {}) => ({
  width: 100,
  height: 100,
  paused: false,
  balls: [],
  ...over,
});

Deno.test("a ball moves by its velocity", () => {
  const out = step(w({ balls: [{ x: 10, y: 10, dx: 2, dy: 3 }] }));
  assertEquals(out[0], { x: 12, y: 13, dx: 2, dy: 3 });
});

Deno.test("a ball bounces off each wall, and keeps its speed", () => {
  const right = step(w({ balls: [{ x: 99, y: 10, dx: 5, dy: 0 }] }));
  assertEquals(right[0]!.dx, -5, "reversed, not zeroed");
  const top = step(w({ balls: [{ x: 10, y: 1, dx: 0, dy: -5 }] }));
  assertEquals(top[0]!.dy, 5);
});

testCell(world, "pausing stops the world", async (t) => {
  t.init();
  await t.send.toggle();
  const before = JSON.stringify(t.getState().balls);
  await t.send.tick();
  assertEquals(JSON.stringify(t.getState().balls), before);
});
`;

// ── `--template=assets` ─────────────────────────────────────────────────────
//
// An app that serves binary data needs TWO things that must agree: the mount
// (\`assets\` in deno.json) and the directory. Declaring the mount and forgetting
// the directory is a 404; creating the directory and forgetting the mount is a
// 404 that looks like a build problem. Scaffolding both together is the point.

const ASSETS_APP = `// Entry — with an \`assets\` mount.
//
// \`assets\` serves a directory in dev AND in production, with every guard
// \`baseDir\` has (traversal, symlink escape, dotfiles, *.server.ts) plus the
// MIME table, ETag revalidation, range requests and compression.
//
// It is declared TWICE on purpose, and they are two different questions:
//   • here, so the running server MOUNTS it — deno.json carries identity and
//     build facts only, and aio says so at boot if you put it there;
//   • in deno.json, so the BUILD knows to EMBED the directory in the binary,
//     instead of a \`compile.include\` entry you would have to keep in sync.
//
// docs/build/imports.md has the whole story.
import "./cell.ts";
import { aio } from "aio";

await aio.run({ assets: { "/media": "./media" }, ui: { theme: "auto" } });
`;

const ASSETS_UI = `// UI — reading from the \`assets\` mount.
//
// \`/media/…\` is served by the mount declared in deno.json. It works the same
// in \`deno task dev\`, under \`--prod\`, and from a compiled binary, which is
// the difference between \`assets\` and \`serveDirs\` (that one is dev-only, for
// a MODULE a prod bundle resolves for itself).
import type { JSX } from "aio";
import { counter } from "./cell.ts";

export default function App(): JSX.Element {
  return (
    <main>
      <h1>Assets</h1>
      <div class="card stack">
        <p>
          This text comes from <code>media/hello.txt</code>, served at
          <code>/media/hello.txt</code> by the <code>assets</code> mount in
          deno.json.
        </p>
        <pre class="card" id="asset-body">loading…</pre>
        <div class="row">
          <button
            type="button"
            t="load"
            onClick={async () => {
              const el = document.getElementById("asset-body");
              if (!el) return;
              const res = await fetch("/media/hello.txt");
              el.textContent = res.ok
                ? await res.text()
                : \`\${res.status} — is the media/ directory there?\`;
            }}
          >
            Load it
          </button>
          <span class="muted">count: {counter.count}</span>
        </div>
      </div>
    </main>
  );
}
`;

/** Per-template sources.
 *
 *  It was a chain of `template === "todo" ? A : B` ternaries, one per file,
 *  which held exactly two templates and could not hold a third without every
 *  line growing another branch — and the branches had already drifted apart
 *  (the UI's had a `css` case the entry's did not). One place to add a
 *  template, one place to read what a template IS.
 *
 *  A FUNCTION, not a const table: the sources below it are `const` string
 *  literals, so a table evaluated at module scope would read them before they
 *  are assigned. A function body runs when it is called.
 *
 *  `cli` is deliberately absent — it has no UI and no separate client, so it
 *  is a different file SET rather than different contents, and it keeps its
 *  own early return in `scaffold`. */
function templateSources(
  template: Template,
): { app: string; cell: string; ui: string; test: string } {
  switch (template) {
    case "todo":
      return { app: TODO_APP, cell: TODO_CELL, ui: TODO_UI, test: TODO_TEST };
    case "canvas":
      return {
        app: COUNTER_APP,
        cell: CANVAS_CELL,
        ui: CANVAS_UI,
        test: CANVAS_TEST,
      };
    case "assets":
      return {
        app: ASSETS_APP,
        cell: COUNTER_CELL,
        ui: ASSETS_UI,
        test: COUNTER_TEST,
      };
    default:
      return {
        app: COUNTER_APP,
        cell: COUNTER_CELL,
        ui: COUNTER_UI,
        test: COUNTER_TEST,
      };
  }
}

export function scaffold(
  name: string,
  template: Template,
  source: boolean,
  target: Target = DEFAULT_TARGET,
  css?: "tailwind",
): Record<string, string> {
  // `src/`-based layout: aio infers baseDir from the entry (so `dev` finds
  // src/App.tsx), and the compile pipeline (build.ts) expects src/App.tsx too —
  // one layout that satisfies both `deno task dev` and `deno task compile`.
  // The `cli` template is ONE binary with two roles (serve / command) and no
  // UI: no src/App.tsx, no separate src/client.ts — its app.ts IS the client.
  if (template === "cli") {
    return {
      "deno.json": denoJson(name, source, target, template),
      ".gitignore": GITIGNORE,
      "src/app.ts": CLI_APP,
      "src/cell.ts": CLI_CELL,
      "tests/cell.test.ts": CLI_TEST,
      "README.md": readme(name, template, target),
      "AGENTS.md": agentsMdScaffold(name),
      "CLAUDE.md": CLAUDE_MD_SCAFFOLD,
    };
  }
  const src = templateSources(template);
  const files: Record<string, string> = {
    "deno.json": denoJson(name, source, target, template, css),
    ".gitignore": css === "tailwind"
      // `src/style.css` is a BUILD PRODUCT here. Committing it means the next
      // person's first `git status` is a diff of generated CSS, and a stale one
      // in the tree looks exactly like a hand-written stylesheet.
      ? GITIGNORE +
        "\n# generated by build.css (see docs/ui/css-toolchain.md)\nsrc/style.css\n"
      : GITIGNORE,
    ...(css === "tailwind"
      ? {
        // The SOURCE sheet. `src/style.css` beside it is the tool's output and
        // is gitignored — editing the wrong one of the two is the mistake this
        // pair of files exists to make obvious.
        "src/app.css": TAILWIND_SOURCE,
      }
      : {}),
    "src/app.ts": src.app,
    "src/cell.ts": src.cell,
    // The UI has to match the STYLESHEET the project will have. See
    // `COUNTER_UI_TAILWIND`: with `--css=tailwind` the generated theme steps
    // aside, so the default markup's theme classes stop existing and the
    // scaffold's first `deno task dev` renders as unstyled HTML. Only the
    // counter has a Tailwind twin — the others do not lean on theme classes.
    "src/App.tsx": template === "counter" && css === "tailwind"
      ? COUNTER_UI_TAILWIND
      : src.ui,
    // Thin CLI client — `deno run -A src/client.ts` in dev; the `cli-client`
    // fleet target compiles it (build-cli.ts's conventional --cli --remote
    // entry is src/client.ts).
    ...(template === "assets"
      ? {
        // The other half of the `assets` key in deno.json. A mount pointing at
        // a directory that is not there is a 404 the author reads as a bug in
        // aio, so the template never ships one without the other.
        "media/hello.txt":
          "Served from the `assets` mount in deno.json — in dev, under --prod,\n" +
          "and from the compiled binary, which embeds this directory because\n" +
          "the mount is declared there.\n",
      }
      : {}),
    "src/client.ts": CLIENT_TS,
    // `tests/`, at the project root — ONE answer to "where do tests go".
    // Three were in circulation (this file scaffolded `src/cell.test.ts`,
    // project-structure.md said `src/test/`, and the quickstart's task ran
    // `deno test -A tests/`); a field report picked one and noted that having
    // three was the problem. `tests/` is what the framework itself does and
    // what the quickstart already ran.
    "tests/cell.test.ts": src.test,
    "README.md": readme(name, template, target),
    // The one file every coding agent loads without being asked. Its whole
    // job is to name `am agent` — a pointer cannot drift from the brief, and
    // a second copy of the brief would. Generated from the same leaf the
    // brief is, so `am create` and `am agent` cannot disagree about aio.
    "AGENTS.md": agentsMdScaffold(name),
    // Claude Code reads CLAUDE.md, not AGENTS.md — one line that imports it.
    "CLAUDE.md": CLAUDE_MD_SCAFFOLD,
  };
  return files;
}

/** One undo step. Best-effort by design: a path that cannot be put back
 *  must not keep the rest behind, and the caller rethrows the ORIGINAL
 *  failure — which is the one worth reading. But never SILENT: a step that
 *  fails lands `path` in `failed`, and the caller names every one ("undo
 *  incomplete") — a user's overwritten deno.json that could not be restored
 *  is the one thing they must hear about. `absentOk`: a remove of a path the
 *  failure never got as far as creating is not a failed undo. */
async function undoStep(
  failed: Set<string>,
  path: string,
  step: () => Promise<unknown>,
  absentOk = false,
): Promise<void> {
  try {
    await step();
  } catch (e) {
    // NotADirectory: a path under a FILE (`src/app.ts/boom`) never existed.
    const absent = e instanceof Deno.errors.NotFound ||
      e instanceof Deno.errors.NotADirectory;
    if (absentOk && absent) return;
    failed.add(path);
  }
}

/** What `am create` put on disk, recorded AS it is put there, so a failure
 *  half-way can take back exactly that — and nothing else.
 *
 *  A failed create used to exit 1 and leave the half-scaffold behind: a
 *  `deno.json` and a `.gitignore` in a directory the user then had to clean by
 *  hand (and `--force` into an existing directory left its files overwritten).
 *  Every path here is one this code wrote or created; nothing is found by
 *  listing or globbing a directory, so undo can never reach content it did
 *  not make. @internal */
export class ScaffoldLedger {
  /** Paths create brought into existence, in creation order. */
  readonly made: string[] = [];
  /** Files that existed and were about to change → their bytes before. */
  readonly saved = new Map<string, Uint8Array>();
  /** Symlinks that existed and were about to change → their target before. */
  readonly savedLinks = new Map<string, string>();
  /** EMPTY real directories create replaced (a `dep/aio` someone made by
   *  hand) — recreated, empty, on undo. */
  readonly emptyDirs: string[] = [];

  /** Record `path` BEFORE something changes or creates it. */
  async touch(path: string): Promise<void> {
    if (this.made.includes(path) || this.saved.has(path)) return;
    if (this.savedLinks.has(path)) return;
    const st = await Deno.lstat(path).catch(() => null);
    if (!st) this.made.push(path);
    else if (st.isSymlink) this.savedLinks.set(path, await Deno.readLink(path));
    else if (st.isFile) this.saved.set(path, await Deno.readFile(path));
    // An existing DIRECTORY is the user's: it is never removed, only its
    // tracked contents are.
  }

  /** Make `path` itself a REGULAR file before create writes it.
   *
   *  `--force` into a directory where `deno.json` was a symlink to a file
   *  outside it wrote THROUGH the link; the undo then restored the link and
   *  left the outside file corrupted. Now that link is recorded (undo puts it
   *  back) and replaced by a plain copy of what it pointed at. This guards the
   *  FINAL component only: a write under a symlinked parent directory, or into
   *  a hard-linked file, still reaches the shared file, exactly as `--force`
   *  always did. What protects those is `touch` — the bytes are saved by the
   *  path written and restored by the same path, so an undo puts back every
   *  file it overwrote, wherever the path led. A dangling link becomes an
   *  absent path. */
  async detach(path: string): Promise<void> {
    await this.touch(path);
    const st = await Deno.lstat(path).catch(() => null);
    if (!st?.isSymlink) return;
    const bytes = await Deno.readFile(path).catch(() => null);
    await Deno.remove(path);
    if (bytes) await Deno.writeFile(path, bytes);
  }

  /** `mkdir -p`, recording every level that did not exist. */
  async mkdirp(path: string): Promise<void> {
    const missing: string[] = [];
    for (let p = path;; p = resolve(p, "..")) {
      if (await Deno.lstat(p).then(() => true, () => false)) break;
      missing.unshift(p);
      if (resolve(p, "..") === p) break;
    }
    for (const p of missing) await this.touch(p);
    await Deno.mkdir(path, { recursive: true });
  }

  /** Put everything back: saved files and links restored, made paths
   *  removed newest-first. A made directory is removed only once empty —
   *  except the target itself when create made it, which holds nothing but
   *  what create wrote. Best-effort per path, so one stuck file cannot keep
   *  the rest behind; the caller still reports the ORIGINAL failure.
   *  Returns every path it could NOT put back (empty = a whole undo). */
  async undo(target: string): Promise<string[]> {
    const failed = new Set<string>();
    const step = (p: string, f: () => Promise<unknown>, absentOk = false) =>
      undoStep(failed, p, f, absentOk);
    for (const [p, bytes] of this.saved) {
      await step(p, () => Deno.writeFile(p, bytes));
    }
    for (const [p, to] of this.savedLinks) {
      await step(p, () => Deno.remove(p), true);
      await step(p, () => Deno.symlink(to, p));
    }
    for (const p of this.emptyDirs) {
      await step(p, () => Deno.remove(p), true);
      await step(p, () => Deno.mkdir(p));
    }
    if (this.made.includes(target)) {
      await step(target, () => Deno.remove(target, { recursive: true }), true);
      // Levels ABOVE the target it made (`am create a/b`): only if empty.
      for (const p of this.made.slice(0, this.made.indexOf(target)).reverse()) {
        await step(p, () => Deno.remove(p), true);
      }
      return [...failed];
    }
    for (const p of [...this.made].reverse()) {
      await step(p, () => Deno.remove(p), true);
    }
    return [...failed];
  }
}

/** Write the scaffold into `dir` — files, the `dep/aio` link, the pin — and on
 *  ANY failure undo exactly what was written, then rethrow (the caller's error
 *  and exit 1 are unchanged). @internal */
export async function writeScaffold(
  dir: string,
  files: Record<string, string>,
  opts: { aioPath?: string; pinnedVersion?: string } = {},
  ledger: ScaffoldLedger = new ScaffoldLedger(),
): Promise<void> {
  const { aioPath, pinnedVersion } = opts;
  try {
    await ledger.mkdirp(dir);
    for (const [rel, content] of Object.entries(files)) {
      const path = resolve(dir, rel);
      // Nested paths (src/app.ts) need their parent dir created first.
      await ledger.mkdirp(resolve(path, ".."));
      await ledger.detach(path);
      await Deno.writeTextFile(path, content);
    }

    // Source mode: link dep/aio → the aio checkout. The app's deno.json is
    // relative (./dep/aio/…), so only this symlink is machine-specific
    // (gitignored — re-created by `am link` or re-running create elsewhere).
    if (aioPath) {
      const link = resolve(dir, "dep/aio");
      await ledger.mkdirp(resolve(dir, "dep"));
      await ledger.touch(link);
      await Deno.symlink(aioPath, link).catch(async (e) => {
        if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
        // A LINK already there (a --force re-run) is replaced — recorded by
        // `touch` above, so undo restores it. An EMPTY real directory is
        // replaced too (it always was; it holds nothing) and recorded so undo
        // recreates it. Anything else at dep/aio — a vendored copy, a file —
        // is the user's: `am link` calls that state "blocked"; so does create.
        const st = await Deno.lstat(link);
        if (!st.isSymlink) {
          const empty = st.isDirectory &&
            (await Array.fromAsync(Deno.readDir(link))).length === 0;
          if (!empty) {
            throw new Error(
              `${link} exists and is not a symlink — it is not create's to ` +
                `replace. Move it aside (or drop --force) and re-run.`,
            );
          }
          ledger.emptyDirs.push(link);
        }
        await Deno.remove(link);
        await Deno.symlink(aioPath, link);
      });
    }

    // Record the pin IN the app, committed with the code — the whole point.
    if (pinnedVersion) {
      // Everything writePin / syncFrameworkDeps may create or change.
      await ledger.touch(resolve(dir, ".aio"));
      for (
        const f of [LOCAL_PIN_FILE, "deno.json", "deno.jsonc", ".gitignore"]
      ) {
        await ledger.detach(resolve(dir, f));
      }
      await writePin(dir, pinnedVersion);
      // …and pin the framework's OWN dependencies to what that version
      // declares. The scaffold writes ranges (`immer@^10`); the framework pins
      // exact (`immer@10.2.0`), and `dep/aio/**` resolves through THIS map —
      // so without this a brand-new app would be half-pinned from birth (see
      // syncFrameworkDeps in am-versions.ts).
      if (aioPath) await syncFrameworkDeps(dir, aioPath);
    }
  } catch (e) {
    const left = await ledger.undo(dir);
    if (left.length === 0) throw e;
    // The original failure stays the headline; what could not be put back
    // follows it — on stderr now, and in the error the caller reports (the
    // json `error` doc included).
    const incomplete = `undo incomplete — not put back: ${left.join(", ")}`;
    sayErr(`am create: ${incomplete}`);
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n  ${incomplete}`,
      { cause: e },
    );
  }
}

export async function cmdCreate(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  // `--force` is a GLOBAL flag: `parseGlobalFlags` consumes it into
  // `flags.force` and never re-emits it, so `parseCreateArgs(args)` — which
  // has its own `--force` and its own test — never saw the one the user
  // typed. `am create <existing-dir> --force` was therefore unbypassable, and
  // the refusal told them to pass the flag they had just passed. The test that
  // covered it called the parser directly, so it stayed green through all of
  // it. Both spellings are honoured here; the global one is the one that
  // reaches this function.
  const parsed = parseCreateArgs(args);
  const opts = { ...parsed, force: parsed.force || !!flags.force };

  if (!opts.name) {
    fail(
      "usage: am create <name> [--template=counter|todo|cli] [--target=browser|electron|android|cli|server]",
      mode,
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(opts.name)) {
    fail(
      `invalid project name '${opts.name}' — start with a letter/digit, then letters, digits, '-', '_', '.'`,
      mode,
    );
  }
  {
    const reserved = reservedAppNameError(opts.name, "am create");
    if (reserved) fail(reserved, mode);
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
  let notDir = false;
  try {
    occupied = [...Deno.readDirSync(dir)].length > 0 && !opts.force;
  } catch (e) {
    // ABSENT is the good case. A FILE there used to be read as absent too, so
    // create went on to provision a framework worktree (a shared side effect)
    // and only then died on its own mkdir. Refuse first, like `occupied`.
    if (e instanceof Deno.errors.PermissionDenied) {
      fail(
        `'${opts.name}' exists but cannot be read (permission denied) — ` +
          `create will not scaffold into a directory it cannot inspect`,
        mode,
      );
    }
    notDir = !(e instanceof Deno.errors.NotFound);
  }
  if (notDir) {
    fail(
      `'${opts.name}' already exists and is not a directory — pick another ` +
        `name, or move it out of the way`,
      mode,
    );
  }
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
      // `--mirror=<checkout>` is framework CO-DEVELOPMENT: the app follows a
      // live tree on this machine. That still needs a pin — and specifically
      // the `path:` one, or the app is born red.
      //
      // Without it, `doctor` FAILED ("no aioVersion — run `am pin latest`")
      // while `aiol` WARNED the moment a pin existed and dep/aio pointed at a
      // checkout rather than the version store. Two first-party tools with
      // opposite demands and no configuration satisfying both: one field
      // report documented the contradiction in their README "as intended
      // behaviour", which is what you do when a tool is wrong, and noted that
      // it teaches people to ignore both.
      //
      // `path:<abs>` is the form that was always the answer — `linkSatisfiesPin`
      // has understood it all along. Nothing told anyone it existed.
      pinnedVersion = `${PATH_PIN_PREFIX}${resolve(root)}`;
    }
  } else if (repoRoot() && !flags.json) {
    // --jsr from a source checkout: the pinned version must actually be on JSR.
    sayErr(
      `⚠ --jsr pins jsr:${PKG}@${VERSION} — make sure that version is published, ` +
        `or the app's deno task dev won't resolve.`,
    );
  }

  // opts.target was parsed, validated and echoed — but never passed, so every
  // app scaffolded as the DEFAULT target regardless of --target=X.
  const files = scaffold(
    opts.name,
    opts.template,
    source,
    opts.target,
    opts.css,
  );
  await writeScaffold(dir, files, { aioPath, pinnedVersion });

  // Format what was just written, BEFORE the first commit.
  //
  // The templates are TypeScript template literals inside this file, so
  // `deno fmt` on the framework never touches their contents — and a scaffolded
  // app therefore started life unformatted (`? true: view.filter === "done"`).
  // The very first thing a new project does is `deno task fmt` or a commit
  // hook, and it opened with a diff over code the user did not write. Running
  // the app's OWN `fmt` task here means the file on disk is the file the
  // toolchain agrees on. Best-effort: an app whose deno is missing is still a
  // valid scaffold, and a formatting failure must never lose the project.
  await new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--quiet"],
    cwd: dir,
    stdout: "null",
    stderr: "null",
  }).output().catch(() => {});

  // Make it a real project from second one — best-effort, never fatal.
  const git = await tryGitInit(dir);

  // Data an earlier app with this appId left behind — said, never silently
  // reused (report 9b §2). The scaffold declares its identity as `title` in
  // deno.json, which `resolveAppId` slugs exactly as the booted app will.
  const appId = resolveAppId(opts.name);
  const existingData = priorAppData(appId);

  // `mode`, NOT `flags.json`: stdout that is not a tty IS json mode (that is
  // what `detectMode` decides), so `am create x | tee`, every CI log and every
  // coding agent used to fall through to the HUMAN branch below and receive
  // `JSON.stringify(<pretty text>)` — one quoted line of escaped newlines.
  // The structured payload is the answer for both of the ways a machine asks.
  if (mode === "json") {
    out({
      created: opts.name,
      /** Absolute — the caller's cwd is not the reader's. */
      dir,
      template: opts.template,
      target: opts.target,
      aioVersion: pinnedVersion ?? null,
      /** Where `dep/aio` points (source mode), or null for JSR pins. */
      framework: aioPath ?? null,
      files: Object.keys(files),
      git,
      /** The home an earlier app with this appId left, or null. */
      existingData,
      /** What to run next, in order — the first run is the step an agent
       *  most often postpones (a field report: 13.7 min to the first start). */
      next: nextSteps(opts.name, "src/App.tsx" in files),
    }, mode);
    return;
  }

  // `styleWith` bound to the SAME decision this branch already made — four
  // hand-written `\x1b[…m` wrappers were a fifth private palette, identical to
  // the house one except that nothing kept them identical.
  const st = styleWith(mode === "pretty" && colorEnabled);
  const b = st.bold, dim = st.dim, cyan = st.cyan, grn = st.green;
  // Show the chosen target's dev command + a hint about other targets.
  const devHint = opts.target === "browser"
    ? `→ ${opts.target} (others: --client=electron|cli|server-only)`
    : `→ ${opts.target}`;
  out(
    [
      "",
      `  ${grn("✓")} ${b(opts.name)} ${
        dim(`— aio ${opts.template} app · target=${opts.target}`)
      }`,
      `    ${dim(dir)}`,
      `    ${dim(gitSentence(git))}`,
      `    ${dim(frameworkSentence(pinnedVersion, aioPath, !!opts.mirror))}`,
      ...(existingData
        ? [`  ${st.yellow("⚠")} ${priorAppDataLine(appId, existingData)}`]
        : []),
      "",
      `  ${dim("run it")}`,
      `    cd ${opts.name}`,
      `    ${cyan("deno task dev")}            ${dim(devHint)}`,
      `    ${
        cyan(nextSteps(opts.name, "src/App.tsx" in files).slice(1).join(" && "))
      }  ${dim("→ in the background, then see it")}`,
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

/** The commands that take a fresh app to "running, and seen": start it in
 *  the background (it waits until the app answers), then look at it — the UI
 *  surface when there is a UI, the state when there is not. Pure. */
export function nextSteps(name: string, hasUI: boolean): string[] {
  return [
    `cd ${name}`,
    "deno task am start",
    hasUI ? "deno task am surface" : "deno task am state",
  ];
}

/** What an EARLIER app with the same appId left in its home. */
export type PriorAppData = {
  /** `appHome(appId)` — `$AIO_APPS_DIR/<appId>`, else `~/.<appId>`. */
  home: string;
  /** From `data/meta.json`; null when it is missing or unreadable. */
  aio: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/** The data a new app with this appId would boot on, or null when its home
 *  does not exist.
 *
 *  report 9b §2: `am create x` succeeded silently over `~/.x/data/state.db`
 *  from an alpha68 app with the same id, and the first `deno task dev` booted
 *  on that state — then refused on shape drift, naming no directory. The
 *  resolver is the SERVER's (`appHome`), so this cannot disagree with where
 *  the app will actually look. Missing meta fields stay null rather than
 *  guessed: a home with no meta.json is still somebody's data. */
export function priorAppData(appId: string): PriorAppData | null {
  const home = appHome(appId);
  try {
    if (!Deno.statSync(home).isDirectory) return null;
  } catch {
    return null; // aio-ok: no home — nothing to warn about
  }
  let meta: Partial<AppMeta> = {};
  try {
    meta = JSON.parse(
      Deno.readTextFileSync(`${home}/data/meta.json`),
    ) as Partial<AppMeta>;
  } catch {
    /* aio-ok: no/unreadable meta.json — the home itself is reported */
  }
  const str = (v: unknown) => typeof v === "string" && v !== "" ? v : null;
  return {
    home,
    aio: str(meta.aio),
    createdAt: str(meta.createdAt),
    updatedAt: str(meta.updatedAt),
  };
}

/** The human line for {@linkcode priorAppData}. Pure. */
export function priorAppDataLine(appId: string, prior: PriorAppData): string {
  const facts = [
    prior.aio && `aio ${prior.aio}`,
    prior.createdAt && `since ${prior.createdAt.slice(0, 10)}`,
  ].filter(Boolean).join(", ");
  return `appId "${appId}" already has data at ${prior.home}` +
    (facts ? ` (${facts})` : "") +
    ` — the first run boots on it. See it with \`am data\` (from the app ` +
    `directory); start fresh with \`am backup\`, then remove that directory.`;
}

/** What `am create` did about git — never a bare `false` with no reason. */
export type GitInit =
  | "initialized"
  | `skipped: inside ${string}`
  | "skipped: git not found"
  | "skipped: git init failed";

/** The sentence the human report prints for each {@linkcode GitInit}. */
export function gitSentence(git: GitInit): string {
  if (git === "initialized") return "git initialized (first commit made)";
  if (git.startsWith("skipped: inside ")) {
    return `no git init — already inside ${
      git.slice("skipped: inside ".length)
    }`;
  }
  if (git === "skipped: git not found") {
    return "no git init — git is not installed";
  }
  return "no git init — git init failed";
}

/** `git init` + first commit so the new project has history from minute one.
 *  Best-effort: no git, or an existing repo, is fine — never fails the create,
 *  but the REASON is always reported (a `"git": false` said nothing). */
async function tryGitInit(dir: string): Promise<GitInit> {
  try {
    // Already inside a repo? Don't nest one — and name it.
    const inside = await new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel"],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
      stdin: "null",
      env: GIT_NO_PROMPT_ENV,
    }).output();
    if (inside.success) {
      const top = new TextDecoder().decode(inside.stdout).trim();
      return `skipped: inside ${top}`;
    }
    const run = (args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd: dir,
        stdout: "null",
        stderr: "null",
        stdin: "null",
        env: GIT_NO_PROMPT_ENV,
      })
        .output();
    if (!(await run(["init"])).success) return "skipped: git init failed";
    await run(["add", "-A"]);
    // An identity of its own: a machine with no git user (a container, CI, a
    // fresh laptop) used to fail this commit silently, leaving every file
    // untracked — and every build of the scaffold "-dirty". The app's first
    // commit is aio's; the developer's own identity takes over from there.
    await run([
      "-c",
      "user.name=aio",
      "-c",
      "user.email=aio@localhost",
      "commit",
      "-m",
      "initial commit — scaffolded with am",
    ]);
    return "initialized";
  } catch {
    return "skipped: git not found";
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
deno task dev              # ${
    template === "cli"
      ? `run the server (\`${name} serve\`) — commands find it by themselves`
      : `run — ${target} (flags pass through, see below)`
  }
deno task test             # run the starter test
deno task compile          # build the default target (${target})
deno task build            # build every target in deno.json build.targets → dist/
deno task check            # type-check src/ + tests/, then am check
\`\`\`

\`deno task dev\` runs in the FOREGROUND and dies with the terminal that started
it. That is right for a person and wrong for an agent, whose every command is a
fresh short-lived shell — one report lost its app about eight times in a session
before finding the answer. \`deno task am start\` is the supervised background
form: it takes a lock, waits for health, and \`am stop\` / \`am status\` /
\`am logs\` address it afterwards.

The app's version is \`major.minor\` in deno.json (\`"version": "0.1"\`) — the
build number is derived from the commit count, so every artifact is named
\`${name}-0.1.<build>…\` and reports that version (\`-dirty.<hash>\` when
built from uncommitted changes).

${
    template === "cli"
      ? `**One binary, two roles.** \`deno task dev\` is the server; every other
command connects to it and prints. Commands find the running server through its
lock file — the same thing \`am\` reads — so a free port needs no configuration:

\`\`\`sh
deno task dev                       # the server (a free port; --port=N to name one)
deno run -A src/app.ts list         # a command, against the running server
deno run -A src/app.ts list --watch # a live view
deno run -A src/app.ts list --json  # for a script
deno task dev --expose              # reachable on the LAN (prints pair PIN)
\`\`\`
`
      : `**\`dev\` flags pass through** — one task, any shell:

\`\`\`sh
deno task dev --client=electron     # desktop window (auto-installs Electron)
deno task dev --client=cli          # terminal client
deno task dev --client=server-only  # headless server
deno task dev --expose              # reachable on the LAN (prints pair PIN)
\`\`\`
`
  }
**Ship more targets** by listing them in deno.json —
\`"build": { "targets": ["${target}", "electron", "android"] }\` — then
\`deno task build\` (or one-off: \`deno task build --targets=electron\`).
Run \`deno task build --list\` for every target name.

${
    template === "cli"
      ? "State lives in `src/cell.ts`; `src/app.ts` is both the server (`serve`) and every command."
      : "State lives in `src/cell.ts`, UI in `src/App.tsx`, entry in `src/app.ts`."
  }
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
  `// Entry — near-zero-config: cells self-register on import; appId/version/
// baseDir are inferred from deno.json + this file's location.
//
// \`theme: "auto"\` is the one opt-in: aio's default look (typography, colour
// in light AND dark, controls, cards — accented from this app's own name)
// until you write \`src/style.css\`, at which point it steps aside and leaves
// only the \`--aio-*\` variables. Delete the line and the app renders with the
// browser's own defaults; \`"full"\` keeps the look alongside your own CSS.
import "./cell.ts";
import { aio } from "aio";

await aio.run({ ui: { theme: "auto" } });
`;

const CLIENT_TS =
  `// Thin CLI client — live view of a running server's state over WebSocket.
// Run it against a dev server (\`deno run -A src/client.ts\`); the
// \`cli-client\` build target compiles it into a standalone client binary
// (add "cli-client" to build.targets, then \`deno task build\`). No local server.
import { connectCli } from "aio/server";

// No default URL: dev picks a FREE port, so a hard-coded one connects to
// nothing — or to a different app. The port is on the dev boot line
// (\`open http://localhost:<port>\`) and in \`am instances\`.
const url = Deno.args[0];
if (!url) {
  console.error(
    "usage: client <ws://host:port/ws>\\n" +
      "  the port is on the dev server's boot line, or: deno task am instances",
  );
  Deno.exit(2);
}
console.log(\`connecting to \${url} ...\`);
// Bounded: a dead URL fails with a message instead of hanging forever.
const app = connectCli(url, { readyTimeoutMs: 10_000 });
await app.ready;
console.log("state:", JSON.stringify(app.state, null, 2));
app.subscribe(() => console.log("state:", JSON.stringify(app.state)));
`;

/** The `--css=tailwind` counter UI.
 *
 *  A SEPARATE component, and this is why. aio's generated theme steps fully
 *  aside the moment `src/style.css` exists — that contract is exactly what
 *  lets Tailwind need no adapter — and `--css=tailwind` WRITES that file. So
 *  the default markup's `card` / `stack` / `row` / `primary` / `muted` classes
 *  stop existing, Tailwind's preflight resets the semantic HTML underneath
 *  them, and the very first `deno task dev` after `am create --css=tailwind`
 *  renders an unstyled page. Scaffolding a Tailwind project whose example is
 *  written against a stylesheet it just replaced is the kind of "works, looks
 *  broken" first impression this whole command exists to avoid.
 *
 *  It also earns its keep as documentation: an author who asked for Tailwind
 *  gets a component written in Tailwind, with dark mode and focus rings
 *  already handled the Tailwind way. */
const COUNTER_UI_TAILWIND = `// UI — export default; the framework mounts it.
//
// Styled with Tailwind. \`src/app.css\` is the SOURCE (\`@import "tailwindcss"\`)
// and \`build.css\` compiles it to \`src/style.css\` before every dev reload and
// every build — so edit app.css, never style.css.
//
// Because src/style.css exists, aio's generated theme steps aside entirely and
// this file owns every pixel. See docs/ui/css-toolchain.md.
//
// \`JSX.Element\` needs the type import below; \`aio\` re-exports it so this is
// the only line to remember.
import type { JSX } from "aio";
import { counter } from "./cell.ts";

const BTN =
  "rounded-lg px-4 py-2 text-sm font-medium transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-sky-500";

export default function App(): JSX.Element {
  return (
    <main class="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div class="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
        <h1 class="text-2xl font-semibold tracking-tight">AIO Counter</h1>

        <div class="flex flex-col items-center gap-6 rounded-xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div class="text-6xl font-bold tabular-nums">{counter.count}</div>

          <div class="flex gap-2">
            <button
              type="button"
              t="minus"
              class={BTN + " bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700"}
              onClick={() => counter.decrement()}
            >
              −
            </button>
            <button
              type="button"
              class={BTN + " text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800"}
              onClick={() => counter.reset()}
            >
              Reset
            </button>
            <button
              type="button"
              t="plus"
              class={BTN + " bg-sky-600 text-white hover:bg-sky-500"}
              onClick={() => counter.increment()}
            >
              +
            </button>
          </div>
        </div>

        <p class="text-sm text-slate-500 dark:text-slate-400">
          State lives in <code class="rounded bg-slate-200 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">src/cell.ts</code>.
          Change it and this updates.
        </p>
      </div>
    </main>
  );
}
`;

const COUNTER_UI = `// UI — export default; the framework mounts it.
//
// No stylesheet: app.ts opted into aio's default theme (\`ui.theme: "auto"\`),
// which styles semantic HTML and a handful of classes, keyed to this app's
// name. Write \`src/style.css\` and it steps aside entirely. See
// docs/ui/theme.md.
//
// \`JSX.Element\` needs the type import below; \`aio\` re-exports it so this is
// the only line to remember.
import type { JSX } from "aio";
import { counter } from "./cell.ts";

export default function App(): JSX.Element {
  return (
    <main>
      <h1>AIO Counter</h1>
      <div class="card stack" style={{ alignItems: "center" }}>
        <div style={{ fontSize: "3.5rem", fontWeight: 700 }}>{counter.count}</div>
        <div class="row">
          <button type="button" t="minus" onClick={() => counter.decrement()}>−</button>
          <button type="button" class="ghost" onClick={() => counter.reset()}>Reset</button>
          <button type="button" t="plus" class="primary" onClick={() => counter.increment()}>+</button>
        </div>
      </div>
      <p class="muted">
        State lives in <code>src/cell.ts</code>. Change it and this updates.
      </p>
    </main>
  );
}
`;

const COUNTER_TEST =
  `// Starter for THIS counter cell only. Replace the cell → delete or rewrite
// this file in the same step (\`deno task check\` reads tests/, so a stale
// import fails there first). Order that works: check → run the app → then
// write tests for YOUR methods. Do not invent a test API before the app runs.
import { testCell } from "aio/testing";
import { counter } from "../src/cell.ts";

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
  `// Starter for THIS todo cell only. Replace the cell → delete or rewrite
// this file in the same step (\`deno task check\` reads tests/, so a stale
// import fails there first). Order that works: check → run the app → then
// write tests for YOUR methods. Do not invent a test API before the app runs.
import { testCell } from "aio/testing";
import { todo, view } from "../src/cell.ts";

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

// ── cli template — examples/cli-tool, with the cell beside the entry ─────
// Kept byte-for-byte with the example (tests/am-create-journey.test.ts pins
// it), so the scaffold and the documented example never drift apart.
const CLI_CELL =
  `// The list — one cell, shared by the server that owns it and the commands
// that talk to it. Persists by default (restart the server, the list is back).
import { cell } from "aio";

/** One todo. */
export type Todo = { id: number; text: string; done: boolean };

export const todos = cell("todos", {
  state: { items: [] as Todo[], next: 1 },
  methods: {
    add(s, text: string) {
      const t = text.trim();
      if (!t) throw new Error("a todo needs some text");
      s.items.push({ id: s.next++, text: t, done: false });
    },
    done(s, id: number) {
      const t = s.items.find((x) => x.id === id);
      if (!t) throw new Error(\`no todo #\${id}\`);
      t.done = true;
    },
    clear(s) {
      s.items = s.items.filter((x) => !x.done);
    },
  },
});
`;

const CLI_APP =
  `// todo — one binary, two roles. \`todo serve\` runs the aio server that OWNS the
// list (persisted, no UI: client "server-only"). Every other command connects
// to it over WS, dispatches a cell method, and prints — with \`aio/cli\` doing
// the flags, the table, the live view, and the exit codes.
//
//   todo serve [--port=N]            # the server (a free port unless named)
//   todo add buy milk                # a command
//   todo list --watch                # a live view: redraws on every change
//   todo list --json | jq            # a script
//
// Commands find the server through its LOCK FILE — the same thing \`am\` reads
// — so \`todo serve\` on a free port just works. \`--url\` overrides (a remote
// server, or one behind a tunnel).
//
// Dev: deno task dev (= serve)   Build: deno task compile (a \`cli\` binary)
import { aio } from "aio";
import { connectCli } from "aio/server";
import { instances, resolveAppId } from "aio/extras";
import { args, EXIT, fail, style, table, watch } from "aio/cli";
import { todos } from "./cell.ts";
import config from "../deno.json" with { type: "json" };

// WHO this tool is — from ITS OWN deno.json, imported (so a compiled binary
// carries it too), never inferred. Both roles find each other by this id, and
// inference reads the deno.json of whatever directory you run the command
// from: \`todo list\` from ~ looked for a different app than \`deno task dev\`
// had started, and either role run inside another project became that project
// — its lock, its data.
const APP_ID = resolveAppId(config.title);

if (Deno.args[0] === "serve") {
  // aio parses its own flags (--port, --expose, …) from Deno.args; the bare
  // \`serve\` word is not a flag, so it passes through.
  await aio.run({ appId: APP_ID, client: "server-only" });
} else {
  const a = args({
    name: "todo",
    help: "A todo list you can script: a server owns it, commands talk to it.",
    version: "0.1.0",
    commands: {
      serve: "run the server (takes aio's flags: --port, --expose, …)",
      list: "show the list",
      add: "add a todo: todo add <text...>",
      done: "mark one done: todo done <id>",
      clear: "drop every done todo",
    },
    rest: "arg",
    flags: {
      url: {
        type: "string",
        help: "the server to talk to (default: the running \`todo serve\`)",
      },
      watch: { type: "boolean", short: "w", help: "list: redraw on change" },
      json: { type: "boolean", help: "machine-readable output" },
    },
  });

  // WHERE the server is. \`serve\` binds a FREE port unless one is named, so a
  // hard-coded ws://localhost:8000 was wrong on nearly every run: \`todo list\`
  // said "no server" against a server that was running. The lock the app
  // writes is the one place that knows, and it is what \`am\` reads too.
  const live = instances(APP_ID).find((i) => i.alive && i.port > 0);
  const url = a.flags.url ??
    (live ? \`ws://localhost:\${live.port}/ws\` : undefined);
  if (!url) {
    fail("no todo server running — start one: todo serve", { json: a.json });
  }

  const app = connectCli(url!, { readyTimeoutMs: 3000 });
  app.bind(todos);
  await app.ready.catch(() =>
    fail(\`no server at \${url} — start one: todo serve\`, {
      json: a.json,
    })
  );

  const render = () =>
    a.json
      ? JSON.stringify(todos.items)
      : todos.items.length === 0
      ? style.dim("(nothing to do)")
      : table(
        todos.items.map((t) => ({
          id: t.id,
          done: t.done ? style.green("x") : " ",
          text: t.done ? style.dim(t.text) : t.text,
        })),
        { columns: [{ key: "id", align: "right" }, "done", "text"] },
      );

  try {
    switch (a.command) {
      case "add":
        if (!a.rest.length) fail("todo add <text...>", { code: EXIT.usage });
        await todos.add(a.rest.join(" "));
        break;
      case "done": {
        const id = Number(a.rest[0]);
        if (!Number.isInteger(id)) fail("todo done <id>", { code: EXIT.usage });
        await todos.done(id);
        break;
      }
      case "clear":
        await todos.clear();
        break;
      case "list":
        if (a.flags.watch) {
          const w = watch(app, render);
          Deno.addSignalListener("SIGINT", () => {
            w.stop();
            app.close();
            Deno.exit(EXIT.ok);
          });
          await new Promise(() => {}); // until ^C
        }
        break;
    }
    console.log(render());
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), { json: a.json });
  }
  app.close();
}
`;

const CLI_TEST =
  `// Starter for THIS scaffold cell only. Replace the cell → delete or rewrite
// this file in the same step (\`deno task check\` reads tests/, so a stale
// import fails there first). Order that works: check → run → then test.
import { testCell } from "aio/testing";
import { todos } from "../src/cell.ts";

testCell(todos, "adds, marks done, and clears", (t) => {
  t.send.add("ship it");
  t.expect.state((s) => s.items.length === 1);
  t.send.done(1);
  t.expect.state((s) => s.items[0].done === true);
  t.send.clear();
  t.expect.state((s) => s.items.length === 0);
});
`;

const TODO_APP = `// Entry — cells self-register on import.
//
// \`theme: "auto"\` opts into aio's default look (it styles the semantic HTML
// and the card / row / stack / badge classes the UI uses) until you write
// \`src/style.css\`, at which point every visual default steps aside.
import "./cell.ts";
import { aio } from "aio";

export type { Filter, Todo } from "./cell.ts";

await aio.run({ ui: { theme: "auto" } });
`;

const TODO_UI = `// UI — a filterable todo list.
//
// No stylesheet: app.ts opted into aio's default theme (\`ui.theme: "auto"\`),
// which styles semantic HTML and the classes used here (card / row / stack /
// badge / muted). Add src/style.css and it steps aside. See docs/ui/theme.md.
import type { JSX } from "aio";
import { useLocal } from "aio/air";
import { type Filter, type Todo, todo, view } from "./cell.ts";

const FILTERS: Filter[] = ["all", "active", "done"];

export default function App(): JSX.Element {
  const { local: input, set: setInput } = useLocal("");

  const filtered: Todo[] = todo.items.filter((t: Todo) =>
    view.filter === "all" ? true: view.filter === "done" ? t.done: !t.done
  );
  const remaining = todo.items.filter((t: Todo) => !t.done).length;

  return (
    <main style={{ maxWidth: "36rem" }}>
      <h1>todos</h1>

      <form
        class="row"
        onSubmit={() => {
          if (input.trim()) {
            todo.add(input.trim());
            setInput("");
          }
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          placeholder="What needs to be done?"
          aria-label="What needs to be done?"
          style={{ flex: 1 }}
        />
        <button type="submit">Add</button>
      </form>

      <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
        {filtered.map((t) => (
          <li key={t.id} class="row" style={{ padding: "0.4rem 0" }}>
            <input
              type="checkbox"
              checked={t.done}
              onChange={() => todo.toggle(t.id)}
              aria-label={"Toggle " + t.text}
            />
            <span
              style={{ flex: 1, textDecoration: t.done ? "line-through": "none" }}
              class={t.done ? "muted": ""}
            >
              {t.text}
            </span>
            <button type="button" class="ghost" onClick={() => todo.remove(t.id)}>×</button>
          </li>
        ))}
      </ul>

      {todo.items.length > 0 && (
        <div class="row" style={{ justifyContent: "space-between" }}>
          <span class="muted">{remaining} item{remaining !== 1 ? "s": ""} left</span>
          <div class="row">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                class={view.filter === f ? "primary": "ghost"}
                onClick={() => view.setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <button type="button" class="ghost" onClick={() => todo.clearDone()}>
            Clear done
          </button>
        </div>
      )}
    </main>
  );
}
`;

/** Which framework the new app runs — said, not left to be discovered. The
 *  F3 benchmark's agent found `dep/aio` pointing at the installed release,
 *  not the checkout it expected, and "nothing said this would happen". */
export function frameworkSentence(
  pinned: string | undefined,
  aioPath: string | undefined,
  mirror: boolean,
): string {
  if (!aioPath) return `framework aio ${pinned ?? VERSION} from JSR (--jsr)`;
  return mirror
    ? `framework: your checkout, live · dep/aio → ${aioPath}`
    : `framework aio ${pinned ?? "?"} (release pin) · dep/aio → ${aioPath} · ` +
      `--mirror=<checkout> to build against a local tree`;
}
