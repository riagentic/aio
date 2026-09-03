#!/usr/bin/env -S deno run --allow-read
// check-docs.ts — verify version strings are consistent across all docs
// Usage: deno run --allow-read scripts/check-docs.ts [expected-version]
// Skips changelog.md (historical) and upgrade.md (migration references)

import { walk } from "https://deno.land/std@0.208.0/fs/walk.ts";

const DOCS_DIR = new URL("../docs/", import.meta.url).pathname;
const VERSION_RE = /v(\d+\.\d+\.\d+)/g;
const SKIP_FILES = new Set(["changelog.md", "upgrade.md"]);

async function main(): Promise<void> {
  const expected = Deno.args[0] ?? await detectVersion();
  if (!expected) {
    console.error("Usage: check-docs.ts <version>  (e.g. 0.7.0)");
    Deno.exit(1);
  }

  const issues: string[] = [];
  const seen = new Map<string, string[]>();
  // Every hard gate below appends here instead of exiting at the first one:
  // a docs pass that can only learn about one broken class per run costs a
  // full round trip per class, and the audit that produced these checks found
  // five classes at once.
  const fatal: string[] = [];
  const docs = await readLiveDocs();

  async function checkFile(path: string, label: string): Promise<void> {
    const content = await Deno.readTextFile(path);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i]!.matchAll(VERSION_RE)) {
        const v = match[1]!;
        const loc = `${label}:${i + 1}`;
        if (!seen.has(v)) seen.set(v, []);
        seen.get(v)!.push(loc);
        if (v !== expected) {
          issues.push(`  ${loc}  found v${v} (expected v${expected})`);
        }
      }
    }
  }

  for await (
    const entry of walk(DOCS_DIR, {
      exts: [".md"],
      maxDepth: 2,
      includeDirs: false,
    })
  ) {
    const basename = entry.path.split("/").pop() ?? "";
    if (SKIP_FILES.has(basename)) continue;
    await checkFile(entry.path, entry.path.replace(DOCS_DIR, ""));
  }

  // Also check README.md at repo root.
  //
  // The path used to be `../../README.md` — this script lives in scripts/, so
  // that resolved OUTSIDE the repo, to a file that does not exist — and the
  // miss was swallowed by an empty catch. So the README half of this gate
  // spent its whole life passing on a file it never opened, which is how the
  // README came to advertise `deno task dev:electron` and friends five alphas
  // after that task matrix was retired. A gate that cannot fail is not a gate:
  // the path is right now, and a missing README is a LOUD failure.
  const readmePath = new URL("../README.md", import.meta.url).pathname;
  try {
    await Deno.stat(readmePath);
  } catch {
    console.error(`✗ README.md not found at ${readmePath} — the root README `);
    console.error(`  is a release surface; this check must not silently skip.`);
    Deno.exit(1);
  }
  await checkFile(readmePath, "README.md");

  console.log(`Version check: v${expected}`);
  console.log(`Found ${seen.size} version(s) across docs:\n`);
  for (const [v, locs] of [...seen.entries()].sort()) {
    const status = v === expected ? "✓" : "✗";
    console.log(
      `  ${status} v${v}  (${locs.length} occurrence${
        locs.length > 1 ? "s" : ""
      })`,
    );
  }

  // Inline doc references: a `docs/<path>.md` cited in a src/ comment is a
  // promise — every anchor the field followed was accurate, which is why they
  // are trusted (a field report). One dangling ref erodes that, so a
  // citation of a nonexistent page is a hard gate.
  const refIssues = await checkSrcDocRefs();
  console.log(
    `Inline doc refs: ${
      refIssues.length ? `${refIssues.length} dangling` : "all resolve"
    }`,
  );

  // Retired spellings must not survive in LIVE docs. The snippet type-check
  // gate cannot catch these: a deprecated-but-still-working form (the old
  // selector spread signature) type-checks by design, and prose/tables
  // (`call({ timeout })` in an API table) are invisible to it. This is the
  // prose-level complement — a small denylist of spellings the one-vocabulary
  // work retired, hard-gated outside the historical dirs.
  const retiredIssues = await checkRetiredSpellings();
  console.log(
    `Retired spellings: ${
      retiredIssues.length ? `${retiredIssues.length} found` : "none"
    }`,
  );

  // A harness member the docs teach must EXIST.
  //
  // `docs/testing/cell-testing.md` documented `t.expect.noStateChange()`,
  // which is in no version of `src/`. Copying it out of the docs is the
  // obvious thing to do and produces a TypeError, and the reporter who found
  // it pointed out the fix is mechanical: the harness surface is a TypeScript
  // literal, the docs are text, and one can be checked against the other. This
  // class of drift never has to be found by a human again.
  const apiIssues = await checkHarnessMembers();
  console.log(
    `Test-harness members in docs: ${
      apiIssues.length ? `${apiIssues.length} do not exist` : "all exist"
    }`,
  );

  // R2.2: every AioErrorCode must be documented in docs/debugging/errors.md, so
  // a new code can never ship without an operator-facing explanation.
  // A snippet is a fragment, so no type-checker ever sees it: the docs are the
  // one surface where a shape the framework refuses can ship green. This runs
  // the two shapes `validateSchedules` refuses against every fenced block.
  const schedIssues = checkScheduleShapes(docs);
  console.log(
    `Schedule shapes in docs: ${
      schedIssues.length
        ? `${schedIssues.length} the framework refuses`
        : "all valid"
    }`,
  );
  if (schedIssues.length) fatal.push(...schedIssues);

  // A doc that names the test guaranteeing its claim is making a promise on
  // that test's behalf. The promise must at least still be reachable.
  const claimIssues = await checkGateClaims(docs);
  console.log(
    `Gate claims (\"pinned by tests/…\"): ${
      claimIssues.length
        ? `${claimIssues.length} name a missing test`
        : "all resolve"
    }`,
  );
  if (claimIssues.length) fatal.push(...claimIssues);

  const codeIssues = await checkErrorCodes();
  console.log(
    `\nError-code coverage: ${
      codeIssues.length ? `${codeIssues.length} undocumented` : "all documented"
    }`,
  );

  // Every upgrade guide from alpha65 on carries a `## Retire` section — the
  // list of workarounds an app may delete, each with the version that fixed
  // the bug. A field report carried two bridge-return workarounds for thirty
  // releases after alpha34 fixed them, because nothing ever said "you can
  // delete this now". The section is the place that says it; the gate is
  // what keeps a release from shipping without one.
  const retireIssues = await checkRetireSections();
  console.log(
    `Upgrade guides with a Retire section: ${
      retireIssues.length ? `${retireIssues.length} missing` : "all present"
    }`,
  );

  // Doc -> code (the direction that was wide open): every command a doc
  // spells must resolve to a real `am` verb or a real task, and every symbol
  // it imports or tables must be in the export snapshot. See the block at the
  // bottom of this file for why each source of truth is read from code
  // rather than allowlisted by hand.
  const surface = await loadSurface();
  const androidAlias = await loadAndroidAlias();
  const cmdIssues = commandIssues(
    docs,
    await loadAmVerbs(),
    await loadTaskNames(),
  );
  console.log(
    `Commands in docs: ${
      cmdIssues.length ? `${cmdIssues.length} do not resolve` : "all resolve"
    }`,
  );
  const symIssues = symbolIssues(docs, surface, androidAlias);
  console.log(
    `Symbols in docs: ${
      symIssues.length ? `${symIssues.length} do not resolve` : "all resolve"
    }`,
  );
  // Structure the docs promise about EACH OTHER (a `page.md#heading` link),
  // about the SERVER (a `/__aio/…` path), and about a SCRIPT (a `--flag`).
  const anchorIss = anchorIssues(await readAllDocs());
  console.log(
    `Anchors (page.md#heading): ${
      anchorIss.length ? `${anchorIss.length} dangling` : "all land"
    }`,
  );
  const routeIss = routeIssues(docs, await loadRoutes());
  console.log(
    `Server routes (/__aio/…) in docs: ${
      routeIss.length ? `${routeIss.length} not mounted` : "all mounted"
    }`,
  );
  const flagIss = flagIssues(
    docs,
    await loadTaskScripts(),
    await loadScriptFlags(),
  );
  console.log(
    `Script flags in docs: ${
      flagIss.length ? `${flagIss.length} do not parse` : "all parse"
    }`,
  );

  // Version-string drift is ADVISORY: docs legitimately reference historical
  // versions (migration notes) and example CLI output, so it warns but never
  // gates. Error-code coverage is EXACT, so it is the hard gate.
  if (issues.length) {
    console.log(
      `\nVersion references differing from v${expected} ` +
        `(review — historical/example mentions are expected):\n${
          issues.join("\n")
        }`,
    );
  }
  if (refIssues.length) {
    fatal.push(
      `\nDangling doc references in src/ (must fix — write the page or fix ` +
        `the path):\n${refIssues.join("\n")}`,
    );
  }
  if (codeIssues.length) {
    fatal.push(
      `\nUndocumented error codes (must fix):\n${codeIssues.join("\n")}`,
    );
  }
  if (retireIssues.length) {
    fatal.push(
      `\nUpgrade guides without a \`## Retire\` section (must fix — list the ` +
        `workarounds this release lets an app delete, with the version each ` +
        `fix shipped in; "nothing to retire" is a valid one-line section):\n${
          retireIssues.join("\n")
        }`,
    );
  }
  if (apiIssues.length) {
    fatal.push(
      `\nTest-harness members the docs teach but src/ does not have (must ` +
        `fix — the reader copies these):\n${apiIssues.join("\n")}`,
    );
  }
  if (retiredIssues.length) {
    fatal.push(
      `\nRetired spellings in live docs (must fix — teach the current ` +
        `vocabulary, or move the page to upgrade/):\n${
          retiredIssues.join("\n")
        }`,
    );
  }
  if (cmdIssues.length) {
    fatal.push(
      `\nCommands the docs teach that do not exist (must fix — the ` +
        `reader copies these into a shell):\n${cmdIssues.join("\n")}`,
    );
  }
  if (symIssues.length) {
    fatal.push(
      `\nSymbols the docs teach that are importable nowhere (must fix — ` +
        `export them, or stop documenting them):\n${symIssues.join("\n")}`,
    );
  }
  if (anchorIss.length) {
    fatal.push(
      `\nLinks to headings that do not exist (must fix — the reader clicks ` +
        `these; anchors follow GitHub's slug rule):\n${anchorIss.join("\n")}`,
    );
  }
  if (routeIss.length) {
    fatal.push(
      `\n/__aio/ paths the server does not mount (must fix — the reader ` +
        `curls these and gets a 404):\n${routeIss.join("\n")}`,
    );
  }
  if (flagIss.length) {
    fatal.push(
      `\nScript flags the docs teach but the script does not parse (must ` +
        `fix — the script exits on an unknown flag):\n${flagIss.join("\n")}`,
    );
  }
  if (fatal.length) {
    console.log(fatal.join("\n"));
    Deno.exit(1);
  }
  console.log(
    "\n✓ Docs check green: error codes, doc refs, vocabulary, " +
      "commands, symbols, anchors, routes, script flags.",
  );
}

