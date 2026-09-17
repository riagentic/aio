// removals.ts — the ONE record of what aio removed within 1.x, and when.
//
// WHY A REGISTRY. The same fact — "`machine:` died in alpha27, here is the
// migration, here is the last version that ran it" — was stated in three places
// that could drift apart: the runtime throw in cell-create.ts, the static check
// in aiol, and the upgrade guide. Three deciders on one fact is exactly how a
// message goes stale and hands a user a recipe that no longer applies. This
// file is the decider; the others read it.
//
// THE 1.x CONTRACT this serves, in two layers:
//
//   FLOOR — an app commits the framework version it was built against
//   (`aioVersion` in its deno.json). A removal therefore never reaches an
//   existing app: it keeps building against its own pinned worktree, forever.
//   Nothing in this file is a compatibility shim, because none is needed.
//
//   LADDER — moving an app forward (`am update`) is allowed to be work, but is
//   never allowed to be a surprise. These rows are what turn "your app explodes
//   at boot on the new version" into a preflight list read off the app's own
//   source, before the pin moves.
//
// ADDING A ROW IS MANDATORY for any future 1.x removal:
// `tests/removals-registry.test.ts` fails if a removal is announced anywhere in
// `src/` or `aiol/` by a message that did not come from here.
import { codeText } from "../diagnostics/code-mask.ts";

import {
  ALPHA70,
  ALPHA76,
  CORE_REMOVALS,
  type Removal,
  RESTRUCTURE,
} from "./removals-core.ts";

// The runtime half — types, the rows a running app can trip, and the message
// every surface prints — lives in removals-core.ts so a browser bundle can
// reach it without the tooling table (see that file's header). Re-exported
// here so THIS module stays the one import path every tool already uses.
export * from "./removals-core.ts";

/** The rows only TOOLING reads: `am` verbs, deno.json keys, and the import
 *  moves `aiol --safe-fix` rewrites. Nothing a page can reach looks these up,
 *  which is what keeps them out of the browser bundle. */
