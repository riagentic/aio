// aiol — project scanner: reads files, extracts cells, builds LintContext

import { basename, extname, join, relative } from "@std/path";
import { codeMatches } from "./scan.ts";
import { removalsInSource } from "../src/state/removals.ts";
import type {
  CellInfo,
  DenoJsonConfig,
  Issue,
  LintContext,
  LintReport,
  SourceFile,
} from "./types.ts";

const SOURCE_EXTS = new Set([".ts", ".tsx"]);
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".claude",
  "untracked",
  ".vscode",
]);
const MAX_FILE_SIZE = 512 * 1024; // 512KB — skip huge generated files

/** Directories beyond `src/` that hold a project's own code, scanned when they
 *  exist. `cells/` is an app shape; `scripts/` and `tools/` are the build,
 *  release-gate and dev-tool code that decides what ships — unlinted until now
 *  purely because the scan started and stopped at `src/`. */
const OPTIONAL_ROOTS = ["cells", "scripts", "tools"] as const;

/** Every entry module the project DECLARES, normalized to project-relative
 *  paths: `entry`, then each `build.targets[].entry` of the object form.
 *  Exported so the rule and its fixture agree on one answer. */
export function declaredEntryPaths(cfg: DenoJsonConfig | null): string[] {
  if (!cfg) return [];
  const norm = (e: unknown): string | null =>
    typeof e === "string" && e.trim() !== ""
      ? e.trim().replace(/^\.\//, "").replaceAll("\\", "/")
      : null;
  const out: string[] = [];
  const push = (e: unknown) => {
    const n = norm(e);
    if (n && !out.includes(n)) out.push(n);
  };
  push(cfg.entry);
  const targets = cfg.build?.targets;
  if (targets && !Array.isArray(targets) && typeof targets === "object") {
    for (const t of Object.values(targets)) push(t?.entry);
  }
  return out;
}

/** The target KINDS a project declares in `build.targets`, for both
 *  spellings: the array form `["server","browser"]` and the object form,
 *  whose key may be a free LABEL with `kind` naming the actual target
 *  (`{"agent":{"kind":"electron"}}` — two apps of one kind in one repo).
 *  Always an array, so a caller can never `.some()` an object. */
export function declaredTargetKinds(cfg: DenoJsonConfig | null): string[] {
  const raw = cfg?.build?.targets;
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string" && !!t.trim())
      .map((t) => t.trim());
  }
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw).map(([label, o]) => {
    const kind = (o as { kind?: unknown } | null)?.kind;
    return typeof kind === "string" && kind.trim() ? kind.trim() : label.trim();
  }).filter(Boolean);
}

/** Is this project an aio APP, or something else that happens to sit next to
 *  aio (the framework repo itself, a tool, a library)?
 *
 *  App-shaped rules — "no entry point found (src/app.ts)", "move appId into
 *  aio.run()", "sync I/O blocks every client's next action" — all presuppose a
 *  dispatch loop with clients on it. Run against the framework repo they advise
 *  moving a framework field into a call that does not exist there, and they
 *  flag sync I/O whose synchrony is the POINT (the journal fsyncs every append
 *  so it survives SIGKILL; "use the async version" would delete the guarantee).
 *  That was 84 of the framework's 85 warnings — which is how a true warning
 *  gets trained away.
 *
 *  The test is CONSUMPTION, read from `deno.json` — the same rule `run.sh` uses
 *  to decide "is this an aio app repo", so there is one answer and not two. It
 *  cannot be read from the source: the framework's own test helpers call
 *  `aio.run()` (booting apps is what they do), so a code scan classifies the
 *  framework as an app.
 *
 *  Unknown → treated as an APP. Mis-silencing a real app's warnings is the
 *  worse error of the two; a false positive is visible, a false negative is not. */
export function looksLikeApp(cfg: DenoJsonConfig | null): boolean {
  if (!cfg) return true;
  // aio's own repo maps `aio` to its OWN root module. An app maps it to a
  // published version (`jsr:@riagentic/aio@…`) or to a vendored copy
  // (`./dep/aio/mod.ts`) — never to `./mod.ts`, because that file is the
  // framework. The package name is the second, blunter half of the same test:
  // this is the one repo the linter ships inside and must recognise.
  if (cfg.name === "@riagentic/aio") return false;
  const aioImport = (cfg.imports ?? {})["aio"];
  if (aioImport === "./mod.ts" || aioImport === "mod.ts") return false;
  return true;
}