/** Spellings the framework retired that live docs must not teach. Each entry
 *  is [pattern, why]. Lines that TALK ABOUT the rename (naming the new
 *  spelling too) are allowed — a migration note is not a stale teaching. */
const RETIRED_SPELLINGS: Array<[RegExp, string]> = [
  [/\bcompile:remote:/, "the compile:remote:* task family → `deno task build`"],
  [/\bdev:remote:/, "the dev:remote:* task family → `deno task dev` + flags"],
  [/\b(?:dev|compile):service\b/, "`service` is spelled `server` (alpha52)"],
  [/\bcall\(\s*\{\s*timeout\s*[,:}?]/, "call()'s `timeout` → `timeoutMs`"],
  [/\{\s*timeout\?,\s*retries\?/, "call()'s `timeout` → `timeoutMs`"],
  // alpha70 — the last compat break. Each has a removals-registry row.
  [
    /\bCellAccess\b|\bServerFnAccess\b/,
    "`CellAccess`/`ServerFnAccess` → `Access` (alpha70)",
  ],
  [/\bExtractState\b/, "`ExtractState` → `StateOf` (alpha70)"],
  [/schedule\.blocking\b/, "`schedule.blocking` → `blocking` (alpha70)"],
  [
    /\b(?:dis)?connectDevTools\b/,
    "`connectDevTools` → `connectReduxDevTools` (alpha70)",
  ],
  [
    /\bam (?:new|update|ls|log|tt|release)\b/,
    "one `am` spelling per verb (alpha70): add/upgrade/instances/logs/timetravel/publish",
  ],
  [/\blistensTo:\s*\[/, "`listensTo` takes the object form (alpha70)"],
];

/** Historical dirs may show old APIs on purpose; everything else is live. */
async function checkRetiredSpellings(): Promise<string[]> {
  const issues: string[] = [];
  for await (
    const entry of walk(DOCS_DIR, {
      exts: [".md"],
      includeDirs: false,
      skip: [/\/upgrade\//, /\/specs\//, /\/release-notes\//],
    })
  ) {
    const rel = entry.path.replace(DOCS_DIR, "");
    if (rel === "content.md") continue; // generated index — mirrors sources
    const lines = (await Deno.readTextFile(entry.path)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const [re, why] of RETIRED_SPELLINGS) {
        if (!re.test(line)) continue;
        // A line that also carries the NEW spelling (or explicitly talks
        // about migrating off the old one) is a migration note, not teaching.
        if (
          /timeoutMs|--migrate-tasks|deprecated|retired|alpha52|alpha70|migration/
            .test(line)
        ) {
          continue;
        }
        issues.push(`  ${rel}:${i + 1}  ${why}  →  ${line.trim()}`);
      }
    }
  }
  return issues;
}

/** The first upgrade guide that must carry `## Retire`; every later one too. */
const RETIRE_SECTION_SINCE = 65;

/** `docs/upgrade/from-alphaNN-to-alphaMM.md` with MM >= 65 must contain a
 *  `## Retire` heading. Older guides are history and stay as written. */
async function checkRetireSections(): Promise<string[]> {
  const issues: string[] = [];
  const dir = `${DOCS_DIR}upgrade/`;
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    const m = /^from-alpha(\d+)-to-alpha(\d+)\.md$/.exec(entry.name);
    if (!m || Number(m[2]) < RETIRE_SECTION_SINCE) continue;
    const text = await Deno.readTextFile(dir + entry.name);
    if (!/^## Retire\s*$/m.test(text)) {
      issues.push(`  upgrade/${entry.name}  no \`## Retire\` heading`);
    }
  }
  return issues.sort();
}

/** Every `docs/….md` path mentioned in src/ code must exist on disk. */
async function checkSrcDocRefs(): Promise<string[]> {
  const root = new URL("..", import.meta.url).pathname;
  const issues: string[] = [];
  const seen = new Map<string, string>(); // path → first citing file
  async function walk(dir: string): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.isFile && /\.(ts|tsx)$/.test(e.name)) {
        const src = await Deno.readTextFile(p);
        for (const m of src.matchAll(/\bdocs\/[\w./-]+\.md/g)) {
          if (!seen.has(m[0])) seen.set(m[0], p.slice(root.length));
        }
      }
    }
  }
  await walk(`${root}src`);
  for (const [ref, file] of seen) {
    try {
      await Deno.stat(`${root}${ref}`);
    } catch {
      issues.push(`  ${ref} (cited in ${file}) does not exist`);
    }
  }
  return issues;
}

