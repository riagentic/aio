// aiol — safe auto-fix functions
// Every fix here is guaranteed to be harmless: no behavior change, no data loss.
// Only adds missing config, removes dead code, or normalizes formatting.

import { basename, join, resolve } from "@std/path";
import { codeMask, codeMatches, codeText, topLevelKeyOffsets } from "./scan.ts";
import { SERVER_ONLY_AIO_SYMBOLS } from "../src/entries.ts";

// Derived from THE set (src/entries.ts, alpha52 one-decider) — never restated.
const SERVER_ONLY_RE = new RegExp(
  `\\b(${[...SERVER_ONLY_AIO_SYMBOLS].join("|")})\\b`,
);
import type { DenoJsonConfig } from "./types.ts";

// ── Helpers ─────────────────────────────────────────────────────────

/** Read, transform, and write deno.json — preserves formatting where possible */
async function patchDenoJson(
  projectDir: string,
  patch: (config: DenoJsonConfig) => void,
): Promise<boolean> {
  // Read and WRITE the same file. This used to fall back to reading
  // `deno.jsonc` while writing `deno.json`: on a jsonc project the fix either
  // did nothing (comments → JSON.parse throws → silent `false`, and the same
  // issue reappears as `[fixable]` on every run with no reason given) or wrote
  // a SECOND config file that Deno silently prefers — from then on every edit
  // the user made to their own `deno.jsonc` was ignored.
  let path = join(projectDir, "deno.json");
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    path = join(projectDir, "deno.jsonc");
    try {
      text = await Deno.readTextFile(path);
    } catch {
      return false;
    }
  }
  let config: DenoJsonConfig;
  try {
    config = JSON.parse(text) as DenoJsonConfig;
  } catch {
    // A jsonc file with real comments (the whole reason to use jsonc). Editing
    // it mechanically would strip them, so refuse — and SAY so, rather than
    // reporting a fix that never happened.
    console.error(
      `[aiol] cannot safe-fix ${path} automatically — it is not plain JSON ` +
        `(comments or trailing commas). Apply this change by hand; the ` +
        `comments in your config are worth more than the automation.`,
    );
    return false;
  }
  try {
    patch(config);
    await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch (e) {
    console.error(`[aiol] failed writing ${path}: ${e}`);
    return false;
  }
}

// A generic "delete every line matching this regex" helper used to live here.
// It is gone on purpose: line deletion cannot tell whether the line carries
// anything else the file still needs, which is exactly how the React-import fix
// took `useState` down with it. Each fix now edits the construct it names.

// ── Config fixes ────────────────────────────────────────────────────

/** `appId` normalized the way aio resolves it — lowercase, `[a-z0-9-]`, no
 *  leading/trailing or doubled dashes. Empty means "nothing here names the
 *  app", which is a REFUSAL, never a default: `appId` names the lock file, the
 *  SQLite path and the UDS socket, so inventing one ("my-app") points a real
 *  app at another app's data. */
function slugAppId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Read + parse the project's deno.json / deno.jsonc. `null` when it is
 *  missing or not plain JSON (a jsonc with real comments) — the caller must
 *  then decline rather than half-apply. */
async function readConfig(
  projectDir: string,
): Promise<{ path: string; config: DenoJsonConfig } | null> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(projectDir, name);
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    try {
      return { path, config: JSON.parse(text) as DenoJsonConfig };
    } catch {
      return null;
    }
  }
  return null;
}

/** Insert `appId: "<id>"` into the entry module's `aio.run(...)` call.
 *
 *  Matching is on CODE offsets: the first RAW `aio.run({` in a file can be the
 *  one inside a doc comment or inside a scaffolder's template literal, and the
 *  insertion then landed in a comment (or in generated text) while reporting
 *  success. Both call spellings are handled — `aio.run({ … })` and the
 *  zero-config `aio.run()` the scaffold also emits.
 *
 *  Returns false, loudly, when there is no call to insert into. */
async function insertAppIdIntoRun(
  entryPath: string,
  appId: string,
): Promise<boolean> {
  let content: string;
  try {
    content = await Deno.readTextFile(entryPath);
  } catch {
    console.error(`[aiol] cannot read ${entryPath} — appId not moved`);
    return false;
  }
  if (codeMatches(content, /\bappId\s*:/g).length > 0) return false; // already set
  const [site] = codeMatches(content, /\baio\.run\s*\(\s*(\{|\))/g);
  if (!site) {
    console.error(
      `[aiol] no \`aio.run(\` call in ${entryPath} — appId "${appId}" left in ` +
        `deno.json rather than deleted from the only place that states it`,
    );
    return false;
  }
  const at = site.index! + site[0]!.length - 1; // the `{` or the `)`
  // Follow the call's own shape: a one-line `aio.run({ … })` gains an inline
  // key, a multi-line one gains a line. (aiol is fmt-agnostic; producing
  // something `deno fmt` leaves alone is still the courteous default.)
  const key = content[at + 1] === "\n"
    ? `\n  appId: "${appId}",`
    : ` appId: "${appId}",`;
  const patched = site[1] === "{"
    ? content.slice(0, at + 1) + key + content.slice(at + 1)
    : `${content.slice(0, at)}{ appId: "${appId}" }${content.slice(at)}`;
  await Deno.writeTextFile(entryPath, patched);
  return true;
}

/** Move `appId` out of deno.json and INTO `aio.run()` — one migration, not
 *  half of one.
 *
 *  This fix used to be the delete alone. A compiled build cannot read
 *  deno.json, so the rule is right that the value has to reach `aio.run()` —
 *  but deleting the only place that states it, without adding the other half,
 *  renames the app: `appId` names the lock file, the SQLite path and the UDS
 *  socket, so the next boot came up under a DIFFERENT identity and the app's
 *  own data was orphaned on disk. Insert first; delete only once the insert
 *  landed. */
export function fixMoveAppIdToRun(
  entryPath: string,
): (projectDir: string) => Promise<boolean> {
  return async (projectDir: string) => {
    const cfg = await readConfig(projectDir);
    if (!cfg) {
      console.error(
        `[aiol] cannot safe-fix appId: ${projectDir}'s config is missing or ` +
          `is not plain JSON — move it by hand (aio.run({ appId: … })), then ` +
          `delete the key.`,
      );
      return false;
    }
    const appId = typeof cfg.config.appId === "string" ? cfg.config.appId : "";
    if (!appId) return false;
    // 1. the value reaches the code that a compiled build actually runs …
    if (!await insertAppIdIntoRun(entryPath, appId)) return false;
    // 2. … and only THEN does deno.json stop stating it.
    if (
      !await patchDenoJson(projectDir, (c) => {
        delete c.appId;
      })
    ) {
      console.error(
        `[aiol] appId "${appId}" is now set in ${entryPath}, but could not be ` +
          `removed from deno.json — harmless (aio.run() wins), delete it by hand.`,
      );
    }
    return true;
  };
}

/** Rename deno.json `target` → `client` (alpha52 one-vocabulary rename: the
 *  key names the default client SHELL, and "target" collided with
 *  build.targets — a different axis). Key rename IN PLACE — the key keeps its
 *  position (same as `am fix`'s rewrite), value untouched; an existing
 *  `client` wins. */
export async function fixRenameTargetToClient(
  projectDir: string,
): Promise<boolean> {
  const path = join(projectDir, "deno.json");
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return false;
  }
  try {
    const cfg = JSON.parse(text) as DenoJsonConfig;
    if (typeof cfg.target !== "string") return false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (k === "target") {
        if (!("client" in cfg)) out.client = v; // rename in place
      } else out[k] = v;
    }
    await Deno.writeTextFile(path, JSON.stringify(out, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Add nodeModulesDir: "auto" */
export function fixAddNodeModulesDir(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.nodeModulesDir) c.nodeModulesDir = "auto";
  });
}