/** True for a project's own TOOLING — build scripts, release gates, benchmarks,
 *  dev utilities.
 *
 *  Tooling is real code and most rules apply to it. What differs is the PREMISE
 *  a handful of rules are built on:
 *
 *  • "sync I/O blocks the event loop — every client's next action waits behind
 *    it": a one-shot CLI has no clients, and its whole job is to finish.
 *  • "use structured logging instead of console.log": a gate script's stdout IS
 *    its interface.
 *  • "this cell has no test file" / "use schedule instead of setTimeout": a cell
 *    defined in a benchmark is a fixture, not a shipped surface.
 *
 *  Those rules must skip tooling. Scanning these directories while firing
 *  premise-false rules in them would make the linter loudest exactly where the
 *  stakes are lowest — the failure mode that keeps a linter from being read. */
export function isToolingPath(relative: string): boolean {
  const p = relative.replaceAll("\\", "/");
  return p.startsWith("scripts/") || p.startsWith("tools/");
}

/** A TEST file — by name (`*.test.ts(x)`, `*_test.ts(x)`) or by living under a
 *  `test/` or `tests/` segment anywhere in the path.
 *
 *  The twin of {@link isToolingPath}, for the same reason and against the same
 *  failure. `SCANNED_ROOTS` includes `test/` and `tests/` on purpose — most
 *  rules apply there, and a test that misuses the API is worth reporting. What
 *  does NOT apply is the premise "this file is compiled into the browser
 *  bundle": a `*.test.tsx` is run by `deno test`, never bundled, and `Deno.test`
 *  is the first line of it.
 *
 *  Without this predicate the `Deno.*` rule reported every UI test file as
 *  shipped code — measured at 55 ERRORs across 16 files in one app, all false,
 *  while `check:graph` walked the real module graph from `App.tsx` and found no
 *  blocking import at all. An ERROR-level gate that is wrong 55 times out of 55
 *  is a gate its author turns off, and then it stops catching the real one it
 *  was written for (`Deno.env.get` in a component, which produces a blank
 *  page). That is the failure `isToolingPath` names above; test paths were
 *  simply never added to it. */
export function isTestPath(relative: string): boolean {
  const p = relative.replaceAll("\\", "/");
  return /(^|\/)tests?\//.test(p) || /\.test\.tsx?$/.test(p) ||
    /_test\.tsx?$/.test(p);
}

/** Directories the scan reads, project-relative. Anything else is skipped —
 *  which is fine, and must be SAID rather than assumed (see `Skip`). */
export const SCANNED_ROOTS: readonly string[] = [
  "src",
  ...OPTIONAL_ROOTS,
  "tests",
  "test",
];

/** Directories that are never a project's own source: build output, the
 *  vendored framework, dependency caches. Not "skipped" — not code. */
const NOT_SOURCE_DIRS = new Set([
  ...IGNORE_DIRS,
  "dep",
  "vendor",
  "coverage",
  "target",
  "out",
  "build",
]);

/** One file (or directory) the scan REFUSED, and why. A linter that reads
 *  nothing looks exactly like a clean project: same silence, same exit 0. Every
 *  refusal is carried out to a finding instead of being swallowed here. */
export type Skip = { path: string; reason: string };

/** Recursively collect source files */
async function collectFiles(
  dir: string,
  root: string,
  out: SourceFile[],
  skipped: Skip[],
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await collectFiles(path, root, out, skipped);
      } else if (entry.isFile && SOURCE_EXTS.has(extname(entry.name))) {
        try {
          const stat = await Deno.stat(path);
          if (stat.size > MAX_FILE_SIZE) {
            skipped.push({
              path: relative(root, path),
              reason: `${Math.round(stat.size / 1024)} KB — over aiol's ${
                MAX_FILE_SIZE / 1024
              } KB per-file limit`,
            });
            continue;
          }
          const content = await Deno.readTextFile(path);
          out.push({
            path,
            relative: relative(root, path),
            name: basename(path),
            ext: extname(path),
            content,
            lines: content.split("\n"),
          });
        } catch (e) {
          skipped.push({
            path: relative(root, path),
            reason: `unreadable — ${e instanceof Error ? e.message : e}`,
          });
        }
      }
    }
  } catch { /* dir unreadable */ }
}