/** Assert every `AioErrorCode` value defined in src/error.ts appears in
 *  docs/debugging/errors.md. Returns one message per undocumented code. */
async function checkErrorCodes(): Promise<string[]> {
  const errorTs = await Deno.readTextFile(
    new URL("../src/diagnostics/error.ts", import.meta.url).pathname,
  );
  const union = errorTs.match(/export type AioErrorCode =([\s\S]*?);/);
  if (!union) return ["  could not parse AioErrorCode union from src/error.ts"];
  const codes = [...union[1]!.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
  const errorsMd = await Deno.readTextFile(
    new URL("../docs/debugging/errors.md", import.meta.url).pathname,
  );
  return codes
    .filter((code) => !errorsMd.includes(code))
    .map((code) => `  ${code} is not documented in docs/debugging/errors.md`);
}

async function detectVersion(): Promise<string | undefined> {
  try {
    // Root CHANGELOG.md is the canonical changelog (see .katana/docs.md); its
    // top heading names the current release, e.g. "## 1.0.0-alpha15 — …".
    const changelog = await Deno.readTextFile(
      new URL("../CHANGELOG.md", import.meta.url).pathname,
    );
    const match = changelog.match(/^## v?(\d+\.\d+\.\d+)/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

// Guarded so the pure checkers below can be imported by their test without
// running the whole gate as a side effect. `deno task check:docs` runs this
// file directly, so the gate itself is unchanged.
if (import.meta.main) main();

/** Every `t.expect.X` / `t.Y(` the docs teach must exist on the harness.
 *
 *  The source of truth is `TestContext` in src/testing/cell-test.ts — read as
 *  text rather than imported, because this script must stay runnable with
 *  `--allow-read` alone and the shape is a plain type literal. */
async function checkHarnessMembers(): Promise<string[]> {
  const src = await Deno.readTextFile(
    new URL("../src/testing/cell-test.ts", import.meta.url),
  );
  // `expect: { … }` — the member names inside that block.
  const expectBlock = /expect:\s*\{([\s\S]*?)\n  \};/.exec(src)?.[1] ?? "";
  const known = new Set(
    [...expectBlock.matchAll(/^\s{4}(\w+)\s*:/gm)].map((m) => m[1]!),
  );
  if (known.size === 0) {
    return [
      "  could not read TestContext.expect from src/testing/cell-test.ts — " +
      "this check went blind; fix the parse rather than deleting it",
    ];
  }
  const issues: string[] = [];
  for await (
    const entry of walk(DOCS_DIR, {
      exts: [".md"],
      includeDirs: false,
      skip: [/\/upgrade\//, /\/specs\//, /\/release-notes\//],
    })
  ) {
    const rel = entry.path.replace(DOCS_DIR, "");
    if (rel === "content.md") continue; // generated index — mirrors sources
    const lines = (await Deno.readTextFile(entry.path)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i]!.matchAll(/\bt\.expect\.(\w+)/g)) {
        if (!known.has(m[1]!)) {
          issues.push(
            `  ${rel}:${i + 1}  t.expect.${m[1]} does not exist ` +
              `(has: ${[...known].sort().join(", ")})`,
          );
        }
      }
    }
  }
  return issues;
}

// ── Doc → code: does what the docs SPELL actually exist? ───────────────
//
// Everything above this line checks code → docs (a new error code must be
// documented, a cited page must exist). The audit that produced this block
// found the opposite direction wide open: the docs promised commands with no
// binary behind them (`aio ship`, `aio build`, `aio doctor` — install.sh
// installs exactly ONE binary, `am`), imported symbols from `"aio"` that no
// export entry serves (`initStandalone`, `matchPath`), and listed a whole
// "Dispatch Introspection" API table for members of a plain function.
//
// The reader's failure mode is identical in all three cases: they copy the
// line, it does not resolve, and nothing in the repo ever said so. Three
// mechanical facts fix the whole class, and all three are already written
// down in code — the export snapshot, `am`'s command map, and the task
// tables — so the docs can be checked against them instead of against care.

/** Live docs = everything except the dirs that are deliberately historical.
 *  An upgrade guide naming `aio/react` is CORRECT: it is telling you the
 *  spelling you are migrating off. Same skip list the other checks use. */
const HISTORICAL_DIRS = [/\/upgrade\//, /\/specs\//, /\/release-notes\//];

export type DocFile = { rel: string; lines: string[] };

/** A schedule the docs TEACH but the framework REFUSES.
 *
 *  `aio.run({ schedules })` validates every entry at the config seam
 *  (`validateSchedules`, src/state/schedule.ts): durations are numbers of
 *  milliseconds and `action` is an action object. Nothing checked that the
 *  docs agreed — snippets are fragments, so no type-checker sees them — and
 *  docs/state/lifecycle.md shipped `{ every: "5m", action: "projects:scan" }`,
 *  wrong in both, in the one example teaching the feature. A reader copying it
 *  now gets a refusal at boot, which is the best possible outcome for THEM and
 *  the worst possible advertisement for us.
 *
 *  Scoped to fenced code blocks in live docs: prose that NAMES the refused
 *  spelling (this file's own message, or scheduling.md explaining it) is the
 *  documentation working, not a defect. */
function checkScheduleShapes(docs: DocFile[]): string[] {
  const out: string[] = [];
  for (const doc of docs) {
    let fenced = false;
    let block: string[] = [];
    let blockStart = 0;
    const flush = () => {
      // Only blocks that are actually about schedules — `action:` is a fine
      // key elsewhere (the alpha10 `interact({ action })` shape, say).
      const text = block.join("\n");
      if (/\bschedules?\s*:/.test(text) || /\bschedule\./.test(text)) {
        block.forEach((line, i) => {
          const loc = `${doc.rel}:${blockStart + i + 1}`;
          const dur = /\b(every|after)\s*:\s*['"]/.exec(line);
          if (dur) {
            out.push(
              `  ${loc}  ${dur[1]}: takes a NUMBER of milliseconds — ` +
                `write 300_000, not a "5m" string (aio.run refuses this at boot)`,
            );
          }
          if (/\baction\s*:\s*['"]/.test(line)) {
            out.push(
              `  ${loc}  action: takes an action OBJECT — ` +
                `cell.method.action() or { type: "cell:method" } ` +
                `(aio.run refuses a bare string at boot)`,
            );
          }
        });
      }
      block = [];
    };
    doc.lines.forEach((line, i) => {
      if (line.trimStart().startsWith("```")) {
        if (fenced) flush();
        else blockStart = i + 1;
        fenced = !fenced;
        return;
      }
      if (fenced) block.push(line);
    });
    if (fenced) flush(); // unterminated fence — check what we saw
  }
  return out;
}

/** A test file named as the thing that GUARANTEES something must exist.
 *
 *  Prose like "pinned by `tests/x.test.tsx`" is a promise: it tells the reader
 *  they need not re-derive the claim, because a gate re-derives it every run.
 *  A rename or a deletion turns that into a lie nothing detects — which is
 *  precisely how docs/ui/air-comparison.md came to say "tests/bundle-size.test.ts
 *  goes red if this page stops matching it" about a table the gate could not
 *  read.
 *
 *  Deliberately scoped to promise-words rather than to every `tests/…` path:
 *  docs also name test files as things to CREATE ("Create `tests/queue.test.ts`")
 *  and as illustrative paths in examples, and a check that cannot tell those
 *  apart would cry wolf. */
async function checkGateClaims(docs: DocFile[]): Promise<string[]> {
  const CLAIM_BEFORE =
    /(?:pinned|gated|guarded|enforced)\s+by[^.]{0,120}?`?(tests\/[A-Za-z0-9_./-]*\.test\.tsx?)`?/gi;
  const CLAIM_AFTER =
    /`(tests\/[A-Za-z0-9_./-]*\.test\.tsx?)`\s+(?:pins|fuzzes|proves|gates|enforces|guards)\b/gi;
  const out: string[] = [];
  const seen = async (ref: string): Promise<boolean> => {
    try {
      await Deno.stat(SRC(ref));
      return true;
    } catch {
      return false;
    }
  };
  const scan = async (label: string, text: string): Promise<void> => {
    for (const re of [CLAIM_BEFORE, CLAIM_AFTER]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const ref = m[1]!;
        if (!(await seen(ref))) {
          out.push(
            `  ${label}: names ${ref} as what guarantees this — that file does not exist`,
          );
        }
      }
    }
  };
  for (const doc of docs) await scan(doc.rel, doc.lines.join("\n"));
  // CLAUDE.md is exempt from the docs KATA (it is not tidied into docs/), not
  // from being true — and it is dense with exactly these claims, naming the
  // fuzzers and parity tests that make its architecture notes trustworthy.
  await scan("CLAUDE.md", await Deno.readTextFile(SRC("CLAUDE.md")));
  for await (
    const entry of walk(SRC("src"), {
      exts: [".ts", ".tsx"],
      includeDirs: false,
    })
  ) {
    await scan(
      entry.path.replace(SRC(""), ""),
      await Deno.readTextFile(entry.path),
    );
  }
  return out;
}

async function readLiveDocs(): Promise<DocFile[]> {
  const out: DocFile[] = [];
  for await (
    const entry of walk(DOCS_DIR, {
      exts: [".md"],
      includeDirs: false,
      skip: HISTORICAL_DIRS,
    })
  ) {
    const rel = entry.path.replace(DOCS_DIR, "");
    if (rel === "content.md") continue; // generated index — mirrors sources
    out.push({ rel, lines: (await Deno.readTextFile(entry.path)).split("\n") });
  }
  // The root README is a release surface and teaches commands too.
  out.push({
    rel: "README.md",
    lines: (await Deno.readTextFile(
      new URL("../README.md", import.meta.url).pathname,
    )).split("\n"),
  });
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const SRC = (p: string) => new URL(`../${p}`, import.meta.url).pathname;

// ── The three sources of truth ────────────────────────────────────────

/** entry specifier (`.`, `./air`, …) → the symbols it exports.
 *  Read from the surface lock the release already regenerates and gates. */
export async function loadSurface(): Promise<Map<string, Set<string>>> {
  const snap = JSON.parse(
    await Deno.readTextFile(SRC("docs/api-snapshot.json")),
  ) as { entries: Record<string, { symbols: Record<string, unknown> }> };
  const m = new Map<string, Set<string>>();
  for (const [entry, v] of Object.entries(snap.entries)) {
    m.set(entry, new Set(Object.keys(v.symbols ?? {})));
  }
  if (m.size === 0) throw new Error("api-snapshot.json has no entries");
  return m;
}

/** In an ANDROID bundle the bundler resolves the bare specifier `"aio"` to
 *  the standalone runtime instead of mod.ts (`src/build/esbuild-shared.ts`
 *  picks `src/standalone-air.ts`). So `import { initStandalone } from "aio"`
 *  is a true line inside an android build and a false one everywhere else —
 *  which is exactly what the targets doc says. Derived from the code rather
 *  than allowlisted by hand, so it cannot drift. */
export async function loadAndroidAlias(): Promise<Set<string>> {
  const shared = await Deno.readTextFile(SRC("src/build/esbuild-shared.ts"));
  const m = /doAndroid\s*\?\s*"([^"]+)"/.exec(shared);
  if (!m) {
    throw new Error(
      "check-docs: could not find the android `aio` alias in " +
        "src/build/esbuild-shared.ts — fix the parse, do not delete the check",
    );
  }
  const src = await Deno.readTextFile(SRC(m[1]!));
  const names = new Set<string>();
  for (
    const mm of src.matchAll(
      /^export\s+(?:async\s+)?(?:function|const|let|class|type|interface)\s+(\w+)/gm,
    )
  ) names.add(mm[1]!);
  for (const mm of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of mm[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "");
      if (name) names.add(name.trim());
    }
  }
  if (names.size === 0) {
    throw new Error(`check-docs: parsed no exports from ${m[1]}`);
  }
  return names;
}

/** `am`'s verbs — the keys of the COMMANDS map in src/am.ts. */
export async function loadAmVerbs(): Promise<Set<string>> {
  const src = await Deno.readTextFile(SRC("src/am.ts"));
  const block = /const COMMANDS:[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
  const verbs = new Set(
    [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!),
  );
  if (verbs.size === 0) {
    throw new Error(
      "check-docs: could not read the COMMANDS map from src/am.ts — " +
        "fix the parse rather than deleting this check",
    );
  }
  return verbs;
}

/** Every `deno task X` a doc may legitimately spell: this repo's own tasks
 *  (deno.json) plus the ones a scaffolded APP gets (`standardTasks()`, the
 *  single producer shared by `am create` and `am fix`). */
export async function loadTaskNames(): Promise<Set<string>> {
  const repo = JSON.parse(await Deno.readTextFile(SRC("deno.json"))) as {
    tasks?: Record<string, unknown>;
  };
  const names = new Set(Object.keys(repo.tasks ?? {}));
  const create = await Deno.readTextFile(SRC("src/am/am-cmd-create.ts"));
  const fn = /export function standardTasks\([\s\S]*?\n\}/.exec(create)?.[0];
  const ret = fn ? /return \{([\s\S]*)\n  \};/.exec(fn)?.[1] ?? "" : "";
  const scaffold = [...ret.matchAll(/^\s{4}(?:"([\w:-]+)"|([\w]+)):/gm)]
    .map((m) => m[1] ?? m[2]!);
  if (scaffold.length === 0) {
    throw new Error(
      "check-docs: could not read standardTasks() from " +
        "src/am/am-cmd-create.ts — fix the parse, do not delete the check",
    );
  }
  for (const t of scaffold) names.add(t);
  return names;
}

// ── Check: every backticked command resolves ──────────────────────────

/** A CLI this project does not install. `install.sh` installs exactly one
 *  binary — `am` — so any `aio <verb>` line is a command the reader cannot
 *  run, and has been since before the installer existed. Value = the working
 *  spelling to print in the failure. */
const GHOST_CLIS: Record<string, string> = {
  aio: "there is no `aio` binary (install.sh installs only `am`) — " +
    "use the app's task (`deno task ship|build|doctor`) or " +
    "`deno run -A jsr:@riagentic/aio/<entry>`",
};

/** Lines whose command word is a placeholder rather than a verb. */
const PLACEHOLDER = /^[<{[$]|^\.\.\.|^…/;

/** Prose that NAMES a retired command in order to say it is retired is
 *  correct documentation, not a broken command — `docs/clients/browser.md`
 *  tells you `am interact`/`am click`/`am dom` were removed in favour of the
 *  semantic surface, and that sentence has to be allowed to spell them. The
 *  window is three lines because the sentence wraps: the verb and the word
 *  "removed" routinely land on different lines. */
const RETIREMENT_PROSE =
  /\b(?:removed|retired|deprecat|renamed|no longer|superseded?|supersedes|in favou?r of|used to be)\b/i;

function retirementWindow(lines: string[], i: number): boolean {
  return RETIREMENT_PROSE.test(
    `${lines[i - 1] ?? ""}\n${lines[i]}\n${lines[i + 1] ?? ""}`,
  );
}

export function commandIssues(
  docs: DocFile[],
  amVerbs: Set<string>,
  tasks: Set<string>,
): string[] {
  const issues: string[] = [];
  for (const { rel, lines } of docs) {
    let inFence = false;
    let fenceInfo = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const fence = /^```(.*)$/.exec(line);
      if (fence) {
        inFence = !inFence;
        fenceInfo = inFence ? fence[1]!.trim() : "";
        continue;
      }
      // Candidate command strings: every backticked span, plus — inside a
      // shell fence — the line itself (that is where a reader copies from).
      const cands: string[] = [...line.matchAll(/`([^`]+)`/g)].map((m) =>
        m[1]!
      );
      if (inFence && /^(sh|bash|shell|console|zsh)$/.test(fenceInfo)) {
        cands.push(line.replace(/^\s*\$\s*/, "").replace(/\s*#.*$/, ""));
      }
      if (retirementWindow(lines, i)) continue;
      for (const raw of cands) {
        const cmd = raw.trim().replace(/^\$\s*/, "");
        const parts = cmd.split(/\s+/);
        const head = parts[0] ?? "";
        const arg = parts[1] ?? "";
        const loc = `  ${rel}:${i + 1}`;
        if (GHOST_CLIS[head] && arg && /^[a-z][\w:-]*$/.test(arg)) {
          issues.push(`${loc}  \`${cmd}\` — ${GHOST_CLIS[head]}`);
          continue;
        }
        if (head === "am" && arg && !PLACEHOLDER.test(arg)) {
          if (/^[a-z][\w-]*$/.test(arg) && !amVerbs.has(arg)) {
            issues.push(
              `${loc}  \`am ${arg}\` is not an am verb ` +
                `(src/am.ts COMMANDS)`,
            );
          }
          continue;
        }
        if (head === "deno" && arg === "task") {
          const name = parts[2] ?? "";
          if (!name || PLACEHOLDER.test(name)) continue;
          if (/^[a-z][\w:-]*$/.test(name) && !tasks.has(name)) {
            issues.push(
              `${loc}  \`deno task ${name}\` is neither a repo task ` +
                `(deno.json) nor a scaffolded app task (standardTasks())`,
            );
          }
        }
      }
    }
  }
  return issues;
}

// ── Check: every symbol the docs import or table resolves ─────────────

/** `"aio"` → `.`, `"aio/air"` → `./air`. Anything else is not ours. */
export function entryOf(spec: string): string | null {
  if (spec === "aio" || spec === "@riagentic/aio") return ".";
  const m = /^(?:aio|@riagentic\/aio)\/(.+)$/.exec(spec);
  return m ? `./${m[1]}` : null;
}

/** Receivers a doc may legitimately dot into in an API table: the value a
 *  reader HOLDS, not a value the package exports. Anything else must be an
 *  exported symbol — which is how `dispatch.getQueueDepth()` was caught: it
 *  was tabled as if `dispatch` were something you can hold, when the app
 *  hands you `app.dispatch`, a plain function. Add a receiver here only when
 *  the docs genuinely teach one; the point of the list is that it is short. */
const TABLE_RECEIVERS = new Set([
  "app", // aio.run()'s handle
  "s", // the method draft
  "t", // testCell context
  "ui", // testUI handle
  "cli", // connectCli()
  "db", // app.db / createDB()
  "ctx", // server request context
  "store", // the raw store
  "blobs", // app.blobs
  "sessions", // app.sessions
  "auth", // app.auth
  "cells", // app.cells
  "window", // the browser global
  "globalThis",
  "Deno",
]);

export function symbolIssues(
  docs: DocFile[],
  surface: Map<string, Set<string>>,
  androidAlias: Set<string>,
): string[] {
  const issues: string[] = [];
  const known = (entry: string, name: string) =>
    surface.get(entry)?.has(name) ||
    (entry === "." && androidAlias.has(name));
  const anywhere = (name: string) =>
    [...surface.values()].some((s) => s.has(name)) || androidAlias.has(name);

  for (const { rel, lines } of docs) {
    // 1. Imports from an aio specifier, inside a CODE FENCE. A fence is what
    //    a reader copies, so a fenced import must resolve. Prose is
    //    deliberately excluded: `docs/build/imports.md` teaches the
    //    server-only boundary by SHOWING the wrong import inline ("**Wrong:**
    //    a static `import { createDB } from \"aio\"`"), and a counter-example
    //    is the one place a broken specifier is the point.
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^```/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (!fenced) continue;
      const m = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/
        .exec(line);
      if (!m) continue;
      const entry = entryOf(m[3]!);
      if (entry === null) continue; // not an aio specifier
      const loc = `  ${rel}:${i + 1}`;
      if (!surface.has(entry)) {
        issues.push(
          `${loc}  "${m[3]}" is not an export entry ` +
            `(deno.json exports: ${[...surface.keys()].join(", ")})`,
        );
        continue;
      }
      for (const part of m[2]!.split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (!name) continue;
        if (!known(entry, name)) {
          issues.push(
            `${loc}  \`${name}\` is not exported from "${m[3]}" ` +
              `(api-snapshot.json ${entry})`,
          );
        }
      }
    }

    // 2. API tables — a table whose first header cell is `API`. Its first
    //    column is a promise that the named thing is public.
    let inApiTable = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.startsWith("|")) {
        inApiTable = false;
        continue;
      }
      const first = line.split("|")[1]?.trim() ?? "";
      if (/^API$/.test(first)) {
        inApiTable = true;
        continue;
      }
      if (!inApiTable || /^-+$/.test(first.replaceAll(" ", ""))) continue;
      const cell = /^`([^`]+)`$/.exec(first)?.[1];
      if (!cell || cell.startsWith("<")) continue; // JSX components: not symbols
      const chain = /^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)/.exec(cell);
      if (!chain) continue;
      const root = chain[1]!;
      const loc = `  ${rel}:${i + 1}`;
      if (chain[2]) {
        if (!anywhere(root) && !TABLE_RECEIVERS.has(root)) {
          issues.push(
            `${loc}  \`${cell}\` — \`${root}\` is neither an exported ` +
              `symbol nor a documented receiver; tabling it as API says the ` +
              `reader can hold one`,
          );
        }
        continue;
      }
      if (!anywhere(root)) {
        issues.push(
          `${loc}  \`${cell}\` — \`${root}\` is in no export entry ` +
            `(api-snapshot.json); it is importable nowhere`,
        );
      }
    }
  }
  return issues;
}