const TOOLING_REMOVALS: readonly Removal[] = [
  {
    key: "aio.run(initialState, config)",
    kind: "api",
    hint:
      "define cells with cell() and call aio.run({ cells: [...] }) — or zero-config aio.run()",
    ...RESTRUCTURE,
  },
  // alpha52 — the surface diet: two aliases deprecated for multiple alphas
  // went out with loud throws (call) / a compile error (useCell).
  {
    key: "useCell()",
    kind: "api",
    removedIn: "alpha52",
    lastGood: "v1.0.0-alpha51",
    hint:
      "read the cell directly — counter.count (reactive) / counter.increment(); " +
      "aiol --safe-fix rewrites useCell(c).state.x",
    guide: "docs/upgrade/from-alpha51-to-alpha52.md",
  },
  // alpha70 — the LAST breaking release: every alpha52-era alias that had been
  // "through beta" goes out together. One spelling per fact from here on.
  {
    key: "CellAccess",
    kind: "api",
    now: "Access",
    hint:
      "rename the type: CellAccess → Access (one vocabulary for cells and serverFns)",
    pattern: /\bCellAccess\b/,
    ...ALPHA70,
  },
  {
    key: "ServerFnAccess",
    kind: "api",
    now: "Access",
    hint:
      "rename the type: ServerFnAccess → Access (one vocabulary for cells and serverFns)",
    pattern: /\bServerFnAccess\b/,
    ...ALPHA70,
  },
  {
    key: "ExtractState",
    kind: "api",
    now: "StateOf",
    hint: "rename the type: ExtractState<typeof c> → StateOf<typeof c>",
    pattern: /\bExtractState\b/,
    ...ALPHA70,
  },
  {
    key: "Action (aio/air)",
    kind: "api",
    now: "NodeAction",
    hint:
      "rename the `use`-prop type: Action → NodeAction (the bare name collided with the dispatch vocabulary)",
    // The import form only (`type Action,` / `type Action }`) — an app's own
    // `type Action = …` is its own business.
    pattern: /\btype\s+Action\s*[,}]/,
    ...ALPHA70,
  },
  {
    key: "aio.run({ appVersion })",
    kind: "api",
    now: 'deno.json "version"',
    hint:
      'delete appVersion from aio.run() — the version lives in deno.json `version` ("major.minor"; aio numbers builds from commits, docs/build/versioning.md)',
    pattern: /\bappVersion\s*:/,
    ...ALPHA70,
  },
  {
    key: "target",
    kind: "deno-json",
    now: "client",
    hint:
      'rename the deno.json key: "target" → "client" (same value) — `am fix` does it',
    ...ALPHA70,
  },
  {
    key: "schedule.blocking",
    kind: "api",
    now: "blocking",
    hint:
      'import { blocking } from "aio" and call blocking(id, fn, arg) — same function, its own top-level name',
    pattern: /\bschedule\.blocking\b/,
    ...ALPHA70,
  },
  {
    key: "connectDevTools()",
    kind: "api",
    now: "connectReduxDevTools()",
    hint:
      "rename: connectDevTools → connectReduxDevTools, disconnectDevTools → disconnectReduxDevTools (the Redux bridge; connectAioDevTools is aio's own)",
    pattern: /\b(?:dis)?connectDevTools\b/,
    ...ALPHA70,
  },
  {
    key: "new",
    kind: "am-verb",
    now: "add",
    hint: "spell it `am add` (same arguments)",
    ...ALPHA70,
  },
  {
    key: "update",
    kind: "am-verb",
    now: "upgrade",
    hint:
      "spell it `am upgrade` (bare: am itself; <app>: that app; <checkout>: a dev am)",
    ...ALPHA70,
  },
  {
    key: "ls",
    kind: "am-verb",
    now: "instances",
    hint: "spell it `am instances` (same output)",
    ...ALPHA70,
  },
  {
    key: "log",
    kind: "am-verb",
    now: "logs",
    hint: "spell it `am logs` (same flags)",
    ...ALPHA70,
  },
  {
    key: "tt",
    kind: "am-verb",
    now: "timetravel",
    hint: "spell it `am timetravel` (same subcommands)",
    ...ALPHA70,
  },
  {
    key: "release",
    kind: "am-verb",
    now: "publish",
    hint: "spell it `am publish` (same flags)",
    ...ALPHA70,
  },
  {
    key: 'import { createDB } from "aio/db"',
    kind: "api",
    now: 'import { createDB } from "aio/server"',
    hint:
      'import the DB runtime values (createDB, DEFAULT_PRAGMAS, initSchema, loadTables, syncTables, reactiveDB) from "aio/server" — aio/db is types-only; aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'import { shipApp } from "aio/build"',
    kind: "api",
    now: 'import { shipApp } from "aio/ship"',
    hint:
      'import the ship family (buildShipManifest, generateSigningKey, shipApp, verifyShipManifest, ShipManifest) from "aio/ship" — aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'import { appDirs } from "aio/testing"',
    kind: "api",
    now: 'import { appDirs } from "aio/server"',
    hint:
      'import appDirs/AppDirs from "aio/server" (ensureAppDirs, registerAppDirs, _resetAppDirs stay on aio/testing) — aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'import { installUpdatesRuntime } from "aio/testing"',
    kind: "api",
    now: 'import { installUpdatesRuntime } from "aio/updates"',
    hint:
      'import the updates runtime seam (installUpdatesRuntime, UpdatesRuntime, ApplyOptions, CheckOptions, CheckResult) from "aio/updates" — aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'import { testComponent } from "aio/air"',
    kind: "api",
    now: 'import { testComponent } from "aio/testing"',
    hint:
      'import testComponent/setDocument (+ TestComponentHandle, TestComponentOptions) from "aio/testing", next to testCell and testUI — aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'import { testCell } from "aio"',
    kind: "api",
    now: 'import { testCell } from "aio/testing"',
    hint:
      'import testCell/TestContext from "aio/testing" — aiol --safe-fix moves them',
    ...ALPHA70,
  },
  {
    key: 'lint() from "aio/extras"',
    kind: "api",
    now: "checkCells",
    hint:
      "rename: checkCells(cells) (the alias collided with aiol's project linter) — aiol --safe-fix keeps the local name: import { checkCells as lint }",
    ...ALPHA70,
  },
  // alpha76 — the pre-beta sweep. Four runtime flags and one `aio.run()` key
  // that had been "accepted aliases" with no removal date; beta freezes the
  // surface, so an alias carried into it is permanent. The flags are refused
  // by `parseCli` (aio-cli.ts), which is why they carry no source `pattern`:
  // a flag lives in a shell line or a deno.json task, not in TypeScript.
  {
    key: "--kill-existing",
    kind: "cli-flag",
    now: "--takeover",
    hint: "spell it `--takeover` (same behaviour), and the aio.run() key too",
    ...ALPHA76,
  },
  {
    key: "--server-url",
    kind: "cli-flag",
    now: "--connect",
    hint:
      "the BARE flag opens the connect page, so it is spelled `--connect`; the valued form `--server-url=<url>` is unchanged",
    ...ALPHA76,
  },
  {
    key: "--zero-port",
    kind: "cli-flag",
    hint:
      "delete the flag — zero TCP ports is already the default for a local electron app; `--port=N` is the opt-OUT",
    ...ALPHA76,
  },
  {
    key: "--backup-logs",
    kind: "cli-flag",
    hint:
      "delete the flag — keeping previous logs is the default; `--no-backup-logs` is the one that changes anything",
    ...ALPHA76,
  },
  {
    key: "aio.run({ killExisting })",
    kind: "api",
    now: "aio.run({ takeover })",
    hint:
      "rename the config key: killExisting: true → takeover: true — one word for the key and the `--takeover` flag, so a compiled service binary can write the current spelling",
    pattern: /\bkillExisting\s*:/,
    ...ALPHA76,
  },
  {
    key: "testgen()",
    kind: "api",
    now: "testGen",
    hint:
      "rename: testGen (camelCase, like testUI/testCell) — aiol --safe-fix keeps the local name: import { testGen as testgen }",
    ...ALPHA70,
  },
] as const;

