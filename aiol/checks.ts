// aiol — all lint checks organized by area

import type { CellInfo, Checker } from "./types.ts";
import { join, resolve } from "@std/path";
import * as fix from "./fixes.ts";
import {
  declaredEntryPaths,
  declaredTargetKinds,
  isTestPath,
  isToolingPath,
  SCANNED_ROOTS,
} from "./context.ts";
import { RESERVED_KEYS } from "../src/state/cell-types.ts";
import {
  AIO_LIBRARY_ENTRIES,
  isServerOnlyFile,
  SERVER_ONLY_AIO_SYMBOLS,
} from "../src/entries.ts";
import { removalMessage, removalOf } from "../src/state/removals.ts";
import {
  linkSatisfiesPin,
  pinDisagreementHint,
} from "../src/server/framework-pin.ts";
import { readFrameworkPinSync } from "../src/server/deno-json.ts";
import { codeMatches, codeText } from "./scan.ts";
import {
  unknownBuildKeys,
  VALID_BUILD_KEYS,
  VALID_BUILD_TARGET_KEYS,
} from "../src/server/config.ts";

// ══════════════════════════════════════════════════════════════════════
// 1. PROJECT CONFIG (deno.json)
// ══════════════════════════════════════════════════════════════════════

/** Registry rows that `checkAlpha52` reports at their exact site with a
 *  `--safe-fix`; the per-cell removed-key loop in `checkCells` leaves these to
 *  it so one fact is one line. */
const SITE_RULED_REMOVALS: ReadonlySet<string> = new Set([
  "listensTo: [...]",
  "schedule.poll({ backoff })",
  "schedule.backoff/poll(id, attempt, opts, action)",
  "cell({ ui })",
  "cellDefaults.ui",
]);

/** Is this finding suppressed?
 *
 *  `// aiol-ok` counts on the flagged line OR on the comment line immediately
 *  above it — which is where a justification naturally goes, where every other
 *  linter accepts it, and (decisively) where `deno fmt` cannot move it. A marker
 *  parked at the end of a long line gets reflowed onto a continuation, and the
 *  hint reappeared somewhere else: one field report spent four passes clearing
 *  eight hints for exactly this reason.
 *
 *  A blank line between the comment and the code breaks the association, so an
 *  unrelated `aiol-ok` further up can't silently cover code below it. */
export function isSuppressed(lines: string[], idx: number): boolean {
  if (lines[idx]?.includes("aiol-ok")) return true;
  const prev = lines[idx - 1]?.trim() ?? "";
  return prev.startsWith("//") && prev.includes("aiol-ok");
}