// ── Check: every `page.md#anchor` link lands on a heading ─────────────
//
// docs/state/the-bridge.md linked `methods.md#returning-schedule-effects`
// after that heading had been rewritten, and three more pages linked three
// more headings that no longer exist. A link is a promise about another
// page's structure; GitHub's slug rule is mechanical, so the promise is
// checkable. Every page is covered — an upgrade guide's links must land too.

/** GitHub's heading → anchor rule: lowercase, strip everything but letters,
 *  digits, spaces, `-` and `_`, then spaces → `-`. A repeated slug in one
 *  page gets `-1`, `-2`, … (see `headingSlugs`). */
export function slugOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** The anchors one page offers: its ATX headings outside code fences. */
export function headingSlugs(lines: string[]): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slugOf(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** `[text](page.md#anchor)` / `[text](#anchor)` — the target and the anchor. */
const ANCHOR_LINK = /\]\(<?([^)\s#>]*)#([^)\s>]+)>?\)/g;

/** `docs` are REPO-relative here (`docs/state/methods.md`, `README.md`) so a
 *  `../README.md#x` from inside docs/ resolves. */
export function anchorIssues(docs: DocFile[]): string[] {
  const byRel = new Map(docs.map((d) => [d.rel, d]));
  const slugs = new Map<string, Set<string>>();
  const slugsOf = (rel: string): Set<string> => {
    let s = slugs.get(rel);
    if (!s) {
      s = headingSlugs(byRel.get(rel)!.lines);
      slugs.set(rel, s);
    }
    return s;
  };
  const out: string[] = [];
  for (const { rel, lines } of docs) {
    let fenced = false;
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      for (const m of line.matchAll(ANCHOR_LINK)) {
        const [, file, anchor] = m as unknown as [string, string, string];
        if (/^[a-z][a-z0-9+.-]*:/i.test(file)) continue; // http(s)://…
        const target = file
          ? new URL(file, `file:///${rel}`).pathname.slice(1)
          : rel;
        if (!target.endsWith(".md")) continue;
        const loc = `  ${rel}:${i + 1}`;
        if (!byRel.has(target)) {
          out.push(`${loc}  links ${file}#${anchor} — no such page`);
          continue;
        }
        const want = decodeURIComponent(anchor).toLowerCase();
        const have = slugsOf(target);
        if (have.has(want)) continue;
        const stem = want.split("-")[0]!;
        const near = [...have].filter((s) => s.includes(stem)).slice(0, 4);
        out.push(
          `${loc}  #${anchor} is not a heading in ${target}` +
            (near.length
              ? ` (near: ${near.map((s) => `#${s}`).join(", ")})`
              : ""),
        );
      }
    });
  }
  return out;
}

