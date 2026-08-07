// aiol — all lint checks organized by area

import type { CellInfo, Checker } from "./types.ts";
import { join, resolve } from "@std/path";
import * as fix from "./fixes.ts";
import { RESERVED_KEYS } from "../src/state/cell-types.ts";
import { AIO_LIBRARY_ENTRIES } from "../src/entries.ts";
import { removalMessage, removalOf } from "../src/state/removals.ts";
import { linkSatisfiesPin } from "../src/server/framework-pin.ts";
import { codeMatches, codeText } from "./scan.ts";

// ══════════════════════════════════════════════════════════════════════
// 1. PROJECT CONFIG (deno.json)
// ══════════════════════════════════════════════════════════════════════

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
  if (dj.appId) {
    const passesAppId = /\bappId\s*:/.test(ctx.appEntry?.content ?? "");
    report(
      passesAppId ? "hint" : "warn",
      "config",
      passesAppId
        ? `appId "${dj.appId}" is in deno.json AND aio.run() — the aio.run() one wins; the deno.json key only helps \`am\` find the app`
        : `appId "${dj.appId}" in deno.json — move to aio.run({ appId: "${dj.appId}" }) (compiled builds can't read deno.json)`,
      {
        fix: passesAppId
          ? 'Optional: remove "appId" from deno.json (aio.run() already sets it)'
          : 'Remove "appId" from deno.json and add appId to aio.run()',
        // Only offer the codemod when the value isn't already in the entry —
        // otherwise --safe-fix would "fix" a correct app.
        ...(passesAppId ? {} : { safeFix: fix.fixRemoveAppId }),
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
  const compileTargets = Object.keys(tasks).filter((k) =>
    k.startsWith("compile:")
  );
  if (compileTargets.length) {
    pass(`compile targets: ${compileTargets.join(", ")}`);
  } else {report(
      "hint",
      "config",
      "no compile tasks defined — add compile:browser, compile:electron, etc. for production builds",
    );}

  // Framework pin vs dep/aio — the promise `am pin` seals. `doctor` checked
  // it, but doctor is the diagnostic nobody runs on a green build: lint, test
  // and dev all stayed green while dep/aio sat one version past the pin (a
  // field report). aiol walks deno.json for every other fact it reports; the
  // pin is one more. `linkSatisfiesPin` is THE decider (shared with doctor,
  // `am pin`, `am fix`), so the verdicts cannot contradict each other.
  const pin = typeof (dj as { aioVersion?: unknown }).aioVersion === "string"
    ? (dj as { aioVersion: string }).aioVersion
    : null;
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
      report(
        "warn",
        "config",
        `framework pin ${pin} does not match dep/aio (→ ${linked}) — ` +
          "the app runs a version it does not declare. " +
          "Run `am pin <version>` to move the pin, or `am fix` to relink",
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
  if (appEntry) pass("entry: src/app.ts");
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
    } else {report(
        "warn",
        "structure",
        "no entry point found (src/app.ts) — create one with aio.run()",
      );}
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
    // "Unused" only if NOTHING in the project builds a UI. One app is many
    // targets: the scaffold's `dev` runs server-only while `dev:browser`,
    // `dev:electron` and `compile:android` all mount App.tsx — calling it
    // unused told a brand-new app to delete a file its own tasks need
    //.
    const uiTargets = (denoJson?.build as { targets?: string[] } | undefined)
      ?.targets ?? [];
    const uiTask = Object.values(tasks).some((t) =>
      /--client[= ](?:browser|electron)|--electron\b|--android\b/.test(t)
    );
    const buildsUI = uiTask ||
      uiTargets.some((t) => ["browser", "electron", "android"].includes(t));
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
          safeFix: fix.fixAddAppIdToRun,
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
      report(
        "error",
        "cells",
        removalMessage(removalOf(key), `cell "${f.name}"`),
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
    for (
      const m of file.content.matchAll(
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

    // No methods and no actions
    if (!f.hasMethods && !f.hasActions) {
      report(
        "warn",
        "cells",
        `cell "${f.name}" has no methods and no actions — it can't change state`,
        loc,
      );
    }

    // Both methods and actions (mixing styles)
    if (f.hasMethods && f.hasActions) {
      report(
        "warn",
        "cells",
        `cell "${f.name}" has both methods and actions — pick one style`,
        loc,
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
  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts")) continue;
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
            `schedule.blocking("id", fn, arg)`,
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
    if (file.name.endsWith(".test.ts") || file.name === "app.ts") continue;
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
  // Not in TOOLING either (field report, llama-master #9): a developer command
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
  const isTooling = (f: typeof sourceFiles[number]) =>
    !isAppSurface(f) && (!inAppSourceDir(f) || /^#!/.test(f.content));
  const isCliClient = (f: typeof sourceFiles[number]) =>
    /\bconnectCli\b/.test(codeText(f.content));
  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts")) continue;
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

  // --expose without auth
  if (appEntry) {
    const hasExpose = appEntry.content.includes("expose") ||
      appEntry.content.includes("--expose");
    const hasUsers = appEntry.content.includes("users:") ||
      appEntry.content.includes("users :");
    if (hasExpose && !hasUsers) {
      // Check if there's a token config
      if (!appEntry.content.includes("token")) {
        report(
          "warn",
          "security",
          "app uses --expose without explicit user auth — auto-generated token will be printed to console but not persisted",
          { file: appEntry.relative },
        );
      }
    }
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
  const SERVER_ONLY_PREFIXES_CHECK2 = ["@std/", "node:"];

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
      if (BROWSER_IMPORTS.has(spec) || isAioEntry(spec)) continue;
      if (denoImports.has(spec)) continue; // in deno.json → auto-aliased
      if (SERVER_ONLY_PREFIXES_CHECK2.some((p) => spec.startsWith(p))) continue; // caught by Check 1
      const lineIdx = file.content.slice(0, m.index).split("\n").length;
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
        BROWSER_IMPORTS.has(spec) || isAioEntry(spec) || denoImports.has(spec)
      ) continue;
      if (SERVER_ONLY_PREFIXES_CHECK2.some((p) => spec.startsWith(p))) continue;
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
  const SERVER_ONLY_PREFIXES = ["@std/", "node:", "aio/server"];
  // AIO-424: server-only SYMBOLS that live in the isomorphic "aio"
  // entry — the browser build of "aio" omits them, so a STATIC import into a
  // cell (shared with the browser bundle) link-fails at boot with an anonymous
  // "does not provide an export named X" blank screen that every server-side
  // check (check/test/lint) passes. Pure schema helpers (table/pk/text/…) stay
  // out of this set — they're browser-safe.
  const SERVER_ONLY_AIO_SYMBOLS = new Set([
    "createDB",
    "DEFAULT_PRAGMAS",
    "connectCli",
    "connectCliUDS",
  ]);
  for (const file of cellFiles) {
    // Skip .tsx files — already checked above
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

    // Deno.* usage. The old "is there a `//` or a `*` earlier on this line?"
    // heuristic was wrong in BOTH directions: `s.count = 2 * Deno.pid` was
    // silently skipped (a `*` is multiplication, not a comment), and a
    // `Deno.readTextFile` named inside a STRING was reported as an ERROR that
    // fails the gate. `codeText` is the one decider for "is this real code".
    const code = codeText(file.content);
    for (const m of code.matchAll(/\bDeno\.\w+/g)) {
      const before = code.slice(0, m.index);
      const lineIdx = before.split("\n").length;
      report(
        "error",
        "ui",
        `${file.relative}:${lineIdx} — ${
          m[0]
        } is server-only but this file contains a cell() definition shared with the browser bundle`,
        {
          file: file.relative,
          line: lineIdx,
          fix: "Move Deno.* calls to a server-only file or async method",
        },
      );
    }
  }

  // Check 3: Transitive server-only import detection (2 levels from App.tsx)
  if (appTsx) {
    const SERVER_ONLY_IMPORT_RE =
      /(?:import|export)\s+(?!type\s).*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/g;
    const LOCAL_IMPORT_RE =
      /(?:import|export)\s+.*?\s+from\s+['"](\.[^'"]+)['"]/g;

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
              fix:
                "Move server-only code to a file that is dynamically imported",
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
      if (target.endsWith(".server.ts")) continue;
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
  const testedCells = new Set<string>();
  for (const tf of testFiles) {
    for (const f of cells) {
      if (
        tf.content.includes(`'${f.name}'`) ||
        tf.content.includes(`"${f.name}"`) || tf.content.includes(f.name)
      ) {
        testedCells.add(f.name);
      }
    }
  }

  const untestedCells = cells.filter((f) => !testedCells.has(f.name));
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
 *  (field report, llama-master #4). The old test was line-level (`does this
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
export function draftReadOffsets(code: string, param: string): number[] {
  const out: number[] = [];
  // `(?<![\w$.])` — `other.s.count` is not a read of `s`.
  // `(?!\$)` — draft META (`s.$signal`, `s.$live`, `s.$commit`) is framework
  // surface, not app state another action can move under you.
  const startRe = new RegExp(`(?<![\\w$.])${param}\\.(?!\\$)[\\w$]`, "g");
  for (const m of code.matchAll(startRe)) {
    const start = m.index!;
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

    // Thrown exceptions in cell code (prefer Result pattern). Fires only on an
    // actual `cell('name', { ... })` call — not on framework files that
    // *define* cell (their throws are config-validation errors, by design).
    if (/\bcell\s*\(\s*['"]/.test(file.content)) {
      const throwLines = file.lines.filter((l) =>
        /\bthrow\s+new\s+/.test(l) && !l.trim().startsWith("//")
      );
      if (throwLines.length > 0) {
        report(
          "hint",
          "patterns",
          `${file.relative}: throw in cell code — consider returning error state instead (machines handle error states well)`,
          { file: file.relative },
        );
      }
    }

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
    //   4. (llama-master #4) A plain WRITE was reported as a read — see
    //      `draftReadOffsets`.
    const isTransactional = /\btransaction\s*:\s*(?:true|\{)/.test(
      file.content,
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
          if (!sawAwait) {
            if (/\bawait\b/.test(code)) sawAwait = true;
            continue; // reads on the first await line happen pre-suspension
          }
          // A live-poll primitive re-reads state ON PURPOSE — that is what it
          // is for. Skip the line and keep looking for a genuine read.
          if (/\b(until|race)\s*\(/.test(code)) continue;
          if (readLines.has(i) && !isSuppressed(file.lines, i)) {
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
            "run: deno install --allow-scripts=npm:electron npm:electron " +
            "(or just `deno task dev:electron` / `compile:electron` — they auto-install)",
        );
      } catch {
        report(
          "hint",
          "build",
          "Electron not installed — it auto-installs on the first `deno task dev:electron` " +
            "or `compile:electron` run (if you need desktop builds)",
        );
      }
    }
  }

  // compile:android without android template
  if (tasks["compile:android"]) {
    pass("Android target configured");
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
  for (const file of [...tsFiles, ...tsxFiles]) {
    // Code only: `timeout:` in a comment or a string is not a call option.
    const code = codeText(file.content);
    const m = /\bcall\s*\(\s*\{[^}]*\btimeout\s*:/.exec(code);
    if (!m) continue;
    found++;
    report(
      "warn",
      "upgrade",
      `${file.relative}: \`call({ timeout })\` is a deprecated alias — use \`timeoutMs\``,
      {
        file: file.relative,
        line: code.slice(0, m.index).split("\n").length,
        fix: "call({ timeoutMs: 5000 }, () => other.method())",
        safeFix: fix.fixCallTimeoutMs(file.path),
      },
    );
  }

  // Server-only symbols moved to the `aio/server` entry (alpha37). A static
  // import of one from `"aio"` in a cell-shared file was the classic
  // blank-screen: it link-fails only when a real browser links the graph.
  const SERVER_ONLY = /\b(createDB|DEFAULT_PRAGMAS|connectCli|connectCliUDS)\b/;
  for (const file of [...tsFiles, ...tsxFiles]) {
    // NOT codeText() here: it blanks string bodies, and the module specifier
    // IS a string — the check would match nothing. Anchored to a real import
    // statement instead, same as the legacy-path rule.
    const code = file.content;
    const m = /(?:^|\n)\s*import\s*\{([^}]*)\}\s*from\s*["']aio["']/.exec(code);
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
    const code = file.content; // real strings needed — specifiers ARE strings
    let dm: RegExpExecArray | null;
    DYN.lastIndex = 0;
    while ((dm = DYN.exec(code)) !== null) {
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
    // opposite of a use of it, and it was warned about anyway.
    const [m] = codeMatches(file.content, /\buseCell\s*\(/g);
    if (!m) continue;
    const line = file.content.slice(0, m.index).split("\n").length;
    report(
      "warn",
      "patterns",
      `${file.relative}:${line} — useCell() is deprecated: use direct cell ` +
        `access (cell.field / cell.method()). Its .state is a LIVE view — ` +
        `stashing it and diffing later compares current state to itself.`,
      { file: file.relative, line },
    );
  }
};

export const ALL_CHECKS: Checker[] = [
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
  checkWorkerPeerReads,
  checkUseCell,
];