/** Add @types/react import */
export function fixAddTypesReact(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.imports) c.imports = {};
    if (!c.imports["@types/react"]) {
      c.imports["@types/react"] = "npm:@types/react@^18";
    }
  });
}

/** Add esbuild import */
export function fixAddEsbuild(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.imports) c.imports = {};
    if (!c.imports["esbuild"]) c.imports["esbuild"] = "npm:esbuild@^0.24";
  });
}

/** Add compilerOptions for the automatic JSX transform.
 *
 *  `jsxImportSource` is aio's, not React's: aio renders JSX through AIR, and
 *  `am fix` (src/am/am-cmd-fix.ts) enforces `"aio"` for exactly that reason.
 *  This fix used to write `"react"` (plus `jsxImportSourceTypes:
 *  "@types/react"`) over an app that already said `"aio"` — two tools with
 *  opposite answers about one key, and the app that ran `--safe-fix` compiled
 *  every element against React's runtime. It now sets the transform the hint
 *  actually names, and only FILLS IN an absent import source. */
export function fixAddJsxConfig(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.compilerOptions) c.compilerOptions = {};
    c.compilerOptions["jsx"] = "react-jsx";
    if (!c.compilerOptions["jsxImportSource"]) {
      c.compilerOptions["jsxImportSource"] = "aio";
    }
  });
}

/** Add dev task */
export function fixAddDevTask(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.tasks) c.tasks = {};
    if (!c.tasks["dev"]) c.tasks["dev"] = "deno run -A src/app.ts";
  });
}

/** Add test task */
export function fixAddTestTask(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.tasks) c.tasks = {};
    if (!c.tasks["test"]) c.tasks["test"] = "deno test -A tests/";
  });
}

/** Add `appId` to `aio.run()` when NOTHING names the app yet — derived from
 *  deno.json (`appId` > `title` > `name`), else the project directory's name.
 *
 *  Three things this used to get wrong, all of which renamed apps:
 *   • `basename(projectDir)` on the DOCUMENTED invocation `aiol .` is
 *     `basename(".")` → `""` → the fallback fired and every app it touched was
 *     branded `my-app`. The path is resolved first, and an unusable name is a
 *     REFUSAL now, not a default.
 *   • the insertion point was the first RAW `aio.run({`, so a match inside a
 *     comment or a template literal won.
 *   • the target was a hardcoded `src/app.ts`, ignoring the entry the project
 *     DECLARES in deno.json — the rule knows it, so the rule passes it in. */
export function fixAddAppIdToRun(
  entryPath: string,
): (projectDir: string) => Promise<boolean> {
  return async (projectDir: string) => {
    const cfg = await readConfig(projectDir);
    const c = cfg?.config ?? {};
    const named = [
      c.appId,
      c.title,
      typeof c.name === "string" ? c.name.split("/").pop() : undefined,
    ]
      .find((v): v is string => typeof v === "string" && v.trim() !== "");
    const appId = slugAppId(named ?? basename(resolve(projectDir)));
    if (!appId) {
      console.error(
        `[aiol] nothing names this app — no appId/title/name in deno.json and ` +
          `the directory name (${
            basename(resolve(projectDir))
          }) has no usable characters. ` +
          `Add appId: "…" to aio.run() by hand; it names the lock file, the ` +
          `SQLite path and the UDS socket, so it must not be guessed.`,
      );
      return false;
    }
    return await insertAppIdIntoRun(entryPath, appId);
  };
}

// ── Source file fixes ───────────────────────────────────────────────

/** Remove the `React` DEFAULT binding from a TSX file's react import — safe
 *  because the `react-jsx` transform injects the runtime itself.
 *
 *  Two things this fix must not do, both of which it used to:
 *   • delete the whole LINE. `import React, { useState } from "react"` lost
 *     `useState` with it and the file stopped compiling. Other bindings are
 *     kept; only the default one goes.
 *   • remove a binding the file still USES. `React.Fragment` / `React.FC`
 *     need it, so when `React` appears anywhere else in real code the fix
 *     declines (the hint stays — a hint is cheaper than a broken file). */