/** EVERY page, historical dirs included, keyed repo-relative. */
export async function readAllDocs(): Promise<DocFile[]> {
  const out: DocFile[] = [];
  for await (
    const entry of walk(DOCS_DIR, { exts: [".md"], includeDirs: false })
  ) {
    const rel = entry.path.replace(DOCS_DIR, "");
    if (rel === "content.md") continue; // generated index — mirrors sources
    out.push({
      rel: `docs/${rel}`,
      lines: (await Deno.readTextFile(entry.path)).split("\n"),
    });
  }
  for (const rel of ["README.md", "CLAUDE.md"]) {
    out.push({ rel, lines: (await Deno.readTextFile(SRC(rel))).split("\n") });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ── Check: every `/__aio/…` path the docs spell is a route the server mounts ─
//
// docs/clients/app-manager.md tabled `/__aio/trojan/health` (the real route is
// `/__aio/health`) and taught `POST /__aio/trojan/interact/0` — retired when
// `trigger/<n>` replaced it — and both 404 for anyone who copies them. The
// route list is not a table anywhere; it is the `pathname === "…"` and
// `route === "…"` comparisons in four server files. So those are what is read.

export type Routes = {
  /** Fully spelled routes: `/__aio/health`, `/__aio/trojan/state`, … */
  exact: Set<string>;
  /** Routes that take a trailing segment: `/__aio/blobs/`, `/__aio/trojan/surface/` */
  prefixes: string[];
  /** Namespaces a doc may wildcard (`/__aio/trojan/*`) or name bare. */
  namespaces: Set<string>;
};

export async function loadRoutes(): Promise<Routes> {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  const namespaces = new Set<string>(["/__aio/"]);
  for (const f of ["src/server/server.ts", "src/server/server-static.ts"]) {
    const src = await Deno.readTextFile(SRC(f));
    for (const m of src.matchAll(/pathname\s*===\s*"(\/__aio\/[^"]+)"/g)) {
      exact.add(m[1]!);
    }
    for (
      const m of src.matchAll(/pathname\.startsWith\("(\/__aio\/[^"]+\/)"\)/g)
    ) {
      prefixes.add(m[1]!);
      namespaces.add(m[1]!);
    }
  }
  const auth = await Deno.readTextFile(SRC("src/server/server-auth.ts"));
  const trojanPrefix = /TROJAN_PREFIX\s*=\s*"(\/__aio\/[^"]+\/)"/.exec(auth)
    ?.[1];
  if (!trojanPrefix) {
    throw new Error(
      "check-docs: could not read TROJAN_PREFIX from src/server/server-auth.ts" +
        " — fix the parse, do not delete the check",
    );
  }
  namespaces.add(trojanPrefix);
  const trojan = await Deno.readTextFile(SRC("src/server/server-trojan.ts"));
  for (const m of trojan.matchAll(/\broute\s*===\s*"([\w-]+)"/g)) {
    exact.add(trojanPrefix + m[1]);
  }
  for (const m of trojan.matchAll(/\broute\.startsWith\("([\w-]+)\/"\)/g)) {
    prefixes.add(`${trojanPrefix}${m[1]}/`);
  }
  const flows = await Deno.readTextFile(SRC("src/server/auth-flows.ts"));
  const authPrefix = /pathname\.startsWith\("(\/__aio\/auth\/)"\)/.exec(flows)
    ?.[1];
  if (!authPrefix) {
    throw new Error(
      "check-docs: could not read the auth route prefix from " +
        "src/server/auth-flows.ts — fix the parse, do not delete the check",
    );
  }
  namespaces.add(authPrefix);
  for (const m of flows.matchAll(/\broute\s*===\s*"[A-Z]+ ([\w/-]+)"/g)) {
    exact.add(authPrefix + m[1]);
  }
  for (const m of flows.matchAll(/^\s*case "([\w/-]+)":/gm)) {
    exact.add(authPrefix + m[1]);
  }
  if (exact.size < 20) {
    throw new Error(
      `check-docs: parsed only ${exact.size} /__aio routes — the parse went ` +
        "blind; fix it rather than deleting the check",
    );
  }
  return { exact, prefixes: [...prefixes], namespaces };
}