/**
 * Every removal in 1.x — THE record. The runtime rows first (removals-core.ts,
 * which a page can reach), then the tooling-only ones.
 */
export const REMOVALS: readonly Removal[] = [
  ...CORE_REMOVALS,
  ...TOOLING_REMOVALS,
];

/** Look a key up across the WHOLE record. Overrides the core-only lookup this
 *  module re-exports: `aiol` and `am` ask about tooling rows too. */
export function removalFor(key: string): Removal | null {
  return REMOVALS.find((r) => r.key === key) ?? null;
}

/** Look up a key the caller KNOWS was removed — a missing row is a bug in this
 *  file, and a guard that quietly stops guarding is the failure this codebase
 *  refuses, so it throws rather than returning null. */
export function removalOf(key: string): Removal {
  const r = removalFor(key);
  if (!r) {
    throw new Error(
      `removals.ts has no row for '${key}' — a surface announces this removal ` +
        `but the registry does not record it. Add the row.`,
    );
  }
  return r;
}

/** A removed key found in source, with the line it sits on (1-based) and
 *  that line's text (trimmed) — a refusal that names `src/x.ts:61` without
 *  showing what matched sends the reader to open the file to learn it was a
 *  real config key and not a word in a comment. */
export interface RemovalHit {
  readonly removal: Removal;
  readonly line: number;
  readonly text: string;
}

/** Is this source path a test/fixture path — where a removed spelling is a
 *  FIXTURE (an app's own upgrade test, a self-test that feeds the old shape
 *  on purpose) rather than a config the app boots with? `am pin` WARNS on
 *  these and REFUSES on the rest. `path` is relative to the app root. */