export function fixRemoveImportReact(filePath: string): () => Promise<boolean> {
  const IMPORT_RE =
    /^([ \t]*)import\s+React\s*(?:,\s*(\{[^}]*\}|\*\s+as\s+[$\w]+))?\s+from\s+(['"])react\3;?[ \t]*$/m;
  return async () => {
    let content: string;
    try {
      content = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const m = IMPORT_RE.exec(content);
    if (!m) return false;
    const [stmt, indent, others, quote] = m;
    const before = content.slice(0, m.index);
    const after = content.slice(m.index + stmt.length);
    // Still referenced in CODE (a mention in a comment doesn't count)?
    // Removing it would break the file — decline.
    if (/\bReact\b/.test(codeText(before + after))) return false;
    const replacement = others
      ? `${indent}import ${others} from ${quote}react${quote};`
      : null;
    const next = replacement !== null
      ? before + replacement + after
      // Drop the now-empty line with it.
      : before + after.replace(/^\r?\n/, "");
    if (next === content) return false;
    await Deno.writeTextFile(filePath, next);
    return true;
  };
}

/** Remove `import { createRoot } from 'react-dom/client'` — the framework does
 *  the mounting. Declines while `createRoot(` is still CALLED: dropping the
 *  import under a live call is a ReferenceError at runtime, not a fix. The
 *  mounting code has to go first, and that is the author's edit, not a safe
 *  one to make automatically. */
export function fixRemoveCreateRootImport(
  filePath: string,
): () => Promise<boolean> {
  const IMPORT_RE =
    /^[ \t]*import\s+\{[^}]*createRoot[^}]*\}\s+from\s+['"]react-dom\/client['"];?[ \t]*$/m;
  return async () => {
    let content: string;
    try {
      content = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const m = IMPORT_RE.exec(content);
    if (!m) return false;
    const rest = content.slice(0, m.index) +
      content.slice(m.index + m[0].length);
    if (/\bcreateRoot\b/.test(codeText(rest))) return false;
    const next = content.slice(0, m.index) +
      content.slice(m.index + m[0].length).replace(/^\r?\n/, "");
    if (next === content) return false;
    await Deno.writeTextFile(filePath, next);
    return true;
  };
}

// ── Upgrade fixes (deprecated aliases → canonical) ──────────────────
//
// aio keeps every renamed option working as a deprecated alias for the rest of
// the major (docs/basics/semver-policy.md), so these are ergonomics, never
// emergencies — but they're mechanical, so the linter can just do them.

/** Offsets of every `timeout` key that is a TOP-LEVEL option of a `call(`.
 *
 *  THE decider for the deprecated-option rule and for its fix alike. Scoping
 *  used to be `\{[^}]*\}`, which does not stop at a nested `{`: in
 *  `call({ retry: { timeout: 30 } })` the user's own data matched, and the fix
 *  rewrote it — a silent meaning change inside a function whose contract is
 *  "no behaviour change". Pure. */
export function callTimeoutSites(src: string): number[] {
  const out: number[] = [];
  for (const m of codeMatches(src, /\bcall\s*\(\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    out.push(...topLevelKeyOffsets(src, open, "timeout"));
  }
  return out;
}

/** `call({ timeout: N }, fn)` → `call({ timeoutMs: N }, fn)`. Scoped to the
 *  options object of a `call(` — a `timeout:` key anywhere else, nested data
 *  included, is untouched. */
export function fixCallTimeoutMs(filePath: string): () => Promise<boolean> {
  return async () => {
    try {
      const content = await Deno.readTextFile(filePath);
      const sites = callTimeoutSites(content);
      if (sites.length === 0) return false;
      // Right to left, so earlier offsets stay valid.
      let out = content;
      for (const at of [...sites].sort((a, b) => b - a)) {
        out = out.slice(0, at) + "timeoutMs" + out.slice(at + "timeout".length);
      }
      if (out === content) return false;
      await Deno.writeTextFile(filePath, out);
      return true;
    } catch {
      return false;
    }
  };
}

/** Rewrite deprecated flags inside `deno.json` tasks. `--cert=`/`--key=` became
 *  `--tls-cert=`/`--tls-key=` (the bare names collided with the auth `key`
 *  concept); `--headless` is a BUILD flag that a run task must not pass — the
 *  runtime equivalent is `--client=server-only`. `entry` scopes the second
 *  rewrite to tasks that actually run the app. */
export function fixTaskFlags(
  entry: string | null,
): (projectDir: string) => Promise<boolean> {
  return (projectDir: string) =>
    patchDenoJson(projectDir, (config) => {
      const tasks = config.tasks;
      if (!tasks) return;
      for (const [name, cmd] of Object.entries(tasks)) {
        if (typeof cmd !== "string") continue;
        let next = cmd
          .replace(/(?<![\w-])--cert=/g, "--tls-cert=")
          .replace(/(?<![\w-])--key=/g, "--tls-key=");
        if (entry && next.includes(entry)) {
          next = next.replace(
            /(?<![\w-])--headless(?![\w=-])/g,
            "--client=server-only",
          );
        }
        tasks[name] = next;
      }
    });
}

/** Add a missing `aio/<entry>` mapping to deno.json, derived from how the app
 *  already maps bare `aio` — so it works for a source checkout
 *  (`./dep/aio/mod.ts` → `./dep/aio/<path>`) and for a JSR pin
 *  (`jsr:@riagentic/aio@X` → `jsr:@riagentic/aio@X/<entry-suffix>`) alike. */
export function fixAddAioEntry(
  spec: string,
  base: string,
  entryPath: string,
): (projectDir: string) => Promise<boolean> {
  return (projectDir: string) =>
    patchDenoJson(projectDir, (config) => {
      const imports = config.imports ??= {};
      if (imports[spec]) return;
      imports[spec] = base.startsWith("jsr:") || base.startsWith("npm:")
        // A package pin: the entry is a sub-path export of the same package.
        ? `${base}${spec.slice("aio".length)}`
        // A source path: swap the root module for the entry's module.
        : base.replace(/mod\.ts$/, "") + entryPath;
    });
}

/** Move server-only symbols to the `aio/server` entry (alpha37). Splits a mixed
 *  import — `import { cell, createDB } from "aio"` becomes two statements, one
 *  per entry — so the boundary is explicit without losing anything. */
/** Rewrite dynamic `import("aio")` to `import("aio/server")` in statements
 *  that destructure (or property-access) a server-only symbol — the lazy
 *  variant of fixServerEntryImport. Only touches the matched statements,
 *  never a bare `import("aio")` used for browser-safe symbols. */
export function fixDynamicServerEntryImport(
  filePath: string,
): () => Promise<boolean> {
  const SERVER_ONLY = SERVER_ONLY_RE;
  return async () => {
    try {
      const src = await Deno.readTextFile(filePath);
      let changed = false;
      let out = src.replace(
        /\{([^}]*)\}\s*=\s*await\s+import\(\s*(["'])aio\2\s*\)/g,
        (whole, inner: string) => {
          if (!SERVER_ONLY.test(inner)) return whole;
          changed = true;
          return whole.replace(/(["'])aio\1/, "$1aio/server$1");
        },
      );
      out = out.replace(
        /\(\s*await\s+import\(\s*(["'])aio\1\s*\)\s*\)\s*\.\s*(\w+)/g,
        (whole, _q: string, prop: string) => {
          if (!SERVER_ONLY.test(prop)) return whole;
          changed = true;
          return whole.replace(/(["'])aio\1/, "$1aio/server$1");
        },
      );
      if (!changed) return false;
      await Deno.writeTextFile(filePath, out);
      return true;
    } catch {
      return false;
    }
  };
}

export function fixServerEntryImport(
  filePath: string,
): () => Promise<boolean> {
  const SERVER_ONLY = SERVER_ONLY_AIO_SYMBOLS;
  return async () => {
    try {
      const src = await Deno.readTextFile(filePath);
      let changed = false;
      const out = src.replace(
        /import\s*\{([^}]*)\}\s*from\s*["']aio["'];?/g,
        (whole, inner: string) => {
          const names = inner.split(",").map((s) => s.trim()).filter(Boolean);
          const server = names.filter((n) =>
            SERVER_ONLY.has(n.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!)
          );
          if (server.length === 0) return whole;
          changed = true;
          const rest = names.filter((n) => !server.includes(n));
          const serverLine = `import { ${
            server.join(", ")
          } } from "aio/server";`;
          return rest.length > 0
            ? `import { ${rest.join(", ")} } from "aio";\n${serverLine}`
            : serverLine;
        },
      );
      if (!changed) return false;
      await Deno.writeTextFile(filePath, out);
      return true;
    } catch {
      return false;
    }
  };
}

// ── alpha52 — the effect channel migrations ─────────────────────────

/** Scan from an opening delimiter to its balanced close. Returns the index of
 *  the matching closer, or -1.
 *
 *  Walks a STRIPPED copy of the source (`codeText` — comments, strings and
 *  regex bodies blanked, offsets preserved), so the depth count is exact.
 *  The old string-aware-but-comment-BLIND walk was how one unpaired
 *  apostrophe in a comment ("don't") swallowed every delimiter until the next
 *  quote — and a fixer with a wrong `end` doesn't under-report, it EDITS the
 *  wrong span. Pass `masked` when calling in a loop (mask once per file). */
function balancedEnd(
  src: string,
  open: number,
  masked: string = codeText(src),
): number {
  const opener = src[open]!;
  const closer = opener === "(" ? ")" : opener === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a string at top-level commas/pipes (no dive into brackets). */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch)) depth--;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A method found in source: signature + return annotation + body range. */
type MethodSpan = {
  /** First param name (`s` for a draft method). */
  param: string | null;
  isAsync: boolean;
  /** `: T` span (colon..just before `{`), or null when unannotated. */
  annStart: number;
  annEnd: number;
  annText: string | null;
  /** First-param span (inside the parens) + its `: Type` text, if any. An
   *  annotated `s` REPLACES the contextual draft type, so a rewrite to
   *  `s.$do(...)` must intersect `MethodDraftServed` into it. */
  paramStart: number;
  paramEnd: number;
  paramAnnText: string | null;
  bodyOpen: number;
  bodyClose: number;
};

/** The draft-param name of the innermost method enclosing offset `at`, or
 *  null when `at` is not inside a recognizable shorthand method.
 *
 *  Exported for the CHECK: `fixReturnEffectsToDo` declines any site whose
 *  method's first param is not literally `s` (rewriting `return effect` to
 *  `_s.$do(...)` would need a rename the fix must not make). The rule asks
 *  THIS predicate at report time so those sites render `[manual]` with the
 *  reason instead of a `[fixable]` that survives every --safe-fix run. */
export function enclosingMethodParam(src: string, at: number): string | null {
  let best: MethodSpan | null = null;
  for (const ms of methodSpans(src)) {
    if (at > ms.bodyOpen && at < ms.bodyClose) {
      if (!best || ms.bodyOpen > best.bodyOpen) best = ms;
    }
  }
  return best?.param ?? null;
}

/** Every shorthand method (`name(s, ...) : T { ... }`) in `src`, by body
 *  range. Arrow-function properties are deliberately not parsed — they get no
 *  rewrite (the report stays). */
function methodSpans(src: string): MethodSpan[] {
  const out: MethodSpan[] = [];
  const sig = /(^|\n)[ \t]*(async\s+)?([\w$]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = sig.exec(src)) !== null) {
    if (
      m[3] === "if" || m[3] === "for" || m[3] === "while" ||
      m[3] === "switch" || m[3] === "catch" || m[3] === "return"
    ) continue;
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = balancedEnd(src, parenOpen);
    if (parenClose === -1) continue;
    // Optional `: T` up to the body `{` — T may carry <>, [], () but no `{`.
    let i = parenClose + 1;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    let annStart = -1;
    let annEnd = -1;
    let annText: string | null = null;
    if (src[i] === ":") {
      annStart = i;
      let d = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        const ch = src[j]!;
        if ("([<".includes(ch)) d++;
        else if (")]>".includes(ch)) d--;
        else if (ch === "{" && d === 0) break;
        else if ((ch === ";" || ch === "," || ch === "}") && d === 0) break;
      }
      if (src[j] !== "{") continue; // not a method body
      annEnd = j;
      annText = src.slice(annStart + 1, annEnd).trim();
      i = j;
    }
    if (src[i] !== "{") continue;
    const bodyOpen = i;
    const bodyClose = balancedEnd(src, bodyOpen);
    if (bodyClose === -1) continue;
    const params = src.slice(parenOpen + 1, parenClose);
    const firstRaw = splitTopLevel(params, ",")[0] ?? "";
    const first = firstRaw.trim();
    const param = /^[\w$]+/.exec(first)?.[0] ?? null;
    const paramStart = parenOpen + 1;
    const paramEnd = paramStart + firstRaw.length;
    const colonIdx = first.indexOf(":");
    const paramAnnText = colonIdx === -1
      ? null
      : first.slice(colonIdx + 1).trim();
    out.push({
      param,
      isAsync: !!m[2],
      annStart,
      annEnd,
      annText,
      paramStart,
      paramEnd,
      paramAnnText,
      bodyOpen,
      bodyClose,
    });
  }
  return out;
}

const EFFECT_MEMBER =
  /^(CellEffect|ScheduleEffect|OwnEffect)(\[\])?$|^\(\s*ScheduleEffect\s*\|\s*OwnEffect\s*\)\[\]$/;
const VOIDISH = /^(void|undefined)$/;

/** How to rewrite a return-type annotation once its effect returns move to
 *  `$do`. `strip` = remove `: T`; `narrow` = replace with the non-effect
 *  members; `keep` = annotation is unrelated (no effect mention — leave it);
 *  `skip` = mentions effects (or is opaque with only-effect returns) but not
 *  confidently rewritable — DON'T touch this method at all. */
function planAnnotation(
  ann: string | null,
  isAsync: boolean,
  hasValueReturns: boolean,
): { action: "strip" | "narrow" | "keep" | "skip"; narrowed?: string } {
  if (ann === null) return { action: "keep" };
  let t = ann.trim();
  let promise = false;
  const pm = /^Promise\s*<([\s\S]*)>$/.exec(t);
  if (pm) {
    promise = true;
    t = pm[1]!.trim();
  }
  const members = splitTopLevel(t, "|").map((x) => x.trim()).filter(Boolean);
  const effectish = members.filter((x) => EFFECT_MEMBER.test(x));
  const voidish = members.filter((x) => VOIDISH.test(x));
  const rest = members.filter(
    (x) => !EFFECT_MEMBER.test(x) && !VOIDISH.test(x),
  );
  if (effectish.length === 0) {
    // No effect type named. With value returns remaining the annotation still
    // holds. With ONLY effect returns, an alias could hide an effect type —
    // stripping or keeping could both be wrong, so don't touch the method.
    return hasValueReturns ? { action: "keep" } : { action: "skip" };
  }
  if (!hasValueReturns) {
    // The effect was the method's only return — the annotation was the TS7022
    // workaround; drop it whole (TS infers void / Promise<void>).
    return rest.length === 0 ? { action: "strip" } : { action: "skip" };
  }
  // Mixed: other value returns remain — narrow to the non-effect members.
  // The rewritten effect-return path now RETURNS NOTHING, so the union must
  // admit it (`void`) or TS2366 fires on the fall-through.
  const remaining = [...rest, ...(voidish.length > 0 ? voidish : ["void"])];
  if (rest.length === 0) return { action: "skip" }; // inconsistent code
  const u = remaining.join(" | ");
  return {
    action: "narrow",
    narrowed: promise || isAsync ? `: Promise<${u}>` : `: ${u}`,
  };
}

/** `return schedule.X(...)` / `return own.X(...)` / `return [<effects...>]`
 *  → `s.$do(...)` (alpha52 — effects move off the return channel).
 *
 *  Method-aware, so the rewrite leaves code that TYPE-CHECKS:
 *   • an effect return-type annotation (`: CellEffect`, `: ScheduleEffect`,
 *     `: Promise<CellEffect | void>` — the TS7022 workarounds `self()`
 *     retires) is STRIPPED when the effect was the method's only return, or
 *     NARROWED to the non-effect members when value returns remain;
 *   • no dead `return;` is appended when the statement is the method's tail;
 *   • anything not confidently rewritable — a non-`s` draft param, an opaque
 *     alias annotation, an unparseable union — leaves the whole METHOD
 *     unfixed (the report stays; conservative beats broken). */
/** One `return <effect>` statement the fix looked at, and its verdict.
 *  `reason === null` means "will be rewritten"; anything else is the decline,
 *  in the words the report prints. */
type EffectSiteVerdict = { start: number; end: number; reason: string | null };

type Edit = { start: number; end: number; text: string };

/** THE plan for one file: what `--safe-fix` will rewrite, and — for every site
 *  it will not — why.
 *
 *  One decider, because the alternative shipped: the rule advertised
 *  `[fixable]` on every effect return, the fix silently declined several
 *  classes of them (an opaque return-type annotation, an annotated draft with
 *  no `"aio"` import clause to add `MethodDraftServed` to, a `return` that is
 *  not the first token on its line), and the finding came back `[fixable]`
 *  after every run — indistinguishable from a broken tool. */
function planReturnEffects(src: string): {
  edits: Edit[];
  needServedImport: boolean;
  verdicts: EffectSiteVerdict[];
} {
  const methods = methodSpans(src);
  /** Innermost method whose body contains `at`. */
  const enclosing = (at: number): MethodSpan | null => {
    let best: MethodSpan | null = null;
    for (const ms of methods) {
      if (at > ms.bodyOpen && at < ms.bodyClose) {
        if (!best || ms.bodyOpen > best.bodyOpen) best = ms;
      }
    }
    return best;
  };

  // 1. Collect every provably-effect return statement.
  type Site = {
    start: number; // start of `return` keyword
    indent: string;
    lead: string; // the matched ^|\n
    stmtEnd: number; // after the optional `;`
    inner: string; // the $do argument list
    method: MethodSpan;
  };
  const sites: Site[] = [];
  const verdicts: EffectSiteVerdict[] = [];
  const re = /(^|\n)([ \t]*)return\s+(schedule\.\w+\s*\(|own\.\w+\s*\(|\[)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const exprStart = m.index + m[0].length - m[3]!.length;
    const openIdx = src.indexOf(m[3]!.startsWith("[") ? "[" : "(", exprStart);
    const end = balancedEnd(src, openIdx);
    if (end === -1) continue;
    const expr = src.slice(exprStart, end + 1);
    const start = m.index + m[1]!.length + m[2]!.length;
    // Provably effects: a bare schedule./own. call, or an array literal
    // whose every element is one.
    if (expr.startsWith("[")) {
      const arr = expr.slice(1, -1).trim();
      if (arr.length === 0) continue; // `return []` is a VALUE
      const parts = splitTopLevel(arr, ",");
      const allEffects = parts.every((p) =>
        /^\s*(schedule|own)\.\w+\s*\(/.test(p) && p.trim().length > 0
      );
      if (!allEffects) continue;
    }
    const method = enclosing(m.index + m[0].length);
    if (!method) {
      verdicts.push({
        start,
        end: end + 1,
        reason: "the safe fix declines: not inside a recognizable cell method",
      });
      continue;
    }
    if (method.param !== "s") {
      verdicts.push({
        start,
        end: end + 1,
        reason:
          `the safe fix declines: the draft param is '${method.param}', not 's'`,
      });
      continue;
    }
    let stmtEnd = end + 1;
    if (src[stmtEnd] === ";") stmtEnd++;
    sites.push({
      start,
      indent: m[2]!,
      lead: m[1]!,
      stmtEnd,
      inner: expr.startsWith("[") ? expr.slice(1, -1).trim() : expr,
      method,
    });
  }

  // 2. Per method: does any VALUE return remain after the rewrite?
  const byMethod = new Map<MethodSpan, Site[]>();
  for (const s of sites) {
    byMethod.set(s.method, [...(byMethod.get(s.method) ?? []), s]);
  }
  const edits: Edit[] = [];
  let needServedImport = false;
  // The augmentation writes `MethodDraftServed` — it needs an `"aio"`
  // import clause to land in. Without one, those methods stay unfixed.
  const hasAioImportClause = /import\s*\{[^}]*\}\s*from\s*["']aio["']/.test(
    src,
  );
  const decline = (list: Site[], reason: string) => {
    for (const s of list) {
      verdicts.push({ start: s.start, end: s.stmtEnd, reason });
    }
  };
  for (const [method, list] of byMethod) {
    // Body with this method's rewritten statements blanked out.
    let body = src.slice(method.bodyOpen + 1, method.bodyClose);
    for (const s of list) {
      const from = s.start - (method.bodyOpen + 1);
      const to = s.stmtEnd - (method.bodyOpen + 1);
      body = body.slice(0, from) + " ".repeat(to - from) + body.slice(to);
    }
    const hasValueReturns = /\breturn\s+[^;\s}]/.test(body);
    const plan = planAnnotation(
      method.annText,
      method.isAsync,
      hasValueReturns,
    );
    if (plan.action === "skip") {
      // whole method stays unfixed
      decline(
        list,
        `the safe fix declines: the method's return type \`${method.annText}\` ` +
          `names an effect but cannot be rewritten mechanically — drop or ` +
          `narrow it by hand first`,
      );
      continue;
    }
    // An ANNOTATED `s` replaces the contextual draft type, so the rewritten
    // `s.$do(...)` needs `MethodDraftServed` intersected into it. Decided
    // BEFORE any edit is pushed — infeasible ⇒ the method stays unfixed.
    const needsAugment = method.paramAnnText !== null &&
      !method.paramAnnText.includes("MethodDraftServed");
    if (needsAugment && !hasAioImportClause) {
      decline(
        list,
        `the safe fix declines: the draft param is typed, so the rewrite needs ` +
          `\`MethodDraftServed\`, and this file has no \`import { … } from "aio"\` ` +
          `clause to add it to`,
      );
      continue;
    }
    if (plan.action === "strip") {
      edits.push({ start: method.annStart, end: method.annEnd, text: " " });
    } else if (plan.action === "narrow") {
      edits.push({
        start: method.annStart,
        end: method.annEnd,
        text: `${plan.narrowed} `,
      });
    }
    if (needsAugment) {
      const t = method.paramAnnText!;
      const needsParens = splitTopLevel(t, "|").length > 1;
      const augmented = needsParens
        ? `s: (${t}) & MethodDraftServed`
        : `s: ${t} & MethodDraftServed`;
      edits.push({
        start: method.paramStart,
        end: method.paramEnd,
        text: augmented,
      });
      needServedImport = true;
    }
    for (const s of list) {
      // Tail statement (only whitespace to the body's `}`) → the bare
      // `return;` would be dead code; elsewhere it must stay (early exit).
      const tail = src.slice(s.stmtEnd, method.bodyClose).trim() === "";
      edits.push({
        start: s.start,
        end: s.stmtEnd,
        text: tail
          ? `s.$do(${s.inner});`
          : `s.$do(${s.inner});\n${s.indent}return;`,
      });
      verdicts.push({ start: s.start, end: s.stmtEnd, reason: null });
    }
  }
  return { edits, needServedImport, verdicts };
}

/** Why `--safe-fix` will NOT rewrite the effect return at `at`, or null when it
 *  will. Asked by the RULE at report time, so a declined site renders
 *  `[manual]` with the reason instead of a `[fixable]` that survives every run.
 *  Same planner the fix runs, so the two can never disagree. */
export function returnEffectDecline(src: string, at: number): string | null {
  const { verdicts } = planReturnEffects(src);
  for (const v of verdicts) {
    if (at >= v.start && at <= v.end) return v.reason;
  }
  // The fix only rewrites a `return` that OPENS its line — it replaces the
  // whole statement. `if (x) return schedule.after(...)` is a real finding the
  // fix will never touch, and it wore [fixable] forever.
  return "the safe fix declines: it rewrites only a `return` that starts its " +
    "own line (this one shares a line with other code)";
}

export function fixReturnEffectsToDo(filePath: string): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const { edits, needServedImport } = planReturnEffects(src);
    if (edits.length === 0) return false;

    // Apply from the end so offsets stay valid.
    edits.sort((a, b) => b.start - a.start);
    let out = src;
    for (const e of edits) {
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    if (out === src) return false;
    // A stripped annotation may have been the file's LAST use of the effect
    // type — the orphaned `type ScheduleEffect` import then fails the app's
    // own `deno lint` (no-unused-vars). Prune it.
    out = pruneOrphanedEffectTypeImports(out);
    // And the augmentation's type has to be importable.
    if (needServedImport) out = ensureServedImport(out);
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}

/** Add `type MethodDraftServed` to the first `import { … } from "aio"` clause
 *  when it is not imported yet. The caller verified such a clause exists. */
function ensureServedImport(src: string): string {
  if (
    /import\s*(?:type\s+)?\{[^}]*\bMethodDraftServed\b[^}]*\}\s*from\s*["']aio["']/
      .test(src)
  ) {
    return src;
  }
  return src.replace(
    /import\s*\{([^}]*)\}\s*from\s*(["'])aio\2/,
    (_whole, inner: string, q: string) =>
      `import { ${
        inner.trim().replace(/,\s*$/, "")
      }, type MethodDraftServed } from ${q}aio${q}`,
  );
}

/** The effect type names the rewrite can orphan. */
const EFFECT_TYPE_NAMES = ["CellEffect", "ScheduleEffect", "OwnEffect"];

/** Remove effect TYPE members from `"aio"` import clauses when the file no
 *  longer references them anywhere outside its imports (the annotation the
 *  rewrite stripped was the last use). Same conservative rule as the rest:
 *  an alias (`X as Y`) or any remaining reference leaves the member alone. */
export function pruneOrphanedEffectTypeImports(src: string): string {
  // Usage counting runs against the source with every import statement
  // blanked, so the import itself never counts as a use.
  const IMPORT_RE = /(^|\n)[ \t]*import\s+[^;]*?from\s*["'][^"']+["'];?/g;
  const withoutImports = src.replace(
    IMPORT_RE,
    (whole) => whole.replace(/[^\n]/g, " "),
  );
  let out = src;
  for (const name of EFFECT_TYPE_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(withoutImports)) continue; // still used
    out = out.replace(
      /(^|\n)([ \t]*)import\s*(type\s+)?\{([^}]*)\}\s*from\s*(["'])aio\5;?/g,
      (
        whole,
        lead: string,
        indent: string,
        typeKw: string | undefined,
        inner: string,
        quote: string,
      ) => {
        const members = splitTopLevel(inner, ",").map((x) => x.trim()).filter(
          Boolean,
        );
        const keep = members.filter((raw) => {
          if (/\bas\b/.test(raw)) return true; // aliased — leave it alone
          const bare = raw.replace(/^type\s+/, "").trim();
          return bare !== name;
        });
        if (keep.length === members.length) return whole; // not imported here
        if (keep.length === 0) return lead === "\n" ? "" : lead; // whole clause gone
        return `${lead}${indent}import ${typeKw ?? ""}{ ${
          keep.join(", ")
        } } from ${quote}aio${quote};`;
      },
    );
  }
  return out;
}

/** `schedule.poll(... { backoff: n ... })` → `factor: n` (alpha52 key rename;
 *  the old key keeps working with a hint). Scoped to the opts object of a
 *  `schedule.poll(` call. */
export function fixPollBackoffKey(filePath: string): () => Promise<boolean> {
  return async () => {
    try {
      const src = await Deno.readTextFile(filePath);
      let changed = false;
      let out = "";
      let cursor = 0;
      const re = /\bschedule\.poll\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const open = m.index + m[0].length - 1;
        const end = balancedEnd(src, open);
        if (end === -1) continue;
        const call = src.slice(m.index, end + 1);
        // Rename EVERY `backoff:` key, but only inside the OPTS literal — the
        // one carrying `every:` (an action payload may legitimately have a
        // `backoff` field of its own).
        const patched = call.replace(
          /\{[^{}]*\}/g,
          (lit) =>
            /\bevery\s*:/.test(lit)
              ? lit.replace(/\bbackoff(\s*:)/g, "factor$1")
              : lit,
        );
        if (patched !== call) {
          out += src.slice(cursor, m.index) + patched;
          cursor = end + 1;
          changed = true;
        }
      }
      if (!changed) return false;
      out += src.slice(cursor);
      await Deno.writeTextFile(filePath, out);
      return true;
    } catch {
      return false;
    }
  };
}

// (alpha57 removed `fixInsertTransactionFalse`. It existed to pin apps against
//  the alpha52 default flip; with `transaction` opt-in again there is nothing
//  to pin — an undeclared cell already has the behavior it was written for.)

/** Selector deps spread → tuple (alpha52): `{ deps: [a, b], fn: (s, x, y) =>`
 *  becomes `fn: (s, [x, y]) =>` — only when the param count exactly covers
 *  every dep (the provably-legacy shape). */
export function fixSelectorDepsTuple(
  filePath: string,
): () => Promise<boolean> {
  return async () => {
    try {
      const src = await Deno.readTextFile(filePath);
      const re =
        /(deps\s*:\s*\[([^\]]*)\]\s*,\s*fn\s*:\s*(?:async\s*)?)\(([^)]*)\)(\s*(?::[^=]+)?=>)/g;
      const out = src.replace(
        re,
        (
          whole,
          pre: string,
          depsBody: string,
          params: string,
          arrow: string,
        ) => {
          const depCount = depsBody.split(",").map((s) =>
            s.trim()
          ).filter(Boolean).length;
          const ps = params.split(",").map((s) => s.trim()).filter(Boolean);
          if (ps.length !== depCount + 1) return whole; // not the legacy shape
          if (depCount === 0) return whole;
          if (ps[1]!.startsWith("[")) return whole; // already the tuple form
          const [first, ...deps] = ps;
          // Typed or defaulted dep params can't be folded into a destructured
          // tuple without changing their types — decline (report stays).
          if (deps.some((p) => p.includes(":") || p.includes("="))) {
            return whole;
          }
          return `${pre}(${first}, [${deps.join(", ")}])${arrow}`;
        },
      );
      if (out === src) return false;
      await Deno.writeTextFile(filePath, out);
      return true;
    } catch {
      return false;
    }
  };
}

// ── alpha52 — the surface diet migrations (Package 4) ───────────────

/** Rename a TOP-LEVEL `ui:` key to `visible:` inside every `cell(name, {...})`
 *  config and every `cellDefaults: {...}` block (alpha52 rename — `access`
 *  gates calls, `visible` gates reads). Depth-tracked so a nested `ui` field
 *  (state: { ui: … }) is never touched; declines a block that already has a
 *  top-level `visible:` (both-set is a hard error at cell() — author's call). */
export function fixUiKeyToVisible(filePath: string): () => Promise<boolean> {
  /** TOP-LEVEL `ui:` key offsets within a config body. Walks the MASKED body
   *  (structure is exact there); the offsets are applied to the RAW body —
   *  identifiers are code, so offsets are identical in both. Declines a block
   *  that already has a top-level `visible:` (both-set is a hard error at
   *  cell() — the author's call). */
  const topLevelUiOffsets = (maskedBody: string): number[] => {
    const offsets: number[] = [];
    let depth = 0;
    let hasVisible = false;
    for (let i = 0; i < maskedBody.length; i++) {
      const ch = maskedBody[i]!;
      if ("({[".includes(ch)) depth++;
      else if (")}]".includes(ch)) depth--;
      else if (depth === 1 && /[$\w]/.test(ch)) {
        if (/[$\w.]/.test(maskedBody[i - 1] ?? "")) continue;
        const m = /^([$\w]+)\s*:/.exec(maskedBody.slice(i));
        if (m) {
          if (m[1] === "visible") hasVisible = true;
          if (m[1] === "ui") offsets.push(i);
        }
        while (i + 1 < maskedBody.length && /[$\w]/.test(maskedBody[i + 1]!)) {
          i++;
        }
      }
    }
    return hasVisible ? [] : offsets;
  };
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const masked = codeText(src);
    // Absolute offsets of every top-level `ui` key to rename.
    const renames: number[] = [];
    const re =
      /\bcell\s*\(\s*["'`][\w\-]+["'`]\s*,\s*\{|\bcellDefaults\s*:\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // A `cell(` mentioned in a comment/string is blanked in the mask.
      if (!/[$\w]/.test(masked[m.index] ?? "")) continue;
      const open = masked.indexOf("{", m.index + m[0].length - 1);
      if (open === -1) continue;
      const end = balancedEnd(src, open, masked);
      if (end === -1) continue;
      for (const off of topLevelUiOffsets(masked.slice(open, end + 1))) {
        renames.push(open + off);
      }
      re.lastIndex = end + 1;
    }
    if (renames.length === 0) return false;
    let out = "";
    let cursor = 0;
    for (const at of renames.sort((a, b) => a - b)) {
      out += src.slice(cursor, at) + "visible";
      cursor = at + 2; // past the raw "ui"
    }
    out += src.slice(cursor);
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}

/** Symbols that moved to `aio/extras` when the `aio/schedule`/`aio/selectors`
 *  entries were DELETED (alpha52); everything else those entries carried lives
 *  on the main `aio` entry. */
const DEAD_ENTRY_EXTRAS = new Set(["isScheduleEffect", "createSliceSelector"]);

/** Rewrite imports from the deleted `aio/schedule` / `aio/selectors` entries:
 *  per-symbol — `isScheduleEffect`/`createSliceSelector` → `aio/extras`, the
 *  rest (`schedule`, `ScheduleDef`, `ScheduleEffect`, `createSelector`,
 *  `Selector`) → `aio`. A mixed import becomes two statements. */
export function fixDeadEntrySpecifiers(
  filePath: string,
): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    let changed = false;
    const out = src.replace(
      /import\s*(type\s*)?\{([^}]*)\}\s*from\s*["']aio\/(?:schedule|selectors)["'];?/g,
      (_whole, typeQual: string | undefined, inner: string) => {
        changed = true;
        const names = inner.split(",").map((s) => s.trim()).filter(Boolean);
        const bare = (n: string) =>
          n.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
        const extras = names.filter((n) => DEAD_ENTRY_EXTRAS.has(bare(n)));
        const core = names.filter((n) => !DEAD_ENTRY_EXTRAS.has(bare(n)));
        const t = typeQual ? "type " : "";
        const stmts: string[] = [];
        if (core.length) {
          stmts.push(`import ${t}{ ${core.join(", ")} } from "aio";`);
        }
        if (extras.length) {
          stmts.push(`import ${t}{ ${extras.join(", ")} } from "aio/extras";`);
        }
        return stmts.join("\n");
      },
    );
    if (!changed) return false;
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}

/** MIGRATION (alpha52): exposed apps with no per-user auth and no `key` now
 *  get a GENERATED shared key by default. Insert an explicit `key: false,`
 *  into `aio.run({ … })` — behaviour-preserving for an app that relied on
 *  being open. Declines when any `key:` is already present at the top level
 *  of the options object. */
export function fixInsertKeyFalse(filePath: string): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const masked = codeText(src);
    const m = /\baio\.run\s*\(\s*\{/.exec(masked);
    if (!m) return false;
    const open = masked.indexOf("{", m.index + m[0].length - 1);
    const end = balancedEnd(src, open, masked);
    if (end === -1) return false;
    // Probe the MASKED body: a `key:` mentioned in a comment must not
    // decline the fix, and one inside a string is not a config key.
    const body = masked.slice(open, end + 1);
    if (/[^$\w.]key\s*:/.test(body)) return false; // already decided
    const nl = src.indexOf("\n", open);
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const baseIndent = /^[ \t]*/.exec(src.slice(lineStart))?.[0] ?? "";
    const indent = nl !== -1 && nl < end
      ? (/^[ \t]*/.exec(src.slice(nl + 1))?.[0] ?? baseIndent + "  ")
      : baseIndent + "  ";
    const insertion =
      `\n${indent}// aiol: pre-alpha52 behavior pinned — this app ran OPEN under --expose.` +
      `\n${indent}// Remove this line to adopt the generated shared key (alpha52 default).` +
      `\n${indent}key: false,`;
    const out = src.slice(0, open + 1) + insertion + src.slice(open + 1);
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}

/** `useCell(cellRef).state.x` → `cellRef.x` — the mechanical form only
 *  (alpha52: useCell REMOVED). When no `useCell` use remains afterwards, its
 *  import binding is dropped too (other bindings kept). */
export function fixUseCellStateReads(filePath: string): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const rewritten = src.replace(
      /\buseCell\s*\(\s*([$\w]+)\s*\)\s*\.\s*state\s*\.(?=[$\w])/g,
      "$1.",
    );
    if (rewritten === src) return false;
    let out = rewritten;
    // No remaining CODE use of useCell → drop its import binding.
    if (!/\buseCell\s*\(/.test(codeText(out))) {
      out = out.replace(
        /(import\s*(?:type\s*)?\{)([^}]*)(\}\s*from\s*["'][^'"]+["'];?)/g,
        (whole, pre: string, inner: string, post: string) => {
          const names = inner.split(",").map((s) => s.trim()).filter(Boolean);
          if (!names.some((n) => /^(type\s+)?useCell$/.test(n))) return whole;
          const rest = names.filter((n) => !/^(type\s+)?useCell$/.test(n));
          return rest.length ? `${pre} ${rest.join(", ")} ${post}` : "";
        },
      ).replace(/^\r?\n/, "");
    }
    if (out === src) return false;
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}

// ── alpha70: one import path per symbol ──────────────────────────────

/** One "these names moved off `from` to `to`" fact. `valuesOnly`: the names
 *  are RUNTIME values and the types stay on `from` (aio/db) — a `type X`
 *  specifier and a whole `import type {}` statement are left alone. Without
 *  it, listed names move whether they are values or types. */
export type MovedImports = {
  readonly from: string;
  readonly to: string;
  readonly names: ReadonlySet<string>;
  readonly valuesOnly?: boolean;
};

const bareName = (n: string): string =>
  n.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();

/** Split the specifiers of every `import {…} from "<from>"` in `src`: the
 *  listed names move to a NEW line importing from `<to>`; the rest keep their
 *  line. Returns null when nothing matched — ONE decider for the rule (does
 *  this file need the fix?) and the fix (apply it), so they cannot disagree. */
export function moveImports(src: string, mv: MovedImports): string | null {
  const spec = mv.from.replace(/[/.]/g, "\\$&");
  const re = new RegExp(
    `import\\s*(type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${spec}["'];?`,
    "g",
  );
  let changed = false;
  const out = src.replace(
    re,
    (whole, typeKw: string | undefined, inner: string) => {
      if (typeKw && mv.valuesOnly) return whole;
      const names = inner.split(",").map((s) => s.trim()).filter(Boolean);
      const moving = names.filter((n) =>
        mv.names.has(bareName(n)) && !(mv.valuesOnly && /^type\s/.test(n))
      );
      if (moving.length === 0) return whole;
      changed = true;
      const rest = names.filter((n) => !moving.includes(n));
      const kw = typeKw ? "type " : "";
      const toLine = `import ${kw}{ ${moving.join(", ")} } from "${mv.to}";`;
      return rest.length > 0
        ? `import ${kw}{ ${rest.join(", ")} } from "${mv.from}";\n${toLine}`
        : toLine;
    },
  );
  return changed ? out : null;
}

/** `--safe-fix` half of {@linkcode moveImports}. */
export function fixMovedImports(
  filePath: string,
  mv: MovedImports,
): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const out = moveImports(src, mv);
    if (out === null) return false;
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}

/** Rewrite `import { old } from "spec"` to `import { new as old } from
 *  "spec"` — the removed ALIAS keeps its local name, so every call site in the
 *  file is untouched and behaviour is provably identical (the alias WAS the
 *  same function). `old as x` is left as `new as x`. Null when absent. */
export function aliasRename(
  src: string,
  spec: string,
  oldName: string,
  newName: string,
): string | null {
  const s = spec.replace(/[/.]/g, "\\$&");
  const re = new RegExp(
    `(import\\s*(?:type\\s+)?\\{)([^}]*)(\\}\\s*from\\s*["']${s}["'])`,
    "g",
  );
  let changed = false;
  const out = src.replace(re, (whole, head: string, inner: string, tail) => {
    const names = inner.split(",").map((x) => x.trim()).filter(Boolean);
    const next = names.map((n) => {
      const m = /^(type\s+)?([$\w]+)(\s+as\s+([$\w]+))?$/.exec(n);
      if (!m || m[2] !== oldName) return n;
      changed = true;
      return `${m[1] ?? ""}${newName} as ${m[4] ?? oldName}`;
    });
    return changed ? `${head} ${next.join(", ")} ${tail}` : whole;
  });
  return changed ? out : null;
}

/** `--safe-fix` half of {@linkcode aliasRename}. */
export function fixAliasRename(
  filePath: string,
  spec: string,
  oldName: string,
  newName: string,
): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const out = aliasRename(src, spec, oldName, newName);
    if (out === null) return false;
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}

/** Word-for-word renames applied to CODE only (strings/comments untouched —
 *  `codeMask` decides what is code), then duplicate specifiers that the rename
 *  produced inside one `import {…} from "aio…"` are collapsed
 *  (`{ Access, Access }` → `{ Access }`). Null when nothing changed. */
export function renameWords(
  src: string,
  renames: ReadonlyArray<readonly [from: string, to: string]>,
): string | null {
  const mask = codeMask(src);
  let out = src;
  let changed = false;
  for (const [from, to] of renames) {
    const re = new RegExp(`\\b${from}\\b`, "g");
    let shift = 0;
    out = out.replace(re, (whole, at: number) => {
      // `at` is an offset into the CURRENT string; map back to the original
      // via the running shift so the mask is read at the right place.
      const orig = at - shift;
      if (mask[orig] !== 1) return whole;
      changed = true;
      shift += to.length - whole.length;
      return to;
    });
  }
  if (!changed) return null;
  return out.replace(
    /(import\s*(?:type\s+)?\{)([^}]*)(\}\s*from\s*["']aio(?:\/[\w-]+)?["'])/g,
    (_w, head: string, inner: string, tail: string) => {
      const seen = new Set<string>();
      const names = inner.split(",").map((n) => n.trim()).filter((n) =>
        n && !seen.has(n) && seen.add(n)
      );
      return `${head} ${names.join(", ")} ${tail}`;
    },
  );
}

/** `--safe-fix` half of {@linkcode renameWords}. */
export function fixRenameWords(
  filePath: string,
  renames: ReadonlyArray<readonly [string, string]>,
): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const out = renameWords(src, renames);
    if (out === null) return false;
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}

/** `schedule.blocking(` → `blocking(` in code, and `blocking` added to the
 *  file's `import {…} from "aio"` (or a new import line when there is none).
 *  `schedule` itself is left imported — removing it needs a usage count, and
 *  an unused import is harmless where a missing one is not. Null on no-op. */
export function scheduleBlockingToTop(src: string): string | null {
  const mask = codeMask(src);
  let changed = false;
  let out = src.replace(
    /\bschedule\.blocking(?=\s*\()/g,
    (whole, at: number) => {
      if (mask[at] !== 1) return whole;
      changed = true;
      return "blocking";
    },
  );
  if (!changed) return null;
  if (!/import\s*\{[^}]*\bblocking\b[^}]*\}\s*from\s*["']aio["']/.test(out)) {
    const re = /import\s*\{([^}]*)\}\s*from\s*(["']aio["'])/;
    out = re.test(out)
      ? out.replace(
        re,
        (_w, inner: string, spec: string) =>
          `import { ${
            inner.trim().replace(/,\s*$/, "")
          }, blocking } from ${spec}`,
      )
      : `import { blocking } from "aio";\n${out}`;
  }
  return out;
}

/** `--safe-fix` half of {@linkcode scheduleBlockingToTop}. */
export function fixScheduleBlocking(filePath: string): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const out = scheduleBlockingToTop(src);
    if (out === null) return false;
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}