/** A `/__aio/…` token as a doc spells it, trimmed of prose punctuation and
 *  of a query string. */
const AIO_PATH = /\/__aio\/[^\s`'")\]|,]*/g;

export function routeIssues(docs: DocFile[], routes: Routes): string[] {
  const ok = (p: string): boolean =>
    routes.exact.has(p) ||
    routes.namespaces.has(p) ||
    (p.endsWith("/*") && routes.namespaces.has(p.slice(0, -1))) ||
    routes.prefixes.some((px) => p.startsWith(px) && p.length > px.length) ||
    /\.tsx?$/.test(p); // dev serves framework source under /__aio/<rel>.ts
  const out: string[] = [];
  for (const { rel, lines } of docs) {
    lines.forEach((line, i) => {
      if (retirementWindow(lines, i)) return;
      for (const m of line.matchAll(AIO_PATH)) {
        const p = m[0].replace(/\?.*$/, "").replace(/[.:;…]+$/, "");
        if (ok(p)) continue;
        out.push(
          `  ${rel}:${i + 1}  ${m[0]} is not a route the server mounts ` +
            `(src/server/server.ts, server-static.ts, server-trojan.ts, ` +
            `auth-flows.ts)`,
        );
      }
    });
  }
  return out;
}

// ── Check: every flag a doc hands to a scripts/*.ts is one it parses ──
//
// docs/testing/onboarding-lab.md taught `--expect`, `--interact` and
// `--no-interact` as `deno task lab` flags; scripts/lab.ts exits 2 on the
// first two (`unknown flag`) and nothing anywhere parses the third. A flag is
// a string literal in the parser, so "does the script accept it" is a fact the
// source states.

export type ScriptFlags = {
  /** Every `--flag` the script's source spells in a string — the flags it
   *  parses plus those it hands to programs it spawns. An over-approximation
   *  that can only miss, never cry wolf. */
  accepted: Set<string>;
  /** The flags a USER may pass: the literals inside `function parse(…)`.
   *  Null when the script has no parse() — then there is no reverse check. */
  user: Set<string> | null;
};

/** The page that teaches a script's flags, so BOTH directions are checked
 *  there: every flag it spells must parse, every user flag must be spelled.
 *  (Same shape as tests/docs-flags-are-documented.test.ts for the runtime,
 *  build and `am` flags.) */
export const SCRIPT_PAGES: Record<string, string> = {
  "scripts/lab.ts": "testing/onboarding-lab.md",
};

const FLAG_LITERAL = /["'`](--[a-z][a-z0-9-]*)/g;