export function isFixturePath(path: string): boolean {
  const p = "/" + path.replaceAll("\\", "/");
  return /\/tests?\//.test(p) || /\/testing\//.test(p) ||
    /\.test\./.test(p) || p.includes("/fixtures/") ||
    p.includes("/util/selftest");
}

/**
 * Find removed cell-config keys in a chunk of source.
 *
 * The registry owns DETECTION as well as the facts — otherwise the linter and
 * the upgrade preflight each grow their own scanner and disagree about what
 * counts as a hit, which is the same drift this file exists to end.
 *
 * Textual, but on CODE only: the source is passed through `codeText` (THE
 * "is this offset real code?" decider, shared with aiol) first, so a key
 * spelled inside a string, a template literal (`${…}` included), a comment
 * or a regex literal is not a hit. A field report: an app's own upgrade-test
 * fixture carried `execute:` in a template string, and `am pin` refused to
 * move an app whose real config was already migrated. Offsets and line breaks
 * survive the mask, so the line number — and the quoted line — are the ones
 * the reader sees in the file.
 *
 * Still deliberately generous within code: callers narrow the input (aiol
 * passes one cell's config block; `am pin` and `am migrate` pass whole files
 * to `removalsInFile`). A false positive costs a warning a human can overrule; a miss costs
 * an app that explodes at boot on a version it was told was safe.
 */
export function removalsInSource(text: string): RemovalHit[] {
  const code = codeText(text);
  // A cell-config key is a key of the object handed to `cell(...)` — and
  // nowhere else. `machine: {` is also a perfectly ordinary key in a UI
  // scope-label map, and matching it anywhere in a file that happens to call
  // `cell(` somewhere refused `am pin` on a false positive with `--force` as
  // the only way past (report 9 §5.2). When the text contains cell() calls, only
  // TOP-LEVEL keys of the config object inside their argument lists count
  // (`isConfigKeyAt`); when it contains none — aiol hands over one cell's
  // config BLOCK, already extracted — every line does. A WHOLE FILE is not a
  // block: callers holding one use `removalsInFile`.
  const spans = _cellCallSpans(code);
  const block = spans.length === 0;
  return scanRemovals(text, code, {
    cellKey: (at) => block || isConfigKeyAt(code, spans, at),
    inCell: (at) => block || inSpans(spans, at),
  });
}

/**
 * `removalsInSource` for a WHOLE source file — what `am pin` and `am migrate`
 * hold.
 *
 * The difference is one rule: a cell-config key counts only as a TOP-LEVEL key
 * of a cell config literal — the object in a `cell(…)` argument list, or an
 * object literal bound to a name that a `cell(…)` call receives
 * (`cell("c", config)`, `{ ...base }`). A
 * file with no `cell(` has no cell config at all. `removalsInSource`'s "no
 * `cell(` → every line counts" is right for aiol's pre-extracted block and was
 * wrong for a file: a table of the names models invent for the shell tool
 * (`execute: "sh"`) and a record of scope labels (`machine: { label }`) —
 * neither anywhere near a cell — refused a compatible upgrade (report 9 §2a).
 * `execute`, `machine`, `actions`, `generators` are ordinary English words;
 * any app of size has them as keys.
 *
 * API-shape rows are judged at their own SITE too — see `API_SITES`.
 */
export function removalsInFile(text: string): RemovalHit[] {
  const code = codeText(text);
  const spans = _cellConfigSpans(code);
  // A `methods` object written apart from the call (`cell("c", { state,
  // methods })` with `const methods = {…}`) holds method bodies too.
  const bodies = [...spans, ...methodsObjectSpans(code, spans)];
  return scanRemovals(text, code, {
    cellKey: (at) => isConfigKeyAt(code, spans, at),
    inCell: (at) => inSpans(bodies, at),
  });
}

/** `isConfigKeyAt` over a whole file's cell configs (MASKED `code`): THE
 *  "is this `key:` a cell's own config key?" decider, shared with aiol's
 *  site rules so a lint and `am pin` never disagree about one key. */
