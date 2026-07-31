// aiol — all lint checks organized by area

import type { CellInfo, Checker } from "./types.ts";
import { join } from "@std/path";
import * as fix from "./fixes.ts";
import { RESERVED_KEYS } from "../src/state/cell-types.ts";
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
 *  eight hints for exactly this reason (llama.md #7).
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
  // (llama-master #6). A deno.json `appId` alongside an explicit one is
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
  if (!imports["react"] && !imports["react-dom"]) {
    pass("server-only / CLI (no React)");
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
    // Check for common alternatives
    const altEntry = sourceFiles.find((f) =>
      f.relative === "src/main.ts" || f.relative === "main.ts"
    );
    if (altEntry) {
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
    if (appTsx) {
      report(
        "hint",
        "structure",
        'App.tsx exists but client is "server-only" or "cli" — file is unused',
        { file: appTsx.relative },
      );
    } else pass("server-only / CLI mode (no App.tsx)");
  }

  // Cell organization
  const cellFiles = sourceFiles.filter((f) =>
    f.content.includes("cell(") && !f.name.endsWith(".test.ts") &&
    f.name !== "app.ts"
  );
  if (cellFiles.length > 3) {
    // A dedicated cell directory counts as organized whether it's named
    // `cell/` or `cells/` — both are valid; don't nag about the choice (risoto).
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

  // appId — mandatory in aio.run()
  if (appEntry) {
    if (appEntry.content.includes("appId")) pass("appId set in aio.run()");
    else {report(
        "error",
        "config",
        "missing appId in aio.run() — mandatory for lock files, KV/SQLite paths, UDS socket",
        {
          file: appEntry.relative,
          fix: 'Add appId: "my-app" to your aio.run() config',
          safeFix: fix.fixAddAppIdToRun,
        },
      );}
  }

  // appVersion — mandatory in v1.0
  if (appEntry) {
    if (appEntry.content.includes("appVersion")) pass("appVersion set");
    else {report(
        "error",
        "config",
        'missing appVersion in aio.run() — mandatory in v1.0, add appVersion: "x.y.z"',
        {
          file: appEntry.relative,
          fix: 'Add appVersion: "0.1.0" to your aio.run() config',
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
    const flags: [boolean, string, string][] = [
      [
        f.hasActions,
        "actions:/reduce:",
        "actions+reduce pairs are one method — `increment(s, by) { s.count += by }`",
      ],
      [
        f.hasGenerators,
        "generators:",
        "plain async methods + until()/race()/sleep(); cancelOn + s.$signal for cancellation",
      ],
      [
        f.hasMachine,
        "machine:",
        'guards are a guard line — `if (s.status !== "idle") return;`',
      ],
    ];
    for (const [hit, key, hint] of flags) {
      if (hit) {
        report(
          "error",
          "cells",
          `cell "${f.name}" uses removed legacy config '${key}' — ${hint}. Migration: docs/upgrade/restructure.md`,
        );
      }
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

    // Empty state
    if (!f.hasState) {
      report(
        "warn",
        "cells",
        `cell "${f.name}" has no state — every cell needs initial state`,
        loc,
      );
    } else if (f.stateIsLiteral && f.stateKeys.length === 0) {
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

  // Check for useAio vs useCell in TSX files
  for (const file of ctx.tsxFiles) {
    if (file.name === "App.tsx") continue; // root layout — useAio is OK
    const useAioCount = (file.content.match(/\buseAio\b/g) ?? []).length;
    const useCellCount = (file.content.match(/\buseCell\b/g) ?? []).length;
    if (useAioCount > 0 && useCellCount === 0) {
      report(
        "warn",
        "perf",
        `${file.relative}: uses useAio() — prefer useCell(ref) for scoped state + selective re-renders`,
        {
          file: file.relative,
          fix: "Replace useAio() with useCell(myCell)",
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
  // Skips (risoto false-positives): the delay-0 yield idiom
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

  // Large state arrays — hint about SQLite
  for (const f of cells) {
    for (const key of f.stateKeys) {
      // Check if state value looks like an array initializer with many items
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const arrayMatch = f.file.content.match(
        new RegExp(`${escaped}\\s*:\\s*\\[`),
      );
      if (arrayMatch) {
        // Check for 'as' type annotation suggesting typed array
        const afterKey = f.file.content.slice(
          f.file.content.indexOf(arrayMatch[0]),
        );
        if (/\[\s*\]\s+as\s+\w+\[\]/.test(afterKey)) {
          // Empty typed array — check if it's a list that could grow
          // Only hint for names that suggest collections
          if (
            /items|orders|entries|logs|messages|events|users|records|rows|list/i
              .test(key)
          ) {
            report(
              "hint",
              "perf",
              `cell "${f.name}" state.${key} is a typed array — if it grows large (100+), consider SQLite`,
              { file: f.file.relative },
            );
          }
        }
      }
    }
  }

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

  // console.log in non-test source
  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts")) continue;
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
      re: /token\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/,
      desc: "hardcoded token",
    },
    { re: /password\s*[:=]\s*['"][^'"]{4,}['"]/, desc: "hardcoded password" },
    { re: /secret\s*[:=]\s*['"][^'"]{8,}['"]/, desc: "hardcoded secret" },
    {
      re: /api[_-]?key\s*[:=]\s*['"][^'"]{10,}['"]/i,
      desc: "hardcoded API key",
    },
  ];
  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts") || file.name.endsWith(".test.tsx")) {
      continue;
    }
    for (const { re, desc } of secretPatterns) {
      const match = file.content.match(re);
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

  // .env files committed — only warn if it isn't already gitignored (risoto #7)
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
  // (risoto #6).
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

  // Direct Deno.Kv usage (should use aio persistence)
  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts")) continue;
    if (
      file.content.includes("Deno.openKv") || file.content.includes("Deno.Kv")
    ) {
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

  // Browser import safety — check .tsx files AND cell files
  const BROWSER_IMPORTS = new Set([
    "react",
    "react-dom/client",
    "react/jsx-runtime",
    "aio",
    "aio/browser",
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

  for (const file of browserCheckedFiles) {
    // Named/default imports
    for (
      const m of file.content.matchAll(
        /(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
      )
    ) {
      const spec = m[1]!;
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (
        m[0]!.startsWith("import type ") || m[0]!.startsWith("import type{")
      ) continue;
      if (BROWSER_IMPORTS.has(spec)) continue;
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
      const m of file.content.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)
    ) {
      const spec = m[1]!;
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (BROWSER_IMPORTS.has(spec) || denoImports.has(spec)) continue;
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
  // "aio/server" is the explicit server-only entry (risoto #1): the whole module
  // is server-only, so a STATIC import into a cell-shared file is the boundary
  // violation — flag it like @std/ / node:.
  const SERVER_ONLY_PREFIXES = ["@std/", "node:", "aio/server"];
  // AIO-424 (risoto): server-only SYMBOLS that live in the isomorphic "aio"
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
      const m of file.content.matchAll(
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

    // Deno.* usage
    for (const m of file.content.matchAll(/\bDeno\.\w+/g)) {
      const before = file.content.slice(0, m.index);
      const lineStart = before.lastIndexOf("\n") + 1;
      const linePrefix = before.slice(lineStart);
      if (linePrefix.includes("//") || linePrefix.includes("*")) continue;
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
    for (const m1 of appTsx.content.matchAll(LOCAL_IMPORT_RE)) {
      const resolved1 = resolveFile(appTsx, m1[1]!);
      if (!resolved1) continue;

      // Level 2: imported file → its local imports
      for (const m2 of resolved1.content.matchAll(LOCAL_IMPORT_RE)) {
        const resolved2 = resolveFile(resolved1, m2[1]!);
        if (!resolved2) continue;

        // Check level 2 file for server-only imports
        for (const sm of resolved2.content.matchAll(SERVER_ONLY_IMPORT_RE)) {
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
    for (const m of file.content.matchAll(STATIC_DYN_RE)) {
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
        const sm of resolved.content.matchAll(
          /(?:import|export)\s+(?!type\s).*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/g,
        )
      ) {
        serverImports.push(sm[1]!);
      }
      if (
        /\bDeno\.\w+/.test(resolved.content) &&
        !/\/\/.*Deno\./.test(resolved.content)
      ) {
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
    const anyLines = (fileLintIgnored || isTypeModule) ? [] : file.lines
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
        // Match : any, as any, <any> but not variable names containing "any"
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

    // State read after an await in an async method (mdview). Every await is a
    // commit + render point — another action may have committed while the
    // method was suspended, so a post-await read can return a value the code
    // above never saw. Deliberate re-reads are correct (reads overlay the
    // method's own pending writes), so this is a hint, once per method, on the
    // first post-await read. Writes and draft mutations (s.x = …, s.arr.push)
    // are exempt — they always land.
    // A `transaction: true` cell (risoto #2) reads a STABLE snapshot across
    // awaits — the post-await read is intended and safe — so skip the hint for
    // files that opt in. See docs/state/transactional-methods.md.
    const isTransactional = /\btransaction\s*:\s*(?:true|\{)/.test(
      file.content,
    );
    if (!isTransactional && /\bcell\s*\(\s*['"]/.test(file.content)) {
      const METHOD_RE =
        /\basync\s+(?!function\b)([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]|\b([A-Za-z_$][\w$]*)\s*:\s*async\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
      for (const m of file.content.matchAll(METHOD_RE)) {
        const method = m[1] ?? m[3]!;
        const param = m[2] ?? m[4]!;
        const startIdx = file.content.slice(0, m.index).split("\n").length - 1;
        const readRe = new RegExp(`\\b${param}\\.[\\w$]`);
        const writeRe = new RegExp(
          `\\b${param}(\\.[\\w$]+|\\[[^\\]]+\\])+\\s*([+\\-*/%&|^]|\\*\\*|\\|\\||&&|\\?\\?)?=[^=]`,
        );
        const mutateRe = new RegExp(
          `\\b${param}(\\.[\\w$]+|\\[[^\\]]+\\])+\\.(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear)\\s*\\(`,
        );
        let depth = 0;
        let entered = false;
        let sawAwait = false;
        for (let i = startIdx; i < file.lines.length; i++) {
          const code = file.lines[i]!.split("//")[0]!;
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
          if (
            readRe.test(code) && !writeRe.test(code) && !mutateRe.test(code) &&
            !isSuppressed(file.lines, i)
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
        report(
          "warn",
          "build",
          "Electron package exists but dist/ missing — run: deno task install:electron",
        );
      } catch {
        report(
          "hint",
          "build",
          "Electron not installed — run: deno task install:electron (if you need desktop builds)",
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

  // Check for schedule IDs with spaces or special chars
  for (const file of sourceFiles) {
    if (file.name.endsWith(".test.ts")) continue;
    for (
      const m of file.content.matchAll(/schedule\.\w+\(\s*['"]([^'"]+)['"]/g)
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

    // Rule 2: .map() rendering memo components without useProjection
    const hasMap = /\.map\s*\(/.test(file.content);
    const hasMemo = /\bmemo\s*\(/.test(file.content) ||
      /\bmemo\b/.test(file.content);
    const hasUseProjection = file.content.includes("useProjection");

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
// 14. DUPLICATE IMPORTS (risoto 2026-07-24)
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

/** Every public `aio/*` entry point an app may import. A specifier missing from
 *  the app's import map is unresolvable — and the error ("not a dependency and
 *  not in import map") never says the mapping is simply absent, so the app
 *  author reads it as "that entry doesn't exist". */
const AIO_ENTRIES: Record<string, string> = {
  "aio/air": "src/air.ts",
  "aio/air/compat": "src/air-compat.ts",
  "aio/ui": "src/ui/mod.ts",
  "aio/jsx-runtime": "src/jsx-runtime.ts",
  "aio/server": "src/server-entry.ts",
  "aio/db": "src/db/mod.ts",
  "aio/sync": "src/sync/mod.ts",
  "aio/schedule": "src/schedule.ts",
  "aio/selectors": "src/selector.ts",
  "aio/extras": "src/extras/mod.ts",
  "aio/state-core": "src/state-core.ts",
  "aio/testing": "src/cell-test.ts",
};

export const checkImports: Checker = (ctx) => {
  const { sourceFiles, denoJson, report } = ctx;

  // An `aio/x` import with no mapping in deno.json — the app followed the docs
  // and the specifier simply doesn't resolve.
  const map = denoJson?.imports ?? {};
  const base = map["aio"];
  const missing = new Map<string, { file: string; line: number }>();
  for (const file of sourceFiles) {
    for (
      const m of codeMatches(file.content, /from\s*['"](aio\/[\w./-]+)['"]/g)
    ) {
      const spec = m[1]!;
      if (map[spec] || !AIO_ENTRIES[spec] || missing.has(spec)) continue;
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

  // The DYNAMIC variant of the same migration (risoto 2026-07-26): the lazy
  // server-only pattern the docs themselves recommend —
  //   const { createDB } = await import("aio")
  // — is invisible to the static rule above and fails only at runtime, as
  // "createDB is not a function" (risoto's nft-cache silently stopped
  // persisting for hours). Same symbols, same fix, dynamic spelling.
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
// 17. CALLER-SIDE POST-AWAIT READS (risoto 2026-07-26)
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
      const read = new RegExp(`\\b${cellVar}\\s*\\.\\s*(\\w+)(?!\\s*\\()`).exec(
        after,
      );
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
// 18. WORKER CELLS READING PEER CELLS (risoto 2026-07-26 — the line in the sand)
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
      const re = new RegExp(`\\b${peer}\\s*\\.\\s*(\\w+)\\s*(?!\\()`, "g");
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
// state against itself, silently (space-invaders field report). Deprecated at
// the source; named here at lint time, before it runs.
export const checkUseCell: Checker = (ctx) => {
  const { tsFiles, tsxFiles, report } = ctx;
  for (const file of [...tsFiles, ...tsxFiles]) {
    const idx = file.content.search(/\buseCell\s*\(/);
    if (idx === -1) continue;
    const line = file.content.slice(0, idx).split("\n").length;
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