export async function loadScriptFlags(): Promise<Map<string, ScriptFlags>> {
  const out = new Map<string, ScriptFlags>();
  for (const dir of ["scripts", "docker"]) {
    for await (const e of Deno.readDir(SRC(dir))) {
      if (!e.isFile || !e.name.endsWith(".ts")) continue;
      const src = await Deno.readTextFile(SRC(`${dir}/${e.name}`));
      const accepted = new Set<string>();
      for (const m of src.matchAll(FLAG_LITERAL)) accepted.add(m[1]!);
      for (
        const m of src.matchAll(/args\.(?:get|has)\("([a-z][a-z0-9-]*)"\)/g)
      ) {
        accepted.add(`--${m[1]}`);
      }
      const parse = /\nfunction parse\([\s\S]*?\n\}/.exec(src)?.[0];
      const user = parse
        ? new Set([...parse.matchAll(FLAG_LITERAL)].map((m) => m[1]!))
        : null;
      out.set(`${dir}/${e.name}`, { accepted, user });
    }
  }
  for (const script of Object.keys(SCRIPT_PAGES)) {
    if (!out.get(script)?.user?.size) {
      throw new Error(
        `check-docs: ${script} has no parse() with --flag literals — ` +
          "fix the parse, do not delete the check",
      );
    }
  }
  return out;
}