/** Top-level directories that hold `.ts`/`.tsx` the scan never reads.
 *
 *  Bounded on purpose — direct children and one level below — so this costs a
 *  couple of `readDir`s, not a walk of the vendored framework. */
async function unscannedCodeDirs(projectDir: string): Promise<string[]> {
  const holdsCode = async (dir: string, depth: number): Promise<boolean> => {
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.isFile && SOURCE_EXTS.has(extname(e.name))) return true;
        if (
          e.isDirectory && depth > 0 && !NOT_SOURCE_DIRS.has(e.name) &&
          !e.name.startsWith(".")
        ) {
          if (await holdsCode(join(dir, e.name), depth - 1)) return true;
        }
      }
    } catch { /* unreadable */ }
    return false;
  };
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(projectDir)) {
      if (!e.isDirectory || e.name.startsWith(".")) continue;
      if (NOT_SOURCE_DIRS.has(e.name) || SCANNED_ROOTS.includes(e.name)) {
        continue;
      }
      if (await holdsCode(join(projectDir, e.name), 1)) out.push(e.name);
    }
  } catch { /* root unreadable */ }
  return out.sort();
}

/** Read and parse deno.json or deno.jsonc */
async function readDenoJson(
  dir: string,
): Promise<{ config: DenoJsonConfig | null; path: string | null }> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(dir, name);
    try {
      const text = await Deno.readTextFile(path);
      // Strip JSONC comments for .jsonc
      const clean = name.endsWith(".jsonc")
        ? text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
        : text;
      return { config: JSON.parse(clean), path };
    } catch {
      continue;
    }
  }
  return { config: null, path: null };
}