export const checkConfig: Checker = (ctx) => {
  const { denoJson: dj, report, pass } = ctx;
  if (!dj) {
    report(
      "error",
      "config",
      "deno.json not found — create one with imports and tasks",
      { fix: "See quickstart.md" },
    );
    return;
  }

  // appId — must reach aio.run(), because a compiled build can't read deno.json.
  //
  // Only warn when the MOVE HAS NOT HAPPENED. Warning "move to aio.run({ appId })"
  // at an app that already passes it there describes a move already made, and a
  // linter that reports work you've done is a linter people stop reading
  //. A deno.json `appId` alongside an explicit one is
  // redundant, not broken — `am` reads it to find the app — so that case is a
  // hint about the duplication, not a warning about a missing move.
  // …and only for an APP. `appId: "aio"` in the framework's own deno.json is
  // the framework's package identity; "move it into aio.run()" names a call
  // that does not exist in this repo.
  if (dj.appId && ctx.isApp) {
    // Read on CODE offsets: the scaffold's own entry opens with a comment that
    // names `appId`, and a raw `.test()` calls that "already moved".
    const entry = ctx.appEntry;
    const passesAppId = entry
      ? codeMatches(entry.content, /\bappId\s*:/g).length > 0
      : false;
    // Where the value would GO. Without a real `aio.run(` in code there is no
    // second half of the migration, and the fix must not perform the first —
    // deleting `appId` alone renames the app's lock file, SQLite path and UDS
    // socket, orphaning its data on the next boot.
    const runSite = entry
      ? codeMatches(entry.content, /\baio\.run\s*\(\s*(\{|\))/g).length > 0
      : false;
    report(
      passesAppId ? "hint" : "warn",
      "config",
      passesAppId
        ? `appId "${dj.appId}" is in deno.json AND aio.run() — the aio.run() one wins; the deno.json key only helps \`am\` find the app`
        : `appId "${dj.appId}" in deno.json — move to aio.run({ appId: "${dj.appId}" }) (compiled builds can't read deno.json)`,
      {
        ...(entry ? { file: entry.relative } : {}),
        fix: passesAppId
          ? 'Optional: remove "appId" from deno.json (aio.run() already sets it)'
          : `Add appId: "${dj.appId}" to aio.run() FIRST, then remove the key ` +
            `from deno.json — --safe-fix does both, in that order`,
        // Only offer the codemod when the value isn't already in the entry —
        // otherwise --safe-fix would "fix" a correct app.
        ...(passesAppId
          ? {}
          : runSite
          ? { safeFix: fix.fixMoveAppIdToRun(entry!.path) }
          : {
            manual: entry
              ? `the safe fix declines: no \`aio.run(\` call in ${entry.relative} ` +
                `to put appId into, and deleting the key alone would rename the app`
              : `the safe fix declines: no entry module found, and deleting the ` +
                `key alone would rename the app (appId names its lock file, ` +
                `SQLite path and UDS socket)`,
          }),
      },
    );
  }

  // deno.json `target` → `client` (alpha52 one-vocabulary rename). The old
  // key still works — the runtime reads it with a one-time boot hint — but the
  // linter names the new spelling and offers the mechanical rename.
  if (typeof dj.target === "string") {
    report(
      "warn",
      "config",
      `deno.json "target": "${dj.target}" is now spelled "client" ` +
        "(it names the default client shell; build.targets is the build axis)",
      {
        fix: 'Rename the "target" key to "client" (same value) — ' +
          "--safe-fix or `am fix` does it",
        safeFix: fix.fixRenameTargetToClient,
      },
    );
  }

  // unstable: ["kv"] — obsolete since the alpha28 restructure (persistence
  // is SQLite-only; legacy Deno.Kv data migrates automatically on boot).
  if (dj.unstable?.includes("kv")) {
    report(
      "hint",
      "config",
      '"unstable": ["kv"] is no longer needed — persistence is SQLite-only since alpha28 (legacy KV data auto-migrates)',
      { fix: 'Remove "kv" from "unstable" in deno.json' },
    );
  }

  // imports
  const imports = dj.imports ?? {};
  if (!imports["aio"] && !imports["@riagentic/aio"]) {
    report(
      "error",
      "config",
      'missing "aio" import mapping — add "aio": "jsr:@riagentic/aio@..."',
    );
  }
  // The React block below only applies to an app that actually maps React —
  // an aio app renders JSX through AIR (`jsxImportSource: "aio"`), so for
  // every scaffolded app this is simply "no React dependency". Saying
  // "server-only / CLI" here labelled a browser app with an App.tsx as
  // headless: a PASS line that states something untrue is still a wrong report.
  if (!imports["react"] && !imports["react-dom"]) {
    pass("no React dependency (aio renders JSX through AIR)");
  } else {
    if (!imports["react"]) report("warn", "config", 'missing "react" import');
    if (!imports["@types/react"]) {
      report(
        "hint",
        "config",
        'missing "@types/react" — add for JSX type checking',
        { safeFix: fix.fixAddTypesReact },
      );
    }
    if (!imports["esbuild"]) {
      report(
        "warn",
        "config",
        'missing "esbuild" import — required for dev mode TSX transpilation',
        { safeFix: fix.fixAddEsbuild },
      );
    }
  }

  // compilerOptions for JSX
  const co = dj.compilerOptions ?? {};
  if (imports["react"] && co["jsx"] !== "react-jsx") {
    report(
      "hint",
      "config",
      'compilerOptions.jsx should be "react-jsx" for automatic JSX transform',
      { safeFix: fix.fixAddJsxConfig },
    );
  }

  // nodeModulesDir
  if (!dj.nodeModulesDir) {
    report(
      "hint",
      "config",
      'missing "nodeModulesDir": "auto" — recommended for npm package resolution',
      { safeFix: fix.fixAddNodeModulesDir },
    );
  }

  // tasks
  const tasks = dj.tasks ?? {};
  if (!tasks["dev"]) {
    report(
      "hint",
      "config",
      'no "dev" task — add "dev": "deno run -A src/app.ts"',
      { safeFix: fix.fixAddDevTask },
    );
  }
  if (!tasks["test"]) {
    report(
      "hint",
      "config",
      'no "test" task — add "test": "deno test -A tests/"',
      { safeFix: fix.fixAddTestTask },
    );
  }
  // One vocabulary (alpha52): `build` (the fleet) / `compile` (the default
  // target) are the build tasks; the old per-target compile:* matrix still
  // counts so a not-yet-migrated app isn't told it can't build.
  const buildTasks = Object.keys(tasks).filter((k) =>
    k === "build" || k === "compile" || k.startsWith("compile:")
  );
  if (buildTasks.length) {
    pass(`build tasks: ${buildTasks.join(", ")}`);
  } else {report(
      "hint",
      "config",
      'no build task defined — add "build" (aio\'s build-all reading ' +
        "build.targets) for production builds; `am fix` adds it",
    );}

  // Framework pin vs dep/aio — the promise `am pin` seals. `doctor` checked
  // it, but doctor is the diagnostic nobody runs on a green build: lint, test
  // and dev all stayed green while dep/aio sat one version past the pin (a
  // field report). aiol walks deno.json for every other fact it reports; the
  // pin is one more. `linkSatisfiesPin` is THE decider (shared with doctor,
  // `am pin`, `am fix`), so the verdicts cannot contradict each other.
  // `readFrameworkPinSync` is THE reader: the per-machine `.aio/pin.local`
  // override first, then `aioVersion` — so a local path pin is judged
  // against the link it actually names, not the release it overrides.
  let pin: string | null = null;
  try {
    pin = readFrameworkPinSync(ctx.projectDir).pin;
  } catch { /* a dangling override — reported by am/doctor, not a lint */ }
  if (pin) {
    let linked: string | null = null;
    try {
      // A relative link target is relative to the link's own directory.
      linked = resolve(
        join(ctx.projectDir, "dep"),
        Deno.readLinkSync(join(ctx.projectDir, "dep", "aio")),
      );
    } catch { /* not linked yet — a fresh clone; `am fix` creates it */ }
    if (linked !== null && !linkSatisfiesPin(pin, linked)) {
      // Naming `path:` is what makes this WINNABLE.
      //
      // `doctor` fails without a pin; this warns when a pin exists and dep/aio
      // points at a working checkout rather than the version store. A field
      // report concluded that no configuration satisfies both and wrote it up
      // in their README as intended behaviour — which is what you do when a
      // tool is wrong, and which teaches people to ignore both tools. There
      // WAS an answer the whole time (`linkSatisfiesPin` has always understood
      // `path:`); nothing said so at the moment it was needed.
      // THE decider for what to say — shared with doctor, which used to offer
      // only "run `am fix`" for this exact case and so contradicted this
      // warning. Two tools disagreeing about one link is how a developer ends
      // up documenting a false red in their own README.
      const hint = pinDisagreementHint(pin, linked);
      report(
        "warn",
        "config",
        `framework pin ${pin} does not match dep/aio (→ ${linked}) — ` +
          "the app runs a version it does not declare.\n" +
          (hint
            ? `      ${hint}`
            : "      Run `am pin <version>` to move the pin, or `am fix` to " +
              "relink"),
      );
    } else {
      pass(
        `framework pin ${pin}${linked === null ? " (dep/aio unlinked)" : ""}`,
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 2. FILE STRUCTURE
// ══════════════════════════════════════════════════════════════════════

export const checkStructure: Checker = async (ctx) => {
  const { projectDir, appEntry, appTsx, sourceFiles, report, pass, denoJson } =
    ctx;
  // Detect server-only / CLI mode: check aio.run() config or --client flag in dev task
  const isClientServerOnly = /client\s*:\s*['"](?:server-only|cli)['"]/.test(
    appEntry?.content ?? "",
  );
  const tasks = denoJson?.tasks ?? {};
  const devTask = tasks["dev"] ?? "";
  const clientFromTask = /--client[= ](?:server-only|cli)/.test(devTask);
  const isHeadless = isClientServerOnly || clientFromTask;

  // app.ts entry point
  if (appEntry) pass(`entry: ${appEntry.relative}`);
  else {
    // A THIN CLIENT has no `aio.run()` and never will: `src/client.ts` opens a
    // `connectCli()` connection to a server that runs elsewhere. That is a
    // first-class target (`compile:cli:remote`, and the shape `am create`
    // scaffolds as `src/client.ts`), so "create one with aio.run()" was the
    // linter telling the framework's own remote-CLI layout to become a
    // different kind of app.
    const clientEntry = sourceFiles.find((f) =>
      /\bconnectCli\b/.test(codeText(f.content))
    );
    // Check for common alternatives
    const altEntry = sourceFiles.find((f) =>
      f.relative === "src/main.ts" || f.relative === "main.ts"
    );
    if (clientEntry) {
      pass(
        `entry: ${clientEntry.relative} (thin client — connects to a server)`,
      );
    } else if (altEntry) {
      report(
        "hint",
        "structure",
        `entry point is "${altEntry.relative}" — convention is "src/app.ts"`,
        { file: altEntry.relative },
      );
    } else if (ctx.isApp) {
      // Not for a project that never consumes aio: advising the framework repo
      // to "create an entry point with aio.run()" is the rule describing
      // itself, not the code.
      // A DECLARED entry that is not on disk is a different (and worse) fact
      // than "no entry point": the project said where its app is and the file
      // is missing. Say which, so the linter is never wrong about a layout
      // the project itself declares (R-8).
      const declared = declaredEntryPaths(denoJson);
      report(
        "warn",
        "structure",
        declared.length > 0
          ? `entry point declared in deno.json but not found: ${
            declared.join(", ")
          } — create it (with aio.run()) or fix the path`
          : "no entry point found (src/app.ts) — create one with aio.run(), " +
            'or declare where it lives with "entry" in deno.json',
      );
    }
  }

  // App.tsx
  if (!isHeadless) {
    if (appTsx) {
      pass("UI: App.tsx");
      if (!appTsx.content.includes("export default")) {
        report(
          "warn",
          "structure",
          "App.tsx missing `export default` — framework can't mount your component",
          { file: appTsx.relative },
        );
      }
    } else {
      report(
        "hint",
        "structure",
        'no App.tsx found — needed for browser/Electron UI (skip if client: "server-only" or "cli")',
      );
    }
  } else {
    // "Unused" only if NOTHING in the project can mount it. One app is many
    // targets, and since alpha52 the scaffold ships ONE `dev` task whose flags
    // pass through (`deno task dev --client=browser`) with the CLI flag beating
    // aio.run() config (src/server/aio.ts client resolution) — so any dev task
    // that runs the app entry keeps App.tsx one flag away from mounting.
    // Calling it unused told a brand-new server-target app to delete a file
    // its own README documents using.
    // BOTH spellings — the array form and the object form, whose keys may be
    // free labels with `kind` naming the target. Reading only the array form
    // made this line throw ("uiTargets.some is not a function") on a repo that
    // used the documented object form.
    const uiTargets = declaredTargetKinds(denoJson);
    const uiTask = Object.values(tasks).some((t) =>
      /--client[= ](?:browser|electron)|--electron\b|--android\b/.test(t)
    );
    // Pass-through reachability: dev runs the app entry → --client=X works.
    const devRunsEntry = /\bsrc\/app\.ts\b|\bapp\.ts\b/.test(devTask);
    const buildsUI = uiTask || devRunsEntry ||
      uiTargets.some((t) =>
        ["browser", "electron", "android", "server-app"].includes(t)
      );
    if (appTsx && !buildsUI) {
      report(
        "hint",
        "structure",
        'App.tsx exists but no target builds a UI (client is "server-only" or "cli") — file is unused',
        { file: appTsx.relative },
      );
    } else if (appTsx) {
      pass("UI: App.tsx (used by the browser/Electron/Android targets)");
    } else pass("server-only / CLI mode (no App.tsx)");
  }

  // Cell organization
  const cellFiles = sourceFiles.filter((f) =>
    f.content.includes("cell(") && !f.name.endsWith(".test.ts") &&
    f.name !== "app.ts"
  );
  if (cellFiles.length > 3) {
    // A dedicated cell directory counts as organized whether it's named
    // `cell/` or `cells/` — both are valid; don't nag about the choice.
    const inCellDir = cellFiles.filter((f) =>
      /(^|\/)cells?\//.test(f.relative)
    );
    if (inCellDir.length < cellFiles.length / 2) {
      report(
        "hint",
        "structure",
        `${cellFiles.length} cell files scattered — consider organizing in a src/cells/ (or src/cell/) directory`,
        { fix: "See structure.md" },
      );
    }
  }

  // Check for test directory
  const testsDir = join(projectDir, "tests");
  const srcTests = sourceFiles.filter((f) => f.name.endsWith(".test.ts"));
  try {
    await Deno.stat(testsDir);
  } catch {
    if (srcTests.length === 0) {
      report(
        "hint",
        "structure",
        "no tests/ directory and no .test.ts files found",
      );
    }
  }

  // appId / appVersion — required to RESOLVE, not required to be typed out.
  //
  // Both are inferable: appId from deno.json (appId > title > name) or the
  // compiled binary's own name, appVersion from deno.json `version`, which the
  // build embeds in the artifact. Demanding them explicitly anyway made a
  // freshly scaffolded app fail aio's own linter in the first five minutes —
  // which teaches "the linter is noise", the most expensive thing a linter can
  // teach. So: pass when it resolves, say where from, and error only
  // when nothing can supply it.
  //
  // Matching is on CODE, not raw text: `content.includes("appId")` was
  // satisfied by the word appId in a comment, so the check passed on a scaffold
  // that never set it — a green light with nothing behind it.
  if (appEntry) {
    const setsInRun = (key: string) =>
      codeMatches(appEntry.content, new RegExp(`\\b${key}\\s*:`, "g")).length >
        0;
    const dj2 = denoJson ?? {};
    const inferredId = dj2.appId ?? dj2.title ??
      (typeof dj2.name === "string" ? dj2.name.split("/").pop() : undefined);

    if (setsInRun("appId")) pass("appId set in aio.run()");
    else if (inferredId) {
      pass(`appId inferred from deno.json (${inferredId})`);
    } else {report(
        "error",
        "config",
        "no appId anywhere — it names the lock file, the SQLite/KV paths and " +
          "the UDS socket, so it cannot be guessed",
        {
          file: appEntry.relative,
          fix:
            'Add appId: "my-app" to aio.run(), or a "title" field to deno.json',
          safeFix: fix.fixAddAppIdToRun(appEntry.path),
        },
      );}

    if (setsInRun("appVersion")) pass("appVersion set in aio.run()");
    else if (dj2.version) {
      pass(`appVersion inferred from deno.json (${dj2.version})`);
    } else {report(
        "error",
        "config",
        'no app version anywhere — add "version" to deno.json, or ' +
          'appVersion: "0.1.0" to aio.run()',
        {
          file: appEntry.relative,
          fix: 'Add "version": "0.1.0" to deno.json',
        },
      );}
  }
};

// ══════════════════════════════════════════════════════════════════════
// 3. FEATURE DEFINITIONS
// ══════════════════════════════════════════════════════════════════════

export const checkCells: Checker = (ctx) => {
  const { cells, report, pass } = ctx;

  if (cells.length === 0) {
    report(
      "hint",
      "cells",
      "no cell() calls found — is this a legacy (reduce/execute) app?",
    );
    return;
  }

  pass(
    `${cells.length} cell(s): ${cells.map((f) => f.name).join(", ")}`,
  );

  // the restructure (perfect-aio D1/D10): Style-B config keys were removed — detect
  // them STATICALLY and print the exact migration mapping, so an old app
  // learns the fix from `deno task lint` before it even boots.
  for (const f of cells) {
    for (const key of f.removedKeys) {
      // A removal with a SITE rule of its own (exact line + --safe-fix, in
      // checkAlpha52) is reported there, once — not here as a second line.
      if (SITE_RULED_REMOVALS.has(key)) continue;
      // An ERROR that fails the gate has to say WHERE. This one named the cell
      // and nothing else, so in a repo with several cell files the reader's
      // first move was a grep — and the linter knows the answer.
      report(
        "error",
        "cells",
        removalMessage(removalOf(key), `cell "${f.name}"`),
        { file: f.file.relative, line: f.line },
      );
    }
  }

  // the restructure (perfect-aio D5/B4c): periphery moved off the core entry to
  // aio/extras — detect old imports and print the one-line fix.
  // symbol → its current home ("" = removed in the alpha41 surface diet).
  const MOVED_OFF_CORE = new Map<string, string>([
    ["lint", "aio/extras"],
    ["parseCli", "aio/extras"],
    ["draft", ""], // removed — pre-methods relic
    ["matchEffect", ""], // removed — pre-methods relic
    ["deepFreeze", "aio/extras"],
    ["markAsync", "aio/extras"],
    ["instances", "aio/extras"],
    ["resolveAppId", "aio/extras"],
    ["connectCliUDS", "aio/server"],
    ["createSliceSelector", "aio/extras"],
    ["DEFAULT_PRAGMAS", "aio/db"],
    ["UnionOf", ""], // removed — pre-methods relic
  ]);
  for (const file of ctx.sourceFiles) {
    // Masked, like every other body probe: a strict (error-severity) rule that
    // reads RAW text fires on an upgrade note in a comment or an import written
    // inside a codegen template literal — failing the gate on code that never
    // runs. `.katana/_aio.md` allows a rule to be strict only when its probe
    // runs over masked code.
    for (
      const m of codeMatches(
        file.content,
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]aio['"]/g,
      )
    ) {
      const moved = m[1]!.split(",")
        .map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!)
        .filter((n) => MOVED_OFF_CORE.has(n));
      if (moved.length === 0) continue;
      const lineIdx = file.content.slice(0, m.index).split("\n").length;
      report(
        "error",
        "cells",
        `${file.relative}:${lineIdx} — ${
          moved.map((n) => {
            const home = MOVED_OFF_CORE.get(n);
            return home
              ? `${n} moved to "${home}"`
              : `${n} was removed (pre-methods relic, alpha41 surface diet)`;
          }).join("; ")
        } — see docs/upgrade/restructure.md`,
        { file: file.relative, line: lineIdx },
      );
    }
  }

  // Duplicate names
  const names = new Map<string, CellInfo[]>();
  for (const f of cells) {
    const list = names.get(f.name) ?? [];
    list.push(f);
    names.set(f.name, list);
  }
  for (const [name, list] of names) {
    if (list.length > 1) {
      report(
        "error",
        "cells",
        `duplicate cell name "${name}" — found in ${
          list.map((f) => f.file.relative).join(", ")
        }`,
      );
    }
  }

  for (const f of cells) {
    const loc = { file: f.file.relative, line: f.line };

    // A completely empty cell — `cell("app", { state: {}, methods: {} })` — is
    // the THIN-CLIENT REGISTRATION STUB, and it is not optional: `aio.run()`
    // refuses to boot with no cells at all ("no cells found"), so every
    // remote/connect-page target (electron-remote, android-remote, …) must
    // carry exactly this shape. Warning about the one spelling the framework
    // requires is a rule firing on code that cannot be written any other way.
    // An empty state with REAL methods still warns — that one is a mistake.
    const isThinClientStub = f.hasState && f.stateIsLiteral &&
      f.stateKeys.length === 0 && f.methodNames.length === 0 &&
      f.actionNames.length === 0 && !f.hasGenerators && !f.hasSelectors;

    // Empty state
    if (!f.hasState) {
      report(
        "warn",
        "cells",
        `cell "${f.name}" has no state — every cell needs initial state`,
        loc,
      );
    } else if (
      f.stateIsLiteral && f.stateKeys.length === 0 && !isThinClientStub
    ) {
      report(
        "warn",
        "cells",
        `cell "${f.name}" has empty state object {}`,
        loc,
      );
    }

    // No methods. `actions:` was removed in alpha27 (src/state/removals.ts) and
    // the loop above already reports it by name — so it must not appear here as
    // half of an acceptable answer. A linter that offers the style it has just
    // declared removed sends you to write code its next run rejects.
    if (!f.hasMethods) {
      report(
        "warn",
        "cells",
        `cell "${f.name}" has no methods — nothing can change its state`,
        {
          ...loc,
          fix:
            "methods: { increment(s, by = 1) { s.count += by; } } — one method per action",
        },
      );
    }

    // Reserved state keys
    const reserved = ["$p", "$d", "__proto__", "constructor", "prototype"];
    for (const key of f.stateKeys) {
      if (reserved.includes(key)) {
        report(
          "error",
          "cells",
          `cell "${f.name}" state has reserved key "${key}" — will cause data corruption`,
          loc,
        );
      }
      if (key === "__aio_status" || key.startsWith("__aio_")) {
        report(
          "error",
          "cells",
          `cell "${f.name}" state has "${key}" key — reserved for aio internals`,
          loc,
        );
      }
    }

    // Reserved key collisions — methods, actions, generators using reserved CellDef property names
    const allUserKeys = [...f.methodNames, ...f.actionNames];
    for (const key of allUserKeys) {
      if (RESERVED_KEYS.has(key)) {
        report(
          "error",
          "cells",
          `cell "${f.name}" has ${
            f.hasMethods ? "method" : "action"
          } "${key}" — collides with reserved property. Reserved: ${
            [...RESERVED_KEYS].join(", ")
          }`,
          loc,
        );
      }
    }

    // Cell name conventions
    if (!/^[a-z][\w-]*$/.test(f.name)) {
      report(
        "hint",
        "cells",
        `cell "${f.name}" — convention is lowercase with hyphens (e.g., "user-profile")`,
        loc,
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 4. STATE & PERFORMANCE
// ══════════════════════════════════════════════════════════════════════

export const checkPerformance: Checker = (ctx) => {
  const { sourceFiles, cells, appEntry, report, pass } = ctx;

  // useAio() subscribes a component to the WHOLE app state, so any commit
  // anywhere re-renders it.
  //
  // The fix used to read "prefer useCell(ref)" — which `checkUseCell` warns
  // about, in the same run, as deprecated. Following one rule earned you the
  // other: two deciders on one question ("how should a component read state?")
  // giving opposite answers, which is how a linter loses the benefit of the
  // doubt. Direct cell access is the single answer; both hooks are the
  // backward-compat layer.
  for (const file of ctx.tsxFiles) {
    if (file.name === "App.tsx") continue; // root layout — useAio is OK
    const code = codeText(file.content);
    const useAioCount = (code.match(/\buseAio\b/g) ?? []).length;
    const useCellCount = (code.match(/\buseCell\b/g) ?? []).length;
    if (useAioCount > 0 && useCellCount === 0) {
      report(
        "warn",
        "perf",
        `${file.relative}: uses useAio() — it subscribes to the ENTIRE app ` +
          `state, so every commit anywhere re-renders this component. Read the ` +
          `cell directly (\`counter.count\`) for scoped, selective re-renders`,
        {
          file: file.relative,
          fix: "Replace useAio().state.counter with counter.count",
        },
      );
    }
  }

  // Check for sync I/O in source (outside test files)
  const syncApis = [
    "Deno.readTextFileSync",
    "Deno.readDirSync",
    "Deno.writeTextFileSync",
    "Deno.statSync",
    "Deno.removeSync",
    "Deno.mkdirSync",
  ];
  // Only where the message is TRUE. "Every client's next action waits behind
  // it" presupposes a dispatch loop with clients on it. Against a project that
  // is not an app — the framework repo, a tool, a library — the rule fired on
  // boot-once pre-flight, shutdown checkpoints, CLI-once key reads, and on the
  // journal, whose synchrony is the POINT (each append fsyncs so it survives
  // SIGKILL; "use the async version" would delete the guarantee). That was 84
  // of 85 warnings, which is how a true warning gets trained away.
  for (const file of sourceFiles) {
    if (!ctx.isApp) break;
    // A build script has no clients, and blocking until it finishes is its
    // job; neither does a TEST, whose sync I/O nobody is waiting behind.
    // `isTestPath` rather than a `.test.ts` name check: that spelling missed
    // `.test.tsx`, `_test.ts` and everything under a `test/` directory.
    if (isToolingPath(file.relative) || isTestPath(file.relative)) continue;
    for (const api of syncApis) {
      // Code only — the API named in a comment or a string isn't a call.
      if (codeText(file.content).includes(api)) {
        // Find line number
        const lineIdx = file.lines.findIndex((l) => l.includes(api));
        report(
          "warn",
          "perf",
          `${file.relative}: sync I/O (${api}) blocks the event loop — every ` +
            `client's next action waits behind it. Use the async version; if ` +
            `the work is CPU-bound or a sync-only API, move it off-thread with ` +
            `blocking("id", fn, arg)`,
          { file: file.relative, line: lineIdx + 1 },
        );
      }
    }
  }

  // Check for setTimeout/setInterval in cell files (should use schedule).
  // Skips: the delay-0 yield idiom
  // `new Promise((r) => setTimeout(r, 0))` — that's a microtask hop, not a
  // timer schedule would replace — and any line carrying `aiol-ok`.
  for (const file of sourceFiles) {
    if (file.name === "app.ts" || isTestPath(file.relative)) continue;
    // A cell defined in a benchmark is a fixture — nobody observes or cancels
    // its timers.
    if (isToolingPath(file.relative)) continue;
    if (!file.content.includes("cell(")) continue;
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i]!;
      if (!/set(Timeout|Interval)\(/.test(line)) continue;
      if (isSuppressed(file.lines, i)) continue;
      if (/setTimeout\([^,)]*,\s*0\s*\)/.test(line)) continue; // delay-0 yield
      report(
        "hint",
        "perf",
        `${file.relative}:${
          i + 1
        }: setTimeout/setInterval in cell code — use schedule.after/every for observable, cancellable timers (suppress with \`// aiol-ok\` on this line or the comment line above)`,
        { file: file.relative, line: i + 1 },
      );
      break; // once per file is enough
    }
  }

  // REMOVED — "state.items is a typed array — if it grows large, consider
  // SQLite". `items: [] as Todo[]` is THE aio state idiom; the rule fired on
  // aio's own todo template, on every app that has ever held a list, and no
  // edit could ever clear it (short of renaming the field). An unclearable hint
  // on correct code is the kind that trains people to skim past the real ones
  //. Collection size is not knowable statically —
  // docs/db/ covers when to reach for SQLite.

  // Check for missing cell-level ui filters
  if (appEntry && cells.length > 0) {
    const hasUiConfig = cells.some((c) =>
      c.file.content.includes("ui:") || c.file.content.includes("ui :")
    );
    const hasCellDefaults = appEntry.content.includes("cellDefaults");
    if (!hasUiConfig && !hasCellDefaults) {
      const totalKeys = cells.reduce((n, f) => n + f.stateKeys.length, 0);
      if (totalKeys > 10) {
        report(
          "hint",
          "perf",
          `${totalKeys} state keys across ${cells.length} cells — consider cell-level ui filters or cellDefaults to control what's sent to browser`,
          { file: appEntry.relative },
        );
      }
    } else {
      pass("cell-level ui visibility configured");
    }
  }

  // console.log in APP code.
  //
  // Not in a CLI client: there, stdout IS the product — printing the state it
  // just received is the whole program, and routing it through the structured
  // logger would prefix and level-filter the output the user asked for. The
  // scaffolded `src/client.ts` is exactly this, so the shipped template was
  // hinted at by the shipped linter on creation.
  //
  // Not in TOOLING either (field report #9): a developer command
  // — a `sync-shared.ts` that mirrors files, a codegen script, a one-off
  // migration runner — prints to a terminal on purpose. It is not the app; it
  // has no logger sinks, no client, and nobody greps its output by level.
  //
  // The scope answers ONE question an author can answer without reading this
  // file: is this file part of what the APP runs?
  //   app  = anything under the app's source dirs (`src/`, `cells/`) — aio's
  //          own layout — plus, wherever it lives, any file that declares a
  //          cell, is a component (`.tsx`), or boots the app (`aio.run(`).
  //   tool = a script outside those dirs (the repo root; `scripts/`, `tools/`
  //          are not scanned at all), or one carrying a `#!` shebang, that
  //          declares none of the above.
  // Both halves are deliberate. The shebang lets a script that must sit inside
  // `src/` opt in by being an actual executable — a signal the author writes,
  // not one the linter infers. And the cell/component/`aio.run` clause is
  // absolute: a `console.log` in a CELL or a component is flagged no matter
  // where the file sits, because that is the case the rule exists for.
  const norm = (p: string) => p.replaceAll("\\", "/");
  const inAppSourceDir = (f: typeof sourceFiles[number]) =>
    norm(f.relative).startsWith("src/") ||
    norm(f.relative).startsWith("cells/");
  const isAppSurface = (f: typeof sourceFiles[number]) => {
    if (f.ext === ".tsx") return true; // a component
    const code = codeText(f.content);
    return /\bcell\s*\(\s*['"`]/.test(code) ||
      /\baio\s*\.\s*run\s*\(/.test(code);
  };
  // The path rule wins over the content heuristic: a benchmark that defines a
  // cell still reads as `isAppSurface`, and it is still tooling.
  const isTooling = (f: typeof sourceFiles[number]) =>
    isToolingPath(f.relative) || isTestPath(f.relative) ||
    (!isAppSurface(f) && (!inAppSourceDir(f) || /^#!/.test(f.content)));
  const isCliClient = (f: typeof sourceFiles[number]) =>
    /\bconnectCli\b/.test(codeText(f.content));
  for (const file of sourceFiles) {
    if (isTestPath(file.relative)) continue;
    if (isCliClient(file)) continue;
    if (isTooling(file)) continue;
    const logLines = file.lines
      .map((l, i) => ({ line: l.trim(), num: i + 1 }))
      .filter(({ line }) =>
        /\bconsole\.(log|dir|table)\b/.test(line) && !line.startsWith("//")
      );
    if (logLines.length > 0) {
      report(
        "hint",
        "perf",
        `${file.relative}: ${logLines.length} console.log call(s) — use log from 'aio' for structured logging`,
        { file: file.relative, line: logLines[0]!.num },
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 5. SECURITY
// ══════════════════════════════════════════════════════════════════════

export const checkSecurity: Checker = (ctx) => {
  const { sourceFiles, appEntry, report, pass } = ctx;

  // Hardcoded tokens/secrets
  const secretPatterns = [
    {
      re: /token\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/g,
      desc: "hardcoded token",
    },
    { re: /password\s*[:=]\s*['"][^'"]{4,}['"]/g, desc: "hardcoded password" },
    { re: /secret\s*[:=]\s*['"][^'"]{8,}['"]/g, desc: "hardcoded secret" },
    {
      re: /api[_-]?key\s*[:=]\s*['"][^'"]{10,}['"]/gi,
      desc: "hardcoded API key",
    },
  ];
  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts") || file.name.endsWith(".test.tsx")) {
      continue;
    }
    for (const { re, desc } of secretPatterns) {
      // Code only. `// never write password: "hunter2"` is a WARNING ABOUT the
      // pattern, not an instance of it, and the doc line that says so was
      // reported as a hardcoded password. Matching is on the START offset (the
      // `password` identifier) — `codeText` can't be used here because the
      // secret IS a string literal and blanking its body would break the
      // length classes these patterns rely on.
      const [match] = codeMatches(file.content, re);
      if (match) {
        const lineIdx = file.content.slice(0, match.index).split("\n").length;
        report(
          "warn",
          "security",
          `${file.relative}:${lineIdx} — possible ${desc} — use environment variables instead`,
          { file: file.relative, line: lineIdx },
        );
      }
    }
  }

  // --expose with no auth story: reported (with the alpha52 key-default
  // migration + safe-fix) by checkAlpha52Surface — ONE decider. Here only the
  // pass line remains.
  if (appEntry) {
    const hasExpose = appEntry.content.includes("expose") ||
      appEntry.content.includes("--expose");
    if (!hasExpose) pass("localhost-only (no --expose)");
  }

  // .env files committed — only warn if it isn't already gitignored
  try {
    Deno.statSync(join(ctx.projectDir, ".env"));
    if (!isGitignored(ctx.projectDir, ".env")) {
      report(
        "warn",
        "security",
        ".env file found — make sure it's in .gitignore",
      );
    }
  } catch { /* good — no .env */ }
};

/** True if `path` is gitignored in `dir`. Uses `git check-ignore`, falling back
 *  to a simple .gitignore scan when git isn't available. */
function isGitignored(dir: string, path: string): boolean {
  try {
    const r = new Deno.Command("git", {
      args: ["-C", dir, "check-ignore", "-q", path],
      stdout: "null",
      stderr: "null",
    }).outputSync();
    return r.code === 0;
  } catch {
    try {
      const gi = Deno.readTextFileSync(join(dir, ".gitignore"));
      return gi.split("\n").map((l) => l.trim()).some(
        (l) => l === ".env" || l === "*.env" || l === ".env*" || l === ".env.*",
      );
    } catch {
      return false;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 6. PERSISTENCE & DATABASE
// ══════════════════════════════════════════════════════════════════════

export const checkPersistence: Checker = (ctx) => {
  const { appEntry, sourceFiles, report, pass } = ctx;

  if (!appEntry) return;

  // ── the update data gate only protects cells that declare a version ──
  //
  // `_cellVersions` collects cells with `version > 0`; `_versionStamp` stamps
  // only those; `dataCompatibility` iterates only what was stamped. So a cell
  // that never declared `version` is invisible to the gate — a release that
  // renames one of its fields is offered to every install as compatible, the
  // merge drops the field, and the persist window writes the loss back.
  //
  // Reported ONLY for an app that configures `updates`, because that is the
  // only app for which it is load-bearing: a cell in an app that never updates
  // itself has nothing to be protected from, and firing there would make this
  // the next warning people learn to scroll past. One line for all of them,
  // not one per cell — twenty lines is its own kind of silence.
  if (/\bupdates\s*:/.test(appEntry.content)) {
    const unguarded = ctx.cells.filter((c) => !c.hasVersion && !c.persistFalse);
    if (unguarded.length > 0) {
      report(
        "warn",
        "data",
        `${unguarded.length} cell(s) persist and declare no \`version\`, so ` +
          `the update data gate cannot protect them: ${
            unguarded.map((c) => c.name).join(", ")
          }. A release that changes one of their shapes is offered as ` +
          `compatible and the old field is dropped on merge. Add ` +
          `\`version: 1\` to each (and an \`onMigrate\` when the shape ` +
          `changes) — the first stamp is free and converts nothing.`,
        { file: unguarded[0]!.file.relative, line: unguarded[0]!.line },
      );
    } else if (ctx.cells.length > 0) {
      pass("every persisted cell declares a version — the data gate covers it");
    }
  }

  // Strip comments so a `db:` mention inside a comment doesn't false-positive
  //.
  const codeNoComments = appEntry.content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const hasDb = /\bdb\s*:/.test(codeNoComments);
  const hasPersistFalse = /persist\s*:\s*false/.test(codeNoComments);

  if (hasDb) {
    pass("SQLite configured");
    // Check for table() imports — quote-agnostic (deno fmt emits double quotes)
    const hasTableImport = sourceFiles.some((f) =>
      /from\s+["']aio(?:\/db)?["']/.test(f.content) &&
      f.content.includes("table")
    );
    if (!hasTableImport) {
      report(
        "hint",
        "persistence",
        "db config found but no table() schema definition — import { table, pk, text } from 'aio'",
      );
    }
  }

  if (hasPersistFalse) {
    report(
      "hint",
      "persistence",
      "persist: false — state won't survive restarts (OK for tests, not for production)",
      { file: appEntry.relative },
    );
  }

  // Check for old version/migrations pattern (removed in v1.0 — use onRestore for state restructuring)
  if (
    /\bversion\s*:\s*\d+/.test(appEntry.content) &&
    appEntry.content.includes("migrations")
  ) {
    report(
      "warn",
      "persistence",
      "version + migrations removed in v1.0 — use onRestore for state restructuring, deepMerge handles new fields automatically",
      { file: appEntry.relative },
    );
  }

  // Direct Deno.Kv usage (should use aio persistence). Code only — the
  // migration note "we moved off Deno.openKv in alpha28" is not a use of it.
  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts")) continue;
    const code = codeText(file.content);
    if (code.includes("Deno.openKv") || code.includes("Deno.Kv")) {
      report(
        "hint",
        "persistence",
        `${file.relative}: direct Deno.Kv usage — aio handles persistence automatically, use app.db for custom queries`,
        { file: file.relative },
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 7. UI / BROWSER
// ══════════════════════════════════════════════════════════════════════

export const checkUI: Checker = (ctx) => {
  const { tsxFiles, appTsx, report, pass } = ctx;

  if (tsxFiles.length === 0) {
    pass("no TSX files (server-only / CLI)");
    return;
  }

  // Browser import safety — check .tsx files AND cell files.
  //
  // aio's OWN entry points are deliberately absent from this rule: `checkImports`
  // owns them, and it knows the mapping to suggest (derived from how the app
  // already maps bare `aio`, with a --safe-fix). This rule's generic advice —
  // `Add "aio/db": "npm:aio/db"` — is not just redundant, it is WRONG: there is
  // no such npm package, so the app that followed it swapped one unresolvable
  // specifier for another. One question, one decider.
  const isAioEntry = (spec: string) =>
    spec === "aio" || spec.startsWith("aio/");
  const BROWSER_IMPORTS = new Set([
    "react",
    "react-dom/client",
    "react/jsx-runtime",
  ]);
  const denoImports = new Set(Object.keys(ctx.denoJson?.imports ?? {}));
  // Server-only module prefixes — ONE list, read by both loops below.
  //
  // There were two, and the second was missing `aio/server`. That alone would
  // be a drift; what made it a hole is that the two loops divide the files
  // between them: the cell-file loop KNOWS these are server-only and skips
  // `.tsx`, while this loop sees every `.tsx` and waved them through —
  // `@std/`/`node:` with "caught by Check 1" (the loop that skips .tsx), and
  // every `aio/*` via `isAioEntry` on the grounds that `checkImports` owns
  // them (it asks whether a specifier RESOLVES, never whether it belongs in a
  // browser). So a component importing `aio/server`, `@std/path` or `node:fs`
  // was checked by nobody, and each one is the anonymous blank screen these
  // rules exist to prevent. aiol's own [upgrade] rule suggests
  // `import { createDB } from "aio/server"` as the fix for `aio/db`, which
  // walked an app straight into it.
  //
  // Half of this was already found once: the `Deno.*` scan was moved OUT of
  // the cell-file loop "precisely because this `continue` was silently
  // exempting components from it". The import scan kept the defect.
  const SERVER_ONLY_PREFIXES = ["@std/", "node:", "aio/server"];

  const cellFiles = ctx.cells.map((f) => f.file).filter((f, i, arr) =>
    arr.indexOf(f) === i
  );
  const browserCheckedFiles = [
    ...tsxFiles,
    ...cellFiles.filter((f) => f.ext !== ".tsx"), // avoid double-checking
  ];

  // Every import scan below matches on CODE offsets (`codeMatches`), not raw
  // text. A code-generating file — an `am`-style scaffold, a bundler entry, a
  // testgen — holds import statements inside template literals, and matching
  // those reported an ERROR ("import 'some-npm-pkg' not found in deno.json")
  // about a string the app never imports. `codeText` can't serve here: the
  // module specifier IS a string literal, so blanking string bodies would
  // erase the very thing being read. The start offset (the `import` keyword)
  // is the honest test of "is this a real statement?".
  for (const file of browserCheckedFiles) {
    // Named/default imports
    for (
      const m of codeMatches(
        file.content,
        /(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
      )
    ) {
      const spec = m[1]!;
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (
        m[0]!.startsWith("import type ") || m[0]!.startsWith("import type{")
      ) continue;
      const lineIdx = file.content.slice(0, m.index).split("\n").length;
      // A `.tsx` reaches the browser bundle, and no other loop sees it: the
      // cell-file loop below skips `.tsx` by design. Non-`.tsx` files ARE in
      // that loop, so they defer to it and are not reported twice.
      if (
        file.ext === ".tsx" &&
        SERVER_ONLY_PREFIXES.some((p) => spec.startsWith(p))
      ) {
        report(
          "error",
          "ui",
          `${file.relative}:${lineIdx} — import "${spec}" is server-only and this file is compiled into the browser bundle`,
          {
            file: file.relative,
            line: lineIdx,
            fix:
              "Move it behind a cell method (`await import(...)` runs on the server), put it in a *.server.ts module, or use `import type`",
          },
        );
        continue;
      }
      if (BROWSER_IMPORTS.has(spec) || isAioEntry(spec)) continue;
      if (denoImports.has(spec)) continue; // in deno.json → auto-aliased
      if (SERVER_ONLY_PREFIXES.some((p) => spec.startsWith(p))) continue; // the cell-file loop owns non-.tsx
      report(
        "error",
        "ui",
        `${file.relative}:${lineIdx} — import "${spec}" not found in deno.json imports`,
        {
          file: file.relative,
          line: lineIdx,
          fix:
            `Add "${spec}": "npm:${spec}" to deno.json imports — AIO auto-aliases for browser`,
        },
      );
    }
    // Side-effect imports
    for (
      const m of codeMatches(
        file.content,
        /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
      )
    ) {
      const spec = m[1]!;
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (
        file.ext === ".tsx" &&
        SERVER_ONLY_PREFIXES.some((p) => spec.startsWith(p))
      ) {
        report(
          "error",
          "ui",
          `${file.relative}: side-effect import "${spec}" is server-only and this file is compiled into the browser bundle`,
          {
            file: file.relative,
            fix: "Move it behind a cell method or into a *.server.ts module",
          },
        );
        continue;
      }
      if (
        BROWSER_IMPORTS.has(spec) || isAioEntry(spec) || denoImports.has(spec)
      ) continue;
      if (SERVER_ONLY_PREFIXES.some((p) => spec.startsWith(p))) continue;
      report(
        "error",
        "ui",
        `${file.relative}: side-effect import "${spec}" not in deno.json imports`,
        {
          file: file.relative,
          fix: `Add "${spec}": "npm:${spec}" to deno.json imports`,
        },
      );
    }
  }

  // createRoot anti-pattern
  if (appTsx?.content.includes("createRoot")) {
    report(
      "hint",
      "ui",
      "App.tsx uses createRoot — remove it, aio handles mounting",
      {
        file: appTsx.relative,
        safeFix: fix.fixRemoveCreateRootImport(appTsx.path),
      },
    );
  }

  // import React (not needed)
  if (appTsx && /import\s+React[\s,{]/.test(appTsx.content)) {
    report(
      "hint",
      "ui",
      'App.tsx imports React — not needed with jsx: "react-jsx" transform',
      { file: appTsx.relative, safeFix: fix.fixRemoveImportReact(appTsx.path) },
    );
  }

  // Server-only imports in cell definition files (shared with browser)
  // "aio/server" is the explicit server-only entry: the whole module
  // is server-only, so a STATIC import into a cell-shared file is the boundary
  // violation — flag it like @std/ / node:.
  // (SERVER_ONLY_PREFIXES is declared once, above both loops.)
  // AIO-424: server-only SYMBOLS that live in the isomorphic "aio"/"aio/db"
  // entries — the browser build omits them, so a STATIC import into a
  // cell (shared with the browser bundle) link-fails at boot with an anonymous
  // "does not provide an export named X" blank screen that every server-side
  // check (check/test/lint) passes. THE set is SERVER_ONLY_AIO_SYMBOLS from
  // src/entries.ts (alpha52 one-decider — graph-validator imports the same).
  for (const file of cellFiles) {
    // A .tsx cell file's imports are already read by the browserCheckedFiles
    // loop above (it starts with every .tsx). Only the import scan is
    // duplicated here; the Deno.* scan moved OUT of this loop precisely
    // because this `continue` was silently exempting components from it.
    if (file.ext === ".tsx") continue;

    // Named/default imports
    for (
      const m of codeMatches(
        file.content,
        /(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
      )
    ) {
      const spec = m[1]!;
      if (
        m[0]!.startsWith("import type ") || m[0]!.startsWith("import type{")
      ) continue;
      const lineIdx = file.content.slice(0, m.index).split("\n").length;

      // (a) server-only module prefix
      if (SERVER_ONLY_PREFIXES.some((p) => spec.startsWith(p))) {
        report(
          "error",
          "ui",
          `${file.relative}:${lineIdx} — import "${spec}" is server-only but this file contains a cell() definition shared with the browser bundle`,
          {
            file: file.relative,
            line: lineIdx,
            fix:
              "Move to a server-only file and use dynamic import, or use import type",
          },
        );
        continue;
      }

      // (b) server-only SYMBOL from the isomorphic "aio"/"aio/db" entry (AIO-424)
      if (spec === "aio" || spec === "aio/db") {
        const braces = m[0]!.match(/\{([^}]*)\}/);
        if (!braces) continue;
        for (const raw of braces[1]!.split(",")) {
          const sym = raw.trim().split(/\s+as\s+/)[0]!.trim();
          if (!SERVER_ONLY_AIO_SYMBOLS.has(sym)) continue;
          report(
            "error",
            "ui",
            `${file.relative}:${lineIdx} — '${sym}' from "${spec}" is server-only (SQLite/Worker) but this file has a cell() shared with the browser bundle; the browser build of "aio" omits it, so this static import blank-screens the client at boot`,
            {
              file: file.relative,
              line: lineIdx,
              fix:
                `Load it lazily in a server-only path — \`const { ${sym} } = await import("aio/server")\` behind a server guard — or move it into a *.server.ts module. (Pure schema helpers like table/pk/text are browser-safe.)`,
            },
          );
        }
      }
    }
  }

  // Deno.* usage — over EVERY file that enters the browser bundle, which is
  // what `browserCheckedFiles` means: the components (.tsx) and the cell
  // modules they share. The scan used to sit inside the cell-file loop, under
  // a `if (file.ext === ".tsx") continue` whose stated reason was "already
  // checked above" — but the loop above reads import SPECIFIERS only, so
  // `Deno.*` was never checked in a .tsx at all. Identical `Deno.env.get`
  // was a gate-failing ERROR in `src/cell.ts` and produced ZERO output in
  // `src/App.tsx` — the file that most literally IS the browser bundle.
  //
  // The old "is there a `//` or a `*` earlier on this line?" heuristic was
  // wrong in BOTH directions: `s.count = 2 * Deno.pid` was silently skipped
  // (a `*` is multiplication, not a comment), and a `Deno.readTextFile` named
  // inside a STRING was reported as an ERROR that fails the gate. `codeText`
  // is the one decider for "is this real code".
  for (const file of browserCheckedFiles) {
    // A component or cell under scripts/ or tools/ is build-time code — it is
    // never bundled, and Deno.* is its whole job. Neither is a TEST file: a
    // `*.test.tsx` is run by `deno test`, and `Deno.test` is its first line.
    // Reporting those made this rule wrong 55 times out of 55 in one real app
    // — an ERROR-level gate at that ratio is one its author turns off, and
    // then it stops catching the case it was written for (`Deno.env.get` in a
    // component, which blank-pages the client).
    if (isToolingPath(file.relative) || isTestPath(file.relative)) continue;
    const isCellFile = cellFiles.includes(file);
    // …and neither is a `*.server.tsx`: the build marks those external, so
    // they never enter the bundle. (A cell file keeps its old verdict — a cell
    // is shared with the browser whatever the file is named, and the import
    // rules above are what decide whether that file leaks.)
    if (!isCellFile && isServerOnlyFile(file.relative)) continue;
    const code = codeText(file.content);
    for (const m of code.matchAll(/\bDeno\.\w+/g)) {
      const before = code.slice(0, m.index);
      const lineIdx = before.split("\n").length;
      report(
        "error",
        "ui",
        `${file.relative}:${lineIdx} — ${m[0]} is server-only but this file ${
          isCellFile
            ? "contains a cell() definition shared with the browser bundle"
            : "is compiled into the browser bundle"
        }, where the \`Deno\` global does not exist — the client throws \`Deno is not defined\` at first render`,
        {
          file: file.relative,
          line: lineIdx,
          fix:
            "Read it on the server — in a cell method, or in a *.server.ts module loaded with a dynamic import — and put the value in cell state; the component reads the state.",
        },
      );
    }
  }

  // Check 3: Transitive server-only import detection (2 levels from App.tsx)
  if (appTsx) {
    const SERVER_ONLY_IMPORT_RE =
      /(?:import|export)\s+(?!type\s).*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/g;
    // `(?!type\s)` — a TYPE-only hop is not an edge in the runtime graph.
    // `import type { Format } from "./x.server.ts"` is erased before esbuild
    // ever sees it, so it cannot drag anything into the browser bundle; without
    // this the chain rule reported an ERROR (gate-failing) on a file that was
    // correct, and the suggested cure did not apply either. A field report lost
    // time to exactly that and worked around it by moving its shared types.
    // The server-only probe below has always had this guard; the hop regex
    // simply never got it.
    const LOCAL_IMPORT_RE =
      /(?:import|export)\s+(?!type\s).*?\s+from\s+['"](\.[^'"]+)['"]/g;

    // Helper: resolve a relative import path to a source file
    const resolveFile = (fromFile: { relative: string }, relPath: string) => {
      const fromDir = fromFile.relative.replace(/[^/]+$/, "");
      const target = fromDir + relPath.replace("./", "");
      return ctx.sourceFiles.find((f) =>
        f.relative === target || f.relative === target + ".ts" ||
        f.relative === target + ".tsx"
      );
    };

    // Level 1: App.tsx → local imports
    for (const m1 of codeMatches(appTsx.content, LOCAL_IMPORT_RE)) {
      const resolved1 = resolveFile(appTsx, m1[1]!);
      if (!resolved1) continue;

      // Level 2: imported file → its local imports
      for (const m2 of codeMatches(resolved1.content, LOCAL_IMPORT_RE)) {
        const resolved2 = resolveFile(resolved1, m2[1]!);
        if (!resolved2) continue;

        // Check level 2 file for server-only imports
        for (
          const sm of codeMatches(resolved2.content, SERVER_ONLY_IMPORT_RE)
        ) {
          const lineIdx =
            resolved2.content.slice(0, sm.index).split("\n").length;
          report(
            "error",
            "ui",
            `${appTsx.relative} → ${resolved1.relative} → ${resolved2.relative}:${lineIdx} — transitive server-only import "${
              sm[1]
            }" reaches browser bundle via import chain`,
            {
              file: resolved2.relative,
              line: lineIdx,
              // Naming the DYNAMIC part matters: renaming the target to
              // *.server.ts alone does nothing here — the build marks those
              // external only for `import(...)`, not for a static import — and
              // a reader who has seen that advice elsewhere will try it first.
              fix: `Import it dynamically from the method that needs it ` +
                `(\`const x = await import("./thing.server.ts")\`). Renaming ` +
                `to *.server.ts only excludes DYNAMIC imports; a static one ` +
                `still enters the bundle. If you only need its types, ` +
                `\`import type\` is already erased and is not reported.`,
            },
          );
        }
      }
    }
  }

  // Check 4: Static dynamic import detection — only warn when target has server-only imports
  const STATIC_DYN_RE = /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;

  for (const file of browserCheckedFiles) {
    for (const m of codeMatches(file.content, STATIC_DYN_RE)) {
      const target = m[1]!;
      // *.server.ts is the first-class convention (AIO-55): the build marks
      // these dynamic imports external, so they never enter the browser bundle.
      if (isServerOnlyFile(target)) continue;
      // Resolve target file
      const dir = file.relative.replace(/[^/]+$/, "");
      const resolved = ctx.sourceFiles.find((f) => {
        const t = dir + target.replace("./", "");
        return f.relative === t || f.relative === t + ".ts" ||
          f.relative === t + ".tsx";
      });
      if (!resolved) continue;

      // Check if target has server-only imports
      const serverImports: string[] = [];
      for (
        const sm of codeMatches(
          resolved.content,
          /(?:import|export)\s+(?!type\s).*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/g,
        )
      ) {
        serverImports.push(sm[1]!);
      }
      if (/\bDeno\.\w+/.test(codeText(resolved.content))) {
        serverImports.push("Deno.*");
      }

      if (serverImports.length === 0) continue; // target is browser-safe, no warning

      const lineIdx = file.content.slice(0, m.index).split("\n").length;
      report(
        "warn",
        "ui",
        `${file.relative}:${lineIdx} — static dynamic import('${target}') will be resolved by esbuild into browser bundle (${resolved.relative} contains server-only imports: ${
          serverImports.join(", ")
        })`,
        {
          file: file.relative,
          line: lineIdx,
          fix: `Rename the target to *.server.ts (the build excludes it from ` +
            `the browser bundle — see docs/build/imports.md), or use a ` +
            `string variable: const _p = '${
              target.replace(/\.ts$/, "")
            }'; import(\`\${_p}.ts\`)`,
        },
      );
    }
  }

  // useCell without loading state
  for (const file of tsxFiles) {
    const useCellCalls = file.content.match(/useCell\(/g);
    if (
      useCellCalls && !file.content.includes("fallback") &&
      !file.content.includes("Loading") && !file.content.includes("Connecting")
    ) {
      report(
        "hint",
        "ui",
        `${file.relative}: useCell() without loading/fallback state — state is null until WS connects`,
        {
          file: file.relative,
          fix: "Add: if (!state) return <div>Loading...</div>",
        },
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 8. TESTING
// ══════════════════════════════════════════════════════════════════════

export const checkTesting: Checker = (ctx) => {
  const { cells, testFiles, report, pass, denoJson } = ctx;

  if (cells.length === 0) return;

  // Check each cell has a test
  // A cell counts as tested when a test file NAMES it — quoted (the cell id) or
  // as a whole identifier (the imported binding). The bare `includes(f.name)`
  // this used to end with was a SUBSTRING test, so a cell called `app` or
  // `view` matched the word inside `src/app.ts`, `snapshot`, `viewer`… in every
  // test file that existed. Those cells were permanently "tested" and the rule
  // could never fire for them — the exact shape of a rule that looks alive and
  // is not.
  const testedCells = new Set<string>();
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  for (const tf of testFiles) {
    for (const f of cells) {
      // Two honest signals: the test names the cell ID as a STRING, or it
      // IMPORTS the module the cell is declared in.
      //
      // The bare `content.includes(f.name)` this used to end with was a
      // SUBSTRING test: a cell called `app` or `view` matched the word inside
      // `src/app.ts`, `snapshot` or `viewer` in any test file that existed, so
      // it was permanently "tested" and the rule could never fire for it — a
      // rule that cannot fire is indistinguishable from a rule that found
      // nothing.
      const quoted = new RegExp(`['"\`]${escape(f.name)}['"\`]`);
      const importsIt = new RegExp(
        `from\\s*['"][^'"]*${escape(f.file.name)}['"]`,
      );
      if (quoted.test(tf.content) || importsIt.test(tf.content)) {
        testedCells.add(f.name);
      }
    }
  }

  // A cell defined under scripts/ or tools/ is a fixture (a benchmark's
  // workload), not a shipped surface waiting for a test file — and neither is
  // one defined inside a test, which would otherwise be told to go and write
  // itself a test file.
  const untestedCells = cells.filter((f) =>
    !testedCells.has(f.name) && !isToolingPath(f.file.relative) &&
    !isTestPath(f.file.relative)
  );
  if (untestedCells.length === 0) {
    pass(`all ${cells.length} cells have tests`);
  } else {
    for (const f of untestedCells) {
      report(
        "hint",
        "testing",
        `cell "${f.name}" has no test file — create ${f.name}.test.ts`,
        { file: f.file.relative },
      );
    }
  }

  // testCell usage
  const usesTestCell = testFiles.some((f) => f.content.includes("testCell"));
  if (testFiles.length > 0 && !usesTestCell) {
    report(
      "hint",
      "testing",
      "test files found but none use testCell() — it provides typed helpers and auto-cleanup",
    );
  }

  // Test task
  if (!denoJson?.tasks?.["test"]) {
    report(
      "hint",
      "testing",
      'no "test" task in deno.json — add "test": "deno test -A tests/"',
      { safeFix: fix.fixAddTestTask },
    );
  }

  if (testFiles.length > 0) pass(`${testFiles.length} test file(s)`);
};

// ══════════════════════════════════════════════════════════════════════
// 9. CODE PATTERNS
// ══════════════════════════════════════════════════════════════════════

/** Draft mutators — a method call that CHANGES the draft in place. A mutation
 *  is a write: it always lands, so it is never the post-await hazard. */
const DRAFT_MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "add",
  "delete",
  "clear",
]);

/** An assignment operator at this offset — plain, compound, or increment.
 *  `=(?!=)` keeps `==`/`===`/`!==` out; `>=`/`<=` never match because `>`/`<`
 *  alone is not in the compound set. */
const ASSIGN_AT =
  /^(?:\+\+|--|(?:\*\*|>>>|>>|<<|&&|\|\||\?\?|[+\-*/%&|^])?=(?!=))/;

/** Skip whitespace — and the comment husks `codeText` leaves behind (`//`,
 *  the delimiters survive masking; only their bodies are blanked). Pure. */
function skipTrivia(code: string, i: number): number {
  for (;;) {
    while (i < code.length && /\s/.test(code[i]!)) i++;
    if (code[i] === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    return i;
  }
}

/** Walk a member/index chain starting right after the draft param — `.x`,
 *  `[expr]`, `?.x` — and stop at the first thing that is not one. Reports
 *  whether the chain ends in a MUTATOR CALL (`s.items.push(`). Pure. */
function memberChain(
  code: string,
  from: number,
): { end: number; mutator: boolean } {
  let i = from;
  let lastName: string | null = null;
  for (;;) {
    const j = skipTrivia(code, i);
    if (code[j] === "?" && code[j + 1] === ".") {
      i = j + 2;
      continue;
    }
    if (code[j] === ".") {
      let k = j + 1;
      while (k < code.length && /[\w$]/.test(code[k]!)) k++;
      lastName = code.slice(j + 1, k);
      i = k;
      continue;
    }
    if (code[j] === "[") {
      let depth = 0, k = j;
      for (; k < code.length; k++) {
        if (code[k] === "[") depth++;
        else if (code[k] === "]" && --depth === 0) break;
      }
      lastName = null;
      i = Math.min(k + 1, code.length);
      continue;
    }
    if (code[j] === "(") {
      return {
        end: i,
        mutator: lastName !== null && DRAFT_MUTATORS.has(lastName),
      };
    }
    return { end: i, mutator: false };
  }
}

/** `++s.x` / `--s.x` / `delete s.x` — a write dressed as a prefix. Pure. */
function isPrefixWrite(code: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && /\s/.test(code[i]!)) i--;
  if (
    i >= 1 &&
    (code.slice(i - 1, i + 1) === "++" || code.slice(i - 1, i + 1) === "--")
  ) {
    // A postfix `a++` has an operand before it — `a++ +s.x` is not a prefix.
    let k = i - 2;
    while (k >= 0 && /\s/.test(code[k]!)) k--;
    if (k < 0 || !/[\w$)\]]/.test(code[k]!)) return true;
  }
  return /\bdelete\s*$/.test(code.slice(Math.max(0, start - 12), start));
}

/** Offsets of every genuine READ of `param.…` in `code`.
 *
 *  `code` must be code-masked (`codeText`), so a `s.x` written inside a comment
 *  or a string is not a read.
 *
 *  A WRITE IS NOT A READ. `s.lastError = "…"` is precisely what a method is
 *  SUPPOSED to do after its I/O — record the result — and flagging it made the
 *  hint unsilenceable without lying: there is no read there to declare
 *  deliberate with `// aiol-ok`, "which is how useful lints get ignored"
 *  (field report #4). The old test was line-level (`does this
 *  line contain any write?`), which failed BOTH ways: a `deno fmt`-wrapped
 *  `s.lastError =\n  String(err)` looked like a bare read (the report's line
 *  189), and `s.x = s.y + 1` hid a genuine read behind the write on its line.
 *  Classification is therefore per OCCURRENCE, and looks past the end of the
 *  line. Excluded (writes):
 *    • `s.x = v`, `s.x.y = v`, `s.x[i] = v` — assignment targets
 *    • `s.x += 1`, `s.x++`, `++s.x`, `s.x ??= v` — compound / increment targets
 *    • `s.items.push(v)` and friends — draft mutations; they always land
 *    • `delete s.x`
 *  Still reported (genuine post-await reads):
 *    • the RHS — `s.x = s.y + 1` reads `s.y`
 *    • the index — `s.items[s.idx] = v` reads `s.idx`
 *    • an argument — `s.items.push(s.n)` reads `s.n`
 *
 *  DELIBERATE CALL: a compound assignment (`s.x += 1`) counts as a WRITE, even
 *  though it does read the old value. The hazard this rule names is a value
 *  that crossed the await STALE and then drove a decision or was stored
 *  somewhere else. A compound assignment cannot be stale that way: it applies a
 *  delta to whatever the field holds at the instant it runs (a draft read
 *  overlays the method's own pending writes), so a concurrent commit in the gap
 *  makes it MORE current, not less — the same reason a relative update is the
 *  safe form under concurrency. It is also the framework's own documented shape
 *  (`async tick(s) { await …; s.n += 1 }`), and a hint that fires on the docs is
 *  a hint people stop reading. Pure. */
/** Character spans of `until(...)` / `race(...)` arguments on ONE line.
 *  The exemption is the CALL, not the line it sits on. */
export function pollSpans(line: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of line.matchAll(/\b(until|race)\s*\(/g)) {
    let depth = 0;
    for (let i = m.index! + m[0].length - 1; i < line.length; i++) {
      if (line[i] === "(") depth++;
      else if (line[i] === ")") {
        depth--;
        if (depth === 0) {
          out.push([m.index!, i]);
          break;
        }
      }
    }
  }
  return out;
}

/** True when EVERY read of `param` on this line falls inside a poll span — i.e.
 *  the line's only reads are the sanctioned re-reads. A read outside one is a
 *  genuine post-await read and must still be reported. */
function readOnlyInside(
  line: string,
  param: string,
  spans: Array<[number, number]>,
  minOffset: number,
): boolean {
  // Only reads that actually run post-suspension count: on the await line
  // itself, anything to the LEFT of the await already happened.
  const offsets = draftReadOffsets(line, param).filter((o) => o > minOffset);
  if (offsets.length === 0) return true; // nothing here to report
  return offsets.every((o) => spans.some(([a, b]) => o >= a && o <= b));
}

/** True when `param` has been RE-BOUND by a nested function between the method
 *  header and this line — a callback whose own parameter happens to share the
 *  draft's name. Its `s.x` is that callback's `s`, not the draft, and blaming
 *  the method for it is a false positive that teaches people to ignore the
 *  rule. Conservative: only an exact same-name parameter counts. */
function nestedShadowLine(
  codeLines: string[],
  startIdx: number,
  lineIdx: number,
  param: string,
): boolean {
  const re = new RegExp(
    `(?:function\\s*\\w*\\s*\\(|\\(|,)\\s*${param}\\s*(?:[,)])\\s*=>|` +
      `function\\s*\\w*\\s*\\(\\s*${param}\\s*[,)]`,
  );
  let depthAtShadow: number | null = null;
  let depth = 0;
  for (let i = startIdx; i <= lineIdx; i++) {
    const line = codeLines[i]!;
    if (i > startIdx && depthAtShadow === null && re.test(line)) {
      depthAtShadow = depth;
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        // Left the shadowing function: the draft's name means the draft again.
        if (depthAtShadow !== null && depth <= depthAtShadow) {
          depthAtShadow = null;
        }
      }
    }
  }
  return depthAtShadow !== null;
}

/** The draft's framework surface — everything else on a draft is app state.
 *  Named, not pattern-matched: see `draftReadOffsets`. */
export const DRAFT_META = ["$signal", "$live", "$commit", "$do"] as const;

export function draftReadOffsets(code: string, param: string): number[] {
  const out: number[] = [];
  // `(?<![\w$.])` — `other.s.count` is not a read of `s`.
  // Draft META is framework surface, not app state another action can move
  // under you — but the exemption is the KNOWN four, not "anything starting
  // with $". A blanket `(?!\$)` also excused `s.$myField`, and while a
  // $-prefixed state key is refused at `cell()` today, an exemption whose
  // breadth is accidental outlives the rule that made it safe.
  const startRe = new RegExp(`(?<![\\w$.])${param}\\.[\\w$]`, "g");
  for (const m of code.matchAll(startRe)) {
    const start = m.index!;
    if (DRAFT_META.some((meta) => code.startsWith(`${param}.${meta}`, start))) {
      continue; // `s.$signal` / `s.$live` / `s.$commit` / `s.$do`
    }
    const chain = memberChain(code, start + param.length);
    if (chain.mutator) continue;
    const after = skipTrivia(code, chain.end);
    if (ASSIGN_AT.test(code.slice(after, after + 5))) continue;
    if (isPrefixWrite(code, start)) continue;
    out.push(start);
  }
  return out;
}

/** 0-based line index for each ASCENDING offset — one pass, no slicing. Pure. */
function linesOfOffsets(code: string, offsets: number[]): number[] {
  const out: number[] = [];
  let line = 0, pos = 0;
  for (const off of offsets) {
    while (pos < off && pos < code.length) {
      if (code[pos] === "\n") line++;
      pos++;
    }
    out.push(line);
  }
  return out;
}

export const checkPatterns: Checker = (ctx) => {
  const { sourceFiles, report } = ctx;

  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts") || file.name.endsWith(".test.tsx")) {
      continue;
    }

    // any usage (outside lint-ignore comments). Exempt: (1) files that opt out
    // of deno linting at the file level — if `any` is intentional for deno it's
    // intentional for aiol too; (2) type-definition modules (*types.ts), where
    // `any` is generic plumbing (infer/variadic positions), not lazy typing.
    const fileLintIgnored = file.lines.some((l) =>
      l.trim().startsWith("// deno-lint-ignore-file")
    );
    const isTypeModule = file.name.endsWith("types.ts");
    // Code only — a doc string that says "avoid as any" is advice ABOUT `any`,
    // not a use of it, and four such lines were reported as four uses.
    // `codeText` keeps offsets and line breaks, so line numbers still line up
    // with the original file.
    const anyLines = (fileLintIgnored || isTypeModule) ? [] : codeText(
      file.content,
    ).split("\n")
      .map((l, i) => ({ line: l, num: i + 1, idx: i }))
      .filter(({ line, idx }) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
        if (trimmed.includes("deno-lint-ignore")) return false;
        // Honor deno's line-level ignore on the preceding line — that's its
        // real scope (the directive applies to the line below it).
        if ((file.lines[idx - 1] ?? "").includes("deno-lint-ignore")) {
          return false;
        }
        // Match: any, as any, <any> but not variable names containing "any"
        return /:\s*any\b|as\s+any\b|<any>/.test(line);
      });
    if (anyLines.length > 3) {
      report(
        "hint",
        "patterns",
        `${file.relative}: ${anyLines.length} uses of 'any' — prefer 'unknown' + type narrowing`,
        { file: file.relative, line: anyLines[0]!.num },
      );
    }

    // REMOVED: "throw in cell code — consider returning error state instead".
    //
    // It argued against the framework's own documented mechanism. Throwing to
    // REFUSE is the endorsed shape — `docs/state/methods.md` lists it first
    // ("the caller's `await` rejects with your message… usually what you want
    // for a guard"), `examples/contacts/cell.ts` demonstrates it three times,
    // and `resolveCall` exists to deliver that rejection to the caller. A
    // field report caught the contradiction: the linter told them not to do
    // the thing the docs and the example told them to do, and when a project's
    // own tools disagree, people stop reading both.
    //
    // The rule was also over-broad — it fired on any file containing
    // `cell("…")` at all, including framework and scaffold sources whose
    // throws are config validation.

    // State read after an await in an async method. Every await is a
    // commit + render point — another action may have committed while the
    // method was suspended, so a post-await read can return a value the code
    // above never saw. Deliberate re-reads are correct (reads overlay the
    // method's own pending writes), so this is a hint, once per method, on the
    // first post-await read. Writes and draft mutations (s.x = …, s.arr.push)
    // are exempt — they always land; `draftReadOffsets` above is the exact
    // read/write split and carries the reasoning.
    // A `transaction: true` cell reads a STABLE snapshot across
    // awaits — the post-await read is intended and safe — so skip the hint for
    // files that opt in. See docs/state/transactional-methods.md.
    //
    // This rule used to be almost exactly INVERTED in practice, which is worse
    // than not having it — a hint that fires on the documentation's own code
    // teaches people to stop reading hints, and the rest of this linter is
    // load-bearing. Three fixes, all here:
    //   1. `METHOD_RE` required the draft param to be followed by `,` or `)`,
    //      so a TYPE-ANNOTATED param (`async work(s: { n: number }, x)`) — what
    //      real TypeScript looks like — never matched and the whole method went
    //      unchecked. The one shape the rule exists for was the one it skipped.
    //   2. `s.$signal.aborted` is THE documented cancellation check
    //      (`cancelOn` + `$signal`), and it is the single most common
    //      post-await read there is. Draft META (`$signal`/`$live`/`$commit`)
    //      is framework surface, not app state — "another action may have
    //      committed" simply does not apply to it.
    //   3. `until(() => s.x)` / `race({...})` are the SANCTIONED way to wait on
    //      live state inside a method; re-reading is the entire point of the
    //      primitive. `mod.ts`'s own flagship example tripped this.
    //   4. (a chat-app report #4) A plain WRITE was reported as a read — see
    //      `draftReadOffsets`.
    //   5. The opt-in probe read RAW content, so a cell that merely MENTIONS
    //      `transaction: true` in a comment — the comment explaining why it
    //      declined the option is the common shape — disabled the rule for the
    //      whole file. Masked, like every other body probe in this file.
    const isTransactional = /\btransaction\s*:\s*(?:true|\{)/.test(
      codeText(file.content),
    );
    if (!isTransactional && /\bcell\s*\(\s*['"]/.test(file.content)) {
      // Code-masked source: comment and string bodies are blanked (offsets and
      // newlines preserved), so a method "declared" in a doc comment is not a
      // method, `s.x` in a string is not a read, and a `{` inside either no
      // longer moves the body-depth counter.
      const codeSrc = codeText(file.content);
      const codeLines = codeSrc.split("\n");
      // One read-scan per draft param name, shared by every method that uses it.
      const readLinesByParam = new Map<string, Set<number>>();
      const readLinesFor = (param: string): Set<number> => {
        const hit = readLinesByParam.get(param);
        if (hit) return hit;
        const lines = new Set(
          linesOfOffsets(codeSrc, draftReadOffsets(codeSrc, param)),
        );
        readLinesByParam.set(param, lines);
        return lines;
      };
      const METHOD_RE =
        // `[,):]` — the `:` admits a type-annotated draft param.
        /\basync\s+(?!function\b)([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,):]|\b([A-Za-z_$][\w$]*)\s*:\s*async\s*\(\s*([A-Za-z_$][\w$]*)\s*[,):]/g;
      for (const m of codeSrc.matchAll(METHOD_RE)) {
        const method = m[1] ?? m[3]!;
        const param = m[2] ?? m[4]!;
        const startIdx = codeSrc.slice(0, m.index).split("\n").length - 1;
        const readLines = readLinesFor(param);
        let depth = 0;
        let entered = false;
        let sawAwait = false;
        for (let i = startIdx; i < codeLines.length; i++) {
          const code = codeLines[i]!;
          for (const ch of code) {
            if (ch === "{") {
              depth++;
              entered = true;
            } else if (ch === "}") depth--;
          }
          if (entered && depth <= 0) break; // method body ended
          // Reads BEFORE the first await happen pre-suspension. That used to
          // excuse the whole line, which is right for `const x = await f(s.a)`
          // and wrong for `await until(...); s.out = s.value;` — everything
          // after the semicolon runs post-suspension like any other line.
          let minOffset = 0;
          if (!sawAwait) {
            const at = code.search(/\bawait\b/);
            if (at < 0) continue;
            sawAwait = true;
            minOffset = at;
          }
          // A live-poll primitive re-reads state ON PURPOSE — that is what it
          // is for. But the exemption belongs to the CALL, not the line: on
          // `await until(() => s.ready); const v = s.value;` skipping the whole
          // line also excused the genuine read that follows it.
          const spans = pollSpans(code);
          const nested = nestedShadowLine(codeLines, startIdx, i, param);
          if (
            readLines.has(i) && !isSuppressed(file.lines, i) &&
            !readOnlyInside(code, param, spans, minOffset) && !nested
          ) {
            report(
              "hint",
              "patterns",
              `${file.relative}:${
                i + 1
              } — "${method}" reads ${param}.* after an await — every await is a commit point and other actions may have run while suspended; re-read deliberately or gather-then-write (docs/state/methods.md); suppress a deliberate read with \`// aiol-ok\` on this line or the comment line above`,
              { file: file.relative, line: i + 1 },
            );
            break; // once per method
          }
        }
      }
    }

    // Old dep/aio import paths. Anchored to a real import/export STATEMENT —
    // a lint rule (or a doc line) that merely mentions the old path inside a
    // string is not importing from it.
    if (
      /(?:^|\n)\s*(?:import|export)\b[^\n]*from\s*['"]\.\.\/dep\/aio\//.test(
        file.content,
      )
    ) {
      report(
        "warn",
        "patterns",
        `${file.relative}: legacy import path "../dep/aio/..." — use "aio" instead`,
        { file: file.relative, fix: "import { ... } from 'aio'" },
      );
    }

    // Node.js APIs
    const nodeApis = [
      "require(",
      "process.env",
      "module.exports",
      "__dirname",
      "__filename",
    ];
    // Same rule: `"process.env"` inside a string or a comment is a mention, not
    // a use — only real code counts.
    const codeOnly = codeText(file.content);
    for (const api of nodeApis) {
      if (
        codeOnly.includes(api) && !file.content.includes("// node") &&
        !file.name.includes("electron")
      ) {
        const lineIdx = file.lines.findIndex((l) => l.includes(api));
        report(
          "hint",
          "patterns",
          `${file.relative}:${
            lineIdx + 1
          } — Node.js API "${api}" — use Deno equivalents`,
          { file: file.relative, line: lineIdx + 1 },
        );
      }
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 10. BUILD READINESS
// ══════════════════════════════════════════════════════════════════════

export const checkBuild: Checker = async (ctx) => {
  const { projectDir, denoJson, report, pass } = ctx;
  const tasks = denoJson?.tasks ?? {};

  // Check esbuild installed
  const esbuildPaths = [
    join(projectDir, "node_modules", "esbuild"),
    join(projectDir, "node_modules", ".bin", "esbuild"),
  ];
  let esbuildFound = false;
  for (const p of esbuildPaths) {
    try {
      await Deno.stat(p);
      esbuildFound = true;
      break;
    } catch { /* not found */ }
  }
  if (
    !esbuildFound &&
    Object.keys(tasks).some((k) => k.startsWith("compile:") || k === "dev")
  ) {
    report(
      "warn",
      "build",
      "esbuild not installed — required for dev mode and compilation",
      { fix: "Run: deno install" },
    );
  }

  // Electron installed
  if (tasks["compile:electron"] || tasks["dev"]?.includes("electron")) {
    try {
      await Deno.stat(join(projectDir, "node_modules", "electron", "dist"));
      pass("Electron installed");
    } catch {
      try {
        await Deno.stat(join(projectDir, "node_modules", "electron"));
        // The binary half of the package is fetched by its postinstall
        // script, which plain `deno install` skips. Name the command that
        // actually runs it — the previously-advised `install:electron` task
        // does not exist in generated apps (Electron auto-installs on the
        // first `dev`/`compile:electron` run).
        report(
          "warn",
          "build",
          "Electron package exists but its binary (node_modules/electron/dist) is missing — " +
            "run: deno task install:electron " +
            "(or just `deno task dev --client=electron` / `deno task build " +
            "--targets=electron` — they auto-install)",
        );
      } catch {
        report(
          "hint",
          "build",
          "Electron not installed — it auto-installs on the first " +
            "`deno task dev --client=electron` or `deno task build " +
            "--targets=electron` run (if you need desktop builds)",
        );
      }
    }
  }

  // compile:android without android template
  if (tasks["compile:android"]) {
    pass("Android target configured");
  }

  // The `build: {}` block was the one aio config object with no typo gate.
  // `aio.run({...})` exits on an unknown key and `cell({...})` refuses one with
  // a did-you-mean; `build: { target: [...] }` (singular) silently built the
  // default target set, which reads as `--targets` being broken.
  const strayBuild = unknownBuildKeys(denoJson?.build);
  if (strayBuild.length > 0) {
    report(
      "error",
      "build",
      `deno.json build block has ${
        strayBuild.length === 1 ? "an unknown key" : "unknown keys"
      }: ${strayBuild.join(", ")} — aio never reads ${
        strayBuild.length === 1 ? "it" : "them"
      }, so ${strayBuild.length === 1 ? "it does" : "they do"} nothing`,
      {
        fix: `valid build keys: ${[...VALID_BUILD_KEYS].join(", ")}; ` +
          `inside an object-form target: ${
            [...VALID_BUILD_TARGET_KEYS].join(", ")
          }`,
      },
    );
  } else if (denoJson?.build) {
    pass("build block keys");
  }
};

// ══════════════════════════════════════════════════════════════════════
// 11. INTER-FEATURE PATTERNS
// ══════════════════════════════════════════════════════════════════════

export const checkInterCell: Checker = (ctx) => {
  const { cells, sourceFiles, report } = ctx;

  if (cells.length < 2) return;

  // Detect cross-cell direct state access (anti-pattern)
  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts")) continue;
    for (const f of cells) {
      // Check if file (that defines a DIFFERENT cell) directly accesses another cell's state
      const definesCell = cells.find((feat) => feat.file.path === file.path);
      if (!definesCell || definesCell.name === f.name) continue;
      // Look for patterns like: otherCell.state or getState().otherCell
      if (
        file.content.includes(`getState().${f.name}`) ||
        file.content.includes(`state.${f.name}`)
      ) {
        report(
          "hint",
          "inter-cell",
          `${file.relative}: accesses "${f.name}" state directly — use selectors for loose coupling`,
          { file: file.relative },
        );
      }
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 12. SCHEDULING
// ══════════════════════════════════════════════════════════════════════

export const checkScheduling: Checker = (ctx) => {
  const { sourceFiles, appEntry, report, pass } = ctx;

  const usesSchedule = sourceFiles.some((f) =>
    f.content.includes("schedule.") && !f.name.endsWith(".test.ts")
  );
  const hasScheduleConfig = appEntry?.content.includes("schedules") ?? false;

  if (usesSchedule || hasScheduleConfig) {
    pass("scheduling configured");
  }

  // Check for schedule IDs with spaces or special chars. Code only — an id
  // quoted in a `// example: schedule.every("my job!", fn)` comment is
  // documentation, and it was reported as an ERROR (which fails the gate).
  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts")) continue;
    for (
      const m of codeMatches(
        file.content,
        /schedule\.\w+\(\s*['"]([^'"]+)['"]/g,
      )
    ) {
      const id = m[1]!;
      if (!/^[\w\-:.]+$/.test(id)) {
        const lineIdx = file.content.slice(0, m.index).split("\n").length;
        report(
          "error",
          "scheduling",
          `${file.relative}:${lineIdx} — schedule ID "${id}" has invalid chars — use alphanumeric, hyphens, colons, dots`,
          { file: file.relative, line: lineIdx },
        );
      }
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 13. MEMO & STRUCTURAL SHARING (AIO-11)
// ══════════════════════════════════════════════════════════════════════

export const checkMemoUsage: Checker = (ctx) => {
  const { tsxFiles, report } = ctx;

  for (const file of tsxFiles) {
    // Rule 1: React.memo import → suggest aio memo
    if (
      /import\s*\{[^}]*\bmemo\b[^}]*\}\s*from\s*['"]react['"]/.test(
        file.content,
      ) ||
      /import\s+.*\bmemo\b.*\s+from\s*['"]react['"]/.test(file.content)
    ) {
      const lineIdx = file.lines.findIndex((l) =>
        /from\s*['"]react['"]/.test(l) && /\bmemo\b/.test(l)
      );
      report(
        "warn",
        "perf",
        `${file.relative}:${
          lineIdx + 1
        } — import { memo } from "react" uses shallow === comparison — import from "aio" instead (uses structural comparison, prevents wasted renders)`,
        {
          file: file.relative,
          line: lineIdx + 1,
          fix: 'Change to: import { memo } from "aio"',
        },
      );
    }

    // Rule 2: .map() rendering memo components without useProjection.
    //
    // The test is an actual `memo(` CALL in code. It used to fall back to
    // `/\bmemo\b/` — the bare WORD anywhere in the file — so a component that
    // maps over a list and merely mentions memo in a comment ("deliberately
    // not memo-ised") was told to wrap transforms it doesn't have. The
    // fallback also made the real pattern unreachable as a distinct signal:
    // any file matching it already matched the word.
    const code = codeText(file.content);
    const hasMap = /\.map\s*\(/.test(code);
    const hasMemo = /\bmemo\s*\(/.test(code);
    const hasUseProjection = code.includes("useProjection");

    if (hasMap && hasMemo && !hasUseProjection) {
      report(
        "hint",
        "perf",
        `${file.relative}: renders memo() components via .map() without useProjection() — derived arrays create new refs every render, defeating memo. Wrap transforms in useProjection()`,
        {
          file: file.relative,
          fix:
            "const projected = useProjection(() => transform(items), [items])",
        },
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// ALL CHECKS
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// 14. DUPLICATE IMPORTS
// ══════════════════════════════════════════════════════════════════════

/** Local binding names introduced by one import clause (the text between
 *  `import` and `from`): default, `* as NS`, and `{ named as alias }`. Aliases
 *  bind the alias; `type` qualifiers are stripped. */
function importedBindings(clause: string): string[] {
  const names: string[] = [];
  // `import type { … }` / `import type Foo` — drop the leading type qualifier so
  // the bare `type` keyword isn't mistaken for a default binding.
  const c = clause.trim().replace(/^type\s+/, "");
  const braced = c.match(/\{([\s\S]*?)\}/);
  const outside = braced ? c.replace(braced[0], "") : c;
  for (const part of outside.split(",")) {
    const s = part.trim().replace(/^type\s+/, "");
    if (!s || s === "type") continue;
    const ns = s.match(/^\*\s+as\s+([$\w]+)$/);
    if (ns) names.push(ns[1]!);
    else if (/^[$\w]+$/.test(s)) names.push(s); // default binding
  }
  if (braced) {
    for (const spec of braced[1]!.split(",")) {
      const s = spec.trim().replace(/^type\s+/, "");
      if (!s) continue;
      const as = s.match(/\bas\s+([$\w]+)$/);
      names.push(as ? as[1]! : s);
    }
  }
  return names;
}

/** The contiguous import header — the run of import statements (and comments)
 *  at the top of a module, up to the first real code line. Restricting to this
 *  makes the scan immune to `import … from` text buried in template literals of
 *  code-GENERATING files (am scaffolds, the bundler entry, testgen). */
function importHeader(content: string): string {
  const out: string[] = [];
  let inBlock = false, openImport = false;
  const hasSpecifier = (t: string) => /['"][^'"]+['"]\s*;?\s*$/.test(t);
  for (const raw of content.split("\n")) {
    let line = raw;
    if (inBlock) {
      const e = line.indexOf("*/");
      if (e === -1) continue;
      line = line.slice(e + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*[\s\S]*?\*\//g, "");
    const o = line.indexOf("/*");
    if (o !== -1) {
      inBlock = true;
      line = line.slice(0, o);
    }
    line = line.replace(/\/\/.*$/, "");
    const t = line.trim();
    if (t === "") {
      out.push("");
      continue;
    }
    if (openImport) {
      out.push(line);
      if (hasSpecifier(t)) openImport = false;
      continue;
    }
    if (/^import\b/.test(t) && !/^import\s*\(/.test(t)) {
      out.push(line);
      openImport = !hasSpecifier(t); // multi-line import still open
      continue;
    }
    break; // first real code line → header ends
  }
  return out.join("\n");
}

/** Every public `aio/*` entry point an app may import — derived from THE list
 *  (`src/entries.ts`), never restated. A hand-kept copy here is how `aio/build`
 *  (real, published, documented as importable) came to be reported as "not an
 *  aio entry point": the linter's belief about the surface drifted from the
 *  surface. Bare `aio` is dropped — the scan only ever matches `aio/…`. */
const AIO_ENTRIES: Record<string, string> = Object.fromEntries(
  Object.entries(AIO_LIBRARY_ENTRIES).filter(([spec]) => spec !== "aio"),
);

export const checkImports: Checker = (ctx) => {
  const { sourceFiles, denoJson, report } = ctx;

  // An `aio/x` import with no mapping in deno.json — the app followed the docs
  // and the specifier simply doesn't resolve.
  const map = denoJson?.imports ?? {};
  const base = map["aio"];
  const missing = new Map<string, { file: string; line: number }>();
  const unknown = new Map<string, { file: string; line: number }>();
  for (const file of sourceFiles) {
    for (
      const m of codeMatches(file.content, /from\s*['"](aio\/[\w./-]+)['"]/g)
    ) {
      const spec = m[1]!;
      if (map[spec]) continue; // the app mapped it — its call, its meaning
      // Every `aio/*` specifier is decided HERE (checkUI defers to this rule),
      // so an entry that does not exist has to be named here too — otherwise
      // a typo'd `aio/dbb` would be the one import nothing reports.
      if (!AIO_ENTRIES[spec]) {
        if (!unknown.has(spec)) {
          unknown.set(spec, {
            file: file.relative,
            line: file.content.slice(0, m.index).split("\n").length,
          });
        }
        continue;
      }
      if (missing.has(spec)) continue;
      missing.set(spec, {
        file: file.relative,
        line: file.content.slice(0, m.index).split("\n").length,
      });
    }
  }
  for (const [spec, where] of missing) {
    report(
      "error",
      "imports",
      `${where.file}:${where.line} — "${spec}" is imported but not mapped in ` +
        `deno.json, so it cannot resolve. Add it to "imports".`,
      {
        file: where.file,
        line: where.line,
        fix: `"${spec}": "<same base as \"aio\">/${AIO_ENTRIES[spec]}"`,
        ...(base
          ? { safeFix: fix.fixAddAioEntry(spec, base, AIO_ENTRIES[spec]!) }
          : {}),
      },
    );
  }
  for (const [spec, where] of unknown) {
    report(
      "error",
      "imports",
      `${where.file}:${where.line} — "${spec}" is not an aio entry point and ` +
        `is not in deno.json "imports", so it cannot resolve. Entries: ${
          Object.keys(AIO_ENTRIES).join(", ")
        }`,
      { file: where.file, line: where.line },
    );
  }

  for (const file of sourceFiles) {
    const code = importHeader(file.content);
    const seen = new Map<string, number>(); // binding → first line it appeared
    for (
      const m of code.matchAll(
        /\bimport\s+([\s\S]*?)\s+from\s*['"][^'"]+['"]/g,
      )
    ) {
      const line = code.slice(0, m.index).split("\n").length;
      for (const name of importedBindings(m[1]!)) {
        const first = seen.get(name);
        if (first === undefined) {
          seen.set(name, line);
        } else {
          // A second binding of the same name is a hard redeclaration —
          // `deno check` can miss it across separate import statements, but it's
          // a runtime SyntaxError when the module loads.
          report(
            "error",
            "imports",
            `${file.relative}:${line} — "${name}" is imported again (first at ` +
              `line ${first}); duplicate import bindings are a SyntaxError at ` +
              `module load. Remove or rename one.`,
            { file: file.relative, line },
          );
        }
      }
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 16. UPGRADE — deprecated aliases still in use
// ══════════════════════════════════════════════════════════════════════
//
// aio never removes a renamed option inside a major (semver-policy.md), so
// nothing here is broken — but every one of these is a mechanical rewrite, and
// an app carrying old spellings drifts further from the docs with each release.
// `am fix` deliberately points code-level upgrades here; `--safe-fix` applies
// them.

export const checkUpgrade: Checker = (ctx) => {
  const { denoJson, tsFiles, tsxFiles, appEntry, report, pass } = ctx;
  let found = 0;

  // call({ timeout }) → call({ timeoutMs }) — the alias still works.
  //
  // The option is the call's OWN top-level key. `\{[^}]*\}` stopped at the
  // first `}`, which for `call({ retry: { timeout: 30 } })` is the inner one,
  // so a field of the caller's own data was reported as a deprecated option —
  // and --safe-fix rewrote it to `timeoutMs`, silently changing what that
  // object means. `topLevelKeyOffsets` is the shared decider (scan.ts): the
  // rule and the fix ask the same question and cannot disagree.
  for (const file of [...tsFiles, ...tsxFiles]) {
    const offsets = fix.callTimeoutSites(file.content);
    if (offsets.length === 0) continue;
    found++;
    report(
      "error",
      "upgrade",
      `${file.relative}: \`call({ timeout })\` was REMOVED in alpha52 — ` +
        `call() now throws on the old key; use \`timeoutMs\``,
      {
        file: file.relative,
        line: file.content.slice(0, offsets[0]).split("\n").length,
        fix: "call({ timeoutMs: 5000 }, () => other.method())",
        safeFix: fix.fixCallTimeoutMs(file.path),
      },
    );
  }

  // Server-only symbols moved to the `aio/server` entry (alpha37). A static
  // import of one from `"aio"` in a cell-shared file was the classic
  // blank-screen: it link-fails only when a real browser links the graph.
  // Derived from THE set (src/entries.ts) — never restated.
  const SERVER_ONLY = new RegExp(
    `\\b(${[...SERVER_ONLY_AIO_SYMBOLS].join("|")})\\b`,
  );
  for (const file of [...tsFiles, ...tsxFiles]) {
    // `codeMatches`, not `codeText`: codeText blanks string bodies and the
    // module specifier IS a string, so masking that way makes the rule unable
    // to match its own violation. Filtering by where the match STARTS keeps the
    // specifier readable while rejecting one that begins inside a comment or a
    // template literal — an `import { createDB } from "aio"` in a scaffolder's
    // template is a line of the GENERATED app, and --safe-fix was rewriting it.
    const code = file.content;
    const [m] = codeMatches(
      code,
      /(?:^|\n)\s*import\s*\{([^}]*)\}\s*from\s*["']aio["']/g,
    );
    if (!m || !SERVER_ONLY.test(m[1]!)) continue;
    found++;
    report(
      "warn",
      "upgrade",
      `${file.relative}: server-only symbols moved to the \`aio/server\` entry ` +
        `(alpha37) — importing them from "aio" no longer resolves`,
      {
        file: file.relative,
        line: code.slice(0, m.index).split("\n").length,
        fix: 'import { createDB } from "aio/server"',
        safeFix: fix.fixServerEntryImport(file.path),
      },
    );
  }

  // The DYNAMIC variant of the same migration: the lazy
  // server-only pattern the docs themselves recommend —
  //   const { createDB } = await import("aio")
  // — is invisible to the static rule above and fails only at runtime, as
  // "createDB is not a function". Same symbols, same fix, dynamic spelling.
  const DYN =
    /(?:\{([^}]*)\}\s*=\s*await\s+import\(\s*["']aio["']\s*\))|(?:\(\s*await\s+import\(\s*["']aio["']\s*\)\s*\)\s*\.\s*(\w+))/g;
  for (const file of [...tsFiles, ...tsxFiles]) {
    // Masked the same way, and for the same reason: the raw scan reported
    // `await import("aio")` written inside a code-generator's template literal
    // and let --safe-fix edit it.
    const code = file.content;
    for (const dm of codeMatches(code, DYN)) {
      const names = dm[1] ?? dm[2] ?? "";
      if (!SERVER_ONLY.test(names)) continue;
      found++;
      report(
        "warn",
        "upgrade",
        `${file.relative}: dynamic \`import("aio")\` destructures a ` +
          `server-only symbol — those moved to the \`aio/server\` entry ` +
          `(alpha37), so this resolves to undefined at RUNTIME ` +
          `("createDB is not a function")`,
        {
          file: file.relative,
          line: code.slice(0, dm.index).split("\n").length,
          fix: 'const { createDB } = await import("aio/server")',
          safeFix: fix.fixDynamicServerEntryImport(file.path),
        },
      );
      break; // one report per file; the safe-fix rewrites every occurrence
    }
  }

  // deno.json tasks: renamed TLS flags, and a build-only flag on a run task.
  const entry = appEntry?.relative ?? null;
  for (const [name, cmd] of Object.entries(denoJson?.tasks ?? {})) {
    if (typeof cmd !== "string") continue;
    if (/(?<![\w-])--(cert|key)=/.test(cmd)) {
      found++;
      report(
        "warn",
        "upgrade",
        `deno.json task "${name}": \`--cert\`/\`--key\` were renamed to ` +
          `\`--tls-cert\`/\`--tls-key\` (the bare names collided with the auth \`key\` config)`,
        {
          file: "deno.json",
          fix: "--tls-cert=/path/cert.pem --tls-key=/path/key.pem",
          safeFix: fix.fixTaskFlags(entry),
        },
      );
    }
    if (
      entry && cmd.includes(entry) && /(?<![\w-])--headless(?![\w=-])/.test(cmd)
    ) {
      found++;
      report(
        "warn",
        "upgrade",
        `deno.json task "${name}": \`--headless\` is a BUILD flag — at runtime it ` +
          `is ignored (with a warning) and the app still starts a client. Use ` +
          `\`--client=server-only\``,
        {
          file: "deno.json",
          fix: "--client=server-only",
          safeFix: fix.fixTaskFlags(entry),
        },
      );
    }
  }

  if (found === 0) pass("no deprecated aio spellings in use");
};

// ══════════════════════════════════════════════════════════════════════
// 17. CALLER-SIDE POST-AWAIT READS
// ══════════════════════════════════════════════════════════════════════
//
// `await cart.checkout(); const id = cart.orderId;` reads the LOCAL replica
// right after the call resolved. On the server that read is fine; from a
// browser client the patch may not have landed yet, so it returns the previous
// value — the class of bug that gets "fixed" with a setTimeout. The method's
// return value is the answer: it crosses the bridge (alpha34), so use it.

export const checkPostAwaitRead: Checker = (ctx) => {
  const { tsFiles, tsxFiles, cells, report } = ctx;
  const cellNames = new Set(cells.map((c) => c.name));
  if (cellNames.size === 0) return;
  // `await <cell>.<method>(` … then `<cell>.<field>` within a few lines.
  const callRe = /\bawait\s+(\w+)\s*\.\s*(\w+)\s*\(/g;
  for (const file of [...tsFiles, ...tsxFiles]) {
    if (file.name.endsWith(".test.ts") || file.name.endsWith(".test.tsx")) {
      continue;
    }
    const code = codeText(file.content);
    for (const m of code.matchAll(callRe)) {
      const cellVar = m[1]!;
      if (!cellNames.has(cellVar)) continue;
      const line = code.slice(0, m.index).split("\n").length;
      // Look at the next few lines only — same logical step.
      const after = code.split("\n").slice(line, line + 4).join("\n");
      // `\b` before the lookahead is load-bearing: without it `\w+` simply
      // backtracks one character, so `counter.increment(2)` matched as a read
      // of `counter.incremen` — a following method CALL reported as a stale
      // field read, naming an identifier that does not exist.
      const read = new RegExp(`\\b${cellVar}\\s*\\.\\s*(\\w+)\\b(?!\\s*\\()`)
        .exec(after);
      if (!read) continue;
      report(
        "hint",
        "patterns",
        `${file.relative}:${line} — reads \`${cellVar}.${
          read[1]
        }\` right after ` +
          `\`await ${cellVar}.${
            m[2]
          }()\`. On a browser client the patch may not ` +
          `have arrived yet, so this can read the PREVIOUS value. Use the ` +
          `method's return value (it crosses the bridge), or re-read after the ` +
          `next render.`,
        { file: file.relative, line },
      );
      break; // one hint per file — the pattern repeats
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 17b. A CELL CALLING ITS OWN METHOD FROM INSIDE A METHOD
// ══════════════════════════════════════════════════════════════════════
//
// `job.foo()` from inside `job.bar()` runs as its OWN transaction against
// COMMITTED state, so it cannot see the write `bar` is halfway through making.
// The behaviour is correct and documented — and invisible at the call site,
// which is the definition of a trap. A field report lost real debugging time to
// it (choosing a file left the estimate empty), and their CLAUDE.md now carries
// a standing warning plus a convention of plain helper functions. A standing
// warning in a project doc is a lint rule that was never written.
//
// Conservative by construction, because a false positive here would push people
// to distrust the linter:
//   • only inside the `cell(...)` literal that DECLARES the method,
//   • only a call to one of THAT cell's own methods,
//   • never inside `$do(...)` — an effect runs after the commit, where calling
//     your own method is the documented, correct thing to do.

/** The span of the `cell(` call declared at `declLine` (1-based), as
 *  [start, end] offsets into `code`, or null when it cannot be located.
 *
 *  Located by LINE, not by matching the cell's name: `codeText` blanks string
 *  contents (that is the point of it), so `cell("job"` reads as `cell("   "`
 *  and a name-matching regex finds nothing. `CellInfo.line` already knows
 *  where the declaration is. */
function cellLiteralSpan(
  code: string,
  declLine: number,
): [number, number] | null {
  const lines = code.split("\n");
  if (declLine < 1 || declLine > lines.length) return null;
  const lineStart = lines.slice(0, declLine - 1).reduce(
    (n, l) => n + l.length + 1,
    0,
  );
  const call = /\bcell\s*\(/.exec(code.slice(lineStart));
  if (!call) return null;
  const open = code.indexOf("(", lineStart + call.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return [open, i];
    }
  }
  return null;
}

/** Offsets covered by `$do(` … `)` — effect bodies, where a self-call is fine. */
function doSpans(code: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of code.matchAll(/\$do\s*\(/g)) {
    const open = code.indexOf("(", m.index);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") {
        depth--;
        if (depth === 0) {
          out.push([open, i]);
          break;
        }
      }
    }
  }
  return out;
}

/** Does the enclosing method write to its draft BEFORE offset `at`?
 *
 *  The window starts at the nearest method header — every cell method takes the
 *  draft as its first parameter (`name(s, …)` / `async name(_s, …)`), which is
 *  a reliable anchor without parsing. A write is an assignment, a compound
 *  assignment, an increment, or a mutating call on a draft field
 *  (`s.list.push(...)`). */
function writesDraftBefore(code: string, at: number): boolean {
  // The window starts at the INNERMOST enclosing function, whatever its
  // parameter list. Anchoring only on `(s` headers meant a method that takes
  // NO draft (`addTwice() { … }`) walked past its own header and inherited the
  // PREVIOUS method's body — so `s.items.push(t)` in the method above counted
  // as "this method already wrote", and the queued-calls case below could
  // never be reached.
  const start = enclosingMethodStart(code, at);
  if (start < 0) return false;
  const body = code.slice(start, at);
  return /\bs\s*\.\s*[\w$]+\s*(?:=[^=]|\+=|-=|\*=|\/=|\?\?=|\|\|=|&&=|\+\+|--|\.\s*(?:push|pop|shift|unshift|splice|sort|reverse|set|delete|add|clear)\s*\()/
    .test(body) || /Object\s*\.\s*assign\s*\(\s*s\b/.test(body);
}

/** Offset just after the header of the innermost function enclosing `at`
 *  (`name(…) {`, `async name(…) {`), or -1. Used to group self-calls by the
 *  method they are written in. Deliberately matches any parameter list — the
 *  method that queues two calls is often the one that takes NO draft at all. */
function enclosingMethodStart(code: string, at: number): number {
  const before = code.slice(0, at);
  const header =
    /(?:^|[\n{,;)])[ \t]*(?:async\s+)?(?:\*\s*)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g;
  let start = -1;
  for (const m of before.matchAll(header)) start = m.index + m[0].length;
  return start;
}

export const checkSelfMethodCall: Checker = (ctx) => {
  const { cells, report } = ctx;
  for (const c of cells) {
    if (c.file.name.endsWith(".test.ts") || c.methodNames.length === 0) {
      continue;
    }
    const code = codeText(c.file.content);
    // The binding the cell was assigned to — that is what a self-call is
    // written through, and a cell nobody named cannot be self-called at all.
    const bind = /\b(?:const|let|var)\s+(\w+)\s*=\s*cell\s*\(/.exec(
      code.split("\n")[c.line - 1] ?? "",
    );
    if (!bind) continue;
    const varName = bind[1]!;
    const span = cellLiteralSpan(code, c.line);
    if (!span) continue;
    const skip = doSpans(code);

    // `(?<![.\w$])` is load-bearing: without it `s.contacts.push(...)` — a
    // STATE FIELD that happens to share the cell's name — reads as a call on
    // the cell binding. It flagged three lines of `examples/contacts`, which is
    // exactly the kind of false positive that teaches people to ignore a rule.
    const call = new RegExp(
      `(?<![.\\w$])${varName}\\s*\\.\\s*(${c.methodNames.join("|")})\\s*\\(`,
      "g",
    );
    // Candidate self-calls inside the cell literal, grouped by the method they
    // are written in — two in ONE method is its own trap (see below).
    const hits: Array<{ at: number; method: string; owner: number }> = [];
    for (const m of code.matchAll(call)) {
      const at = m.index;
      if (at < span[0] || at > span[1]) continue; // outside the cell literal
      if (skip.some(([s, e]) => at > s && at < e)) continue; // inside $do()
      hits.push({ at, method: m[1]!, owner: enclosingMethodStart(code, at) });
    }
    const perMethod = new Map<number, number>();
    for (const h of hits) {
      perMethod.set(h.owner, (perMethod.get(h.owner) ?? 0) + 1);
    }

    for (const { at, method, owner } of hits) {
      // TWO self-calls in one method body: the SECOND one is the trap even
      // when the caller never touched its own draft. Calls are queued, so the
      // second runs against state committed before the first — `addTwice() {
      // notes.add(); notes.add() }` returns `{"ok":true}` and adds one item,
      // with zero diagnostics. `writesDraftBefore` cannot see this: there is
      // no draft write to see.
      const queued = (perMethod.get(owner) ?? 0) > 1 && owner >= 0;
      // …otherwise only when the caller has ALREADY WRITTEN to its draft. That
      // is the other half of the trap: the nested call runs against committed
      // state and cannot see that write. With no prior write and only ONE call
      // there is nothing to miss — `examples/disk`'s `up()` awaiting
      // `disk.open(parent)` is a deliberate supersession, and flagging it would
      // be flagging the documented answer.
      if (!queued && !writesDraftBefore(code, at)) continue;
      const line = code.slice(0, at).split("\n").length;
      if (isSuppressed(c.file.lines, line - 1)) continue;
      if (queued && !writesDraftBefore(code, at)) {
        report(
          "warn",
          "patterns",
          `${c.file.relative}:${line} — \`${varName}.${method}()\` is one of ` +
            `${perMethod.get(owner)} calls to ${c.name}'s OWN methods in a ` +
            `single method. Each one is queued and runs as its own ` +
            `transaction against COMMITTED state, so the second sees the ` +
            `state from before the first — the method returns ` +
            `\`{"ok":true}\` having done a fraction of what it reads like. ` +
            `Do the work once in a plain function the method calls directly ` +
            `(\`apply${
              method.charAt(0).toUpperCase() + method.slice(1)
            }(s, …)\`), taking the draft \`s\` — or dispatch each call from ` +
            `an effect (\`s.$do(...)\`), which runs after the commit.`,
          { file: c.file.relative, line, manual: "extract a plain helper" },
        );
        continue;
      }
      report(
        "warn",
        "patterns",
        `${c.file.relative}:${line} — \`${varName}.${method}()\` is called from inside ` +
          `${c.name}'s own method. A nested same-cell call runs as its OWN ` +
          `transaction against COMMITTED state, so it cannot see the write ` +
          `this method is halfway through making — the value it reads is the ` +
          `one from before. Extract the shared work into a plain function ` +
          `both methods call (\`apply${
            method.charAt(0).toUpperCase() + method.slice(1)
          }(s, …)\`), or dispatch it from an effect (\`s.$do(...)\`), which ` +
          `runs after the commit.`,
        { file: c.file.relative, line, manual: "extract a plain helper" },
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 18. WORKER CELLS READING PEER CELLS
// ══════════════════════════════════════════════════════════════════════
//
// A `worker: true` cell holds ONLY its own slice. Reading another cell from
// inside it used to return that peer's declared default forever; the runtime
// now throws, but a throw is a runtime event — you learn when the code path
// runs, which for a rare branch can be much later. This is the STATIC half:
// the same mistake reported at lint/boot time, with file:line, before anything
// runs.
//
// Detection is deliberately conservative: only a read of a KNOWN cell name
// (`other.field`, never `other.method(...)`) inside the file that declares the
// worker cell counts. The runtime guard remains the guarantee; this is the
// early warning.

export const checkWorkerPeerReads: Checker = (ctx) => {
  const { cells, report } = ctx;
  const workerCells = cells.filter((c) => c.isWorker);
  if (workerCells.length === 0) return;
  const peerNames = new Set(cells.map((c) => c.name));

  for (const wc of workerCells) {
    peerNames.delete(wc.name);
    const code = codeText(wc.file.content);
    for (const peer of peerNames) {
      // `peer.field` — a property READ. A call (`peer.method(`) already throws
      // loudly at runtime (unbound-runtime guard), so it isn't this trap.
      //
      // `\b` before the lookahead is what makes that exclusion real: with
      // `(\w+)\s*(?!\()` the `\w+` backtracks one character and the lookahead
      // never sees the `(`, so `counter.increment(1)` was reported as an
      // ERROR — "reads counter.incremen", an identifier that appears nowhere —
      // and a legal peer CALL failed the gate with a false explanation.
      const re = new RegExp(`\\b${peer}\\s*\\.\\s*(\\w+)\\b(?!\\s*\\()`, "g");
      const m = re.exec(code);
      if (!m) continue;
      const line = code.slice(0, m.index).split("\n").length;
      report(
        "error",
        "cells",
        `${wc.file.relative}:${line} — cell "${wc.name}" has worker: true and ` +
          `reads "${peer}.${m[1]}". A worker cell has ONLY its own state, so ` +
          `this read cannot see ${peer}'s live value (the runtime throws when ` +
          `it executes). Pass the value in as a method argument, or keep the ` +
          `heavy work in one self-contained cell — the designated-thread idiom.`,
        {
          file: wc.file.relative,
          line,
          fix:
            `${wc.name}.method(${peer}Value) — hand the value in from the caller`,
        },
      );
      break; // one per worker cell: the fix is structural, not per-line
    }
    peerNames.add(wc.name);
  }
};

// `useCell(...)`.state is a LIVE proxy — the stash-and-diff idiom compares
// state against itself, silently (a field report). Deprecated at
// the source; named here at lint time, before it runs.
export const checkUseCell: Checker = (ctx) => {
  const { tsFiles, tsxFiles, report } = ctx;
  for (const file of [...tsFiles, ...tsxFiles]) {
    // Code only — a migration note that NAMES useCell( in a comment is the
    // opposite of a use of it, and it was warned about anyway. A DECLARATION
    // (`function useCell(` — the framework's own compat shim) is not a use.
    const [m] = codeMatches(
      file.content,
      /(?<!function\s)\buseCell\s*\(/g,
    );
    if (!m) continue;
    const line = file.content.slice(0, m.index).split("\n").length;
    if (isSuppressed(file.lines, line - 1)) continue;
    report(
      "error",
      "patterns",
      `${file.relative}:${line} — useCell() was REMOVED in alpha52 ` +
        `(deprecated since alpha41): use direct cell access (cell.field / ` +
        `cell.method()). Its .state was a LIVE view — stashing it and ` +
        `diffing later compared current state to itself.`,
      {
        file: file.relative,
        line,
        fix: "useCell(c).state.x → c.x (direct read, reactive)",
        safeFix: fix.fixUseCellStateReads(file.path),
      },
    );
  }
};

// ══════════════════════════════════════════════════════════════════════
// ALPHA52 — the effect channel (deprecations)
// ══════════════════════════════════════════════════════════════════════

/** alpha52 breaks, each with its migration:
 *  • effects off the return channel → `s.$do(...)` (safe-fix, conservative)
 *  • listensTo array form deprecated (report — the object form needs the
 *    author to pick a handler method)
 *  • selector deps spread signature → tuple (safe-fix when untyped)
 *  • schedule.backoff/poll old arg order + poll `backoff` key → `factor` */
export const checkAlpha52: Checker = (ctx) => {
  const { tsFiles, tsxFiles, report, pass } = ctx;
  let found = 0;
  const files = [...tsFiles, ...tsxFiles];

  for (const file of files) {
    const code = codeText(file.content);
    const lineOf = (idx: number) => code.slice(0, idx).split("\n").length;

    // Will --safe-fix actually rewrite THIS site? The fix's own planner
    // answers, at report time — a draft param that is not `s`, a return-type
    // annotation it cannot narrow, a typed draft with no `"aio"` import clause
    // to hang `MethodDraftServed` on, a `return` sharing its line with other
    // code: each is a deliberate decline, and each used to render `[fixable]`
    // and survive every run, which is indistinguishable from a broken tool.
    // One planner, so the label and the behaviour cannot drift apart.
    const effectSiteOpts = (at: number, line: number) => {
      const declined = fix.returnEffectDecline(file.content, at);
      if (declined === null) {
        return {
          file: file.relative,
          line,
          fix: "s.$do(schedule.after(...)); return;",
          safeFix: fix.fixReturnEffectsToDo(file.path),
        };
      }
      const param = fix.enclosingMethodParam(file.content, at);
      return {
        file: file.relative,
        line,
        fix: param === null || param === "s"
          ? "rewrite by hand: s.$do(effect); return;"
          : `rename the draft param '${param}' to 's' and rerun ` +
            `--safe-fix, or rewrite by hand: ${param}.$do(effect); return;`,
        manual: declined,
      };
    };

    // return-ed effects → s.$do
    for (
      const m of codeMatches(
        file.content,
        /\breturn\s+(?:schedule|own)\.\w+\s*\(/g,
      )
    ) {
      const line = lineOf(m.index!);
      if (isSuppressed(file.lines, line - 1)) continue;
      found++;
      report(
        "warn",
        "alpha52",
        `${file.relative}:${line} — returning effects from a method is ` +
          `deprecated (works through beta): call s.$do(effect) and use ` +
          `\`return\` for values only`,
        effectSiteOpts(m.index! + m[0].length, line),
      );
    }

    // return-ed effect ARRAYS → s.$do (only when provably all effects).
    // Depth walk over the STRIPPED code — braces/brackets inside comments or
    // strings must not move `end` (same defect class as _balancedClose).
    for (const m of codeMatches(file.content, /\breturn\s+\[/g)) {
      const open = m.index! + m[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = open; i < code.length; i++) {
        const ch = code[i];
        if ("([{".includes(ch!)) depth++;
        else if (")]}".includes(ch!)) {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) continue;
      const inner = code.slice(open + 1, end).trim();
      if (inner.length === 0) continue; // `return []` is a VALUE
      const parts: string[] = [];
      let d = 0;
      let start = 0;
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i]!;
        if ("([{".includes(ch)) d++;
        else if (")]}".includes(ch)) d--;
        else if (ch === "," && d === 0) {
          parts.push(inner.slice(start, i));
          start = i + 1;
        }
      }
      parts.push(inner.slice(start));
      if (
        !parts.every((p) =>
          /^\s*(schedule|own)\.\w+\s*\(/.test(p) && p.trim().length > 0
        )
      ) {
        continue;
      }
      const line = lineOf(m.index!);
      if (isSuppressed(file.lines, line - 1)) continue;
      found++;
      report(
        "warn",
        "alpha52",
        `${file.relative}:${line} — returning an effects ARRAY is deprecated ` +
          `(works through beta): call s.$do(effect, ...) and use \`return\` ` +
          `for values only`,
        effectSiteOpts(m.index! + m[0].length, line),
      );
    }

    // (The alpha52 transaction MIGRATION check stood here. alpha57 returned
    // `transaction` to opt-in, so a cell with async methods and no transaction
    // key is correct as written and has nothing to migrate. An app already
    // carrying the inserted `transaction: false,` needs no action either — it
    // now states the default.)

    // listensTo array form
    for (const m of codeMatches(file.content, /\blistensTo\s*:\s*\[/g)) {
      const line = lineOf(m.index!);
      if (isSuppressed(file.lines, line - 1)) continue;
      found++;
      report(
        "error",
        "alpha52",
        removalMessage(
          removalOf("listensTo: [...]"),
          `${file.relative}:${line}`,
        ),
        {
          file: file.relative,
          line,
          fix: "listensTo: { myHandler: other.method }",
        },
      );
    }

    // selector deps spread signature → tuple
    for (
      const m of codeMatches(
        file.content,
        /deps\s*:\s*\[([^\]]*)\]\s*,\s*fn\s*:\s*(?:async\s*)?\(([^)]*)\)/g,
      )
    ) {
      const depCount = m[1]!.split(",").map((s) => s.trim()).filter(Boolean)
        .length;
      const ps = m[2]!.split(",").map((s) => s.trim()).filter(Boolean);
      if (depCount === 0 || ps.length !== depCount + 1) continue;
      if ((ps[1] ?? "").startsWith("[")) continue; // already tuple form
      const line = lineOf(m.index!);
      if (isSuppressed(file.lines, line - 1)) continue;
      found++;
      report(
        "warn",
        "alpha52",
        `${file.relative}:${line} — selector deps now arrive as a TUPLE: ` +
          `fn: (s, [${
            ps.slice(1).map((p) => p.split(":")[0]!.trim()).join(", ")
          }], ...args) => … (the spread form works through beta with a hint)`,
        {
          file: file.relative,
          line,
          fix: "fn: (s, [dep1, dep2], ...args) => …",
          safeFix: fix.fixSelectorDepsTuple(file.path),
        },
      );
    }

    // schedule.backoff/poll old argument order (opts 3rd). The NEW spelling
    // may ALSO put an object literal third — the action, `{ type: "..." }` —
    // so a literal with a top-level `type:` key is the CORRECT order and must
    // never be flagged (a checker that warns forever on migrated code teaches
    // people to skim past the real findings).
    for (
      const m of codeMatches(
        file.content,
        /\bschedule\.(backoff|poll)\s*\(\s*[^,()]+,\s*[^,()]+,\s*\{/g,
      )
    ) {
      const litOpen = m.index! + m[0].length - 1;
      let d = 0;
      let litEnd = -1;
      for (let i = litOpen; i < file.content.length; i++) {
        const ch = file.content[i];
        if (ch === "{") d++;
        else if (ch === "}") {
          d--;
          if (d === 0) {
            litEnd = i;
            break;
          }
        }
      }
      if (litEnd === -1) continue;
      const inner = code.slice(litOpen + 1, litEnd);
      // Top-level `type:` key ⇒ this third arg is the ACTION (new order).
      let depth = 0;
      let isAction = false;
      let segStart = 0;
      const segs: string[] = [];
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i]!;
        if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) depth--;
        else if (ch === "," && depth === 0) {
          segs.push(inner.slice(segStart, i));
          segStart = i + 1;
        }
      }
      segs.push(inner.slice(segStart));
      for (const seg of segs) {
        if (/^\s*["']?type["']?\s*:/.test(seg)) isAction = true;
      }
      if (isAction) continue;
      const line = lineOf(m.index!);
      if (isSuppressed(file.lines, line - 1)) continue;
      found++;
      report(
        "error",
        "alpha52",
        removalMessage(
          removalOf("schedule.backoff/poll(id, attempt, opts, action)"),
          `${file.relative}:${line}`,
        ),
        {
          file: file.relative,
          line,
          fix: `schedule.${m[1]}("id", s.attempt, A.tick(), { ... })`,
        },
      );
    }

    // poll's `backoff` option key → `factor`. Scoped to the OPTS literal (the
    // one carrying `every:`) — an action payload may have a `backoff` field of
    // its own, and that one is data, not the deprecated key.
    for (
      const m of codeMatches(
        file.content,
        /\bschedule\.poll\s*\([^;]*?\{[^{}]*\bevery\s*:[^{}]*\bbackoff\s*:|\bschedule\.poll\s*\([^;]*?\{[^{}]*\bbackoff\s*:[^{}]*\bevery\s*:/g,
      )
    ) {
      const line = lineOf(m.index!);
      if (isSuppressed(file.lines, line - 1)) continue;
      found++;
      report(
        "error",
        "alpha52",
        removalMessage(
          removalOf("schedule.poll({ backoff })"),
          `${file.relative}:${line}`,
        ),
        {
          file: file.relative,
          line,
          fix: "{ every: 5000, factor: 2, max: 60000 }",
          safeFix: fix.fixPollBackoffKey(file.path),
        },
      );
    }
  }

  if (found === 0) {
    pass("alpha52: no deprecated effect-channel/selector/schedule spellings");
  }
};

// ══════════════════════════════════════════════════════════════════════
// ALPHA52 — the surface diet + safety defaults (Package 4)
// ══════════════════════════════════════════════════════════════════════

/** Balanced-scan from an opening `{` to its close; -1 when unbalanced.
 *
 *  Takes STRIPPED text (`codeText()` — comments/strings/regex bodies blanked,
 *  offsets preserved), so a plain depth walk is exact. It USED to take raw
 *  text with its own string tracking — which was comment-BLIND: one unpaired
 *  apostrophe in a comment ("don't") flipped the string state and swallowed
 *  every brace until the next quote, so `end` landed wrong and whole cells
 *  were silently skipped (a 33-cell field app got 11 of 33 findings — and the
 *  access-without-visible SECURITY branch under-reported identically).
 *  Offsets in stripped text equal offsets in the raw source. */
function _balancedClose(stripped: string, open: number): number {
  let depth = 0;
  for (let i = open; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** TOP-LEVEL identifier keys of an object literal body (incl. braces).
 *  Takes a STRIPPED slice (see _balancedClose) — identifiers are code and
 *  survive stripping, so a depth walk with no string state is exact. */
function _topLevelKeys(body: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    else if (depth === 1 && /[$\w]/.test(ch)) {
      if (/[$\w.]/.test(body[i - 1] ?? "")) continue;
      const m = /^([$\w]+)\s*:/.exec(body.slice(i));
      if (m) keys.add(m[1]!);
      while (i + 1 < body.length && /[$\w]/.test(body[i + 1]!)) i++;
    }
  }
  return keys;
}

/** alpha52 surface-diet + safety-default migrations:
 *  • cell/cellDefaults `ui:` → `visible:` (alias through beta; safe-fix)
 *  • deleted entries `aio/schedule`/`aio/selectors` (safe-fix re-routes)
 *  • exposed app with no auth + no `key` → key now DEFAULTS to a generated
 *    shared key; MIGRATION inserts `key: false` (behaviour-preserving)
 *  • `access:` with no `visible` on an exposed/multi-user app → the boot
 *    REFUSAL, reported pre-boot (one-word fix: visible: "all") */
export const checkAlpha52Surface: Checker = (ctx) => {
  const { sourceFiles, tsFiles, tsxFiles, appEntry, denoJson, report, pass } =
    ctx;
  let found = 0;
  const files = [...tsFiles, ...tsxFiles];

  // Audience: exposed to the network, or multi-user auth — resolved once.
  const entryCode = appEntry ? codeText(appEntry.content) : "";
  const taskExpose = Object.values(denoJson?.tasks ?? {}).some((c) =>
    typeof c === "string" && /(?<![\w-])--expose(?![\w-])/.test(c)
  );
  const cfgExpose = /\bexpose\s*:\s*true/.test(entryCode);
  const multiUser = /\busers\s*:|\bresolveUser\s*[:(]|\bauth\s*:\s*(true|\{)/
    .test(
      entryCode,
    );
  const exposedOrMulti = taskExpose || cfgExpose || multiUser;

  for (const file of files) {
    const code = codeText(file.content);
    const lineOf = (idx: number) => code.slice(0, idx).split("\n").length;

    // cell `ui:` → `visible:` (and cellDefaults.ui) — key rename, aliased.
    // NOTE the block regex runs on RAW content (the cell NAME is a string —
    // stripping would blank it) with codeMatches filtering comment mentions;
    // everything STRUCTURAL below runs on the stripped `code`, same offsets.
    const blockRe =
      /\bcell\s*\(\s*["'`][\w\-]+["'`]\s*,\s*\{|\bcellDefaults\s*:\s*\{/g;
    for (const m of codeMatches(file.content, blockRe)) {
      const open = code.indexOf("{", m.index! + m[0].length - 1);
      const end = _balancedClose(code, open);
      if (end === -1) continue;
      const keys = _topLevelKeys(code.slice(open, end + 1));
      const isCell = !m[0].startsWith("cellDefaults");
      if (!keys.has("ui")) {
        // access-without-visible: only meaningful on cell blocks, and only
        // when the audience is real — mirrors aio.run()'s boot refusal.
        if (
          isCell && exposedOrMulti && keys.has("access") &&
          !keys.has("visible")
        ) {
          const line = lineOf(m.index!);
          if (isSuppressed(file.lines, line - 1)) continue;
          found++;
          report(
            "error",
            "security",
            `${file.relative}:${line} — this cell declares \`access\` (the ` +
              `CALL side) but no \`visible\` (the READ side). This app is ` +
              `${taskExpose || cfgExpose ? "exposed" : "multi-user"}, so ` +
              `aio.run() REFUSES to boot (alpha52): with no \`visible\`, ` +
              `the whole cell is broadcast to every connected client. ` +
              `Decide reads: visible: "none" / { exclude: [...] } / ` +
              `forUser — or acknowledge in one word: visible: "all"`,
            {
              file: file.relative,
              line,
              fix:
                'visible: "all"  // or "none" / { exclude: [...] } / forUser',
            },
          );
        }
        continue;
      }
      const line = lineOf(m.index!);
      if (isSuppressed(file.lines, line - 1)) continue;
      found++;
      report(
        "error",
        "alpha52",
        removalMessage(
          removalOf(isCell ? "cell({ ui })" : "cellDefaults.ui"),
          `${file.relative}:${line}`,
        ),
        {
          file: file.relative,
          line,
          fix: "visible: { exclude: [...] }  // was ui:",
          safeFix: fix.fixUiKeyToVisible(file.path),
        },
      );
    }
  }

  // Deleted entries: aio/schedule + aio/selectors (alpha52 entry diet).
  for (const file of sourceFiles) {
    // Masked (see the note on the moved-symbol probe above): a strict rule must
    // not fire on a mention inside a comment or a template literal.
    //
    // `codeMatches` (start-offset filtering), NOT `codeText`: codeText blanks
    // every non-code span INCLUDING string contents, and an import's specifier
    // is a string — masking it that way made this rule unable to match its own
    // violation. Filtering by where the match STARTS (the `import` keyword,
    // which is code) keeps the specifier readable while still rejecting a match
    // that begins inside a comment or a template literal.
    const m = codeMatches(
      file.content,
      /(?:^|\n)\s*import\s[^\n]*from\s*["']aio\/(schedule|selectors)["']/g,
    )[0];
    if (!m) continue;
    found++;
    // `+1` is only right when the match started at the `\n` the pattern
    // allows; a FIRST-LINE import matches at index 0 and was reported as
    // line 2 — an error-severity finding pointing at the wrong line.
    const line = file.content.slice(0, m.index).split("\n").length +
      (m.index === 0 ? 0 : 1);
    report(
      "error",
      "upgrade",
      `${file.relative}:${line} — the \`aio/${m[1]}\` entry was DELETED in ` +
        `alpha52: its symbols live on \`aio\` (schedule, createSelector, ` +
        `types) and \`aio/extras\` (isScheduleEffect, createSliceSelector)`,
      {
        file: file.relative,
        line,
        fix: m[1] === "schedule"
          ? 'import { schedule } from "aio"'
          : 'import { createSelector } from "aio"',
        safeFix: fix.fixDeadEntrySpecifiers(file.path),
      },
    );
  }

  // (aio/db value imports: see checkAlpha70Removals — the deprecation became
  // a removal in alpha70.)

  // MIGRATION: exposed + no per-user auth + no `key` → alpha52 generates a
  // shared key by default. Insert `key: false` to pin the old OPEN behavior.
  // Fires ONLY for a project still pinned to pre-alpha52 aio — that is the
  // one population whose behavior the default changes. A fresh scaffold (or
  // an already-upgraded app) is SAFE by default now, and warning it would be
  // pure noise: the boot log already explains the generated key.
  // The pin can live in TWO places: a jsr specifier in `imports.aio`
  // (`jsr:@riagentic/aio@1.0.0-alphaNN`), or — the am-created population,
  // which is the MAIN one — a `dep/aio` link with the recorded version in
  // deno.json `aioVersion` ("v1.0.0-alphaNN"). Consult both; an unversioned
  // source checkout stays exempt (can't tell → the boot log explains).
  const aioPin = denoJson?.imports?.["aio"] ?? "";
  const pinAlpha = /@1\.0\.0-alpha(\d+)/.exec(aioPin);
  const verAlpha = /^v?1\.0\.0-alpha(\d+)$/.exec(
    String((denoJson as Record<string, unknown> | null)?.aioVersion ?? ""),
  );
  const alphaNum = pinAlpha
    ? Number(pinAlpha[1])
    : verAlpha
    ? Number(verAlpha[1])
    : null;
  const preAlpha52 = alphaNum !== null && alphaNum < 52;
  if (preAlpha52 && appEntry && (taskExpose || cfgExpose) && !multiUser) {
    // entryCode is the stripped entry (computed above) — scan structure there.
    const m = /\baio\.run\s*\(\s*\{/.exec(entryCode);
    const open = m ? entryCode.indexOf("{", m.index + m[0].length - 1) : -1;
    const end = open === -1 ? -1 : _balancedClose(entryCode, open);
    const keys = end === -1
      ? new Set<string>()
      : _topLevelKeys(entryCode.slice(open, end + 1));
    if (!keys.has("key")) {
      found++;
      report(
        "warn",
        "security",
        `${appEntry.relative} — this app is exposed with no per-user auth ` +
          `and no \`key\`: since alpha52 aio generates a persisted shared ` +
          `key by default (the share link carries it). To keep the app OPEN ` +
          `on the network, pin it explicitly: key: false`,
        {
          file: appEntry.relative,
          fix: "key: false  // explicit opt-out, pre-alpha52 behavior",
          safeFix: fix.fixInsertKeyFalse(appEntry.path),
        },
      );
    }
  }

  if (found === 0) {
    pass("alpha52 surface: no ui:-key, dead-entry, or exposed-open findings");
  }
};

// ══════════════════════════════════════════════════════════════════════
// 22. THE $live HAZARD — A TRANSACTIONAL METHOD THAT REREADS ITS OWN READS
// ══════════════════════════════════════════════════════════════════════
//
// Under `transaction: true`, a method's reads are PINNED at entry: an `await`
// never changes them, and at return the commit validates the read-set against
// live state. So a method that
//
//     reads  s.issues        ← pinned here
//     awaits something
//     writes s.issues        ← computed from the pinned value
//
// conflicts the moment ANY other action commits `s.issues` while it was
// suspended, and the commit is rejected (`conflict: "abort"`).
//
// The runtime error for this is excellent — it names the field, the mechanism
// and three fixes. Its TIMING is the problem: it fires at runtime, on a real
// machine, on a race that needs two async methods to overlap. A field report
// hit it on the first live run of a desktop app, from `onStart` firing a
// monitor tick and a scan concurrently, and called this "the single
// highest-value change on this list" — because the hazard is STATICALLY
// VISIBLE and aiol already walks the cell. A production crash that a lint line
// could have been is the worst trade a framework makes.
//
// Deliberately narrow, because a false positive here trains people to ignore
// the linter:
//   • only cells declaring `transaction` (that is the mode with pinned reads),
//   • only ASYNC methods that actually `await`,
//   • only a field READ before the first await AND WRITTEN after it,
//   • silent when the body mentions `$live` at all — the author knows.

/** Field names read through the draft in `body` — `s.x`, `s.x.y`, `s.x[i]`.
 *  `$`-prefixed meta (`$live`/`$commit`/`$do`/`$signal`) is not state.
 *
 *  A WRITE is not a read. The first cut of this counted every `s.field`
 *  mention, including the LHS of `s.status = "capturing"` — and promptly
 *  flagged three of the framework's own cells whose methods only ever WRITE
 *  status/error around an await. The runtime's conflict detector pins reads
 *  alone (the set trap records writes, never reads), so write→await→write
 *  cannot conflict and must not warn: a rule that cries wolf on the shape the
 *  framework itself uses is the false positive this rule promised not to be.
 *  Compound assignment (`+=`), `++`/`--` and mutator calls that READ first
 *  are conservative territory; only the plain `=` LHS and pure mutator calls
 *  (`push`/`pop`/… — noteWrite-only in the runtime) are excluded. */
function draftReads(body: string): Set<string> {
  const MUTATORS = new Set([
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
    "sort",
    "reverse",
    "fill",
    "copyWithin",
    "set",
    "delete",
    "add",
    "clear",
  ]);
  const out = new Set<string>();
  for (const m of body.matchAll(/\bs\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    const f = m[1]!;
    if (f.startsWith("$")) continue;
    // Walk the rest of the access chain to see how it ENDS.
    let i = m.index + m[0].length;
    let lastSeg = f;
    while (i < body.length) {
      const seg = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(body.slice(i));
      if (seg) {
        lastSeg = seg[1]!;
        i += seg[0].length;
        continue;
      }
      const idx = /^\s*\[[^\]]*\]/.exec(body.slice(i));
      if (idx) {
        lastSeg = "";
        i += idx[0].length;
        continue;
      }
      break;
    }
    const after = body.slice(i);
    // Chain ends in a PURE-MUTATOR call (`s.items.push(…)`): noteWrite-only
    // in the runtime — not a read.
    if (MUTATORS.has(lastSeg) && /^\s*\(/.test(after)) continue;
    // Chain is the LHS of a plain assignment (`s.status = …`, `s.a.b = …`):
    // the set trap records a write, never a read. `==`/`===`/`=>` stay reads.
    if (/^\s*=(?![=>])/.test(after)) continue;
    out.add(f);
  }
  return out;
}

/** Field names WRITTEN through the draft in `body` — assignment, compound
 *  assignment, increment, or a mutating array/collection call. */
function draftWrites(body: string): Set<string> {
  const out = new Set<string>();
  const re =
    /\bs\s*\.\s*([A-Za-z_$][\w$]*)\s*(?:(?:\[[^\]]*\]|\.\s*[\w$]+)*\s*)?(=[^=]|\+=|-=|\*=|\/=|\?\?=|\|\|=|&&=|\+\+|--|\.\s*(?:push|pop|shift|unshift|splice|sort|reverse|fill|set|delete|add|clear)\s*\()/g;
  for (const m of body.matchAll(re)) {
    const f = m[1]!;
    if (!f.startsWith("$")) out.add(f);
  }
  return out;
}

export const checkLiveHazard: Checker = (ctx) => {
  const { cells, report } = ctx;
  for (const cell of cells) {
    const code = codeText(cell.file.content);
    const span = cellLiteralSpan(code, cell.line);
    if (!span) continue;
    const literal = code.slice(span[0], span[1]);
    // Only the pinned-read mode has this hazard at all.
    if (!/\btransaction\s*:/.test(literal)) continue;
    if (/\btransaction\s*:\s*false\b/.test(literal)) continue;

    // Walk each async method body inside the literal.
    const header = /\basync\s+([A-Za-z_$][\w$]*)\s*\(\s*_?s\b[^)]*\)\s*\{/g;
    for (const m of literal.matchAll(header)) {
      const name = m[1]!;
      const open = span[0] + m.index + m[0].length - 1;
      // Body span by brace matching from the method's `{`.
      let depth = 0, close = -1;
      for (let i = open; i < code.length; i++) {
        if (code[i] === "{") depth++;
        else if (code[i] === "}") {
          depth--;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      if (close < 0) continue;
      const body = code.slice(open, close);
      // `$live` anywhere in the body: the author has met this and chosen.
      if (body.includes("$live")) continue;
      const firstAwait = body.search(/\bawait\b/);
      if (firstAwait < 0) continue;
      const before = body.slice(0, firstAwait);
      const after = body.slice(firstAwait);
      const reads = draftReads(before);
      const writes = draftWrites(after);
      const hazard = [...writes].filter((w) => reads.has(w));
      if (hazard.length === 0) continue;
      const line = code.slice(0, open).split("\n").length;
      const fields = hazard.map((f) => `s.${f}`).join(", ");
      report(
        "warn",
        "patterns",
        `${cell.file.relative}:${line} — \`${cell.name}.${name}()\` is ` +
          `transactional: it READS ${fields} before an await and WRITES ` +
          `${
            hazard.length === 1 ? "it" : "them"
          } after. Reads are pinned at entry, so if ` +
          `another action commits ${
            hazard.length === 1 ? "that field" : "those fields"
          } while this ` +
          `method is suspended, the commit is REJECTED as a conflict — at ` +
          `runtime, only when the two overlap.\n` +
          `      fix: read through \`s.$live\` after the await ` +
          `(\`s.${hazard[0]} = f(s.$live.${hazard[0]})\`), or gather async ` +
          `results FIRST and do the read+write in one contiguous block, or ` +
          `set \`transaction: { conflict: "warn" }\` to commit anyway.`,
        { file: cell.file.relative, line },
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 23. YOU ARE DOING IT THE OLD WAY — perfBudget.methods → long:
// ══════════════════════════════════════════════════════════════════════
//
// `long: ["scan"]` is checked against the cell's own method list at `cell()`
// time. `perfBudget: { methods: { "models:scan": { timeout: 0 } } }` is a
// string in another file that no rename follows.
//
// The second one is still what the canonical example teaches, and it shows:
// one field report accumulated nine such entries BEFORE `long:` existed, and a
// LATER project accumulated three AFTER it existed, purely by copying
// `examples/disk`. Docs and examples were fixed — this is the backstop, because
// the next person copies from a blog post. Mechanically detectable and
// mechanically fixable: aiol knows the cell names and their methods.

export const checkOldWayPerfBudget: Checker = (ctx) => {
  const { tsFiles, cells, report } = ctx;
  if (cells.length === 0) return;
  const owned = new Map<string, string>(); // "cell:method" → cell name
  for (const c of cells) {
    for (const m of c.methodNames) owned.set(`${c.name}:${m}`, c.name);
  }
  for (const file of tsFiles) {
    if (file.name.endsWith(".test.ts")) continue;
    const code = codeText(file.content);
    if (!/perfBudget\s*:/.test(code)) continue;
    // The KEY is inside a string, and codeText() blanks string CONTENTS — so
    // match against the raw source and use codeText only to skip comments.
    const raw = file.content;
    for (
      const m of raw.matchAll(
        /["'`]([\w-]+:[\w$]+)["'`]\s*:\s*\{[^}]*\btimeout\s*:/g,
      )
    ) {
      const key = m[1]!;
      const cellName = owned.get(key);
      if (!cellName) continue; // a foreign/unknown key — checkConfig owns that
      const method = key.slice(cellName.length + 1);
      const line = raw.slice(0, m.index).split("\n").length;
      report(
        "warn",
        "patterns",
        `${file.relative}:${line} — \`perfBudget.methods["${key}"].timeout\` ` +
          `is the OLD way to say "this method may run as long as it needs". ` +
          `Declare it on the cell instead: \`long: ["${method}"]\` in ` +
          `cell("${cellName}", …). That is checked against the method list at ` +
          `cell() time, so a rename cannot silently orphan it — this string ` +
          `can, and does.`,
        { file: file.relative, line },
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 24. `t` IS NOT AN ATTRIBUTE — [t="…"] IN A SELECTOR MATCHES NOTHING
// ══════════════════════════════════════════════════════════════════════
//
// `t` is a framework-owned handle: it names the element on the semantic test
// surface and is STRIPPED before the DOM. It looks like an attribute and is
// written like one, so `document.querySelector('video[t="player"]')` and a CSS
// rule `[t="result-image"] { … }` both match nothing — silently.
//
// This is documented twice, including in the spec, and it still shipped a dead
// Play button in one repo (found by accident, while editing that element for
// another reason) and a set of no-op CSS rules in the same codebase an hour
// later. Documentation did not prevent two bugs in one project; that is the
// definition of a footgun, and the reporter named this rule the highest value
// per unit of effort on their list.

export const checkTestHandleSelectors: Checker = (ctx) => {
  const { tsFiles, tsxFiles, cssFiles, styleCss, report } = ctx;
  const sel = /\[\s*t\s*(?:=|\^=|\*=|\$=|~=|\|=)/;
  for (const file of [...tsFiles, ...tsxFiles]) {
    const code = codeText(file.content);
    // Only inside a QUERY — `[t=` in ordinary code (a type index, an array
    // literal) is not a selector.
    for (
      const m of code.matchAll(
        /\b(?:querySelector|querySelectorAll|closest|matches)\s*\(\s*["'`]([^"'`]*)["'`]/g,
      )
    ) {
      // codeText blanks string contents, so re-read the same span from source.
      const raw = file.content.slice(m.index, m.index + m[0].length + 2);
      if (!sel.test(raw)) continue;
      const line = code.slice(0, m.index).split("\n").length;
      report(
        "error",
        "ui",
        `${file.relative}:${line} — this selector matches on \`[t=…]\`, and ` +
          `\`t\` never reaches the DOM: it is a framework-owned test handle, ` +
          `stripped before render. The query returns null, silently, forever.\n` +
          `      fix: query something real (an id, a class, a data- attribute), ` +
          `or drive the element through its handle instead — \`ui.<name>\` in a ` +
          `test, \`am trigger\` against a live app.`,
        { file: file.relative, line },
      );
    }
  }
  // …and the same mistake in a stylesheet. This used to filter `sourceFiles`
  // for `.css`, which is always empty — the file scan collects .ts/.tsx only —
  // so "a multi-sheet app is not half-covered" was a comment describing a
  // branch that could not run. `cssFiles` is the real set.
  const sheets = [
    ...(styleCss ? [styleCss] : []),
    ...cssFiles.filter((f) => f.path !== styleCss?.path),
  ];
  for (const file of sheets) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!sel.test(lines[i]!)) continue;
      report(
        "error",
        "ui",
        `${file.relative}:${i + 1} — this rule selects on \`[t=…]\`, which ` +
          `never reaches the DOM (\`t\` is a framework-owned test handle, ` +
          `stripped before render). The rule matches nothing.\n` +
          `      fix: style by class or a data- attribute.`,
        { file: file.relative, line: i + 1 },
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 25. A SYNC METHOD / SELECTOR READING A ui-HIDDEN FIELD
// ══════════════════════════════════════════════════════════════════════
//
// `visible: { exclude: [...] }` is enforced on every CLIENT read — and sync
// methods of a `sync`/`localFirst`/client-scoped cell REPLAY on the client
// (optimistic rebase), selectors of every cell compute over the filtered
// slice. A sync reducer touching `s.encSecKey` therefore THROWS there
// (dev and prod alike). A field report: a lock screen's
// `vaultInitialized()` selector read a hidden field, got `undefined`, and
// offered to CREATE a vault over the existing one. The runtime tripwire is
// the guarantee; this names the read with file:line before anything runs.

/** The static shape of a cell's `visible:`/`ui:` config, read from RAW
 *  source (the field names are strings — stripped text blanks them). */
type _StaticVisibility = {
  mode: "all" | "none" | "include" | "exclude";
  fields: string[]; // include or exclude list (dot-paths kept)
  publicFields: string[];
};

function _strings(list: string): string[] {
  return [...list.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
}

/** Parse `visible:` (or the deprecated `ui:` alias) from one cell's config
 *  body. `raw` and `stripped` share offsets; `open..end` bound the body. */
function _staticVisibility(
  raw: string,
  stripped: string,
  open: number,
  end: number,
): _StaticVisibility {
  const none: _StaticVisibility = { mode: "all", fields: [], publicFields: [] };
  const body = stripped.slice(open, end + 1);
  // Top-level `visible:` / `ui:` only — a nested `ui:` inside state is data.
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    else if (depth === 1 && /[$\w]/.test(ch)) {
      if (/[$\w.]/.test(body[i - 1] ?? "")) continue;
      const m = /^(visible|ui)\s*:\s*/.exec(body.slice(i));
      if (!m) {
        while (i + 1 < body.length && /[$\w]/.test(body[i + 1]!)) i++;
        continue;
      }
      const at = open + i + m[0].length;
      if (stripped[at] === "{") {
        const close = _balancedClose(stripped, at);
        if (close === -1) return none;
        const cfg = raw.slice(at, close + 1);
        const pub = /\bpublicFields\s*:\s*\[([^\]]*)\]/.exec(cfg);
        const publicFields = pub ? _strings(pub[1]!) : [];
        const inc = /\binclude\s*:\s*\[([^\]]*)\]/.exec(cfg);
        if (inc) {
          return { mode: "include", fields: _strings(inc[1]!), publicFields };
        }
        const exc = /\bexclude\s*:\s*\[([^\]]*)\]/.exec(cfg);
        if (exc) {
          return { mode: "exclude", fields: _strings(exc[1]!), publicFields };
        }
        return { ...none, publicFields };
      }
      const lit = /^["'`](all|none)["'`]/.exec(raw.slice(at));
      if (lit?.[1] === "none") return { ...none, mode: "none" };
      return none;
    }
  }
  return none;
}

/** Top-level keys hidden from the client + the LEAF names of deep excludes. */
function _hiddenOf(
  vis: _StaticVisibility,
  stateKeys: string[],
): { top: Set<string>; leaves: Map<string, string> } {
  const top = new Set<string>();
  const leaves = new Map<string, string>(); // leaf → full dot-path
  if (vis.mode === "none") { for (const k of stateKeys) top.add(k); }
  if (vis.mode === "include") {
    for (const k of stateKeys) if (!vis.fields.includes(k)) top.add(k);
  }
  if (vis.mode === "exclude") {
    for (const f of vis.fields) {
      if (f.includes(".")) leaves.set(f.slice(f.lastIndexOf(".") + 1), f);
      else top.add(f);
    }
  }
  return { top, leaves };
}

/** Function-shaped members of an object-literal body (stripped text):
 *  `name(s) {…}`, `async name(s) {…}`, `name: (s) => {…}`, `name: async (s) =>`,
 *  `name: { deps, fn(s, …) {…} }` (the fn is reported under the outer name). */
function _members(
  stripped: string,
  open: number,
  end: number,
): Array<
  { name: string; async: boolean; param: string; start: number; body: string }
> {
  const out: Array<
    { name: string; async: boolean; param: string; start: number; body: string }
  > = [];
  // Includes the opening `{` so the first member has its `[,{]` lead-in.
  const body = stripped.slice(open, end);
  const re =
    /[,{]\s*(?:(async)\s+)?(?:\*\s*)?([$\w]+)\s*(?::\s*(async\s*)?)?\(([^)]*)\)\s*(?:=>\s*)?\{/g;
  for (const m of body.matchAll(re)) {
    // Depth-1 members only (depth counted AFTER the lead-in delimiter).
    let depth = 0;
    for (let i = 0; i <= m.index!; i++) {
      const ch = body[i]!;
      if ("({[".includes(ch)) depth++;
      else if (")}]".includes(ch)) depth--;
    }
    if (depth !== 1) continue;
    const name = m[2]!;
    if (["if", "for", "while", "switch", "catch"].includes(name)) continue;
    const braceAt = open + m.index! + m[0].length - 1;
    const close = _balancedClose(stripped, braceAt);
    if (close === -1) continue;
    const param = (m[4] ?? "").split(",")[0]!.trim().replace(/[:=].*$/s, "")
      .trim();
    out.push({
      name,
      async: Boolean(m[1] || m[3]),
      param,
      start: braceAt,
      body: stripped.slice(braceAt, close + 1),
    });
  }
  // EXPRESSION-BODIED arrows: `name: (s) => s.seed.length`, `name: s => …`,
  // `name: async (s) => …`. The body runs to the depth-0 `,` (or the block's
  // end). These used to be invisible to every rule that reads `_members`, so
  // a selector written the short way read a hidden field unflagged while the
  // same selector with braces was an error (a field report).
  const arrow =
    /[,{]\s*([$\w]+)\s*:\s*(async\s*)?(?:\(([^)]*)\)|([$\w]+))\s*=>(?!\s*\{)/g;
  for (const m of body.matchAll(arrow)) {
    let depth = 0;
    for (let i = 0; i <= m.index!; i++) {
      const ch = body[i]!;
      if ("({[".includes(ch)) depth++;
      else if (")}]".includes(ch)) depth--;
    }
    if (depth !== 1) continue;
    const from = m.index! + m[0].length;
    let d = 0, to = body.length;
    for (let i = from; i < body.length; i++) {
      const ch = body[i]!;
      if ("({[".includes(ch)) d++;
      else if (")}]".includes(ch)) {
        if (d === 0) {
          to = i;
          break;
        }
        d--;
      } else if (ch === "," && d === 0) {
        to = i;
        break;
      }
    }
    const param = (m[3] ?? m[4] ?? "").split(",")[0]!.trim()
      .replace(/[:=].*$/s, "").trim();
    out.push({
      name: m[1]!,
      async: Boolean(m[2]),
      param,
      start: open + from,
      body: body.slice(from, to),
    });
  }
  // deps-form selectors: `name: { deps: [...], fn(s, ...) {…} }`
  for (const m of body.matchAll(/([$\w]+)\s*:\s*\{\s*deps\s*:/g)) {
    const at = open + m.index! + m[0].lastIndexOf("{");
    const close = _balancedClose(stripped, at);
    if (close === -1) continue;
    const inner = _members(stripped, at, close).find((x) => x.name === "fn");
    if (inner) out.push({ ...inner, name: m[1]! });
  }
  return out;
}

/** Offsets of a depth-1 `key:` block (`methods`, `selectors`) inside a cell
 *  body; null when absent. */
function _blockOf(
  stripped: string,
  open: number,
  end: number,
  key: string,
): [number, number] | null {
  const body = stripped.slice(open, end + 1);
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    else if (
      depth === 1 && body.startsWith(key, i) &&
      !/[$\w.]/.test(body[i - 1] ?? "")
    ) {
      const m = new RegExp(`^${key}\\s*:\\s*\\{`).exec(body.slice(i));
      if (!m) continue;
      const at = open + i + m[0].length - 1;
      const close = _balancedClose(stripped, at);
      return close === -1 ? null : [at, close];
    }
  }
  return null;
}

const _CELL_BLOCK_RE = /\bcell\s*\(\s*["'`]([\w\-]+)["'`]\s*,\s*\{/g;

export const checkSyncMethodHiddenReads: Checker = (ctx) => {
  const { tsFiles, tsxFiles, cells, report, pass } = ctx;
  let found = 0, checked = 0;
  for (const file of [...tsFiles, ...tsxFiles]) {
    if (/\.test\.tsx?$/.test(file.name)) continue;
    const raw = file.content;
    const code = codeText(raw);
    const lineOf = (idx: number) => code.slice(0, idx).split("\n").length;
    for (const m of codeMatches(raw, _CELL_BLOCK_RE)) {
      const name = m[1]!;
      const open = code.indexOf("{", m.index! + m[0].length - 1);
      const end = _balancedClose(code, open);
      if (end === -1) continue;
      const keys = _topLevelKeys(code.slice(open, end + 1));
      const info = cells.find((c) =>
        c.name === name && c.file.path === file.path
      );
      const vis = _staticVisibility(raw, code, open, end);
      const { top, leaves } = _hiddenOf(vis, info?.stateKeys ?? []);
      if (top.size === 0 && leaves.size === 0) continue;
      checked++;
      const replays = (keys.has("sync") &&
        !/\bsync\s*:\s*false\b/.test(code.slice(open, end + 1))) ||
        /\bscope\s*:\s*["'`]client["'`]/.test(raw.slice(open, end + 1));
      const targets: Array<
        { kind: "sync method" | "selector"; block: [number, number] }
      > = [];
      const sel = _blockOf(code, open, end, "selectors");
      if (sel) targets.push({ kind: "selector", block: sel });
      const meth = replays ? _blockOf(code, open, end, "methods") : null;
      if (meth) targets.push({ kind: "sync method", block: meth });
      for (const { kind, block } of targets) {
        for (const fn of _members(code, block[0], block[1])) {
          if (fn.async) continue;
          const roots = [
            ...new Set([fn.param, "s", "state", "draft"].filter(Boolean)),
          ]
            .map((r) => r.replace(/[$]/g, "\\$"));
          let hit: { key: string; path: string; at: number } | undefined;
          for (const key of top) {
            const re = new RegExp(
              `\\b(?:${roots.join("|")})\\s*\\.\\s*${key}\\b`,
            );
            const r = re.exec(fn.body);
            if (r) {
              hit = { key, path: key, at: fn.start + r.index };
              break;
            }
          }
          if (!hit) {
            for (const [leaf, path] of leaves) {
              const r = new RegExp(`\\.\\s*${leaf}\\b`).exec(fn.body);
              if (r) {
                hit = { key: leaf, path, at: fn.start + r.index };
                break;
              }
            }
          }
          if (!hit) continue;
          const line = lineOf(hit.at);
          if (isSuppressed(file.lines, line - 1)) continue;
          found++;
          const fact = `has${hit.key.charAt(0).toUpperCase()}${
            hit.key.slice(1)
          }`;
          report(
            "error",
            "cells",
            `${file.relative}:${line} — cell "${name}" ${kind} "${fn.name}" ` +
              `reads \`${
                fn.param || "s"
              }.${hit.key}\`, which \`visible\` hides ` +
              `("${hit.path}"). ${
                kind === "selector"
                  ? "Selectors run in CLIENT context over the filtered slice"
                  : "Sync methods of a sync/localFirst/client-scoped cell REPLAY on the client against the filtered slice"
              }, so this read THROWS there (dev and prod alike). ` +
              `Read hidden fields only in server-side/async ` +
              `methods, or publish a non-secret fact field ` +
              `(\`${fact}: boolean\`) beside the secret and read that.`,
            {
              file: file.relative,
              line,
              fix:
                `state: { ${fact}: false, … } — set it where ${hit.key} is written; read ${fact} here`,
            },
          );
        }
      }
    }
  }
  if (checked > 0 && found === 0) {
    pass("no sync method/selector reads a ui-hidden field");
  }
};

// ══════════════════════════════════════════════════════════════════════
// 26. A STATE FIELD NAMED LIKE A CREDENTIAL, VISIBLE TO EVERY CLIENT
// ══════════════════════════════════════════════════════════════════════
//
// The static port of aio.run()'s boot refusal (src/server/aio-composition.ts,
// HARD_SECRET_RE + guards): a top-level state key that unambiguously names a
// credential and is broadcast to every client stops the app from BOOTING in
// dev — after the suite went green, because tests never compose the app. A
// field report: a display label named `namePrivateKey` refused the boot, and
// the override (`publicFields`) took a docs search. The regexes below MUST
// stay byte-identical to the runtime's (tests/aiol-credential-field-name
// .test.ts pins them against the source), so the lint and the boot agree.
const HARD_SECRET_RE =
  /passwo?rd|passphrase|mnemonic|private[_-]?key|api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token/i;
const PUBLIC_HINT_RE =
  /(?:^|[_-])(?:pub|public|Pub|Public|PUB|PUBLIC)(?![a-z])|[a-z0-9](?:Pub|Public)(?![a-z])/;
const NONSECRET_SUFFIX_RE =
  /(Id|Ids|Type|Name|Count|Index|Idx|At|Ref|Kind|Length|Len|Path|Mode|Status|Flag|Enabled|Visible|Label|Order|Version|Ms|Sec|Secs|Seconds|Bytes|Kb|Mb|Gb|Hz|Pct|Percent|Ratio|Rate|Total|Avg|Min|Max|Size|Width|Height|Duration|Elapsed)$/;

export const checkCredentialFieldName: Checker = (ctx) => {
  const { tsFiles, tsxFiles, cells, report, pass } = ctx;
  let found = 0, checked = 0;
  for (const file of [...tsFiles, ...tsxFiles]) {
    if (/\.test\.tsx?$/.test(file.name)) continue;
    const raw = file.content;
    const code = codeText(raw);
    for (const m of codeMatches(raw, _CELL_BLOCK_RE)) {
      const name = m[1]!;
      const open = code.indexOf("{", m.index! + m[0].length - 1);
      const end = _balancedClose(code, open);
      if (end === -1) continue;
      const info = cells.find((c) =>
        c.name === name && c.file.path === file.path
      );
      if (!info?.stateIsLiteral) continue;
      // A client-scoped cell is never broadcast — nothing to leak.
      if (/\bscope\s*:\s*["'`]client["'`]/.test(raw.slice(open, end + 1))) {
        continue;
      }
      checked++;
      const vis = _staticVisibility(raw, code, open, end);
      const { top, leaves } = _hiddenOf(vis, info.stateKeys);
      const deepHeads = new Set(
        [...leaves.values()].map((p) => p.split(".")[0]!),
      );
      const bad = info.stateKeys.filter((k) =>
        !top.has(k) && !deepHeads.has(k) && !vis.publicFields.includes(k) &&
        HARD_SECRET_RE.test(k) && !PUBLIC_HINT_RE.test(k) &&
        !NONSECRET_SUFFIX_RE.test(k)
      );
      if (bad.length === 0) continue;
      const line = code.slice(0, m.index!).split("\n").length;
      if (isSuppressed(file.lines, line - 1)) continue;
      found++;
      const list = `[${bad.map((k) => `"${k}"`).join(", ")}]`;
      const one = bad.length === 1;
      report(
        "error",
        "security",
        `${file.relative}:${line} — cell "${name}" state ${
          one ? "field" : "fields"
        } ` +
          `${list} ${one ? "is" : "are"} named like a credential and visible ` +
          `to every client, so aio.run() REFUSES to boot in dev (tests do ` +
          `not compose the app; this is the same check, pre-boot). Hide ` +
          `${one ? "it" : "them"}: visible: { exclude: ${list} } — or, if ` +
          `${one ? "it" : "they"} genuinely ${one ? "is" : "are"} public ` +
          `(a label, not a secret), declare ${one ? "it" : "them"}: ` +
          `visible: { publicFields: ${list} }.`,
        {
          file: file.relative,
          line,
          fix:
            `visible: { exclude: ${list} }  // or publicFields: ${list} if truly public`,
        },
      );
    }
  }
  if (checked > 0 && found === 0) {
    pass("no credential-named state field is client-visible");
  }
};

// ══════════════════════════════════════════════════════════════════════
// EMPTY COLLECTION LITERALS IN CELL STATE
// ══════════════════════════════════════════════════════════════════════
//
// `state: { items: [] }` infers `never[]`, and every use of `items` in every
// method then fails with `Property 'x' does not exist on type 'never'` — a
// cascade of errors that point at the METHODS and never at the declaration
// that caused them. It is the first mistake a new app makes (measured on a
// fresh `am create`: one unannotated `[]` produced five errors, none of which
// named the array, the cell, or the fix).
//
// TypeScript cannot say it better, because from its side nothing is wrong at
// the declaration. The linter can: it knows this is CELL STATE, where an empty
// collection is always a placeholder for something.

export const checkEmptyStateCollection: Checker = (ctx) => {
  const { cells, report } = ctx;
  for (const c of cells) {
    if (c.file.name.endsWith(".test.ts") || !c.stateIsLiteral) continue;
    const code = codeText(c.file.content);
    const span = cellLiteralSpan(code, c.line);
    if (!span) continue;
    const lit = code.slice(span[0], span[1]);
    const sm = /\bstate\s*:\s*\{/.exec(lit);
    if (!sm) continue;
    const sIdx = sm.index + sm[0].length;
    let depth = 1, sEnd = sIdx;
    for (let i = sIdx; i < lit.length && depth > 0; i++) {
      if (lit[i] === "{") depth++;
      else if (lit[i] === "}") {
        depth--;
        if (depth === 0) sEnd = i;
      }
    }
    const stateBlock = lit.slice(sIdx, sEnd);
    // `key: []` / `key: {}` / `key: new Map()` — the empty forms whose type is
    // useless. A trailing `as …` / `satisfies …` is the annotation we are
    // asking for, so it is never reported.
    const EMPTY =
      /([$\w]+)\s*:\s*(\[\s*\]|new\s+(?:Map|Set)\s*\(\s*\))(?!\s*(?:as|satisfies)\b)/g;
    for (const m of stateBlock.matchAll(EMPTY)) {
      // Top level of `state:` only — a nested `{ filters: { tags: [] } }` is
      // the same trap but the fix reads differently, and being conservative is
      // what keeps a rule worth reading.
      let kd = 0;
      for (const ch of stateBlock.slice(0, m.index)) {
        if (ch === "{" || ch === "[") kd++;
        else if (ch === "}" || ch === "]") kd--;
      }
      if (kd !== 0) continue;
      const at = span[0] + sIdx + m.index;
      const line = code.slice(0, at).split("\n").length;
      if (isSuppressed(c.file.lines, line - 1)) continue;
      const key = m[1]!;
      const isArray = m[2]!.startsWith("[");
      const example = isArray
        ? `${key}: [] as ${
          key.charAt(0).toUpperCase() + key.slice(1).replace(/s$/, "")
        }[]`
        : `${key}: ${m[2]!.replace(/\(\s*\)$/, "()")} as ${
          m[2]!.startsWith("new Map") ? "Map<string, Item>" : "Set<string>"
        }`;
      report(
        "warn",
        "cells",
        `${c.file.relative}:${line} — \`${key}: ${m[2]}\` in ${c.name}'s ` +
          `state has no element type, so TypeScript infers ` +
          `${isArray ? "`never[]`" : "an empty collection type"} and EVERY ` +
          `use of \`s.${key}\` in every method fails with ` +
          `"does not exist on type 'never'" — errors that point at the ` +
          `methods and never at this line. ` +
          `fix: annotate the element type here — \`${example}\` ` +
          `(declare the type above the cell, or inline it: ` +
          `\`[] as { id: number; title: string }[]\`).`,
        {
          file: c.file.relative,
          line,
          manual: "annotate the element type",
        },
      );
    }
  }
};

// ══════════════════════════════════════════════════════════════════════
// 27. WHAT THE SCAN COULD NOT READ
// ══════════════════════════════════════════════════════════════════════
//
// A linter that reads nothing prints exactly what a clean project prints: no
// findings, a green verdict, exit 0. Two silent skips produced that — a file
// over 512 KB, and any code outside the scanned roots — and an audit planted a
// credential field and a `Deno.env` leak in a project laid out as `app/` and
// got `Files: 0`, no findings, exit 0. Coverage is now stated, and NO coverage
// is an error, because "I found nothing" and "I looked at nothing" must never
// print the same thing.

export const checkScanCoverage: Checker = (ctx) => {
  const { sourceFiles, skipped, unscannedDirs, projectDir, report, pass } = ctx;

  for (const s of skipped) {
    report(
      "warn",
      "scan",
      `${s.path} was NOT read (${s.reason}) — every rule is silent about it, ` +
        `which reads exactly like a clean file`,
      {
        file: s.path,
        fix:
          "Split it, or generate it into a directory aiol does not scan, so the " +
          "silence is deliberate rather than accidental",
      },
    );
  }

  if (sourceFiles.length === 0) {
    report(
      "error",
      "scan",
      `no source files found in ${projectDir} — aiol read ZERO files, so every ` +
        `check below it passed by default. Its scan covers ${
          SCANNED_ROOTS.join("/, ")
        }/ and root-level .ts/.tsx${
          unscannedDirs.length
            ? `; this project keeps code in ${
              unscannedDirs.map((d) => `${d}/`).join(", ")
            }`
            : ""
        }`,
      {
        fix: unscannedDirs.length
          ? `Move the app's code under src/ (or point aiol at the right ` +
            `directory: \`aiol ${unscannedDirs[0]}\`)`
          : "Run aiol from the project root, or pass the project directory",
      },
    );
    return;
  }

  if (unscannedDirs.length > 0) {
    report(
      "hint",
      "scan",
      `${
        unscannedDirs.map((d) => `${d}/`).join(", ")
      } hold .ts/.tsx that aiol does not read — its scan covers ${
        SCANNED_ROOTS.join("/, ")
      }/ and root-level files`,
      {
        fix:
          "Move shipped code under src/ (or build/dev code under scripts/ or " +
          "tools/) so it is checked; nothing in those directories is.",
      },
    );
  }

  pass(
    `${sourceFiles.length} file(s) read${
      skipped.length ? ` (${skipped.length} skipped, listed above)` : ""
    }`,
  );
};

// ══════════════════════════════════════════════════════════════════════
// 28. ALPHA70 — ONE IMPORT PATH PER SYMBOL (and three removed spellings)
// ══════════════════════════════════════════════════════════════════════
//
// The last compatibility-breaking release. Every fact here is a row in
// src/state/removals.ts — this rule reads the row and prints its message, so
// the linter, the runtime and the upgrade guide cannot drift. `--safe-fix`
// moves the import (split the statement: moved names to the new entry, the
// rest stay) or keeps a removed alias behaviour-identical
// (`import { checkCells as lint }`), so a project lints clean in one run.

/** Where each duplicate home's names went. `key` is the registry row. */
const ALPHA70_MOVES: ReadonlyArray<fix.MovedImports & { key: string }> = [
  {
    key: 'import { createDB } from "aio/db"',
    from: "aio/db",
    to: "aio/server",
    valuesOnly: true,
    names: new Set([
      "createDB",
      "DEFAULT_PRAGMAS",
      "initSchema",
      "loadTables",
      "syncTables",
      "reactiveDB",
    ]),
  },
  {
    key: 'import { shipApp } from "aio/build"',
    from: "aio/build",
    to: "aio/ship",
    names: new Set([
      "buildShipManifest",
      "generateSigningKey",
      "shipApp",
      "verifyShipManifest",
      "ShipManifest",
    ]),
  },
  {
    key: 'import { appDirs } from "aio/testing"',
    from: "aio/testing",
    to: "aio/server",
    names: new Set(["appDirs", "AppDirs"]),
  },
  {
    key: 'import { installUpdatesRuntime } from "aio/testing"',
    from: "aio/testing",
    to: "aio/updates",
    names: new Set([
      "installUpdatesRuntime",
      "UpdatesRuntime",
      "ApplyOptions",
      "CheckOptions",
      "CheckResult",
    ]),
  },
  {
    key: 'import { testComponent } from "aio/air"',
    from: "aio/air",
    to: "aio/testing",
    names: new Set([
      "testComponent",
      "setDocument",
      "TestComponentHandle",
      "TestComponentOptions",
    ]),
  },
  {
    key: 'import { testCell } from "aio"',
    from: "aio",
    to: "aio/testing",
    names: new Set(["testCell", "TestContext"]),
  },
];

/** Removed aliases: the old local name stays, bound to the surviving symbol. */
const ALPHA70_ALIASES: ReadonlyArray<
  { key: string; spec: string; old: string; now: string }
> = [
  {
    key: 'lint() from "aio/extras"',
    spec: "aio/extras",
    old: "lint",
    now: "checkCells",
  },
  { key: "testgen()", spec: "aio/testing", old: "testgen", now: "testGen" },
];

const IMPORT_RE = /import\s*(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']+["'];?/g;

export const checkAlpha70Removals: Checker = (ctx) => {
  const { tsFiles, tsxFiles, appEntry, report, pass } = ctx;
  let found = 0;
  for (const file of [...tsFiles, ...tsxFiles]) {
    const lineOf = (idx: number) =>
      file.content.slice(0, idx).split("\n").length;
    for (const m of codeMatches(file.content, IMPORT_RE)) {
      const stmt = m[0];
      const line = lineOf(m.index!);
      if (isSuppressed(file.lines, line - 1)) continue;
      for (const mv of ALPHA70_MOVES) {
        if (fix.moveImports(stmt, mv) === null) continue;
        found++;
        // A component cannot open a database: swapping the specifier there
        // turns a removal into a server-only boundary error, so the fix is
        // declined and the real move (into a cell method) is named.
        const componentDb = mv.from === "aio/db" && file.ext === ".tsx";
        report(
          "error",
          "upgrade",
          removalMessage(removalOf(mv.key), `${file.relative}:${line}`),
          {
            file: file.relative,
            line,
            fix: componentDb
              ? "a component cannot open a database — move the call into a " +
                "cell method, which runs on the server"
              : `import { … } from "${mv.to}"`,
            safeFix: componentDb
              ? undefined
              : fix.fixMovedImports(file.path, mv),
            manual: componentDb
              ? "move the database call into a cell method"
              : undefined,
          },
        );
      }
      for (const al of ALPHA70_ALIASES) {
        if (fix.aliasRename(stmt, al.spec, al.old, al.now) === null) continue;
        found++;
        report(
          "error",
          "upgrade",
          removalMessage(removalOf(al.key), `${file.relative}:${line}`),
          {
            file: file.relative,
            line,
            fix: `import { ${al.now} as ${al.old} } from "${al.spec}"`,
            safeFix: fix.fixAliasRename(file.path, al.spec, al.old, al.now),
          },
        );
      }
    }
  }
  // `memory.gcStressRatio` — accepted and never read; boot refuses it now.
  if (appEntry) {
    const code = codeText(appEntry.content);
    const m = /\bgcStressRatio\s*:/.exec(code);
    if (m) {
      const line = code.slice(0, m.index).split("\n").length;
      if (!isSuppressed(appEntry.lines, line - 1)) {
        found++;
        report(
          "error",
          "upgrade",
          removalMessage(
            removalOf("memory.gcStressRatio"),
            `${appEntry.relative}:${line}`,
          ),
          {
            file: appEntry.relative,
            line,
            fix: "delete the key",
            manual: "delete `gcStressRatio:` from `memory: { … }`",
          },
        );
      }
    }
  }
  if (found === 0) pass("no alpha70-removed import path or alias in use");
};

/** alpha70 word renames — the old name has ONE meaning, so a masked-code word
 *  replace is the whole migration. `Action` is not here: it is an app's own
 *  word too, so its import specifier is aliased instead (below). */
const ALPHA70_WORDS: ReadonlyArray<
  { key: string; from: string; to: string; pattern: RegExp }
> = [
  {
    key: "CellAccess",
    from: "CellAccess",
    to: "Access",
    pattern: /\bCellAccess\b/,
  },
  {
    key: "ServerFnAccess",
    from: "ServerFnAccess",
    to: "Access",
    pattern: /\bServerFnAccess\b/,
  },
  {
    key: "ExtractState",
    from: "ExtractState",
    to: "StateOf",
    pattern: /\bExtractState\b/,
  },
  {
    key: "connectDevTools()",
    from: "connectDevTools",
    to: "connectReduxDevTools",
    pattern: /\bconnectDevTools\b/,
  },
  {
    key: "connectDevTools()",
    from: "disconnectDevTools",
    to: "disconnectReduxDevTools",
    pattern: /\bdisconnectDevTools\b/,
  },
];

export const checkAlpha70Renames: Checker = (ctx) => {
  const { tsFiles, tsxFiles, report, pass } = ctx;
  let found = 0;
  for (const file of [...tsFiles, ...tsxFiles]) {
    const code = codeText(file.content);
    const lineOf = (idx: number) => code.slice(0, idx).split("\n").length;
    const seen = new Set<string>();
    for (const w of ALPHA70_WORDS) {
      const m = w.pattern.exec(code);
      if (!m || seen.has(w.key)) continue;
      const line = lineOf(m.index);
      if (isSuppressed(file.lines, line - 1)) continue;
      seen.add(w.key);
      found++;
      report(
        "error",
        "upgrade",
        removalMessage(removalOf(w.key), `${file.relative}:${line}`),
        {
          file: file.relative,
          line,
          fix: `${w.from} → ${w.to}`,
          safeFix: fix.fixRenameWords(
            file.path,
            ALPHA70_WORDS.filter((x) => x.key === w.key).map((
              x,
            ) => [x.from, x.to] as const),
          ),
        },
      );
    }
    // `type Action` from aio/air → `type NodeAction as Action`: the local name
    // survives (an app may use `Action` for its own things), the import is
    // the one line that changes.
    for (const m of codeMatches(file.content, IMPORT_RE)) {
      if (!/from\s*["']aio\/air["']/.test(m[0])) continue;
      if (!/\btype\s+Action\s*[,}]/.test(m[0])) continue;
      const line = lineOf(m.index!);
      if (isSuppressed(file.lines, line - 1)) continue;
      found++;
      report(
        "error",
        "upgrade",
        removalMessage(
          removalOf("Action (aio/air)"),
          `${file.relative}:${line}`,
        ),
        {
          file: file.relative,
          line,
          fix: 'import { type NodeAction as Action } from "aio/air"',
          safeFix: fix.fixAliasRename(
            file.path,
            "aio/air",
            "Action",
            "NodeAction",
          ),
        },
      );
    }
    // `schedule.blocking(` → `blocking(` (+ the import).
    const b = /\bschedule\.blocking\s*\(/.exec(code);
    if (b) {
      const line = lineOf(b.index);
      if (!isSuppressed(file.lines, line - 1)) {
        found++;
        report(
          "error",
          "upgrade",
          removalMessage(
            removalOf("schedule.blocking"),
            `${file.relative}:${line}`,
          ),
          {
            file: file.relative,
            line,
            fix: 'import { blocking } from "aio"; blocking("id", fn, arg)',
            safeFix: fix.fixScheduleBlocking(file.path),
          },
        );
      }
    }
  }
  if (found === 0) pass("no alpha70-renamed symbol in use");
};

// ══════════════════════════════════════════════════════════════════════
// 29. THE LIVE DRAFT ESCAPES THE METHOD
// ══════════════════════════════════════════════════════════════════════
//
// `s` is a live proxy over the cell's draft. It is valid for exactly the span
// of the method (an async method: until it settles). Parked in a module-level
// variable, or captured by a callback that is stored outside the method, it
// outlives that span — and the runtime cannot track it: a later read serves
// stale data, a later write throws (a finalized draft) or lands on nothing the
// store sees. The shape is lexical, so the linter is the guard.
//
// EXACT CRITERION (error): inside a cell method whose draft parameter is `P`,
//   (a) `P` itself is assigned or pushed into a MODULE-LEVEL binding of this
//       file (`let`/`var`/`const` declared at column 0, or `globalThis`):
//       `X = P`, `X.y = P`, `X.push(P)`, `X.set(k, P)`, `X.add(P)`; or
//   (b) a function literal whose text references `P` is assigned to, or
//       pushed/set/added/registered (`push|set|add|on|once|subscribe|
//       addEventListener|addListener`) on, such a binding.
// Not a hit: `P` handed to `own.set`, `s.$do`, `schedule.*`, a local `const`,
// or a callback that copies plain data (`{ ...P }`, `P.items.slice()`) —
// those do not reference `P` after the copy.

/** Offsets of a cell's CONFIG literal (`{` … `}` — the second argument), or
 *  null. `cellLiteralSpan` returns the CALL's parentheses; a rule that walks
 *  `methods:` needs the object one level in. */
function _cellConfigSpan(
  code: string,
  declLine: number,
): [number, number] | null {
  const call = cellLiteralSpan(code, declLine);
  if (!call) return null;
  const open = code.indexOf("{", call[0]);
  if (open < 0 || open > call[1]) return null;
  const close = _balancedClose(code, open);
  return close === -1 ? null : [open, close];
}

/** Column-0 `let|var|const` names (+ `globalThis`) — the module's own scope. */
function _moduleBindings(code: string): string[] {
  const out = new Set<string>(["globalThis"]);
  for (
    const m of code.matchAll(/^(?:export\s+)?(?:let|var|const)\s+([$\w]+)/gm)
  ) out.add(m[1]!);
  return [...out];
}

/** The extent of a function literal starting at `at` (its `=>` or `function`
 *  keyword): block body → balanced `}`; expression body → the depth-0 `,`,
 *  `;` or closing bracket. Returns the body text. */
function _fnLiteralBody(code: string, at: number): string {
  const rest = code.slice(at);
  const brace = /^(?:=>|function\b[^{]*)\s*\{/.exec(rest);
  if (brace) {
    const open = at + brace[0].length - 1;
    const close = _balancedClose(code, open);
    return close === -1 ? rest : code.slice(open, close + 1);
  }
  let d = 0;
  for (let i = at + 2; i < code.length; i++) {
    const ch = code[i]!;
    if ("({[".includes(ch)) d++;
    else if (")}]".includes(ch)) {
      if (d === 0) return code.slice(at, i);
      d--;
    } else if ((ch === "," || ch === ";") && d === 0) return code.slice(at, i);
  }
  return rest;
}

export const checkProxyEscape: Checker = (ctx) => {
  const { cells, report, pass } = ctx;
  let found = 0, checked = 0;
  for (const cell of cells) {
    const raw = cell.file.content;
    const code = codeText(raw);
    const bindings = _moduleBindings(code);
    if (bindings.length === 0) continue;
    const span = _cellConfigSpan(code, cell.line);
    if (!span) continue;
    const meth = _blockOf(code, span[0], span[1], "methods");
    if (!meth) continue;
    const X = `(?:${bindings.map((b) => b.replace(/\$/g, "\\$")).join("|")})`;
    for (const fn of _members(code, meth[0], meth[1])) {
      const P = fn.param;
      if (!P) continue;
      checked++;
      const p = P.replace(/\$/g, "\\$");
      const sink = `\\b${X}(?:\\.[$\\w]+|\\[[^\\]]*\\])*\\s*`;
      const hits: Array<{ at: number; how: string }> = [];
      // (a) the proxy itself, stored.
      const direct = new RegExp(
        `${sink}(?:=(?!=)\\s*${p}\\b(?![$\\w.(\\[])|\\.(?:push|add|set)\\s*\\((?:[^()]*,\\s*)?${p}\\s*\\))`,
        "g",
      );
      for (const m of fn.body.matchAll(direct)) {
        hits.push({ at: m.index!, how: `stores \`${P}\` itself` });
      }
      // (b) a callback that closes over the proxy, stored.
      const cb = new RegExp(
        `${sink}(?:=(?!=)|\\.(?:push|set|add|on|once|subscribe|addEventListener|addListener)\\s*\\()`,
        "g",
      );
      for (const m of fn.body.matchAll(cb)) {
        const from = m.index! + m[0].length;
        const lit =
          /^[^;{}]*?((?:async\s*)?(?:\([^)]*\)|[$\w]+)\s*=>|\bfunction\b)/
            .exec(fn.body.slice(from, from + 400));
        if (!lit) continue;
        const kw = lit[1]!;
        const litAt = from + lit.index + lit[0].length -
          (kw.endsWith("=>") ? 2 : "function".length);
        const body = _fnLiteralBody(fn.body, litAt);
        if (!new RegExp(`\\b${p}\\b`).test(body)) continue;
        hits.push({
          at: m.index!,
          how: `stores a callback that reads \`${P}\``,
        });
      }
      for (const h of hits) {
        const line = code.slice(0, fn.start + h.at).split("\n").length;
        if (isSuppressed(cell.file.lines, line - 1)) continue;
        found++;
        report(
          "error",
          "cells",
          `${cell.file.relative}:${line} — \`${cell.name}.${fn.name}()\` ${h.how} ` +
            `in a module-level binding. \`${P}\` is a LIVE draft, valid only ` +
            `while the method runs; outside it a read is stale and a write ` +
            `throws (dev and prod alike) — and the runtime cannot see the ` +
            `escape, so nothing warns until it fires.\n` +
            `      fix: keep \`${P}\` inside the method — store plain data ` +
            `(\`{ ...${P} }\`, \`${P}.items.slice()\`), call the cell from ` +
            `the callback instead (\`${cell.name}.${fn.name}()\` re-enters ` +
            `with a fresh draft), or hold the resource with \`own.set()\`.`,
          { file: cell.file.relative, line },
        );
      }
    }
  }
  if (checked > 0 && found === 0) pass("no method lets its live draft escape");
};

// ══════════════════════════════════════════════════════════════════════
// 30. I/O IN A SYNC METHOD (a reducer)
// ══════════════════════════════════════════════════════════════════════
//
// A sync method IS the reducer: it runs inside the dispatch loop, and its
// mutations of `s` are the next state. `fetch()` there returns a Promise the
// state never sees; `Deno.readTextFileSync()` there blocks every other method
// of the app for the duration. Both are one keyword away from correct.
//
// EXACT CRITERION (error): a non-async member of a cell's `methods:` whose
// body — with every NESTED function literal blanked, so a callback handed to
// `own.set` / `s.$do` / `schedule` is not the method's own body — calls
// `fetch(` or `Deno.<io>(` where <io> is a file/process/network/KV operation
// (the list below). `Deno.env`, `Deno.cwd`, `Deno.build`, `Deno.inspect` are
// not I/O and never fire.

const DENO_IO =
  "(?:readTextFile|readFile|writeTextFile|writeFile|open|create|" +
  "stat|lstat|readDir|mkdir|remove|rename|copyFile|readLink|realPath|truncate|" +
  "utime|chmod|chown|symlink|link|makeTempDir|makeTempFile|watchFs|Command|run|" +
  "connect|connectTls|listen|listenTls|listenDatagram|serve|serveHttp|" +
  "upgradeWebSocket|openKv|resolveDns|startTls)(?:Sync)?";
const SYNC_IO_RE = new RegExp(`\\b(fetch|Deno\\.${DENO_IO})\\s*\\(`);

/** `body` with every nested function literal's body blanked (offsets kept). */
function _blankNestedFns(body: string): string {
  let out = body;
  const re = /=>|\bfunction\b/g;
  for (const m of body.matchAll(re)) {
    const lit = _fnLiteralBody(body, m.index!);
    const from = m.index! + (m[0] === "=>" ? 2 : 0);
    const to = m.index! + lit.length;
    out = out.slice(0, from) + out.slice(from, to).replace(/[^\n]/g, " ") +
      out.slice(to);
  }
  return out;
}

export const checkSyncMethodIO: Checker = (ctx) => {
  const { cells, report, pass } = ctx;
  let found = 0, checked = 0;
  for (const cell of cells) {
    const code = codeText(cell.file.content);
    const span = _cellConfigSpan(code, cell.line);
    if (!span) continue;
    const meth = _blockOf(code, span[0], span[1], "methods");
    if (!meth) continue;
    for (const fn of _members(code, meth[0], meth[1])) {
      if (fn.async) continue;
      checked++;
      const m = SYNC_IO_RE.exec(_blankNestedFns(fn.body));
      if (!m) continue;
      const line = code.slice(0, fn.start + m.index).split("\n").length;
      if (isSuppressed(cell.file.lines, line - 1)) continue;
      found++;
      report(
        "error",
        "cells",
        `${cell.file.relative}:${line} — \`${cell.name}.${fn.name}()\` is a ` +
          `SYNC method (the reducer) and calls \`${m[1]}()\`. A reducer runs ` +
          `inside the dispatch loop: a Promise it returns is not state, and ` +
          `sync I/O there blocks every other method of the app.\n` +
          `      fix: make it \`async ${fn.name}(${fn.param || "s"}, …)\` — ` +
          `await the I/O, then write \`${fn.param || "s"}\`; or keep the ` +
          `method sync and hand the I/O to \`${fn.param || "s"}.$do(…)\`.`,
        {
          file: cell.file.relative,
          line,
          fix: `async ${fn.name}(${fn.param || "s"}) { const r = await ${
            m[1]
          }(…); ${fn.param || "s"}.x = r }`,
        },
      );
    }
  }
  if (checked > 0 && found === 0) pass("no sync method performs I/O");
};

// ══════════════════════════════════════════════════════════════════════
// 31. `own.set` KEYED BY A CONSTANT WHILE THE RESOURCE VARIES
// ══════════════════════════════════════════════════════════════════════
//
// `own.set(key, factory)` has REPLACE semantics: setting a key again disposes
// what it held. That is the point when the key names one thing ("the watcher")
// and a trap when it names a family: `watch(s, path) { own.set("watcher", () =>
// Deno.watchFs(path)) }` silently closes the first path's watcher the moment a
// second path is watched — and nothing reports it, because replacing IS the
// contract.
//
// EXACT CRITERION (warn): an `own.set(KEY, …)` where KEY is a plain string
// literal (no `${}`), lexically inside a function or method with a parameter
// whose name is resource-id shaped (ends in id/key/name/path/url/uri/host/
// port/file/dir/handle/addr/address, case-insensitive; the draft `s` is never
// one), AND that parameter appears in the call's REMAINING arguments (the
// factory) — the resource depends on the id, the key does not. A literal key
// in a function without such a parameter, a template key, or a factory that
// does not use the id are not hits.

const ID_PARAM_RE =
  /(?:^|[a-z_])(?:id|key|name|path|url|uri|host|port|file|dir|handle|addr|address)$/i;

/** `_balancedClose` for a call's parentheses. */
function _balancedParen(stripped: string, open: number): number {
  let depth = 0;
  for (let i = open; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Innermost function (header params + body span) enclosing `at`. */
function _enclosingFn(
  code: string,
  at: number,
): { params: string[]; open: number } | null {
  const re =
    /(?:\bfunction\b\s*[$\w]*\s*\(([^(){}]*)\)|(?:\b[$\w]+\s*(?::\s*)?(?:async\s+)?)?\(([^(){}]*)\)\s*(?::[^{=]*)?(?:=>)?)\s*\{/g;
  let best: { params: string[]; open: number } | null = null;
  for (const m of code.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    if (open >= at) break;
    const close = _balancedClose(code, open);
    if (close < at) continue;
    const list = (m[1] ?? m[2] ?? "").split(",").map((p) =>
      p.trim().replace(/[:=?].*$/s, "").replace(/^\.\.\./, "").trim()
    ).filter(Boolean);
    best = { params: list, open };
  }
  return best;
}

export const checkOwnKeyIdentity: Checker = (ctx) => {
  const { tsFiles, tsxFiles, report, pass } = ctx;
  let found = 0, checked = 0;
  for (const file of [...tsFiles, ...tsxFiles]) {
    if (/\.test\.tsx?$/.test(file.name)) continue;
    const raw = file.content;
    const code = codeText(raw);
    for (const m of codeMatches(raw, /\bown\.set\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const close = _balancedParen(code, open);
      if (close === -1) continue;
      checked++;
      const argsRaw = raw.slice(open + 1, close).trim();
      const key = /^(["'])((?:(?!\1).)*)\1\s*,/.exec(argsRaw);
      if (!key) continue; // template / variable key: identity is the author's
      const rest = code.slice(open + 1 + key[0].length, close);
      const fn = _enclosingFn(code, open);
      if (!fn) continue;
      const id = fn.params.find((p) =>
        ID_PARAM_RE.test(p) &&
        new RegExp(`\\b${p.replace(/\$/g, "\\$")}\\b`).test(rest)
      );
      if (!id) continue;
      const line = code.slice(0, open).split("\n").length;
      if (isSuppressed(file.lines, line - 1)) continue;
      found++;
      report(
        "warn",
        "patterns",
        `${file.relative}:${line} — \`own.set("${
          key[2]
        }", …)\` keys a resource ` +
          `built from \`${id}\` by a constant. \`own\` REPLACES on re-set, so ` +
          `the second \`${id}\` disposes the first's resource — silently, ` +
          `because replacing is the contract.\n` +
          `      fix: key by the resource's identity — ` +
          `own.set(\`${key[2]}:\${${id}}\`, …) — or, if one-at-a-time is the ` +
          `intent, say so: // aiol-ok: one ${key[2]} at a time`,
        {
          file: file.relative,
          line,
          fix: `own.set(\`${key[2]}:\${${id}}\`, …)`,
        },
      );
    }
  }
  if (checked > 0 && found === 0) pass("every own.set key names its resource");
};

export const ALL_CHECKS: Checker[] = [
  checkScanCoverage,
  checkConfig,
  checkStructure,
  checkCells,
  checkPerformance,
  checkSecurity,
  checkPersistence,
  checkUI,
  checkTesting,
  checkPatterns,
  checkBuild,
  checkInterCell,
  checkScheduling,
  checkMemoUsage,
  checkImports,
  checkUpgrade,
  checkPostAwaitRead,
  checkSelfMethodCall,
  checkWorkerPeerReads,
  checkUseCell,
  checkAlpha52,
  checkAlpha52Surface,
  checkLiveHazard,
  checkOldWayPerfBudget,
  checkTestHandleSelectors,
  checkSyncMethodHiddenReads,
  checkCredentialFieldName,
  checkEmptyStateCollection,
  checkAlpha70Removals,
  checkAlpha70Renames,
  checkProxyEscape,
  checkSyncMethodIO,
  checkOwnKeyIdentity,
];