// aio-ok: the peer linter's seam — `aiol` is the only caller, from its own root.
export function isCellConfigKeyAt(code: string, at: number): boolean {
  return isConfigKeyAt(code, _cellConfigSpans(code), at);
}

/** Is the key at offset `at` a TOP-LEVEL key of a cell config literal — not
 *  merely somewhere inside one? `perfBudget: { reduce: 100 }` is the current
 *  reduce budget and `state: { machine: {…}, execute: 2 }` is app data; both
 *  sit inside `cell(...)`, and reading any key in the span as config refused
 *  `am pin` on a compatible upgrade (llama-master). A removed key was only
 *  ever a key of the config object itself.
 *
 *  Judged on MASKED code by the bracket stack between the span's start and
 *  `at`: exactly one open `{`, reached through nothing but `(` — a call span
 *  starts after `cell(` (`cell("c", {` → `{`), a bound literal starts AT its
 *  `{`, and a wrapper (`cell("c", withX({`) or a parenthesised cast
 *  (`cell("c", ({ … }) as C)`) still hands the object over. */
function isConfigKeyAt(
  code: string,
  spans: readonly (readonly [number, number])[],
  at: number,
): boolean {
  return spans.some(([s, e]) => {
    if (at < s || at >= e) return false;
    const stack: string[] = [];
    for (let i = s; i < at; i++) {
      const ch = code[i];
      if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
      else if (ch === ")" || ch === "]" || ch === "}") stack.pop();
    }
    return /^\(*\{$/.test(stack.join(""));
  });
}

function inSpans(
  spans: readonly (readonly [number, number])[],
  at: number,
): boolean {
  return spans.some(([s, e]) => at >= s && at < e);
}

/** Where a match counts, per entry point. */
type Sites = {
  /** A TOP-LEVEL key of a cell config literal. */
  cellKey: (at: number) => boolean;
  /** Anywhere inside a cell config (its method bodies included). */
  inCell: (at: number) => boolean;
};

/** Per-file facts the API-shape sites share, computed once per scan. */
type FileSites = Sites & {
  code: string;
  text: string;
  runSpans: [number, number][];
  pollSpans: [number, number][];
  scheduleIsLocal: boolean;
  aioImports: [number, number][];
};

/**
 * THE SITE of each API-shape row: where its spelling is the removed API and
 * not an app's own name. Without one a row's pattern matched ANYWHERE in the
 * file — `state: { appVersion: "0.1" }`, an app's own `type Action` union,
 * `const retry = { every, backoff }`, `state: { ui: "dark" }` — and `am pin`
 * refused a compatible upgrade with `--force` as the only way past (h8 F1).
 * `word` is the token the site is judged at (a key's own offset). Rows with
 * no entry are names unique to aio (`CellAccess`, `connectDevTools`) and
 * still match anywhere. Only NARROWS: every site admits every spelling the
 * runtime refuses.
 */
const API_SITES: Readonly<
  Record<string, { word: string; at: (f: FileSites, at: number) => boolean }>
> = {
  // The rename is of aio/air's export — an import/export from an `aio*`
  // specifier. Any other `type Action` is the app's own.
  "Action (aio/air)": {
    word: "Action",
    at: (f, at) => inSpans(f.aioImports, at),
  },
  // `aio.run()` config keys: top-level keys of the object `aio.run(` takes.
  "aio.run({ appVersion })": {
    word: "appVersion",
    at: (f, at) => isConfigKeyAt(f.code, f.runSpans, at),
  },
  "aio.run({ killExisting })": {
    word: "killExisting",
    at: (f, at) => isConfigKeyAt(f.code, f.runSpans, at),
  },
  // Cell config keys: top-level keys of a cell config, like `machine:`.
  "cell({ ui })": { word: "ui", at: (f, at) => f.cellKey(at) },
  "listensTo: [...]": { word: "listensTo", at: (f, at) => f.cellKey(at) },
  // The options object of `schedule.poll(` — inline or bound to a name.
  "schedule.poll({ backoff })": {
    word: "every",
    at: (f, at) => inSpans(f.pollSpans, at),
  },
  // `schedule.blocking` on a `schedule` the file did not declare itself.
  "schedule.blocking": { word: "schedule", at: (f) => !f.scheduleIsLocal },
  // A returned effect is refused from a METHOD; a helper returning one to be
  // handed to `s.$do(…)` is the current form.
  "return effect(s) from a method": {
    word: "return",
    at: (f, at) => f.inCell(at),
  },
};

/** The cell-config KEY a row is found as (`machine`, `ui`, `listensTo`), or
 *  null for a row whose site is not a cell-config key. A caller that holds
 *  one cell's config block (aiol) keeps a hit only where that key is a
 *  TOP-LEVEL key of the block — the same line `removalsInFile` draws. */
// aio-ok: the peer linter's seam — `aiol` is the only caller, from its own root.
export function cellConfigKeyOf(r: Removal): string | null {
  if (r.kind === "cell-config") return r.key;
  return CELL_KEY_SITED.has(r.key) ? API_SITES[r.key]!.word : null;
}

const CELL_KEY_SITED: ReadonlySet<string> = new Set([
  "cell({ ui })",
  "listensTo: [...]",
]);

/** THE matcher both entry points share: one hit per row, first line it is on,
 *  judged against masked `code` and quoted from the original `text`. */
function scanRemovals(
  text: string,
  code: string,
  sites: Sites,
): RemovalHit[] {
  const hits: RemovalHit[] = [];
  const raw = text.split("\n");
  const lines = code.split("\n");
  const lineStart: number[] = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    lineStart.push(lineStart[i]! + lines[i]!.length + 1);
  }
  let file: FileSites | null = null;
  const fileSites = (): FileSites =>
    file ??= {
      ...sites,
      code,
      text,
      runSpans: _boundConfigSpans(code, callSpans(code, /\baio\s*\.\s*run\b/g)),
      pollSpans: _boundConfigSpans(
        code,
        callSpans(code, /\bschedule\s*\.\s*poll\b/g),
      ),
      scheduleIsLocal:
        /\b(?:const|let|var|function|class)\s+schedule\b/.test(code) ||
        /[(,]\s*schedule\s*[:,)=]/.test(code),
      aioImports: aioImportSpans(text, code),
    };
  for (const r of REMOVALS) {
    const cellKey = r.kind === "cell-config";
    const site = cellKey ? undefined : API_SITES[r.key];
    const res: RegExp[] = cellKey
      ? [
        new RegExp(`(^|[{,\\s])${r.key}\\s*:`, "g"),
        // A QUOTED key is the same key to the runtime. `codeText` blanks the
        // name, so it is matched on the original line — its quotes are code.
        new RegExp(`(^|[{,\\s])(["'])${r.key}\\2\\s*:`, "g"),
      ]
      : r.pattern
      ? [new RegExp(r.pattern.source, r.pattern.flags.replace("g", "") + "g")]
      : []; // not textual
    if (res.length === 0) continue;
    const i = lines.findIndex((l, n) => {
      if (!cellKey && !site) return res[0]!.test(l);
      // Every occurrence on the line, each judged at the KEY's own offset (not
      // the line's): a one-line `cell("x", { machine: … })` has its line start
      // before the call opens, and a line can hold a plain `machine:` before
      // a config one.
      for (const [k, re] of res.entries()) {
        const quoted = k === 1;
        for (const m of (quoted ? raw[n]! : l).matchAll(re)) {
          const word = site ? site.word : r.key;
          const off = m.index! + m[0].indexOf(quoted ? m[2]! : word);
          const at = lineStart[n]! + off;
          // A quoted key's quote must be real code (the key itself is a
          // string); an unquoted one is already matched on masked code.
          if (quoted && l[off] !== m[2]) continue;
          if (cellKey ? sites.cellKey(at) : site!.at(fileSites(), at)) {
            return true;
          }
        }
      }
      return false;
    });
    if (i >= 0) hits.push({ removal: r, line: i + 1, text: raw[i]!.trim() });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Offsets `[start, end)` of every `import`/`export … from "aio…"` statement
 *  (the specifier read from the ORIGINAL text — the mask blanks it). */
function aioImportSpans(text: string, code: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*(["'])/g;
  for (const m of code.matchAll(re)) {
    const q = m.index! + m[0].length;
    if (/^aio(?:[/"']|$)/.test(text.slice(q, q + 4))) {
      out.push([m.index!, q]);
    }
  }
  return out;
}

/** Argument-list spans of every call whose callee matches `callee` (a global
 *  regex ending at the callee name). */
function callSpans(code: string, callee: RegExp): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of code.matchAll(callee)) {
    const paren = /^\s*\(/.exec(code.slice(m.index! + m[0].length));
    if (!paren) continue;
    const start = m.index! + m[0].length + paren[0].length;
    spans.push([start, closeOf(code, start)]);
  }
  return spans;
}

/** End offset of the argument list opening just before `start` (unbalanced
 *  input ends at end of text rather than dropping it). */
function closeOf(code: string, start: number): number {
  let depth = 1;
  let i = start;
  for (; i < code.length && depth > 0; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  return i;
}

/** The innermost `{…}` block enclosing `at`, as `[open, close]`, or the whole
 *  text for module scope. MASKED code. */
function enclosingBlock(code: string, at: number): [number, number] {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = code[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) return [i, closeOf(code, i + 1)];
      depth--;
    }
  }
  return [0, code.length];
}

/** `calls` plus the object literal of any name those argument lists hand over
 *  — as a whole depth-0 argument (`cell("c", config)`), or as a spread
 *  directly inside a depth-0 object argument (`{ ...base }`) — when the file
 *  binds that name to one IN A SCOPE THAT ENCLOSES THE CALL (`const config =
 *  { … }` in module scope or the calling function). A same-named local in an
 *  unrelated function is not the config (h8 F11). Returned in order: the
 *  calls first, then the bound literals. @internal — aiol reads one cell's
 *  config through it, so the linter and `am pin` follow the same binding. */
export function _boundConfigSpans(
  code: string,
  calls: [number, number][],
): [number, number][] {
  const spans = [...calls];
  const names = new Map<string, number[]>();
  const want = (name: string, at: number) =>
    names.set(name, [...(names.get(name) ?? []), at]);
  for (const [s, e] of calls) {
    // Walk the argument list once: a depth-0 argument that is a bare name, and
    // a `...name` spread directly inside a depth-0 object argument. Anything
    // deeper (`{ state, methods }` shorthand, a nested spread) is not a config
    // object being handed over.
    let depth = 0;
    let argStart = s;
    for (let i = s; i <= e; i++) {
      const ch = i < e ? code[i] : ",";
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if ((ch === ")" || ch === "]" || ch === "}") && depth > 0) depth--;
      else if (depth === 0 && (ch === "," || ch === ")")) {
        const arg = code.slice(argStart, i).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(arg)) want(arg, s);
        argStart = i + 1;
      }
      if (depth === 1 && code.startsWith("...", i)) {
        const m = /^\.\.\.\s*([A-Za-z_$][\w$]*)/.exec(code.slice(i, i + 80));
        if (m) want(m[1]!, s);
      }
    }
  }
  for (const [name, uses] of names) {
    const bind = new RegExp(
      `\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\b[^=;]*=\\s*\\{`,
      "g",
    );
    for (const m of code.matchAll(bind)) {
      const [bs, be] = enclosingBlock(code, m.index!);
      if (!uses.some((u) => u >= bs && u <= be)) continue;
      const open = m.index! + m[0].length - 1;
      spans.push([open, closeOf(code, open + 1)]);
    }
  }
  return spans;
}

/** Object literals bound to the name a cell config's `methods` key refers to
 *  (`methods,` shorthand or `methods: name`). */
function methodsObjectSpans(
  code: string,
  configs: [number, number][],
): [number, number][] {
  const refs: [number, number][] = [];
  for (const [s, e] of configs) {
    const body = code.slice(s, e);
    const ref = /(?:^|[{,\s])methods\s*(?::\s*([A-Za-z_$][\w$]*)\s*)?[,}\n]/g;
    for (const m of body.matchAll(ref)) {
      const name = m[1] ?? "methods";
      // Followed only from a scope enclosing the cell config.
      const at = s + m.index!;
      const bind = new RegExp(
        `\\b(?:const|let|var)\\s+${
          name.replace(/\$/g, "\\$")
        }\\b[^=;]*=\\s*\\{`,
        "g",
      );
      for (const b of code.matchAll(bind)) {
        const [bs, be] = enclosingBlock(code, b.index!);
        if (at < bs || at > be) continue;
        const open = b.index! + b[0].length - 1;
        refs.push([open, closeOf(code, open + 1)]);
      }
    }
  }
  return refs;
}

/** Offsets of every cell CONFIG literal in MASKED code: each `cell(…)`
 *  argument list, plus the object literal of any name that list hands over —
 *  as a whole argument (`cell("c", config)`) or as a spread (`{ ...base }`) —
 *  when the file binds that name to one (`const config = { … }`, with or
 *  without a type annotation) in a scope enclosing the call. A name bound
 *  elsewhere (an import) is not followed: that file is scanned on its own,
 *  and a config there is judged by its own `cell(` — or, with none, not at
 *  all. */
export function _cellConfigSpans(code: string): [number, number][] {
  return _boundConfigSpans(code, _cellCallSpans(code));
}

/** Offsets `[start, end)` of every `cell(...)` call's argument list in MASKED
 *  code (strings and comments already blanked, so brackets inside them do not
 *  count). A generic call — `cell<S>(`, `cell<Record<K, () => V>>(` — is one
 *  too, and so is a call through an import alias (`import { cell as
 *  defineCell }`): each boots the same config and throws on the same removed
 *  key. Unbalanced input ends the last span at end of text rather than
 *  dropping it. */
export function _cellCallSpans(code: string): [number, number][] {
  const names = new Set(["cell"]);
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const a of m[1]!.matchAll(/\bcell\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      names.add(a[1]!);
    }
  }
  const spans: [number, number][] = [];
  const open = new RegExp(
    `(?<![\\w$])(?:${
      [...names].map((n) => n.replace(/\$/g, "\\$")).join("|")
    })\\b`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = open.exec(code))) {
    let i = m.index + m[0].length;
    while (/\s/.test(code[i] ?? "")) i++;
    if (code[i] === "<") {
      // Balanced type arguments; the `>` of an arrow (`=>`) closes nothing.
      let depth = 0;
      for (; i < code.length; i++) {
        const ch = code[i];
        if (ch === "<") depth++;
        else if (ch === ">" && code[i - 1] !== "=") {
          if (--depth === 0) break;
        } else if (ch === ";") break;
      }
      if (depth !== 0) continue;
      i++;
      while (/\s/.test(code[i] ?? "")) i++;
    }
    if (code[i] !== "(") continue;
    const start = i + 1;
    const end = closeOf(code, start);
    spans.push([start, end]);
    open.lastIndex = end;
  }
  return spans;
}

/** Removed top-level `deno.json` keys this config still carries. */
export function removalsInDenoJson(
  denoJson: Record<string, unknown> | undefined,
): readonly Removal[] {
  if (!denoJson) return [];
  return REMOVALS.filter((r) =>
    r.kind === "deno-json" && denoJson[r.key] !== undefined
  );
}

/** The removal row for an `am` verb that no longer exists, or null. */
export function removedAmVerb(verb: string): Removal | null {
  return REMOVALS.find((r) => r.kind === "am-verb" && r.key === verb) ?? null;
}