/** `deno task X` → `scripts/Y.ts` for every task that IS one script run
 *  (a chained task like `test` runs several programs; its flags are theirs). */
export async function loadTaskScripts(): Promise<Map<string, string>> {
  const repo = JSON.parse(await Deno.readTextFile(SRC("deno.json"))) as {
    tasks?: Record<string, string>;
  };
  const out = new Map<string, string>();
  for (const [name, cmd] of Object.entries(repo.tasks ?? {})) {
    if (/&&|\|\||;/.test(cmd)) continue;
    const m = /^deno run\b[^\n]*?\s((?:scripts|docker)\/[\w-]+\.ts)/.exec(cmd);
    if (m) out.set(name, m[1]!);
  }
  if (!out.has("lab")) {
    throw new Error(
      "check-docs: deno.json's `lab` task no longer maps to scripts/lab.ts — " +
        "fix the parse, do not delete the check",
    );
  }
  return out;
}

/** The strings a reader would copy as a command: every backticked span, and —
 *  inside a shell fence — the line itself. */
function* commandCandidates(
  lines: string[],
): Generator<[number, string]> {
  let inFence = false;
  let fenceInfo = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      inFence = !inFence;
      fenceInfo = inFence ? fence[1]!.trim() : "";
      continue;
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) yield [i, m[1]!];
    if (inFence && /^(sh|bash|shell|console|zsh)$/.test(fenceInfo)) {
      yield [i, line.replace(/^\s*\$\s*/, "").replace(/\s*#.*$/, "")];
    }
  }
}

export function flagIssues(
  docs: DocFile[],
  taskScripts: Map<string, string>,
  scriptFlags: Map<string, ScriptFlags>,
): string[] {
  const out: string[] = [];
  const flagName = (tok: string) => tok.replace(/=.*$/, "");
  for (const { rel, lines } of docs) {
    // 1. A command line handing flags to a script: `deno task lab --x`,
    //    `deno run -A scripts/lab.ts --x`, `deno run -A docker/verify-app.ts --x`.
    for (const [i, raw] of commandCandidates(lines)) {
      const parts = raw.trim().replace(/^\$\s*/, "").split(/\s+/);
      if (parts[0] !== "deno") continue;
      let script: string | undefined;
      let from = 0;
      if (parts[1] === "task" && parts[2] && taskScripts.has(parts[2])) {
        script = taskScripts.get(parts[2]);
        from = 3;
      } else if (parts[1] === "run") {
        from = parts.findIndex((p) =>
          /^(?:scripts|docker)\/[\w-]+\.ts$/.test(p)
        );
        if (from < 0) continue;
        script = parts[from++];
      }
      const flags = script ? scriptFlags.get(script) : undefined;
      if (!script || !flags) continue;
      for (const tok of parts.slice(from)) {
        if (!/^--[a-z]/.test(tok)) continue;
        const name = flagName(tok);
        if (flags.accepted.has(name)) continue;
        out.push(
          `  ${rel}:${i + 1}  \`${tok}\` — ${script} does not parse ${name} ` +
            `(it accepts: ${
              [...flags.user ?? flags.accepted].sort().join(" ")
            })`,
        );
      }
    }
    // 2. The page that teaches a script: every bare `--flag` span on it must
    //    parse (in that script, or in a script the page names), and every
    //    user flag the script parses must be on the page.
    const owner = Object.entries(SCRIPT_PAGES).find(([, page]) => page === rel)
      ?.[0];
    if (!owner) continue;
    const text = lines.join("\n");
    const named = new Set<string>([owner]);
    for (const m of text.matchAll(/\b((?:scripts|docker)\/[\w-]+\.ts)\b/g)) {
      named.add(m[1]!);
    }
    const accepted = new Set<string>();
    for (const s of named) {
      for (const f of scriptFlags.get(s)?.accepted ?? []) accepted.add(f);
    }
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/`(--[a-z][a-z0-9-]*)/g)) {
        if (accepted.has(m[1]!)) continue;
        out.push(
          `  ${rel}:${i + 1}  \`${m[1]}\` — no script this page names ` +
            `(${[...named].join(", ")}) parses it`,
        );
      }
    });
    for (const f of scriptFlags.get(owner)!.user!) {
      if (new RegExp(`${f.replace(/-/g, "\\-")}(?![a-z0-9-])`).test(text)) {
        continue;
      }
      out.push(
        `  ${rel}  ${owner} parses \`${f}\` but this page never spells it`,
      );
    }
  }
  return out;
}