/** Extract cell() calls from source files via regex (no AST needed) */
function extractCells(files: SourceFile[]): CellInfo[] {
  const cells: CellInfo[] = [];
  // Match: cell('name', { ... }) or cell("name", { ... })
  const cellRe = /\bcell\s*\(\s*(['"`])(\w[\w-]*)\1/g;

  for (const file of files) {
    // Only real code declares a cell — a `cell("x")` in a doc comment or in a
    // code-generator's template literal is an example, not this project's cell
    // (it used to produce phantom cells + unfixable duplicate-name errors).
    for (const match of codeMatches(file.content, cellRe)) {
      const name = match[2]!;
      const lineIdx = file.content.slice(0, match.index).split("\n").length;
      // Scan forward from match to find the config object
      const afterMatch = file.content.slice(match.index!);
      const info = parseCellConfig(afterMatch);

      cells.push({
        name,
        file,
        line: lineIdx,
        hasState: info.hasState,
        hasMethods: info.hasMethods,
        hasActions: info.hasActions,
        hasGenerators: info.hasGenerators,
        hasMachine: info.hasMachine,
        removedKeys: info.removedKeys,
        hasSelectors: info.hasSelectors,
        isWorker: info.isWorker,
        hasVersion: info.hasVersion,
        persistFalse: info.persistFalse,
        stateKeys: info.stateKeys,
        stateIsLiteral: info.stateIsLiteral,
        methodNames: info.methodNames,
        actionNames: info.actionNames,
      });
    }
  }
  return cells;
}

/** Parse cell config block to extract state keys, methods, etc. */
function parseCellConfig(source: string): {
  hasState: boolean;
  hasMethods: boolean;
  hasActions: boolean;
  hasGenerators: boolean;
  hasMachine: boolean;
  removedKeys: string[];
  hasSelectors: boolean;
  isWorker: boolean;
  /** `version: N` — what makes this cell visible to the update data gate. */
  hasVersion: boolean;
  /** `persist: false` — this cell keeps nothing on disk. */
  persistFalse: boolean;
  stateKeys: string[];
  stateIsLiteral: boolean;
  methodNames: string[];
  actionNames: string[];
} {
  // Find the config object: first { after cell('name',
  // The source starts at `cell('name',...` so find the first {
  const firstBrace = source.indexOf("{");
  if (firstBrace === -1) {
    return {
      hasState: false,
      hasMethods: false,
      hasActions: false,
      hasGenerators: false,
      hasMachine: false,
      removedKeys: [],
      hasSelectors: false,
      isWorker: false,
      hasVersion: false,
      persistFalse: false,
      stateKeys: [],
      stateIsLiteral: false,
      methodNames: [],
      actionNames: [],
    };
  }
  let depth = 1;
  let end = -1;
  // Scan bound guards against pathological files; 10_000 was too small — a large
  // cell config (e.g. a vault cell with many signing methods) overran it, so the
  // matcher returned end === -1 and the cell was falsely reported as having no
  // state / no methods. 200_000 covers any realistic cell, still bounded.
  for (let i = firstBrace + 1; i < Math.min(source.length, 200_000); i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) {
    return {
      hasState: false,
      hasMethods: false,
      hasActions: false,
      hasGenerators: false,
      hasMachine: false,
      removedKeys: [],
      hasSelectors: false,
      isWorker: false,
      hasVersion: false,
      persistFalse: false,
      stateKeys: [],
      stateIsLiteral: false,
      methodNames: [],
      actionNames: [],
    };
  }

  // Strip comments so a phrase inside a `//` or `/* */` comment (e.g. "lives in
  // state (error…)") can't be mis-parsed as a real state key, method or action
  // and trip a phantom reserved-key error — same naive strip checkPersistence uses.
  const block = source.slice(firstBrace, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const hasState = /\bstate\s*:/.test(block);
  // `state: initialGameState()` is a call, not a literal — keys are unknowable
  // statically, and warning "empty state {}" about it is a false positive
  // (a field report).
  const stateIsLiteral = /\bstate\s*:\s*\{/.test(block);
  const hasMethods = /\bmethods\s*:/.test(block);
  const hasActions = /\bactions\s*:/.test(block);
  const hasGenerators = /\bgenerators\s*:/.test(block);
  const hasMachine = /\bmachine\s*:/.test(block);
  // Removed 1.x config keys, sourced from the framework's removal registry so a
  // future removal is caught here the day its row lands — never a second list.
  const removedKeys = removalsInSource(block).map((h) => h.removal.key);
  const hasSelectors = /\bselectors\s*:/.test(block);
  const isWorker = /\bworker\s*:\s*true\b/.test(block);
  const hasVersion = /\bversion\s*:\s*\d+/.test(block);
  const persistFalse = /\bpersist\s*:\s*false\b/.test(block);

  // Extract state keys from state: { key1: ..., key2: ... }
  // Use brace matching instead of [^}] to handle nested objects/arrays
  const stateKeys: string[] = [];
  const stateStart = block.match(/\bstate\s*:\s*\{/);
  if (stateStart) {
    const sIdx = block.indexOf(stateStart[0]) + stateStart[0].length;
    // Find matching close brace for the state object
    let sd = 1, sEnd = sIdx;
    for (let i = sIdx; i < block.length && sd > 0; i++) {
      if (block[i] === "{") sd++;
      else if (block[i] === "}") {
        sd--;
        if (sd === 0) sEnd = i;
      }
    }
    const stateBlock = block.slice(sIdx, sEnd);
    // Extract top-level keys (skip nested object contents)
    for (const m of stateBlock.matchAll(/([$\w]+)\s*:/g)) {
      // Count depth up to this match to ensure it's top-level
      const before = stateBlock.slice(0, m.index);
      let kd = 0;
      for (const ch of before) {
        if (ch === "{" || ch === "[") kd++;
        else if (ch === "}" || ch === "]") kd--;
      }
      if (kd === 0) stateKeys.push(m[1]!);
    }
  }

  // Extract method names from methods: { name(...) { } }
  const methodNames: string[] = [];
  const methodsMatch = block.match(/\bmethods\s*:\s*\{/);
  if (methodsMatch) {
    const methodsStart = block.indexOf(methodsMatch[0]) +
      methodsMatch[0].length;
    let d = 1;
    let methodsEnd = methodsStart;
    for (let i = methodsStart; i < block.length && d > 0; i++) {
      if (block[i] === "{") d++;
      else if (block[i] === "}") d--;
      if (d === 0) methodsEnd = i;
    }
    const methodsBlock = block.slice(methodsStart, methodsEnd);
    // Match method declarations: name(, async name(, *name(
    for (
      const m of methodsBlock.matchAll(/(?:async\s+)?(?:\*\s*)?(\w+)\s*\(/g)
    ) {
      const n = m[1]!;
      if (n !== "async" && n !== "function") methodNames.push(n);
    }
  }

  // Extract action names from actions: { Name: ... }
  const actionNames: string[] = [];
  const actionsMatch = block.match(/\bactions\s*:\s*\{/);
  if (actionsMatch) {
    const actionsStart = block.indexOf(actionsMatch[0]) +
      actionsMatch[0].length;
    let d = 1;
    let actionsEnd = actionsStart;
    for (let i = actionsStart; i < block.length && d > 0; i++) {
      if (block[i] === "{") d++;
      else if (block[i] === "}") d--;
      if (d === 0) actionsEnd = i;
    }
    const actionsBlock = block.slice(actionsStart, actionsEnd);
    for (const m of actionsBlock.matchAll(/(\w+)\s*:/g)) {
      actionNames.push(m[1]!);
    }
  }

  return {
    hasState,
    stateIsLiteral,
    hasMethods,
    hasActions,
    hasGenerators,
    hasMachine,
    removedKeys,
    hasSelectors,
    isWorker,
    hasVersion,
    persistFalse,
    stateKeys,
    methodNames,
    actionNames,
  };
}

/** Build the full lint context for a project directory */
export async function buildContext(
  projectDir: string,
): Promise<{ ctx: LintContext; report: LintReport }> {
  const issues: Issue[] = [];
  const passed: string[] = [];
  const sourceFiles: SourceFile[] = [];
  const skipped: Skip[] = [];

  // Read deno.json
  const { config: denoJson, path: denoJsonPath } = await readDenoJson(
    projectDir,
  );

  // Collect source files from src/ and project root
  const srcDir = join(projectDir, "src");
  await collectFiles(srcDir, projectDir, sourceFiles, skipped);
  // …and every other directory a project keeps REAL code in. `src/` + root was
  // the whole scan, so a project's build scripts, release gates and dev tools —
  // the code that decides what ships — were the one part the linter never read.
  // A linter that skips the tooling is loudest exactly where the stakes are
  // lowest. Directories are optional by design: a missing one is not an error,
  // it is a project that does not have that shape.
  for (const dir of OPTIONAL_ROOTS) {
    const path = join(projectDir, dir);
    try {
      if (!(await Deno.stat(path)).isDirectory) continue;
    } catch {
      continue; // this project has no such directory
    }
    await collectFiles(path, projectDir, sourceFiles, skipped);
  }
  // Scan root .ts/.tsx files
  try {
    for await (const entry of Deno.readDir(projectDir)) {
      if (!entry.isFile || !SOURCE_EXTS.has(extname(entry.name))) continue;
      try {
        const path = join(projectDir, entry.name);
        const stat = await Deno.stat(path);
        if (stat.size > MAX_FILE_SIZE) {
          skipped.push({
            path: entry.name,
            reason: `${Math.round(stat.size / 1024)} KB — over aiol's ${
              MAX_FILE_SIZE / 1024
            } KB per-file limit`,
          });
          continue;
        }
        const content = await Deno.readTextFile(path);
        // Don't duplicate files already in sourceFiles
        if (!sourceFiles.some((f) => f.path === path)) {
          sourceFiles.push({
            path,
            relative: entry.name,
            name: entry.name,
            ext: extname(entry.name),
            content,
            lines: content.split("\n"),
          });
        }
      } catch { /* unreadable */ }
    }
  } catch { /* root unreadable */ }

  // Every stylesheet under src/ (and at the root). The test-handle rule used to
  // reach for "any other .css in sourceFiles" — a branch that could never run,
  // because the file scan only ever collects .ts/.tsx. A multi-sheet app was
  // silently half-checked by a rule whose own comment said it wasn't.
  const cssFiles: SourceFile[] = [];
  const collectCss = async (dir: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory) {
        if (!IGNORE_DIRS.has(e.name)) await collectCss(path);
        continue;
      }
      if (!e.isFile || extname(e.name) !== ".css") continue;
      try {
        const content = await Deno.readTextFile(path);
        cssFiles.push({
          path,
          relative: relative(projectDir, path),
          name: e.name,
          ext: ".css",
          content,
          lines: content.split("\n"),
        });
      } catch { /* unreadable */ }
    }
  };
  await collectCss(srcDir);
  try {
    for await (const e of Deno.readDir(projectDir)) {
      if (!e.isFile || extname(e.name) !== ".css") continue;
      const path = join(projectDir, e.name);
      if (cssFiles.some((f) => f.path === path)) continue;
      try {
        const content = await Deno.readTextFile(path);
        cssFiles.push({
          path,
          relative: e.name,
          name: e.name,
          ext: ".css",
          content,
          lines: content.split("\n"),
        });
      } catch { /* unreadable */ }
    }
  } catch { /* root unreadable — the source scan reports it */ }

  // Read CSS
  let styleCss: SourceFile | null = null;
  for (
    const loc of [join(srcDir, "style.css"), join(projectDir, "style.css")]
  ) {
    try {
      const content = await Deno.readTextFile(loc);
      styleCss = {
        path: loc,
        relative: relative(projectDir, loc),
        name: "style.css",
        ext: ".css",
        content,
        lines: content.split("\n"),
      };
      break;
    } catch { /* not found */ }
  }

  // Tests live in `tests/` by aio's own convention ("tests all live in tests/,
  // never beside their source" — CLAUDE.md), and that directory was never
  // scanned. So a project with 271 passing tests was told `Tests: 0` and "cell X
  // has no test file" for every cell: the framework's linter was blind to the
  // framework's own layout, and 8 of 14 hints in one real app were this. A
  // linter confidently wrong about half its output trains you to skim the rest.
  //
  // Collected SEPARATELY from app sources: `tsFiles`/`tsxFiles` drive the
  // app-code checks, and sweeping tests into them would trade one class of false
  // positive for another.
  const testSources: SourceFile[] = [];
  for (const dir of ["tests", "test"]) {
    try {
      const path = join(projectDir, dir);
      if ((await Deno.stat(path)).isDirectory) {
        await collectFiles(path, projectDir, testSources, skipped);
      }
    } catch { /* no such directory */ }
  }
  const isTest = (f: SourceFile) =>
    f.name.endsWith(".test.ts") || f.name.endsWith(".test.tsx");
  const tsxFiles = sourceFiles.filter((f) => f.ext === ".tsx");
  const tsFiles = sourceFiles.filter((f) => f.ext === ".ts");
  const testFiles = [
    ...sourceFiles.filter(isTest), // co-located tests, if an app keeps them there
    ...testSources.filter(isTest),
  ];
  // A cell defined inside a test is a FIXTURE, not app surface — counting it
  // would then report it as untested. (`.test.tsx` was missed here too.)
  const cells = extractCells(sourceFiles.filter((f) => !isTest(f)));

  // Find app entry and App.tsx. The project's OWN declaration wins over the
  // `src/app.ts` convention: `entry` in deno.json, then every
  // `build.targets[].entry` (one repo, three apps — a relay and two desktop
  // clients — is a shape the docs recommend, and the linter warned "no entry
  // point found" on every lint of it; R-8).
  const declaredEntries = declaredEntryPaths(denoJson);
  const appEntry =
    sourceFiles.find((f) => declaredEntries.includes(f.relative)) ??
      sourceFiles.find((f) =>
        f.relative === "src/app.ts" || f.relative === "app.ts"
      ) ?? null;
  const appTsx = sourceFiles.find((f) => f.name === "App.tsx") ?? null;

  const ctx: LintContext = {
    projectDir,
    denoJson,
    denoJsonPath,
    sourceFiles,
    cssFiles,
    skipped,
    unscannedDirs: await unscannedCodeDirs(projectDir),
    isApp: looksLikeApp(denoJson),
    tsxFiles,
    tsFiles,
    testFiles,
    cells,
    appEntry,
    appTsx,
    styleCss,
    report: (severity, area, message, opts) => {
      issues.push({
        severity,
        area,
        message,
        file: opts?.file,
        line: opts?.line,
        fix: opts?.fix,
        safeFix: opts?.safeFix,
        manual: opts?.manual,
      });
    },
    pass: (message) => {
      passed.push(message);
    },
  };

  const report: LintReport = {
    issues,
    passed,
    stats: {
      filesScanned: sourceFiles.length,
      cellsFound: cells.length,
      testsFound: testFiles.length,
    },
  };

  return { ctx, report };
}
