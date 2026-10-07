// aiol — safe auto-fix functions
// Every fix here is guaranteed to be harmless: no behavior change, no data loss.
// Only adds missing config, removes dead code, or normalizes formatting.

import {
  basename,
  dirname,
  fromFileUrl,
  join,
  resolve,
  SEPARATOR,
} from "@std/path";
import {
  argumentSpan,
  codeMask,
  codeMatches,
  codeText,
  jsxRead,
  type ListEntry,
  type ModuleStatement,
  moduleStatements,
  topLevelKeyOffsets,
} from "./scan.ts";
import { SERVER_ONLY_AIO_SYMBOLS } from "../src/entries.ts";

// Derived from THE set (src/entries.ts, alpha52 one-decider) — never restated.
const SERVER_ONLY_RE = new RegExp(
  `\\b(${[...SERVER_ONLY_AIO_SYMBOLS].join("|")})\\b`,
);
import type { DenoJsonConfig } from "./types.ts";

// ── Helpers ─────────────────────────────────────────────────────────

/** `src.replace(re, …)` for matches that START in CODE. A match inside a
 *  string body, a template body, a regex body or a comment is left
 *  byte-for-byte — a `--safe-fix` must never edit a program's own text or
 *  prose. `re` must be global; `repl` receives the match and returns its
 *  replacement. Pure.
 *
 *  The project's standing rule is that a source rewrite consults `codeMask`;
 *  four fixes did not, so a `useCell(...).state.x` inside a string, a
 *  `backoff:` inside a comment, a `deps: […], fn: …` inside a doc string, or a
 *  dynamic-`import("aio")` inside a template was rewritten. This is the shared
 *  guard. */
export function replaceCode(
  src: string,
  re: RegExp,
  repl: (m: RegExpMatchArray) => string,
  mask: Uint8Array = codeMask(src),
): string {
  let out = "";
  let cursor = 0;
  let hit = false;
  for (const m of src.matchAll(re)) {
    const at = m.index!;
    if (mask[at] !== 1) continue; // string / template / regex / comment
    out += src.slice(cursor, at) + repl(m);
    cursor = at + m[0].length;
    hit = true;
  }
  return hit ? out + src.slice(cursor) : src;
}

/** {@linkcode codeMask}, with the `${…}` of a template literal lexed as the
 *  code it is. The shared mask calls a whole template "content" on purpose (a
 *  cell declared in generated text is not this project's cell); a CALL in an
 *  interpolation runs all the same, so a rule about calls asks this one.
 *  Offsets stay 1:1 with `src`. Pure. */
export function codeMaskDeep(src: string): Uint8Array {
  const mask = codeMask(src);
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "`" || mask[i] !== 1) continue;
    let close = i + 1;
    while (close < src.length && mask[close] === 0) close++;
    if (src[close] !== "`") continue; // unterminated — prose, not a template
    for (let k = i + 1; k < close; k++) {
      if (src[k] === "\\") k++; // an escaped `\${` is text
      else if (src[k] === "$" && src[k + 1] === "{") {
        // The interpolation ends at the `}` that closes it in CODE — a brace in
        // a string or a nested template inside it does not count.
        const body = src.slice(k + 2, close);
        const flat = codeMask(body);
        let end = 0;
        for (let depth = 1; end < body.length; end++) {
          if (flat[end] !== 1) continue;
          if (body[end] === "{") depth++;
          else if (body[end] === "}" && --depth === 0) break;
        }
        mask.set(codeMaskDeep(body.slice(0, end)), k + 2);
        // The `{` and `}` of the interpolation itself: 2 and 3 — not code to
        // anything that asks `=== 1`, and the brackets of the expression to
        // {@linkcode _bareDeep}.
        mask[k + 1] = 2;
        if (end < body.length) mask[k + 2 + end] = 3;
        k += 2 + end;
      }
    }
    i = close;
  }
  return mask;
}

/** Is `name` still WRITTEN in `rest` — the file without the import that binds
 *  it? THE question every fix here asks before it removes an import, and it is
 *  asked of the raw text: comments, strings, templates and JSX prose count.
 *  "Is this occurrence code?" is a judgement, and each time it was wrong an
 *  import went from under a live use — a file that no longer builds. An
 *  import kept beside a mere mention is an unused import, which the app's own
 *  lint names. Pure. */
export function stillNamed(rest: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(rest);
}

/** Is `[at, end)` JSX TEXT — prose an element shows, not code? `codeMask`
 *  knows strings, templates, regexes and comments, not JSX, so
 *  `<code>useCell(counter).state.count</code>` — a migration note the app
 *  SHOWS — was reported as a use and rewritten. Pure.
 *
 *  Text is a CHILD of an element, and only two shapes prove that from the
 *  run itself (no `{ } < >` in it): it follows an element's OPENING tag, or
 *  it ends at a CLOSING tag. A run between two whole elements proves nothing:
 *  `<b>x</b> prose <br />` inside a parent reads exactly like
 *  `const t = <h1>Hi</h1>; const n = useCell(c).state.n; return <p>…` — and
 *  calling that prose hid a real use from the rule and left it behind the
 *  fix, with its import removed. Unknown is CODE: reported, as it always was.
 *  Prose beside a `{…}` child reads as code too.
 *
 *  Tags are looked for in CODE: `// the <h1> title` or `const open = "<div>"`
 *  before a statement is not an element, and neither is a comparison spelled
 *  like one (`a <b || c> 2` — what follows a tag's name is attributes). */
export function inJsxText(raw: string, at: number, end: number): boolean {
  const src = codeText(raw);
  const left = Math.max(
    ...["<", ">", "{", "}"].map((c) => src.lastIndexOf(c, at - 1)),
  );
  if (left === -1 || src[left] !== ">") return false;
  // `=>`, `a > b`, a generic (`Set<string>`) — not a tag's end.
  const tag = _tagEndingAt(src, left);
  if (!tag) return false;
  const right = /[<>{}]/.exec(src.slice(end));
  if (right?.[0] !== "<") return false;
  const next = src.slice(end + right.index);
  const opens = !tag.startsWith("</") && !tag.endsWith("/>");
  return opens
    ? /^<[/>A-Za-z]/.test(next)
    : /^<\/(?:[A-Za-z][\w.:-]*\s*)?>/.test(next);
}

/** The JSX tag whose closing `>` is at `gt` in code-masked `code`, or null.
 *
 *  Its `<` is found by walking back with the braces BALANCED: an attribute
 *  value is an expression, and `onClick={() => go()}` or `on={a > b}` holds a
 *  `>` that is not the tag's — read as one, the element's text was taken for
 *  code and what the page shows was rewritten. What lies between must then
 *  parse as a tag — a name, then attributes — so a `<` that is an operator,
 *  or another tag's, yields none. */
function _tagEndingAt(code: string, gt: number): string | null {
  let lt = -1;
  for (let i = gt - 1, depth = 0; i >= 0 && gt - i < 4000; i--) {
    const ch = code[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (--depth < 0) return null;
    } else if (depth === 0 && ch === "<") {
      lt = i;
      break;
    }
  }
  if (lt === -1) return null;
  const tag = code.slice(lt, gt + 1);
  if (/^<\/[A-Za-z][\w.:-]*\s*>$|^<\/?>$/.test(tag)) return tag;
  // A generic or a comparison follows a name, a `)` or a `]`.
  if (/[\w$)\]]/.test(code[lt - 1] ?? "")) return null;
  let i = /^<[A-Za-z][\w.:-]*/.exec(tag)?.[0].length ?? 0;
  if (i === 0) return null;
  const braces = (from: number) => balancedEnd(tag, from, tag) + 1;
  while (true) {
    const ws = /^\s*/.exec(tag.slice(i))![0].length;
    const rest = tag.slice(i + ws);
    if (rest === ">" || rest === "/>") return tag;
    if (ws === 0) return null;
    i += ws;
    if (tag[i] === "{") i = braces(i);
    else {
      const attr = /^[\w:.-]+(\s*=\s*)?/.exec(rest);
      if (!attr) return null;
      i += attr[0].length;
      if (attr[1]) {
        const value = /^"[^"]*"|^'[^']*'/.exec(tag.slice(i));
        if (value) i += value[0].length;
        else if (tag[i] === "{") i = braces(i);
        else return null;
      }
    }
    if (i === 0) return null; // an unbalanced `{`
  }
}

/** {@linkcode inJsxText} for a match in the file at `path`. Only a `.tsx` /
 *  `.jsx` file has JSX: in a `.ts` file `<number>useCell(c).state.n` is a
 *  cast, and what follows it is code. */
export function matchInJsxText(
  path: string,
  src: string,
  m: RegExpMatchArray,
): boolean {
  return /\.[jt]sx$/.test(path) &&
    inJsxText(src, m.index!, m.index! + m[0].length);
}

/** What to do with ONE `import {…} from "x"` statement. Every field is
 *  optional; an edit that changes nothing leaves the statement byte-for-byte
 *  as it was. */
type ListEdit = {
  /** Per existing named entry, in order: its new text, or null to drop it. */
  readonly entries?: ReadonlyArray<string | null>;
  /** Specifiers to append after the last kept entry. */
  readonly add?: readonly string[];
  /** A new module specifier for the statement. */
  readonly spec?: string;
  /** A second import of the SAME kind (`type` or not) to insert on the line
   *  after this one — or, when every entry is dropped, to REPLACE it. It is
   *  rendered here, so it carries the statement's attribute clause
   *  (`with { … }`) exactly as the statement does. */
  readonly after?: { readonly names: readonly string[]; readonly spec: string };
};

/** The import-attribute clause (`with { … }` / legacy `assert { … }`) right
 *  after a statement's specifier, as written; "" when there is none. The
 *  statement ends after it — splicing at the specifier left the clause
 *  behind, attached to whatever was spliced in. */
function attributeClause(src: string, specQuoteEnd: number): string {
  const m = /^\s*\b(?:with|assert)\s*\{[^{}]*\}/.exec(
    codeText(src).slice(specQuoteEnd),
  );
  return m ? src.slice(specQuoteEnd, specQuoteEnd + m[0].length) : "";
}

/** THE import-list rewriter: every `--safe-fix` that edits the `{…}` of an
 *  import goes through here. Null when no statement changed. Pure.
 *
 *  Each fix used to split the list on "," and re-join the pieces on ONE line.
 *  A `// comment` after a specifier — ordinary in the multi-line list
 *  `deno fmt` writes — then swallowed the rest of the statement (`} from
 *  "aio";` landed inside the comment) and the "safe" fix left a file that did
 *  not parse. Some re-joined EVERY matching import in the file, touched or
 *  not. Here the list is read by `moduleStatements` (comments are never
 *  specifiers and a comma inside one never splits), an edit is spliced into
 *  the original layout, comments are kept, and a statement the edit does not
 *  change is not rewritten at all.
 *
 *  Only `import {…}` / `import type {…}` statements are offered to `edit` — a
 *  default or namespace binding beside the list is declined, not guessed. */
function rewriteImportLists(
  src: string,
  edit: (st: ModuleStatement, names: readonly string[]) => ListEdit | null,
): string | null {
  const splices: Array<{ from: number; to: number; text: string }> = [];
  for (const st of moduleStatements(src)) {
    if (st.kind !== "import" || !st.list || !st.clause.startsWith("{")) {
      continue;
    }
    const named = st.list.entries.filter((e) => e.text);
    const e = edit(st, named.map((n) => n.text));
    if (!e) continue;
    const next = e.entries ?? named.map((n) => n.text);
    const add = e.add ?? [];
    if (
      next.every((t, i) => t === named[i]!.text) && add.length === 0 &&
      (e.spec === undefined || e.spec === st.spec) && e.after === undefined
    ) continue;
    const attrs = attributeClause(src, st.end);
    const stEnd = st.end + attrs.length;
    const semi = src[stEnd] === ";" ? 1 : 0;
    const end = stEnd + semi;
    let after: string | undefined;
    if (e.after !== undefined) {
      const kw = st.typeOnly ? "type " : "";
      after = `import ${kw}{ ${e.after.names.join(", ")} } from ` +
        `"${e.after.spec}"${attrs};`;
      // Read back like the rewritten statement below: an emitted import that
      // does not come back as exactly these names from exactly this spec
      // declines the whole fix.
      const b = moduleStatements(after)[0];
      if (
        b?.start !== 0 || b.spec !== e.after.spec ||
        attributeClause(after, b.end) !== attrs ||
        JSON.stringify(b.list?.entries.map((x) => x.text)) !==
          JSON.stringify(
            e.after.names.map((t) => t.replace(/\s+/g, " ").trim()),
          )
      ) return null;
    }
    if (next.every((t) => t === null) && add.length === 0) {
      if (after !== undefined) {
        splices.push({ from: st.start, to: end, text: after });
        continue;
      }
      // Nothing left to import: the statement goes, with its line when it
      // had the line to itself.
      const lineStart = src.lastIndexOf("\n", st.start - 1) + 1;
      const own = /^[ \t]*$/.test(src.slice(lineStart, st.start)) &&
        /^[ \t]*(?:\r?\n|$)/.test(src.slice(end));
      splices.push(
        own
          ? {
            from: lineStart,
            to: end + (/^[ \t]*(?:\r?\n)?/.exec(src.slice(end))![0].length),
            text: "",
          }
          : { from: st.start, to: end, text: "" },
      );
      continue;
    }
    const body = listBody(src, st.list.entries, next, add, st.list);
    let text = src.slice(st.start, st.list.open + 1) + body +
      src.slice(st.list.close, st.specStart) + (e.spec ?? st.spec) +
      src.slice(st.specEnd, end);
    // Read the result back with the same scanner. A statement that does not
    // come back as exactly the intended list (a comment ate the brace, a
    // layout this splice did not foresee) declines the WHOLE fix: a finding
    // left for a human is recoverable, a file that no longer parses is not.
    const back = moduleStatements(text)[0];
    const want = [...next.filter((t) => t !== null), ...add]
      .map((t) => t.replace(/\s+/g, " ").trim());
    const got = back?.list?.entries.filter((x) => x.text).map((x) => x.text);
    if (
      back?.start !== 0 || back.spec !== (e.spec ?? st.spec) ||
      JSON.stringify(got) !== JSON.stringify(want)
    ) return null;
    if (after !== undefined) text += `\n${after}`;
    splices.push({ from: st.start, to: end, text });
  }
  if (splices.length === 0) return null;
  let out = src;
  for (const sp of splices.reverse()) {
    out = out.slice(0, sp.from) + sp.text + out.slice(sp.to);
  }
  return out;
}

/** The new text between `{` and `}` — see {@linkcode rewriteImportLists}. */
function listBody(
  src: string,
  entries: readonly ListEntry[],
  next: ReadonlyArray<string | null>,
  add: readonly string[],
  list: { open: number; close: number },
): string {
  const interior = src.slice(list.open + 1, list.close);
  // One line, no comment: nothing to preserve but the names themselves.
  if (!/[\n/]/.test(interior)) {
    return ` ${[...next.filter((t) => t !== null), ...add].join(", ")} `;
  }
  // Otherwise splice into the original layout, slot by slot. A kept entry
  // keeps its comma; a dropped one loses its code and its comma but keeps any
  // comment around it — so no comma is ever doubled and no comment can reach
  // past the code that follows it.
  let out = "";
  let insertAt = -1;
  let ni = 0;
  entries.forEach((en, i) => {
    if (!en.text) { // the empty slot after a trailing comma
      out += src.slice(en.slotStart, en.slotEnd);
      return;
    }
    const t = next[ni++];
    const pre = src.slice(en.slotStart, en.start);
    const post = src.slice(en.end, en.slotEnd);
    if (t === null || t === undefined) {
      const rest = pre + post;
      out += /\S/.test(rest) ? rest.replace(/[ \t]+$/, "") : post;
      return;
    }
    out += pre + t;
    insertAt = out.length;
    out += post;
    if (i < entries.length - 1) out += ",";
  });
  // A dropped entry can leave its line empty (its comment belonged to the
  // line above). Removing a newline that is followed only by another newline
  // can never end a `//` comment early, so this is always safe — and it is
  // skipped when the author had blank lines in the list on purpose.
  if (!/\n[ \t]*\n/.test(interior)) out = out.replace(/\n[ \t]*(?=\n)/g, "");
  if (add.length === 0) return out;
  const added = add.join(", ");
  return insertAt === -1
    ? ` ${added}${/\S/.test(out) ? out : " "}`
    : `${out.slice(0, insertAt)}, ${added}${out.slice(insertAt)}`;
}

/** Add `name` to the first value `import {…} from "<spec>"`, or prepend a new
 *  import line when there is none. Pure. */
function addToFirstImport(src: string, spec: string, name: string): string {
  let done = false;
  const out = rewriteImportLists(src, (st) => {
    if (done || st.spec !== spec || st.typeOnly) return null;
    done = true;
    return { add: [name] };
  });
  return out ?? `import { ${name} } from "${spec}";\n${src}`;
}

/** The local binding of one list entry: `a as b` → b, `type A` → A. */
const localName = (entry: string): string =>
  entry.replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();

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

/** Rename deno.json `target` → `client` (alpha52 one-vocabulary rename: the
 *  key names the default client SHELL, and "target" collided with
 *  build.targets — a different axis). Key rename IN PLACE — the key keeps its
 *  position (same as `am fix`'s rewrite), value untouched; an existing
 *  `client` wins. */
export async function fixRenameTargetToClient(
  projectDir: string,
): Promise<boolean> {
  // The file the PROJECT uses — `deno.json` OR `deno.jsonc` (`readConfig`), the
  // same reader the rule uses. Reading only `deno.json` made the reported
  // `[fixable]` a lie on a jsonc project: `--safe-fix` reported 0 applied and
  // the finding returned on every run.
  const found = await readConfig(projectDir);
  if (!found) return false;
  const { path, config: cfg } = found;
  if (typeof cfg.target !== "string") return false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "target") {
      if (!("client" in cfg)) out.client = v; // rename in place
    } else out[k] = v;
  }
  await Deno.writeTextFile(path, JSON.stringify(out, null, 2) + "\n");
  return true;
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
    if (!c.imports["esbuild"]) c.imports["esbuild"] = "npm:esbuild@^0.25";
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
 *     need it, so when `React` is written anywhere else in the file
 *     ({@linkcode stillNamed}) the fix declines (the hint stays — a hint is
 *     cheaper than a broken file). */
export function fixRemoveImportReact(filePath: string): () => Promise<boolean> {
  return async () => {
    let content: string;
    try {
      content = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const next = withoutReactImport(content);
    if (next === null) return false;
    await Deno.writeTextFile(filePath, next);
    return true;
  };
}

/** The file without its default `React` import, or null when the fix leaves
 *  it. THE decider: the fix writes this, and the rule labels the finding
 *  `[fixable]` or `[manual]` by it — a fix that declined used to stay
 *  `[fixable]` forever. Pure. */
export function withoutReactImport(content: string): string | null {
  const m =
    /^([ \t]*)import\s+React\s*(?:,\s*(\{[^}]*\}|\*\s+as\s+[$\w]+))?\s+from\s+(['"])react\3;?[ \t]*$/m
      .exec(content);
  if (!m) return null;
  const [stmt, indent, others, quote] = m;
  const before = content.slice(0, m.index);
  const after = content.slice(m.index + stmt.length);
  // Still named anywhere else? Removing it could break the file — decline.
  if (stillNamed(before + after, "React")) return null;
  const next = others
    ? `${before}${indent}import ${others} from ${quote}react${quote};${after}`
    // Drop the now-empty line with it.
    : before + after.replace(/^\r?\n/, "");
  return next === content ? null : next;
}

/** Remove `import { createRoot } from 'react-dom/client'` — the framework does
 *  the mounting. Declines while `createRoot` — or anything else the statement
 *  binds — is still named ({@linkcode stillNamed}): dropping the import under
 *  a live call is a ReferenceError at runtime, not a fix. The mounting code
 *  has to go first, and that is the author's edit, not a safe one to make
 *  automatically. */
export function fixRemoveCreateRootImport(
  filePath: string,
): () => Promise<boolean> {
  return async () => {
    let content: string;
    try {
      content = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const next = withoutCreateRootImport(content);
    if (next === null) return false;
    await Deno.writeTextFile(filePath, next);
    return true;
  };
}

/** The file without its `react-dom/client` import, or null when the fix
 *  leaves it — the decider for the fix and for its label alike. Pure. */
export function withoutCreateRootImport(content: string): string | null {
  const m =
    /^[ \t]*import\s+\{([^}]*createRoot[^}]*)\}\s+from\s+['"]react-dom\/client['"];?[ \t]*$/m
      .exec(content);
  if (!m) return null;
  const head = content.slice(0, m.index);
  const tail = content.slice(m.index + m[0].length);
  const bound = m[1]!.split(",").map((n) => n.trim()).filter(Boolean)
    .map(localName);
  if (bound.some((n) => stillNamed(head + tail, n))) return null;
  return head + tail.replace(/^\r?\n/, "");
}

// ── Upgrade fixes (deprecated aliases → canonical) ──────────────────
//
// aio keeps every renamed option working as a deprecated alias for the rest of
// the major (docs/basics/semver-policy.md), so these are ergonomics, never
// emergencies — but they're mechanical, so the linter can just do them.

/** `codeText` with the comment DELIMITERS blanked too (it blanks only their
 *  bodies), so "the previous / next token" is a plain walk over whitespace.
 *  Offsets stay 1:1 with `src`. */
function _bareCode(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return codeText(src).replace(/\/\*\s*\*\//g, blank)
    .replace(/\/\/[^\S\n]*$/gm, blank);
}

/** {@linkcode _bareCode} with a template's `${…}` read as the code it is
 *  ({@linkcode codeMaskDeep}): the text every "whose is this name" question
 *  is asked of, so a name used in an interpolation is seen like any other.
 *  The interpolation's own `${` and `}` become ` (` and `)`: the expression
 *  stands in brackets, apart from the one before it. Offsets stay 1:1. */
function _bareDeep(src: string): string {
  const mask = codeMaskDeep(src);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    out += mask[i] === 1 || src[i] === "\n"
      ? src[i]
      : mask[i] === 2
      ? "("
      : mask[i] === 3
      ? ")"
      : " ";
  }
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return out.replace(/\/\*\s*\*\//g, blank)
    .replace(/\/\/[^\S\n]*$/gm, blank);
}

/** Is this specifier aio? The bare name an app maps, its sub-entries, the
 *  registry spellings, and the vendored copy (`../dep/aio/mod.ts`). THE
 *  decider for every rewrite that acts on a NAME aio exports. Pure. */
export function isAioSpec(spec: string): boolean {
  return /^(?:aio|@riagentic\/aio|jsr:\/?@riagentic\/aio(?:@[^/]+)?|https:\/\/jsr\.io\/@riagentic\/aio)(?:\/|$)|^(?:\.\.?\/)+dep\/aio\//
    .test(spec);
}

/** Where code-masked `bare` DECLARES `name` itself — `const`/`let`/`var`
 *  (destructured too), `function`, `class`, a type, a parameter, a `catch`
 *  binding — or -1. A destructure inside one of the `skip` spans is not
 *  asked: `const { name } = await import("aio")` is an import. There is no scope analyser here, so the answer is
 *  file-wide and errs toward "declared": a name in parameter position of any
 *  `(…)` that is followed by `=>`, `{` or `:` counts.
 *
 *  Known limits. Read as declared when it is not: the argument of a call
 *  inside a ternary (`ok ? f(name) : y`), and `if (name) {`. Not seen: a
 *  second declarator (`const a = 1, name = 2`) and a rename two patterns deep
 *  (`({ a: { b: name } })`). The first kind costs a `[manual]` where a fix
 *  was possible; the second is a declaration nobody has been seen to write. */
function _declaredAt(
  bare: string,
  name: string,
  skip: readonly (readonly [number, number])[] = [],
): number {
  // Not a member (`x.name`, `#name`) — a rest parameter's `...` is no `.`.
  const id = `(?<!(?:[^.]|^)\\.\\s*)(?<!#\\s*)(?<![\\w$])${name}(?![\\w$])`;
  // `type name` is a declaration only before `=` or `<`: in an import list
  // (`import { type name } from …`) it is a modifier. A name before `=>` is
  // a parameter unless it is the arrow's return type (`(x: T): name => x`).
  const plain = new RegExp(
    `\\b(?:(?:const|let|var|class|interface|enum|namespace)\\s+|function\\s*\\*\\s*|function\\s+)${name}(?![\\w$])|\\btype\\s+${name}\\s*[=<]|(?<!\\)\\s*:\\s*)${id}(?=\\s*=>)`,
  ).exec(bare);
  if (plain) return plain.index;
  for (const m of bare.matchAll(/\b(?:const|let|var)\s*([{[])/g)) {
    if (skip.some(([from, to]) => from <= m.index && m.index < to)) continue;
    const open = m.index + m[0].length - 1;
    const close = balancedEnd(bare, open, bare);
    const hit = new RegExp(`${id}(?!\\s*:)`).exec(bare.slice(open, close));
    if (close !== -1 && hit) return open + hit.index;
  }
  // A parameter: directly in a `(…)` after `(`, `,` or `...` — or in a
  // pattern there (`({ call })`, `({ rpc: call })`). `: {…}` is a type, and
  // `key:` inside braces a key, never a binding.
  const token = new RegExp(`${id}(?=\\s*(?:[,)\\]}:?]|=(?!=)))`, "g");
  for (const m of bare.matchAll(token)) {
    const before = (i: number) =>
      /(\.\.\.|\S)\s*$/.exec(bare.slice(Math.max(0, i - 80), i))?.[1] ?? "";
    let paren = -1;
    let inner = "";
    for (let i = m.index - 1, depth = 0; i >= 0; i--) {
      const ch = bare[i]!;
      if (")]}".includes(ch)) depth++;
      else if ("([{".includes(ch) && --depth < 0) {
        inner ||= ch;
        if (ch === "(") {
          paren = i;
          break;
        }
        if (!"(,[{".includes(before(i) || " ")) break;
        depth = 0;
      }
    }
    const prev = before(m.index);
    const binds = inner === "("
      ? ["(", ",", "..."].includes(prev)
      : ["{", "[", ",", ":", "..."].includes(prev) &&
        !/^\s*:/.test(bare.slice(m.index + name.length));
    const close = paren === -1 ? -1 : balancedEnd(bare, paren, bare);
    if (
      binds && close !== -1 && /^\s*(?:=>|\{|:)/.test(bare.slice(close + 1))
    ) return m.index;
  }
  return -1;
}

/** Is `name` declared in a way no VALUE can stand behind — `function`,
 *  `class`, a type, an `enum`, a `namespace`? A `const`, a parameter or a
 *  destructure may hold what an aio namespace handed it; these cannot. */
function _declaredHard(bare: string, name: string): boolean {
  return new RegExp(
    `\\b(?:(?:class|interface|enum|namespace)\\s+|function\\s*\\*?\\s*)${name}(?![\\w$])|\\btype\\s+${name}\\s*[=<]`,
  ).test(bare);
}

/** Is the `name` token at `at` a property the file names itself — an object
 *  key or shorthand, a destructure key, a type-literal or class member, a
 *  method? Never an export of aio, whatever it is called.
 *
 *  Errs toward "a key" (which only ever declines a rewrite): a name between
 *  two commas of a generic argument list inside `{…}` reads as a shorthand. */
function _ownKeyAt(
  bare: string,
  at: number,
  name: string,
  lists: readonly (readonly [number, number])[],
): boolean {
  // An import or re-export list names bindings, not keys.
  if (lists.some(([from, to]) => from <= at && at < to)) return false;
  let open = -1;
  for (let i = at - 1, depth = 0; i >= 0 && open === -1; i--) {
    const ch = bare[i]!;
    if (")]}".includes(ch)) depth++;
    else if ("([{".includes(ch) && --depth < 0) open = i;
  }
  // `export { name }` lists the file's bindings, not an object's keys.
  if (
    open === -1 || bare[open] !== "{" ||
    /\bexport\s*(?:type\s*)?$/.test(bare.slice(0, open))
  ) return false;
  const head = bare.slice(Math.max(0, at - 200), at);
  const prev = /(\S)(\s*)$/.exec(head);
  const end = at + name.length;
  const next = /^\s*(\?\s*:|=>|={2,3}|\S)/.exec(bare.slice(end))?.[1] ?? "";
  // Where a member starts: after `{`, `,`, `;`, `}`, a modifier — or on a new
  // line after one that ended (a class field or type member with no `;`).
  const starts = !prev || "{,;}".includes(prev[1]!) ||
    /\b(?:readonly|static|public|private|protected|declare|override|accessor|get|set|async)\s+$/
      .test(head) ||
    (prev[2]!.includes("\n") && /[\w$)\]"'`]/.test(prev[1]!));
  if (!starts) return false;
  // `{name}` straight after `=` or `>`: a JSX expression, not a shorthand.
  const jsx = bare[at - 1] === "{" && bare[end] === "}" &&
    "=>".includes(bare[at - 2] ?? " ");
  if ((next === "," || next === "}") && "{,".includes(prev?.[1] ?? "{")) {
    return !jsx;
  }
  if (next === ":" || next.startsWith("?") || next === "=") return true;
  const paren = next === "(" ? bare.indexOf("(", end) : -1;
  return paren !== -1 && _isCallDefinition(bare, at, paren);
}

/** What a specifier is to aio — two answers are PROOFS, the third is the
 *  default. The specifier is resolved through the project's import map FIRST
 *  (the scope that applies to the importing file, then the top level; an
 *  exact key, else the longest prefix), and the answer is read off what it
 *  resolves to:
 *  - `aio` — aio by its spelling ({@linkcode isAioSpec}: the registry name,
 *    the vendored copy); what the map's own `aio` key points at, unless that
 *    is a file of this app; or a module of this app that hands the asked
 *    `name` on from aio and from nowhere else (ONE hop, never two);
 *  - `other` — another package by its scheme (`npm:`, `jsr:`, `node:`,
 *    `http(s):`); or a module of this app that declares the asked `name` in
 *    an `export` of its own;
 *  - `maybe` — everything else: a path nothing here can open, a bare
 *    specifier the map does not list, a map entry that is no string, a map
 *    that could not be read, a module of this app that names the asked
 *    `name` in any other way. Reported for a look, never rewritten, never
 *    silent. */
export type SpecKinds =
  & ((
    spec: string,
    name?: string,
    /** Only aio's MAIN entry counts as `aio` — for a name that lives there
     *  and in no sub-entry (`blocking`). Another entry of aio is `maybe`. */
    main?: boolean,
  ) => "aio" | "maybe" | "other")
  & {
    /** The export of aio that the app's own module `spec` hands out under
     *  ANOTHER name, `name` (`export { schedule as sched } from "aio"` →
     *  `schedule` for `sched`); undefined when it does no such thing. */
    origin?: (spec: string, name: string) => string | undefined;
  };

/** The files one lint run holds, seen from the file that imports. */
export type Run = {
  /** Where the import map's relative targets start. */
  root: string;
  /** The importing file. */
  from: string;
  /** A held file's text, by absolute path. */
  source(path: string): string | undefined;
  /** The project names an import map that could not be read: a bare
   *  specifier may resolve to anything. */
  opaque?: boolean;
};

/** One level of an import map as the entries it can be trusted with: `map`
 *  holds the string → string ones, `bad` the keys whose target is anything
 *  else. THE reader — nothing else looks at a map's values, so a target
 *  that is no string is never handed to string code. Pure. */
function _mapEntries(
  value: unknown,
): { map: Map<string, string>; bad: Set<string> } {
  const map = new Map<string, string>();
  const bad = new Set<string>();
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, target] of Object.entries(value)) {
      if (typeof target === "string") map.set(key, target);
      else bad.add(key);
    }
  }
  return { map, bad };
}

const _SCHEME = /^(?:npm|jsr|node|https?):/;

/** The path a `file:` specifier names, in the host's spelling: a URL's
 *  `pathname` is `/C:/x` on Windows, which is no path there. */
function _filePath(spec: string): string {
  try {
    return fromFileUrl(spec);
  } catch (e) {
    // An escape that decodes to no text (`%ff`): the raw pathname names no
    // file the run holds, so the answer stays "maybe" — and no config throws.
    if (e instanceof URIError) return new URL(spec).pathname;
    throw e;
  }
}

/** {@linkcode SpecKinds} from a deno.json `imports` value (`null`, or
 *  anything that is no object, maps nothing) and its `scopes` — and, with
 *  `run`, the one hop into the app's own modules. Pure. */
export function specKinds(
  imports: unknown = {},
  run?: Run,
  scopes?: unknown,
): SpecKinds {
  return _kinds(imports, run, scopes, true);
}

function _kinds(
  imports: unknown,
  run: Run | undefined,
  scopes: unknown,
  hopping: boolean,
): SpecKinds {
  // The maps that apply to the importing file, most specific first: each
  // scope whose prefix holds the file, then the top level.
  const levels = [_mapEntries(imports)];
  const scoped = _mapEntries(null);
  if (scopes !== null && typeof scopes === "object" && !Array.isArray(scopes)) {
    const applies: [number, ReturnType<typeof _mapEntries>][] = [];
    for (const [prefix, value] of Object.entries(scopes)) {
      // Without a file to place, or with a prefix that is no path, nothing
      // here can say whether the scope applies: what it lists is unknown.
      const path = run && /^(?:\.{0,2}\/|file:)/.test(prefix)
        ? resolve(
          run.root,
          prefix.startsWith("file:") ? _filePath(prefix) : prefix,
          // `resolve` answers in the host's separators, and so does `run.from`.
        ) + (prefix.endsWith("/") ? SEPARATOR : "")
        : undefined;
      const level = _mapEntries(value);
      if (path === undefined) {
        for (const key of [...level.map.keys(), ...level.bad]) {
          scoped.bad.add(key);
        }
      } else if (
        path.endsWith(SEPARATOR)
          ? run!.from.startsWith(path)
          : run!.from === path
      ) applies.push([path.length, level]);
    }
    applies.sort((a, b) => b[0] - a[0]);
    levels.unshift(scoped, ...applies.map(([, level]) => level));
  }
  /** The map's answer for `spec`: its target and the key that gave it; a
   *  bare `{ target }` when no key matches; null when the key that matches
   *  has no usable target. */
  const mapped = (
    spec: string,
  ): { target: string; key?: string } | null => {
    for (const { map, bad } of levels) {
      if (bad.has(spec)) return null;
      const exact = map.get(spec);
      if (exact !== undefined) return { target: exact, key: spec };
      // An import map picks the LONGEST prefix that matches.
      const dir = [...map.keys(), ...bad]
        .filter((k) => k.endsWith("/") && spec.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (dir === undefined) continue;
      const to = map.get(dir);
      return to === undefined
        ? null
        : { target: to + spec.slice(dir.length), key: dir };
    }
    return { target: spec };
  };
  /** The file a target names, when it names one. */
  const fileOf = (target: string, key: string | undefined) =>
    !run || !/^(?:\.{0,2}\/|file:)/.test(target)
      ? undefined
      : target.startsWith("file:")
      ? _filePath(target)
      : resolve(key === undefined ? dirname(run.from) : run.root, target);
  const hops = new Map<string, "aio" | "maybe" | "other">();
  /** Whose `name` is, as the app's own module at `path` hands it out. `aio`
   *  only when the module gives the name EXACTLY ONE source and that source
   *  is aio: the one `export { name } from <aio>` with no other mention of
   *  the name, or the module's only `export * from <aio>` with no mention of
   *  the name at all. */
  const hop = (
    path: string,
    name: string,
    main?: boolean,
  ): "aio" | "maybe" | "other" => {
    const src = run!.source(path)!;
    // Seen from the module itself, and no further: a second hop is `maybe`.
    const direct = _kinds(imports, { ...run!, from: path }, scopes, false);
    const bare = _bareDeep(src);
    const said = [...bare.matchAll(_token(name))].length;
    const exports = moduleStatements(src).filter((st) => st.kind === "export");
    const named = exports.flatMap((st) =>
      (st.list?.entries ?? []).filter((e) =>
        e.text && (bareName(e.text) === name || localName(e.text) === name)
      ).map((e) => ({ st, e }))
    );
    if (said === 1 && named.length === 1) {
      const { st, e } = named[0]!;
      // `export { other as name } from …` is another export under this name;
      // `export { name as other } from …` does not hand `name` out at all.
      if (localName(e.text) !== name) return "maybe";
      if (bareName(e.text) !== name) return "other";
      return direct(st.spec, name, main);
    }
    if (said === 0) {
      const stars = exports.filter((st) => st.clause === "*");
      return stars.length === 1 ? direct(stars[0]!.spec, name, main) : "maybe";
    }
    // An `export` that declares the name is the module's own, whatever else
    // it re-exports: a local export wins over `export *`.
    return new RegExp(
        `\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\s*\\*?|const|let|var|class|type|interface|enum|namespace)\\s+${name}(?![\\w$])`,
      ).test(bare)
      ? "other"
      : "maybe";
  };
  /** What the map's own `aio` keys point at — the names an alias of aio
   *  resolves to. A file of this app under the `aio` key is the app's. */
  const isOwn = (target: string, key: string | undefined) => {
    const path = fileOf(target, key);
    return path !== undefined && run!.source(path) !== undefined;
  };
  const aioTargets = new Set(
    levels.flatMap(({ map }) => [...map]).filter(([key, target]) =>
      isAioSpec(key) && !/^(?:npm|jsr|node):/.test(target) &&
      !isOwn(target, key)
    ).map(([, target]) => target),
  );
  /** aio's main entry: the package itself, its `mod.ts`, or what the map's
   *  `aio` key (not `aio/…`) points at. */
  const MAIN = /^(?:aio|@riagentic\/aio|jsr:\/?@riagentic\/aio(?:@[^/]+)?)$/;
  const mainTargets = new Set(
    levels.flatMap(({ map }) => [...map]).filter(([key]) => MAIN.test(key))
      .map(([, target]) => target),
  );
  const isMain = (target: string) =>
    MAIN.test(target) || mainTargets.has(target) ||
    (isAioSpec(target) && /\/mod\.ts$/.test(target));
  const kinds: SpecKinds = (spec, name, main) => {
    const hit = mapped(spec);
    if (hit === null) return "maybe";
    const { target, key } = hit;
    const bareSpec = !/^(?:\.{0,2}\/|file:)/.test(spec) && !_SCHEME.test(spec);
    // A map nobody could read may send a bare specifier anywhere.
    if (run?.opaque && bareSpec) return "maybe";
    if (isAioSpec(target) || aioTargets.has(target)) {
      return !main || isMain(target) ? "aio" : "maybe";
    }
    if (_SCHEME.test(target)) return "other";
    const path = fileOf(target, key);
    if (path === undefined || name === undefined || !hopping) return "maybe";
    if (run!.source(path) === undefined) return "maybe";
    const id = `${path}\n${name}\n${main ? 1 : 0}`;
    if (!hops.has(id)) hops.set(id, hop(path, name, main));
    return hops.get(id)!;
  };
  kinds.origin = (spec, name) => {
    const hit = hopping ? mapped(spec) : null;
    const path = hit ? fileOf(hit.target, hit.key) : undefined;
    const src = path === undefined ? undefined : run!.source(path);
    if (src === undefined) return undefined;
    const direct = _kinds(imports, { ...run!, from: path! }, scopes, false);
    for (const st of moduleStatements(src)) {
      if (st.kind !== "export" || !st.spec) continue;
      for (const e of st.list?.entries ?? []) {
        const from = e.text ? bareName(e.text) : name;
        if (
          from !== name && localName(e.text) === name &&
          direct(st.spec, from) === "aio"
        ) return from;
      }
    }
    return undefined;
  };
  return kinds;
}

/** {@linkcode specKinds} for each file of one lint run: the project's import
 *  map (`imports`/`scopes` in deno.json, else the `importMap` file — read
 *  once, here) and the files the run holds. An `importMap` that cannot be
 *  read is `opaque`: every bare specifier stays `maybe`, reported and not
 *  rewritten. So is a run with NO config (`null`: none in the linted
 *  directory, or one that does not parse): the map that applies may sit in a
 *  directory above, and may send `aio` anywhere. */
export function runKinds(
  projectDir: string,
  config:
    | { imports?: unknown; scopes?: unknown; importMap?: unknown }
    | null,
  files: readonly { path: string; content: string }[],
): (file: string) => SpecKinds {
  let imports = config?.imports;
  let scopes = config?.scopes;
  let root = projectDir;
  let opaque = config === null;
  // `imports` or `scopes` in deno.json ARE the map; `importMap` is read only
  // without them.
  if (
    (imports === undefined || imports === null) &&
    (scopes === undefined || scopes === null) &&
    config?.importMap !== undefined && config.importMap !== null
  ) {
    opaque = true;
    if (typeof config.importMap === "string") {
      const path = resolve(projectDir, config.importMap);
      try {
        const map = JSON.parse(Deno.readTextFileSync(path));
        if (map !== null && typeof map === "object" && !Array.isArray(map)) {
          imports = map.imports;
          scopes = map.scopes;
          root = dirname(path);
          opaque = false;
        }
      } catch {
        /* aio-ok: no readable map — every bare specifier stays "maybe": reported, never rewritten */
      }
    }
  }
  const held = new Map(files.map((f) => [resolve(f.path), f.content]));
  return (file) =>
    specKinds(
      imports,
      { root, from: resolve(file), source: (p) => held.get(p), opaque },
      scopes,
    );
}

/** Whose a name is, where it is used. ONE answer lets `--safe-fix` rewrite,
 *  and it needs a narrow, positive PROOF; every other answer leaves the code
 *  as written:
 *  - `aio` (PROVEN) — bound by exactly ONE static `import { name } from
 *    <aio>` ({@linkcode SpecKinds}), and every other time the file writes the
 *    name it is positively a USE of that import ({@linkcode _tokenRole}: a
 *    call, a receiver, a type reference) or a member of another object. Or a
 *    member of a namespace proven the same way (`import * as ns from <aio>`,
 *    then `ns.name`);
 *  - `shadowed` — imported from aio, but the name is also written somewhere
 *    that is not positively a use: a second binding (a declaration, a
 *    parameter, an inner `await import(…)`), a key, a shorthand, a value
 *    passed along, anything this reader does not recognise. `[manual]`,
 *    naming the line;
 *  - `none` — no binding at all in this file. `[manual]`: nothing here says
 *    whose it is;
 *  - `other` (PROVEN not aio's) — imported from another package, or as the
 *    alias of another export; declared in this file; a property the file
 *    names itself (a key, a member of an object that is no aio namespace);
 *  - `maybe` — everything else. Imported from a module nothing here can
 *    open; bound through `await import(…)`; a local, a parameter or a member
 *    of one in a file that holds aio as a VALUE (a namespace import, any
 *    `import(…)`).
 *
 *  THE table every rule keyed on a name aio exports, and its fix, follow:
 *
 *  | rule                               | aio | shadowed      | none          | maybe         | other    |
 *  |------------------------------------|-----|---------------|---------------|---------------|----------|
 *  | `useCell(c).state.x`               | fix | [manual]      | hint [manual] | hint [manual] | silent   |
 *  | `schedule.poll({ backoff })`       | fix | [manual]      | hint [manual] | hint [manual] | silent   |
 *  | `schedule.blocking(`               | fix | [manual]      | hint [manual] | hint [manual] | silent   |
 *  | the alpha70 renames (`CellAccess`) | fix | [manual]      | hint [manual] | hint [manual] | silent   |
 *  | `call({ timeout })`                | fix | hint [manual] | hint [manual] | hint [manual] | silent   |
 *  | `cell("x", { ui })`                | fix | [manual]      | [manual]      | [manual]      | [manual] |
 *  | `return [effects]`: its `cell`     | fix | [manual]      | [manual]      | [manual]      | [manual] |
 *  | …and the `schedule`/`own` returned | fix | [manual]      | [manual]      | [manual]      | [manual] |
 *
 *  - Nothing is rewritten outside the `fix` column, and nothing but the
 *    `other` column is silent.
 *  - A fix is all or nothing for a name in a file: one occurrence it cannot
 *    read as a use, and every occurrence in that file is `[manual]`.
 *  - A `fix` cell can still be `[manual]` for a reason of the use itself: an
 *    option written as a shorthand, a quoted or a computed key; a call in a
 *    template's `${…}`; `call({ timeout, timeoutMs })`; a `blocking` that
 *    already means something in the file.
 *  - A renamed word is renamed in a file only where its import can take the
 *    new name too (aio itself, or a module that only passes aio on with
 *    `export *`); a module that lists the name (`export { CellAccess } from
 *    "aio"`) and everything importing it from there is `[manual]`, together.
 *  - A returned effect written through a namespace
 *    (`return aio.schedule.after(…)`) is `[manual]`: the fix knows only the
 *    bare spelling.
 *  - The `cell("name", {…})` rows report an `other` too (as `[manual]`): the
 *    finding comes from the project's cell detection, and says why it is
 *    left. A `cell` that is a member of the app's own object is silent. */
export type Owner = "aio" | "shadowed" | "maybe" | "other" | "none";

/** One use: whose it is, whether it is a member (or a key), the reason a fix
 *  leaves it ("" for `aio` only) — and, of the file-level binding, the
 *  specifier it came from and whether the file declares the name. */
export type Use = {
  who: Owner;
  member: boolean;
  why: string;
  spec?: string;
  declared: boolean;
};

const BY_HAND = "if it is aio's, make the change by hand";

/** `name` as a whole identifier, wherever `bare` code writes it. */
const _token = (name: string): RegExp =>
  new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");

/** An identifier written with at least one `\u` escape, and the name it
 *  spells (an escape that names no character spells nothing). */
const _ESCAPED =
  /[\w$]*(?:\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})(?:[\w$]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})*/g;
const _unescaped = (id: string): string =>
  id.replace(/\\u\{?([0-9a-fA-F]+)\}?/g, (_, hex: string) => {
    const point = parseInt(hex, 16);
    return point > 0x10ffff ? "" : String.fromCodePoint(point);
  });

/** Words after which a dotted or indexed name is being DECLARED, not read:
 *  `namespace name.inner {…}`, `infer name[]`. */
const _DECLARES = /^(?:namespace|module|infer)$/;

/** What the `name` token at `at` of `bare` code ({@linkcode _bareDeep}) is:
 *  - `member` — `x.name`, `x?.name`, `this.#name`, and a method or signature
 *    called `name` (`name(o) {…}` in a class or an object): another
 *    object's property, never a binding;
 *  - `use` — POSITIVELY a use of whatever the file binds `name` to: a call
 *    that is no definition, a receiver (`name.x`, `name[0]`), a cast or
 *    alias source (`name as T`), a type reference where no declaration can
 *    stand (`x as name`, `): name`, `(p: name)`, `name<T>` after `:` or `=`,
 *    `Box<name>`), an operand after `=`, `|`, `&`, `return`, `new`, `typeof`…;
 *  - `unknown` — everything else.
 *
 *  THE declaration test of the whole file, and it is asked the other way
 *  round on purpose: nothing here recognises a declaration. A second
 *  declarator, a parameter (property), a pattern at any depth, `using`, a
 *  generic parameter, a key, a shorthand, a JSX attribute, an export list —
 *  each is simply not on the list of uses, as is a use this list is too
 *  short for (`f(name)`, `Map<K, name>`). `unknown` costs a `[manual]`; a
 *  declaration read as a use would rewrite code that is not aio's. Pure. */
function _tokenRole(
  bare: string,
  at: number,
  name: string,
): "member" | "use" | "unknown" {
  const head = bare.slice(Math.max(0, at - 240), at);
  const prev = /(\.\.\.|\?\.|=>|[\w$]+|\S)\s*$/.exec(head)?.[1] ?? "";
  if (prev === "." || prev === "?." || prev === "#") return "member";
  const end = at + name.length;
  const next =
    /^\s*(\?\.|=>|={1,3}|!\s*\.|[\w$]+|\S)/.exec(bare.slice(end, end + 240))
      ?.[1] ?? "";
  // A call — with type arguments too (`name<T>(…)`).
  const paren = next === "(" || next === "<" ? _callParen(bare, end) : -1;
  if (paren !== -1) {
    // `function name(` declares a binding. A method or a signature
    // (`name(o) {…}`, `static name(…)`, `name(o): T;`) is a property of its
    // class, object or interface — never a binding.
    if (prev === "function" || /\bfunction\s*\*\s*$/.test(head)) {
      return "unknown";
    }
    return _isCallDefinition(bare, at, paren) ? "member" : "use";
  }
  // `name =>` is a parameter — unless the name is the arrow's return type
  // (`(x: T): name => x`).
  const returned = /\)\s*:\s*$/.test(head);
  if (_DECLARES.test(prev) || (next === "=>" && !returned)) return "unknown";
  if (next === "." || next === "?." || next === "[" || /^!\s*\.$/.test(next)) {
    return "use";
  }
  /** The bracket this token sits in, and what comes before that bracket. */
  const within = (): { open: string; before: string } => {
    for (let i = at - 1, depth = 0; i >= 0; i--) {
      const ch = bare[i]!;
      if (")]}".includes(ch)) depth++;
      else if ("([{".includes(ch) && --depth < 0) {
        return { open: ch, before: bare.slice(Math.max(0, i - 40), i) };
      }
    }
    return { open: "", before: "" };
  };
  /** An `export {…}` list names what the module hands out, not a use. */
  const exported = () => {
    const { open, before } = within();
    return open === "{" && /\bexport\s*(?:type\s*)?$/.test(before);
  };
  // `name as T`, and the local side of `export { name as other }`.
  if (next === "as" || next === "satisfies" || next === "instanceof") {
    return "use";
  }
  const TYPED =
    /^(?::|\||&|=|<|as|extends|implements|satisfies|=>|new|return|keyof)$/;
  if (next === "<") {
    return TYPED.test(prev) || prev === "(" || prev === "typeof"
      ? "use"
      : "unknown";
  }
  if (
    /^(?:\||&|=|=>|extends|implements|satisfies|typeof|keyof|instanceof|new|return|await|throw)$/
      .test(prev)
  ) return "use";
  if (prev === "as") return exported() ? "unknown" : "use";
  if (prev === "<") {
    // A type ARGUMENT — `: Box<name>`, `= make<name>()` — never the type
    // PARAMETER of a declaration (`function f<name>(`, `type Box<name> =`,
    // a method's `m<name>(`).
    const m = /([\w$]+|\S)\s*([\w$]+)\s*<\s*$/.exec(head);
    return m !== null && /^[>,|&]$/.test(next) && TYPED.test(m[1]!) &&
        !/^(?:async|function|class|interface|type)$/.test(m[2]!)
      ? "use"
      : "unknown";
  }
  if (prev === ":") {
    // An annotation, a return type, a ternary's last operand — where no
    // pattern can be. `{ key: name }` may be a pattern that DECLARES `name`.
    const open = within().open;
    if (open === "(" || open === "[") return "use";
    if (returned || /^[;|&]$/.test(next)) return "use";
    if (/\b(?:const|let|var)\s+[\w$]+\s*[!?]?\s*:\s*$/.test(head)) {
      return "use";
    }
  }
  return "unknown";
}

/** The names this file gives a namespace — name → specifier: `static`, by
 *  `import * as ns from "spec"`; `held`, by `const ns = await
 *  import("spec")`. */
function _namespaces(
  src: string,
): { static: Map<string, ModuleStatement>; held: Map<string, string> } {
  const fixed = new Map<string, ModuleStatement>();
  for (const st of moduleStatements(src)) {
    const ns = st.kind === "import"
      ? /\*\s*as\s+([\w$]+)\s*$/.exec(st.clause.split("{")[0]!.trim())
      : null;
    if (ns) fixed.set(ns[1]!, st);
  }
  const held = new Map<string, string>();
  for (
    const m of codeMatches(
      src,
      /\b(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+import\(\s*(["'])([^"']+)\2\s*\)/g,
    )
  ) held.set(m[1]!, m[3]!);
  return { static: fixed, held };
}

/** The first `</` in the raw text of `src` that does not start the closing
 *  tag of an element the reader took, or -1. No pattern of what a closing
 *  tag looks like is asked: however its name is spelled and whatever stands
 *  inside it, one the reader did not consume is one it did not account for. */
function _strayClose(src: string): number {
  if (!src.includes("</")) return -1;
  const closed = new Set(jsxRead(src).closed);
  for (let at = src.indexOf("</"); at !== -1; at = src.indexOf("</", at + 2)) {
    if (!closed.has(at)) return at;
  }
  return -1;
}

/** One file, read once: `use(at, name)` is {@linkcode whose}; `stop(name,
 *  st)` is where the file writes `name` in a way that is neither the binding
 *  in statement `st`, nor a use of it, nor another object's member (-1: no
 *  such place); `written(name)` is every such non-member place when nothing
 *  is taken to bind the name. */
function _read(src: string, kinds: SpecKinds) {
  const bare = _bareDeep(src);
  const statements = moduleStatements(src);
  const imports = statements.filter((st) => st.kind === "import");
  const namespaces = _namespaces(src);
  // `const { a, b: c } = await import("spec")` — an import by another name.
  const dynamic = codeMatches(
    src,
    /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*await\s+import\(\s*(["'])([^"']+)\2\s*\)/g,
  ).map((m) => ({
    span: [m.index!, m.index! + m[0].length] as const,
    spec: m[3]!,
    names: m[1]!.split(",").map((e) => e.split(":").map((x) => x.trim()))
      .filter((e) => e[0]),
  }));
  // Where a `{…}` lists what is imported, not an object's keys.
  const lists = [
    ...statements.map((st) => [st.start, st.end] as const),
    ...dynamic.map((d) => d.span),
  ];
  const lineOf = (at: number) => src.slice(0, at).split("\n").length;
  // The proof below reads the code the mask shows it, and the mask is a
  // lexer without a parser. Where a file holds strings, templates, regexes
  // and comments only, that lexer is the language's own and is trusted. A
  // file that may hold JSX is another matter — every element ends in `</` or
  // `/>`, so that is the test: what an element shows is prose, the element
  // reader is a best effort (a tag it cannot parse leaves prose lexed as
  // code, where an apostrophe or a `//` blanks whatever follows it), and an
  // old-style cast can read as an element in a `.ts` file. So in such a
  // file a name is proven only when it is written NOWHERE the mask blanks:
  // not in a string, a template's text, a regex, a comment or shown text.
  // This is complete by construction, whatever the reader got wrong: a
  // declaration the mask hides has its name inside what the mask blanked,
  // and a use it hides has too — one hidden use left behind a renamed
  // import is as wrong as a rewrite.
  //
  // Two readings are not excuses. A module statement's own specifier is the
  // string it is when it holds specifier characters only: no space, bracket
  // or `=`, so nothing in it can declare a name. And the one declaration
  // whose NAME stays in sight while the mask hides its keyword — `function`
  // closing a `//` line, the name opening the next — is a stop as well.
  const flat = /<\/|\/>/.test(src) ? codeMaskDeep(src) : null;
  const hiddens = new Map<string, number[]>();
  const hidden = (name: string): number[] => {
    if (!flat) return [];
    let out = hiddens.get(name);
    if (!out) {
      out = [...src.matchAll(_token(name))].map((m) => m.index).filter(
        (at) => {
          if (flat[at] === 1) {
            const line = src.lastIndexOf("\n", at);
            return line > 0 && flat[line - 1] === 0 &&
              /^\s*$/.test(src.slice(line, at)) &&
              /\bfunction\s*\*?\s*$/.test(src.slice(0, line));
          }
          return !statements.some((st) =>
            st.specStart <= at && at < st.specEnd &&
            /^[\w$@./:#~+-]*$/.test(st.spec)
          );
        },
      );
      // The name spelled with an escape, where the mask blanks: the same.
      for (const m of src.matchAll(_ESCAPED)) {
        if (_unescaped(m[0]) === name) out.push(m.index);
      }
      out.sort((a, b) => a - b);
      hiddens.set(name, out);
    }
    return out;
  };
  const unread = (name: string): number => hidden(name)[0] ?? -1;
  // Two things in a file mean that NO name in it is proven, whatever the
  // name: nothing is rewritten, and every finding names the line.
  //  - An identifier written with a `\u` escape (`c\u0061ll` is `call`). Names
  //    are read here as they are spelled, so a declaration spelled that way
  //    is not seen. Outside strings, templates, regexes and comments a `\u`
  //    can only be part of an identifier — so one in the code is the test.
  //  - A `</` written ANYWHERE in the raw text — in code, a string, a
  //    comment — that does not start the closing tag of an element the
  //    reader took. An element the reader did not take (a tag it cannot
  //    parse, a place it never tries) has its text lexed as code, where a
  //    fix would rewrite what the page shows — and such an element always
  //    ends in a `</` the reader did not account for, whatever its own text
  //    blanked and however its tag is written.
  const escaped = bare.search(/\\u/);
  const stray = _strayClose(src);
  const lost = escaped !== -1 ? escaped : stray;
  const lostWhy = lost === -1 ? "" : `line ${lineOf(lost)} ` +
    (escaped !== -1
      ? `writes an identifier with a \`\\u\` escape, and aiol reads ` +
        `names as they are spelled — no name is proven in this file`
      : `writes \`</\` where it closes no element aiol read (in code, a ` +
        `string or a comment), so what an element shows may have been ` +
        `taken for code — no name is proven in this file`);
  const stop = (name: string, binds?: ModuleStatement): number => {
    if (lost !== -1) return lost;
    let bound = false;
    for (const m of bare.matchAll(_token(name))) {
      const at = m.index;
      const st = statements.find((st) => st.start <= at && at < st.end);
      if (!st) {
        if (_tokenRole(bare, at, name) === "unknown") return at;
        continue;
      }
      const entry = st.list?.entries.find((e) =>
        e.slotStart <= at && at < e.slotEnd
      );
      const local = entry ? localName(entry.text) : name;
      // `import { name as other }` binds `other`: the name of an export,
      // not of anything in this file.
      if (st.kind === "import" && entry && local !== name) continue;
      // The binding itself, once: the list entry (under its local name),
      // or the namespace clause.
      if (
        st.start === binds?.start && !bound &&
        (!entry || (localName(entry.text) === name && at >= entry.start))
      ) {
        bound = true;
        continue;
      }
      return at;
    }
    return unread(name);
  };
  // Does the file hold aio — or what may be aio — as a VALUE? Then a local
  // may be taken from it, and "declared here" proves nothing.
  const loose =
    [...namespaces.static.values()].some((st) => kinds(st.spec) !== "other") ||
    [...namespaces.held.values()].some((s) => kinds(s) !== "other") ||
    [...bare.matchAll(/\bimport\s*\(\s*(["'])?/g)].some((m) => {
      const spec = m[1]
        ? src.slice(m.index + m[0].length).split(m[1])[0]!
        : undefined;
      return spec === undefined || kinds(spec) !== "other";
    });
  const HELD = "this file holds aio (or what may be aio) as a value";
  const softs = new Map<string, boolean>();
  const soft = (id: string): boolean => {
    if (!softs.has(id)) {
      softs.set(
        id,
        _declaredAt(bare, id) !== -1 && !_declaredHard(bare, id),
      );
    }
    return softs.get(id)!;
  };
  const files = new Map<string, Use>();
  // `name` is what the file calls it, `exported` what aio does: `import {
  // call as c }` binds `c` to aio's `call`.
  const inFile = (name: string, exported: string): Use => {
    // Everything that binds `name` here: whose, from where, and — for the
    // one form that can prove it — the statement.
    const bindings: {
      kind: "aio" | "maybe" | "other";
      spec: string;
      proof?: ModuleStatement;
      held?: boolean;
      handed?: string;
    }[] = [];
    for (const st of imports) {
      for (const e of st.list?.entries ?? []) {
        if (!e.text || localName(e.text) !== name) continue;
        // The alias of ANOTHER export of aio is not aio's `exported` — unless
        // the module it comes from is the app's own and hands aio's
        // `exported` out under that other name.
        const from = bareName(e.text);
        const alias = from !== exported;
        const handed = alias && kinds.origin?.(st.spec, from) === exported;
        const kind = kinds(st.spec, from);
        bindings.push({
          kind: handed ? "maybe" : kind === "aio" && alias ? "other" : kind,
          spec: st.spec,
          proof: kind === "aio" && !alias ? st : undefined,
          handed: handed ? from : undefined,
        });
      }
      // A namespace called `name` is nobody's export; `import name from …`
      // is the module's default — aio has none.
      const lead = st.clause.split("{")[0]!.trim();
      if (namespaces.static.get(name)?.start === st.start) {
        bindings.push({ kind: "other", spec: st.spec });
      } else if (new RegExp(`^${name}\\s*(?:,|$)`).test(lead)) {
        const kind = kinds(st.spec);
        bindings.push({ kind: kind === "aio" ? "other" : kind, spec: st.spec });
      }
    }
    for (const d of dynamic) {
      for (const [key, as] of d.names) {
        if ((as ?? key) !== name) continue;
        // `await import(…)` binds inside one function; which uses it reaches
        // is a question of scope, and nothing here reads scopes.
        const kind = kinds(d.spec, key);
        bindings.push({
          kind: kind === "other" || key !== exported ? "other" : "maybe",
          spec: d.spec,
          held: kind === "aio",
        });
      }
    }
    const declared = _declaredAt(bare, name, dynamic.map((d) => d.span)) !== -1;
    const taken = declared && loose && !_declaredHard(bare, name);
    const first = bindings[0];
    const spec = first?.spec;
    const proof = bindings.find((b) => b.proof)?.proof;
    const stopped = proof ? stop(name, proof) : -1;
    const unsure = bindings.find((b) => b.kind !== "other");
    const who: Owner = proof
      ? (stopped === -1 ? "aio" : "shadowed")
      : unsure
      ? "maybe"
      : first
      ? "other"
      : declared
      ? (taken ? "maybe" : "other")
      : "none";
    const why = who === "shadowed"
      ? `the safe fix declines: this file imports aio's \`${exported}\`` +
        (name === exported ? "" : ` as \`${name}\``) + `, and ` +
        (lostWhy ||
          `line ${lineOf(stopped)} writes \`${name}\` ` +
            (flat && flat[stopped] !== 1
              ? `inside a comment, a string or shown text — in a file with ` +
                `JSX aiol cannot rule out that this is code`
              : `in a way aiol cannot read as a use of that import (another ` +
                `binding, a key, a value passed along)`)) +
        ` — make the change by hand where it is aio's`
      : who === "maybe"
      ? (unsure?.handed
        ? `the safe fix declines: \`${name}\` comes from "${unsure.spec}", ` +
          `which hands out aio's \`${exported}\` as \`${unsure.handed}\` — ` +
          `make the change by hand`
        : unsure?.held
        ? `the safe fix declines: \`${name}\` is bound by \`await ` +
          `import("${unsure.spec}")\` inside a function, and aiol does not ` +
          `follow which uses that reaches — ${BY_HAND}`
        : unsure
        ? `the safe fix declines: \`${name}\` is imported from ` +
          `"${unsure.spec}" — aiol cannot tell whose it is; ${BY_HAND}`
        : `the safe fix declines: ${HELD}, and \`${name}\` is a local that ` +
          `may be taken from it — ${BY_HAND}`)
      : who === "other"
      ? `the safe fix declines: \`${name}\` is this file's own` +
        (first ? ` (imported from "${spec}")` : " (declared here)") +
        `, not aio's`
      : who === "none"
      ? `the safe fix declines: nothing in this file imports \`${name}\`, ` +
        `so aiol cannot tell whose it is — ${BY_HAND}`
      : "";
    return { who, member: false, why, spec: proof?.spec ?? spec, declared };
  };
  const OWN = (name: string): Use => ({
    who: "other",
    member: true,
    why: `the safe fix declines: \`${name}\` here is a property of the ` +
      `app's own object`,
    declared: false,
  });
  // `at` < 0 asks about the bare name itself. `exported`: the export of
  // aio the question is about, when the file may call it something else.
  const use = (at: number, name: string, exported = name): Use => {
    if (at >= 0 && _ownKeyAt(bare, at, name, lists)) return OWN(name);
    const before = bare.slice(Math.max(0, at - 200), Math.max(0, at));
    // `x.name`, `x?.name`, `x!.name`, `this.#name` — a rest/spread `...name`
    // is no member.
    const dot = at < 0 || /\.\.\.\s*$/.test(before)
      ? null
      : /([\w$)\]]*)\s*!?\s*(?:\?\.|\.|#)\s*$/.exec(before);
    if (!dot) {
      const id = `${name}\n${exported}`;
      if (!files.has(id)) files.set(id, inFile(name, exported));
      return files.get(id)!;
    }
    // A member is aio's on a PROVEN namespace of aio (`ns.name`); of any
    // other object it is that object's own — unless the file holds aio as a
    // value and the object is a local or an expression that may be it.
    const object = dot[1]!;
    const chained = /[.#]\s*$/.test(before.slice(0, dot.index));
    const st = chained ? undefined : namespaces.static.get(object);
    const spec = st?.spec ??
      (chained ? undefined : namespaces.held.get(object));
    if (spec !== undefined) {
      const kind = kinds(spec, name);
      if (kind === "other") return OWN(name);
      const stopped = st ? stop(object, st) : -1;
      const proven = kind === "aio" && st !== undefined && stopped === -1;
      return {
        who: proven ? "aio" : "maybe",
        member: true,
        why: proven
          ? ""
          : kind === "maybe"
          ? `the safe fix declines: \`${object}\` is imported from ` +
            `"${spec}" — aiol cannot tell whose it is; ${BY_HAND}`
          : !st
          ? `the safe fix declines: \`${object}\` is bound by \`await ` +
            `import(…)\`, which aiol does not follow — ${BY_HAND}`
          : `the safe fix declines: ` +
            (lostWhy ||
              `line ${lineOf(stopped)} writes \`${object}\` in a way aiol ` +
                `cannot read as a use of the namespace import`) +
            ` — ${BY_HAND}`,
        spec,
        declared: false,
      };
    }
    const taken = loose &&
      (object.endsWith(")") ||
        (!chained && /^[\w$]+$/.test(object) && soft(object)));
    return taken
      ? {
        who: "maybe",
        member: true,
        why: `the safe fix declines: ${HELD}, and \`${name}\` is read from ` +
          `an expression that may be it — ${BY_HAND}`,
        declared: false,
      }
      : OWN(name);
  };
  /** Every place the file writes `name` outside a member access and outside
   *  the source side of an import alias (`import { name as other }`). */
  const written = (name: string): number[] => [
    ...[...bare.matchAll(_token(name))].map((m) => m.index).filter((at) => {
      if (_tokenRole(bare, at, name) === "member") return false;
      const st = imports.find((st) => st.start <= at && at < st.end);
      const entry = st?.list?.entries.find((e) =>
        e.slotStart <= at && at < e.slotEnd
      );
      return !entry || localName(entry.text) === name;
    }),
    // …and, where the mask is not trusted, every place it blanks.
    ...hidden(name).filter((at) => flat![at] !== 1),
  ];
  /** What this file may call aio's `exported`: the name itself, and every
   *  other local name an import binds to it — `import { call as c }`, `const
   *  { call: c } = await import(…)`, a name the app's own barrel renamed. */
  const names = (exported: string): string[] => {
    const out = new Set([exported]);
    for (const st of imports) {
      for (const e of st.list?.entries ?? []) {
        if (!e.text || localName(e.text) === exported) continue;
        const from = bareName(e.text);
        if (
          from === exported
            ? kinds(st.spec, exported) !== "other"
            : kinds.origin?.(st.spec, from) === exported
        ) out.add(localName(e.text));
      }
    }
    for (const d of dynamic) {
      for (const [key, as] of d.names) {
        if (key === exported && as && kinds(d.spec, key) !== "other") {
          out.add(as);
        }
      }
    }
    return [...out];
  };
  return { bare, statements, lists, lineOf, use, stop, written, names };
}

/** The `(` of a call whose callee ends at `from` in `bare` code, past an
 *  optional list of type arguments (`call<number>(`, `f<Map<K, V>>(`, `f<(a:
 *  A) => B>(`) — or -1 when no call stands there. A `<` that is a
 *  comparison never reaches a `>` followed by `(` without a `;`, `&&` or
 *  `||` on the way. */
function _callParen(bare: string, from: number): number {
  let i = from;
  while (/\s/.test(bare[i] ?? "")) i++;
  if (bare[i] === "<") {
    let depth = 0;
    for (; i < bare.length; i++) {
      const ch = bare[i]!;
      if (ch === "<") depth++;
      else if (ch === ">" && bare[i - 1] !== "=") {
        if (--depth === 0) break;
      } else if ("({[".includes(ch)) {
        i = balancedEnd(bare, i, bare);
        if (i === -1) return -1;
      } else if (ch === ";" || /^(?:&&|\|\|)/.test(bare.slice(i, i + 2))) {
        return -1;
      }
    }
    if (depth !== 0) return -1;
    i++;
    while (/\s/.test(bare[i] ?? "")) i++;
  }
  return bare[i] === "(" ? i : -1;
}

/** `(at, name) →` {@linkcode Use} for the `name` token at offset `at` of
 *  `src`. One per file text; the file is read once. Pure. */
export function whose(
  src: string,
  kinds: SpecKinds = specKinds(),
): (at: number, name: string, exported?: string) => Use {
  return _read(src, kinds).use;
}

/** The names this file gives a namespace of aio (`import * as aio`, `const
 *  aio = await import("aio")`), or of a module that may be one. Pure. */
export function aioNamespaces(
  src: string,
  kinds: SpecKinds = specKinds(),
): string[] {
  const { static: fixed, held } = _namespaces(src);
  return [
    ...[...fixed].map(([name, st]) => [name, st.spec] as const),
    ...held,
  ].filter(([, spec]) => kinds(spec) !== "other").map(([name]) => name);
}

/** One of the renamed words in `src`: each place the file writes it, and
 *  whose it is there. THE decider for the rename rule and its fix: the
 *  occurrences that come back `aio` are exactly the ones renamed to `to`.
 *
 *  All or nothing. They are renamed only when the file's import of the word
 *  is proven aio's AND can take the new name ({@linkcode SpecKinds} says
 *  `aio` for `to` as well — a module that lists the old name cannot), every
 *  other place the word is written is positively a use of that import, and
 *  `to` is not written in the file already (unless it is aio's too). One
 *  place that is none of that — a key, a member of the app's own object, a
 *  re-export, a declaration, anything unrecognised — and every occurrence
 *  that would have been aio's is `shadowed`: left to a person, with the line
 *  that stopped it. Pure. */
export function wordUses(
  src: string,
  word: string,
  to: string,
  kinds: SpecKinds = specKinds(),
): { at: number; use: Use }[] {
  const file = _read(src, kinds);
  const { bare, statements } = file;
  const plain = file.use(-1, word);
  /** What each occurrence is: `aio` (renamed if nothing stops the file),
   *  `stop` (not renamed, and nothing else is either), a finding of its own
   *  (`maybe`), or the app's (`other`). */
  type Seen = { at: number; as: "aio" | "bound" | "stop" | "other" | Use };
  const seen: Seen[] = [];
  const canTake = (spec: string) => kinds(spec, to) === "aio";
  const cannot = (spec: string): Use => ({
    who: "maybe",
    member: false,
    why: `the safe fix declines: \`${word}\` comes from "${spec}", which ` +
      `hands out the old name by name — rename it there and here together, ` +
      `by hand`,
    spec,
    declared: false,
  });
  const unknown = (spec: string): Use => ({
    who: "maybe",
    member: false,
    why: `the safe fix declines: \`${word}\` is imported from "${spec}" — ` +
      `aiol cannot tell whose it is; ${BY_HAND}`,
    spec,
    declared: false,
  });
  for (const m of bare.matchAll(_token(word))) {
    const at = m.index;
    const st = statements.find((st) => st.start <= at && at < st.end);
    if (st) {
      const entry = st.list?.entries.find((e) =>
        e.slotStart <= at && at < e.slotEnd
      );
      // A default or namespace binding called like the word is nobody's
      // export.
      if (!entry) {
        seen.push({ at, as: st.kind === "import" ? "bound" : "other" });
        continue;
      }
      // `x as word` — a local (or exported) name for another export.
      const text = bare.slice(entry.start, entry.end);
      const as = text.search(/\sas\s/);
      if (as !== -1 && at - entry.start > as) {
        seen.push({ at, as: st.kind === "import" ? "bound" : "other" });
        continue;
      }
      const kind = kinds(st.spec, word);
      if (kind === "other") {
        seen.push({
          at,
          as: st.kind === "import" && localName(entry.text) === word
            ? "bound"
            : "other",
        });
      } else if (st.kind === "export") {
        // Handing the old name on: whoever imports it from here reads it by
        // that name, so the list is never renamed.
        seen.push({
          at,
          as: kind === "aio"
            ? {
              who: "shadowed",
              member: false,
              why: `the safe fix declines: this module hands out ` +
                `\`${word}\` by name, and whatever imports it from here ` +
                `would have to change with it — rename both by hand`,
              spec: st.spec,
              declared: false,
            }
            : unknown(st.spec),
        });
      } else if (kind === "maybe") seen.push({ at, as: unknown(st.spec) });
      else if (!canTake(st.spec)) seen.push({ at, as: cannot(st.spec) });
      else seen.push({ at, as: "aio" });
      continue;
    }
    const one = file.use(at, word);
    if (one.member) {
      // `ns.word` on a proven namespace of aio; a key or a member of the
      // app's own object stops the file.
      seen.push({
        at,
        as: one.who === "other"
          ? "stop"
          : one.who !== "aio"
          ? one
          : canTake(one.spec!)
          ? "aio"
          : cannot(one.spec!),
      });
      continue;
    }
    seen.push({
      at,
      as: plain.who === "other"
        ? "other"
        : plain.who !== "aio" && plain.who !== "shadowed"
        ? plain
        : _tokenRole(bare, at, word) === "use"
        ? "aio"
        : "stop",
    });
  }
  // `to` already written here must be aio's own `to`, or the rename would
  // run two things into one name.
  const aioHere = seen.some((s) => s.as === "aio");
  const takenAt = aioHere && file.written(to).length > 0 &&
      file.use(-1, to).who !== "aio"
    ? file.written(to)[0]!
    : -1;
  const stopAt =
    seen.find((s) => s.as === "stop" || typeof s.as === "object")?.at ??
      (aioHere ? seen.find((s) => s.as === "bound")?.at : undefined) ?? -1;
  const halted = stopAt !== -1 || takenAt !== -1 || plain.who === "shadowed";
  const declined: Use = {
    who: "shadowed",
    member: false,
    why: stopAt !== -1
      ? `the safe fix declines: line ${file.lineOf(stopAt)} writes ` +
        `\`${word}\` in a way aiol cannot read as a use of aio's (a key, a ` +
        `member of the app's own object, a re-export, another binding); ` +
        `renaming some and not the rest changes what the program reads — ` +
        `rename by hand what is aio's`
      : plain.who === "shadowed"
      ? plain.why
      : `the safe fix declines: \`${to}\`, the new name, is already ` +
        `written on line ${file.lineOf(takenAt)} and is not aio's there — ` +
        `rename by hand`,
    declared: false,
  };
  const AIO: Use = { who: "aio", member: false, why: "", declared: false };
  const OTHER: Use = { who: "other", member: false, why: "", declared: false };
  return seen.map(({ at, as }) => ({
    at,
    use: typeof as === "object"
      ? as
      : as === "aio"
      ? (halted ? declined : AIO)
      : as === "stop" && (aioHere || plain.who === "shadowed")
      ? declined
      : OTHER,
  }));
}

/** Does `--safe-fix` act on this use? Only on a PROVEN `aio`
 *  ({@linkcode Owner}). */
export const fixable = (use: Use): boolean => use.who === "aio";

/** Why `--safe-fix` leaves the `cell("name", {…})` at `at` to a person: ""
 *  when it does not, null when that `cell` is a member of the app's own
 *  object (`grid.cell("a1", {…})`) — not a finding at all. The `cell` row of
 *  the table at {@linkcode Owner}: only a `cell` proven aio's is rewritten. */
export function cellUse(use: Use): string | null {
  if (use.member && use.who === "other") return null;
  if (fixable(use)) return "";
  if (use.who !== "other") return use.why;
  return use.declared
    ? "the safe fix declines: this file declares a `cell` of its own, so " +
      `this may not be aio's \`cell(…)\` — ${BY_HAND}`
    : `the safe fix declines: \`cell\` is imported from "${use.spec}", ` +
      `not from aio — ${BY_HAND}`;
}

/** {@linkcode cellUse} of the file's bare `cell`, and the same question of
 *  the names a returned effect starts with, where the file writes them:
 *  `return schedule.after(…)` from the file's OWN `schedule` is that
 *  method's value, not an effect to hand to `s.$do`. And the one name the
 *  fix may ADD is asked too: `MethodDraftServed` goes into the file's
 *  `import … from "aio"`, so that specifier has to be aio here. */
function _effectsDecline(src: string, kinds: SpecKinds): string {
  const file = _read(src, kinds);
  const mapped = file.statements.some((st) => st.spec === "aio") &&
    kinds("aio", "MethodDraftServed") !== "aio";
  return cellUse(file.use(-1, "cell")) ||
    ["schedule", "own"].filter((n) => file.written(n).length > 0)
      .map((n) => file.use(-1, n)).find((u) => !fixable(u))?.why ||
    (mapped
      ? `the safe fix declines: "aio" does not resolve to aio in this ` +
        `project — ${BY_HAND}`
      : "");
}

/** Is the `call` at `at`, whose parameter list opens at `paren`, a
 *  DEFINITION or a signature rather than an invocation? A method, function or
 *  interface member named `call` is never aio's bare (imported) `call` — and
 *  rewriting the option key inside its destructured parameters renames a
 *  binding the body still reads (`call({ timeout: 1 }) { return timeout; }`
 *  became `timeoutMs` while the body kept `timeout`), or a property the
 *  parameter's own type does not have (`{ timeoutMs: t }: { timeout: number }`
 *  — a file that no longer type-checks).
 *
 *  It was "the `)` is followed by `{`", which a return type defeats:
 *  `call({ timeout: t }): number {`. A definition is any of:
 *  - `function call(` / a member modifier before it (`async`, `static`,
 *    `abstract`, `declare`, …);
 *  - a TYPE ANNOTATION on the first parameter (`}: T`) — an argument is never
 *    followed by `:`;
 *  - after the `)`: a body `{`, an arrow `=>`, or a return type `:` — the last
 *    only where a member can start (after `{` `,` `;` `}`, or on a new line
 *    after a member that ended without one), so the `:` of a ternary
 *    (`ok ? call({ timeout: 1 }, f) : x`) is not one. */
function _isCallDefinition(bare: string, at: number, paren: number): boolean {
  const before = bare.slice(0, at).trimEnd();
  const prev = /(?:[\w$]+|[^\s\w$])$/.exec(before)?.[0] ?? "";
  if (
    /^(?:function|async|static|public|private|protected|override|abstract|declare|readonly|get|set)$/
      .test(prev) || /\bfunction\s*\*$/.test(before)
  ) return true;
  const next = (i: number) => /\S/.exec(bare.slice(i))?.[0] ?? "";
  let depth = 0;
  let firstArg = true;
  for (let i = paren; i < bare.length; i++) {
    const ch = bare[i]!;
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 1 && firstArg) {
        firstArg = false;
        if (next(i + 1) === ":") return true; // `}: T` — a typed parameter
      }
      if (depth === 0) {
        const after = bare.slice(i + 1).trimStart();
        if (after.startsWith("{") || after.startsWith("=>")) return true;
        if (!after.startsWith(":")) return false;
        if (/^[{,;}]?$/.test(prev)) return true;
        // …or on a line of its own after something that ENDS an expression —
        // a field with no semicolon (`x = 1`), a decorator (`@dec()`). An
        // invocation there would be a statement, and no statement goes on
        // with `:`. A keyword that takes an operand does not end one.
        return /\n\s*$/.test(bare.slice(0, at)) && /[\w$)\]"'`]$/.test(prev) &&
          !/^(?:return|await|yield|typeof|void|delete|new|throw|case|in|of|else|do|instanceof)$/
            .test(prev);
      }
    }
  }
  return false;
}

/** One top-level entry of an object literal: where it starts, the key it
 *  sets, and how the key is written. */
type OptionKey = {
  at: number;
  name: string;
  form: "plain" | "shorthand" | "quoted" | "computed";
};

/** The TOP-LEVEL keys of the object literal whose `{` sits at `open` of
 *  `bare` code ({@linkcode _bareDeep}): `key: v`, the shorthand `key`, the
 *  quoted `"key": v` and the computed `["key"]: v`. A key of a nested object
 *  is not this object's; a spread, a method and a computed expression name
 *  no key here. Pure. */
function _optionKeys(src: string, bare: string, open: number): OptionKey[] {
  const out: OptionKey[] = [];
  let start = open + 1;
  for (let i = open, depth = 0; i < bare.length; i++) {
    const ch = bare[i]!;
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    if (depth > 1 || (depth === 1 && ch !== ",")) continue;
    const slot = bare.slice(start, i);
    const at = start + slot.length - slot.trimStart().length;
    const text = slot.trim();
    const plain = /^([\w$]+)\s*(:|$)/.exec(text);
    const quoted = /^(\[\s*)?(["'`])\s*\2\s*(\])?\s*:/.exec(text);
    if (plain) {
      out.push({ at, name: plain[1]!, form: plain[2] ? "plain" : "shorthand" });
    } else if (quoted && !quoted[1] === !quoted[3]) {
      const from = src.indexOf(quoted[2]!, at) + 1;
      out.push({
        at,
        name: src.slice(from, src.indexOf(quoted[2]!, from)),
        form: quoted[1] ? "computed" : "quoted",
      });
    }
    start = i + 1;
    if (depth <= 0) break;
  }
  return out;
}

/** Offsets of every `timeout` key that is a TOP-LEVEL option of a `call(` —
 *  `sites` — and of those, `fix`: the ones the safe fix renames. A site is
 *  renamed only when its `call` is PROVEN aio's ({@linkcode whose}) and the
 *  key is the plain `timeout: v` of a call in ordinary code. Every other
 *  site is a finding all the same — `why` says what stopped the first of
 *  them, `sure` whether that one's `call` is aio's (an error) or only may be
 *  (a hint): a `call` nothing proves; a key written as a shorthand, quoted
 *  or computed; a call inside a template's `${…}`; a call that sets
 *  `timeoutMs` as well (renaming would write the key twice).
 *
 *  THE decider for the deprecated-option rule and for its fix alike. Scoping
 *  used to be `\{[^}]*\}`, which does not stop at a nested `{`: in
 *  `call({ retry: { timeout: 30 } })` the user's own data matched, and the fix
 *  rewrote it — a silent meaning change inside a function whose contract is
 *  "no behaviour change". Pure. */
export function callTimeoutScan(
  src: string,
  kinds: SpecKinds = specKinds(),
): { sites: number[]; fix: number[]; why: string; sure: boolean } {
  const sites: number[] = [];
  const fix: number[] = [];
  let why = "";
  let sure = false;
  const file = _read(src, kinds);
  const { bare } = file;
  const flat = codeMask(src);
  // Every call of what this file calls aio's `call` — under an alias too
  // (`import { call as c }`), with or without type arguments
  // (`call<number>(…)`): `at` the callee, `paren` its `(`.
  const calls = file.names("call").flatMap((name) =>
    [...bare.matchAll(_token(name))].map((m) => ({
      name,
      index: m.index,
      paren: _callParen(bare, m.index + name.length),
    })).filter((c) =>
      // A member named like the ALIAS is the object's own, always.
      c.paren !== -1 &&
      (name === "call" ||
        !/[.#]\s*$/.test(bare.slice(Math.max(0, c.index - 40), c.index)))
    )
  ).sort((a, b) => a.index - b.index);
  for (const m of calls) {
    const brace = /^\s*\{/.exec(bare.slice(m.paren + 1));
    if (!brace) continue;
    // Whose `call` is this one? A MEMBER is the object's own —
    // `fn.call({ timeout: 5 })` is Function.prototype.call with a `this`
    // object, `client.call({ timeout })` some other library's option,
    // `this.#call({ timeout })` the class's — unless the object is an aio
    // namespace. A `call` the file declares, or imports from another
    // package, is that function's option. Each was once reported as aio's
    // REMOVED option and rewritten to a key its callee never reads.
    const use = file.use(m.index, m.name, "call");
    if (use.who === "other") continue;
    const paren = m.paren;
    // A METHOD named `call` (`{ call({ timeout: 1 }) {…} }`, `class C { call… }`,
    // `function call(…)`, an interface member) is the same false positive by a
    // different spelling: it is preceded by `{`/`,`, not by a `.`.
    if (!use.member && _isCallDefinition(bare, m.index, paren)) continue;
    const keys = _optionKeys(src, bare, paren + brace[0].length);
    const mine = keys.filter((k) => k.name === "timeout");
    if (mine.length === 0) continue;
    sites.push(...mine.map((k) => k.at));
    const odd = mine.find((k) => k.form !== "plain");
    const reason = !fixable(use)
      ? use.why
      : flat[m.index] !== 1
      ? "the safe fix declines: this call sits in the `${…}` of a template " +
        "literal, which the fix does not edit — rename the key by hand"
      : odd
      ? `the safe fix declines: \`timeout\` is written as a ${odd.form} key ` +
        `here — write \`timeoutMs\` by hand` +
        (odd.form === "shorthand" ? " (`timeoutMs: timeout`)" : "")
      : keys.some((k) => k.name === "timeoutMs")
      ? "the safe fix declines: this call sets `timeout` and `timeoutMs` " +
        "both, and renaming one would write the key twice — keep one, by hand"
      : "";
    if (reason === "") fix.push(...mine.map((k) => k.at));
    else if (why === "") {
      why = reason;
      sure = use.who === "aio";
    }
  }
  // `call(opts, fn)` with the options built elsewhere in the file: the key
  // is the same removed one, and where it is written is for a person to
  // decide (the object may be handed to something else as well).
  for (const m of calls) {
    const built = /^\s*([\w$]+)\s*[,)]/.exec(bare.slice(m.paren + 1))?.[1];
    if (built === undefined) continue;
    const use = file.use(m.index, m.name, "call");
    const defined = !use.member &&
      _isCallDefinition(bare, m.index, m.paren);
    if (defined || use.who === "other") continue;
    const made = new RegExp(
      `\\b(?:const|let|var)\\s+${
        built.replace(/\$/g, "\\$")
      }\\s*(?::[^=;]*)?=\\s*\\{`,
    ).exec(bare);
    if (!made) continue;
    const keys = _optionKeys(src, bare, made.index + made[0].length - 1)
      .filter((k) => k.name === "timeout");
    if (keys.length === 0) continue;
    sites.push(...keys.map((k) => k.at));
    if (why === "") {
      why = fixable(use)
        ? `the safe fix declines: the options of this call are built in ` +
          `\`${built}\` (line ${file.lineOf(made.index)}) — rename the key ` +
          `there by hand`
        : use.why;
      sure = use.who === "aio";
    }
  }
  return { sites, fix, why, sure };
}

/** The `timeout` keys `--safe-fix` renames: the sites of
 *  {@linkcode callTimeoutScan} whose `call` is aio's. Pure. */
export function callTimeoutSites(
  src: string,
  kinds: SpecKinds = specKinds(),
): number[] {
  return callTimeoutScan(src, kinds).fix;
}

/** `call({ timeout: N }, fn)` → `call({ timeoutMs: N }, fn)`. Scoped to the
 *  options object of a `call(` — a `timeout:` key anywhere else, nested data
 *  included, is untouched. */
export function fixCallTimeoutMs(
  filePath: string,
  kinds: SpecKinds = specKinds(),
): () => Promise<boolean> {
  return async () => {
    try {
      const content = await Deno.readTextFile(filePath);
      const sites = callTimeoutSites(content, kinds);
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

/** Does this deno.json task run the APP (its entry module)? THE scope of every
 *  task-flag finding and of its rewrite. `--key=`, `--cert=`, `--server-url`
 *  are ordinary flag names: a `"sign": "deno run -A scripts/sign.ts
 *  --key=prod.pem"` task is some other program's command line, and it used to
 *  be reported as a renamed aio flag and REWRITTEN to `--tls-key=` by
 *  --safe-fix — breaking a script aio never runs. Pure. */
export function taskRunsApp(cmd: string, entry: string | null): boolean {
  const want = entry ? normTaskPath(entry) : "";
  // A whole TOKEN, never a substring: entry `app.ts` is inside
  // `scripts/webapp.ts`, and that program's `--key=` got rewritten.
  return want !== "" && taskTokens(cmd).some((t) => normTaskPath(t) === want);
}

/** Does this task run SOME script (`deno run … <file>.ts`)? The fallback scope
 *  for REPORTING a renamed flag when no app entry is detectable — never for
 *  the rewrite, which cannot tell the app from another program then. Pure. */
export function taskRunsScript(cmd: string): boolean {
  const t = taskTokens(cmd);
  const run = t.findIndex((x, i) => x === "deno" && t[i + 1] === "run");
  return run !== -1 &&
    t.slice(run + 2).some((x) => /^[^-].*\.(?:[mc]?[jt]s|[jt]sx)$/.test(x));
}

/** A task's command line as tokens: split on whitespace and shell operators,
 *  surrounding quotes dropped. Pure. */
function taskTokens(cmd: string): string[] {
  return cmd.split(/[\s;&|()]+/).filter(Boolean)
    .map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));
}

/** `./src/app.ts` and `src\app.ts` name the same file as `src/app.ts`. */
function normTaskPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

/** Rewrite deprecated flags inside `deno.json` tasks. `--cert=`/`--key=` became
 *  `--tls-cert=`/`--tls-key=` (the bare names collided with the auth `key`
 *  concept); `--headless` is a BUILD flag that a run task must not pass — the
 *  runtime equivalent is `--client=server-only`. `entry` scopes EVERY rewrite
 *  to tasks that actually run the app ({@link taskRunsApp}). */
export function fixTaskFlags(
  entry: string | null,
): (projectDir: string) => Promise<boolean> {
  return (projectDir: string) =>
    patchDenoJson(projectDir, (config) => {
      const tasks = config.tasks;
      if (!tasks) return;
      for (const [name, cmd] of Object.entries(tasks)) {
        if (typeof cmd !== "string" || !taskRunsApp(cmd, entry)) continue;
        let next = cmd
          .replace(/(?<![\w-])--cert=/g, "--tls-cert=")
          .replace(/(?<![\w-])--key=/g, "--tls-key=")
          // alpha76 removals (src/state/removals.ts). Two are renames; two
          // are deletions — a flag whose whole behaviour was "nothing" has
          // no successor spelling, so the surrounding space goes with it.
          .replace(/(?<![\w-])--kill-existing(?![\w=-])/g, "--takeover")
          .replace(/(?<![\w-])--server-url(?![\w=-])/g, "--connect")
          .replace(/\s*(?<![\w-])--zero-port(?![\w=-])/g, "")
          .replace(/\s*(?<![\w-])--backup-logs(?![\w=-])/g, "");
        next = next.replace(
          /(?<![\w-])--headless(?![\w=-])/g,
          "--client=server-only",
        );
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
/** The destructured names of `const { … } = await import("aio")` that
 *  `aio/server` does NOT export — the names a whole-statement repoint to
 *  `"aio/server"` would turn into `undefined`. Empty = the rewrite is safe.
 *  `aio/server` carries only the server-only set, so `{ aio, createDB }` used
 *  to be repointed wholesale and `aio` came back undefined — the "safe" fix
 *  broke the line it fixed. ONE decider for the rule's [manual] and the fix's
 *  decline. Pure. */
export function dynamicDestructureNonServer(inner: string): string[] {
  return inner.split(",").map((n) => n.trim()).filter(Boolean)
    .map((n) => n.replace(/^\.\.\./, "").split(/[:=]/)[0]!.trim())
    .filter((n) => !SERVER_ONLY_AIO_SYMBOLS.has(n));
}

export function fixDynamicServerEntryImport(
  filePath: string,
): () => Promise<boolean> {
  const SERVER_ONLY = SERVER_ONLY_RE;
  return async () => {
    try {
      const src = await Deno.readTextFile(filePath);
      // Code only — the rule reports code sites only, and a generator's
      // template literal spelling the same statement is not this file's import.
      const mask = codeMask(src);
      let changed = false;
      let out = src.replace(
        // `[^{}]`, not `[^}]`: the match must START at the destructure's own
        // `{`. `[^}]*` let it start at an enclosing function body's `{`, so
        // the "names" were a whole code span ("const { createDB").
        /\{([^{}]*)\}\s*=\s*await\s+import\(\s*(["'])aio\2\s*\)/g,
        (whole, inner: string, _q: string, at: number) => {
          if (mask[at] !== 1 || !SERVER_ONLY.test(inner)) return whole;
          if (dynamicDestructureNonServer(inner).length > 0) return whole;
          changed = true;
          return whole.replace(/(["'])aio\1/, "$1aio/server$1");
        },
      );
      out = out.replace(
        /\(\s*await\s+import\(\s*(["'])aio\1\s*\)\s*\)\s*\.\s*(\w+)/g,
        (whole, _q: string, prop: string, at: number) => {
          if (mask[at] !== 1 || !SERVER_ONLY.test(prop)) return whole;
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
      const out = rewriteImportLists(src, (st, names) => {
        if (st.spec !== "aio" || st.typeOnly) return null;
        const isServer = (n: string) => SERVER_ONLY.has(bareName(n));
        const server = names.filter(isServer);
        if (server.length === 0) return null;
        if (server.length === names.length) return { spec: "aio/server" };
        return {
          entries: names.map((n) => isServer(n) ? null : n),
          after: { names: server, spec: "aio/server" },
        };
      });
      if (out === null) return false;
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
const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
]);

/** Does the `{` at `open` (in MASKED source) open a FUNCTION body — an arrow
 *  (`=> {`), a `function (…) {`, a nested method shorthand `name(…) {`, or one
 *  of those with a return-type annotation — rather than a control block or an
 *  object literal? Conservative in the direction that matters: a false "yes"
 *  only makes the fix decline. Pure. */
function opensFunctionBody(masked: string, open: number): boolean {
  let j = open - 1;
  while (j >= 0 && /\s/.test(masked[j]!)) j--;
  if (masked[j] === ">" && masked[j - 1] === "=") return true; // `=> {`
  // `(…): T {` — an annotated function/method. Look back a bounded window for
  // a `)` followed by `:` and a type with no statement punctuation in it.
  if (/\)\s*:\s*[^;{}=]*$/.test(masked.slice(Math.max(0, open - 200), open))) {
    return true;
  }
  if (masked[j] !== ")") return false;
  // Find the matching `(` and read the word before it.
  let depth = 0;
  let k = j;
  for (; k >= 0; k--) {
    const ch = masked[k]!;
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (k < 0) return false;
  const word = /([$\w]+)\s*$/.exec(masked.slice(Math.max(0, k - 40), k))?.[1];
  return !(word && CONTROL_KEYWORDS.has(word));
}

/** Is offset `at` inside a function nested in the method body that opens at
 *  `bodyOpen`? Walks the braces enclosing `at` from the inside out. Pure. */
function insideNestedFunction(
  masked: string,
  bodyOpen: number,
  at: number,
): boolean {
  const stack: number[] = [];
  for (let i = bodyOpen + 1; i < at; i++) {
    const ch = masked[i];
    if (ch === "{") stack.push(i);
    else if (ch === "}") stack.pop();
  }
  return stack.some((o) => opensFunctionBody(masked, o));
}

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
  const masked = codeText(src);
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
    if (insideNestedFunction(masked, method.bodyOpen, start)) {
      verdicts.push({
        start,
        end: end + 1,
        reason: "the safe fix declines: this `return` belongs to a function " +
          "nested inside the method (a callback or a helper) — its value goes " +
          "to that function's caller, not to the cell, so rewriting it to " +
          "`s.$do(...)` would change what the code does",
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
export function returnEffectDecline(
  src: string,
  at: number,
  kinds: SpecKinds = specKinds(),
): string | null {
  const notAios = _effectsDecline(src, kinds);
  if (notAios) return notAios;
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

export function fixReturnEffectsToDo(
  filePath: string,
  kinds: SpecKinds = specKinds(),
): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    if (_effectsDecline(src, kinds)) return false;
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
  return addToFirstImport(src, "aio", "type MethodDraftServed");
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
    // An aliased member (`X as Y`) is left alone; so is every statement that
    // does not import `name` (rewriteImportLists leaves those byte-for-byte).
    const orphan = (raw: string) =>
      !/\bas\b/.test(raw) && raw.replace(/^type\s+/, "").trim() === name;
    out = rewriteImportLists(out, (st, names) =>
      st.spec === "aio" && names.some(orphan)
        ? {
          entries: names.map((n) =>
            orphan(n) ? null : n
          ),
        }
        : null) ?? out;
  }
  return out;
}

/** Offsets of every `backoff` key that is a TOP-LEVEL option of a
 *  `schedule.poll(id, attempt, action, opts)` call's opts object — the FOURTH
 *  argument, located by `argumentSpan`. THE decider for the deprecated-key
 *  rule and its fix alike.
 *
 *  Scoping used to be "a flat `{…}` holding `every:` and `backoff:`", picked by
 *  regex. An ACTION PAYLOAD carrying both fields matched it, so the rule
 *  reported code that is not the option and `--safe-fix` renamed the payload's
 *  own field — a silent behaviour change from a "no behaviour change" fix.
 *
 *  One entry per `schedule.poll(` call: `at` is its `schedule` token — whose
 *  it is decides what happens to its `keys`. Pure. */
export function pollBackoffCalls(
  src: string,
  kinds: SpecKinds = specKinds(),
): { at: number; keys: number[]; use: Use }[] {
  const calls: { at: number; keys: number[]; use: Use }[] = [];
  const file = _read(src, kinds);
  const { bare } = file;
  const flat = codeMask(src);
  // A use the fix cannot read: reported for aio's `schedule`, left as it is.
  const left = (use: Use, why: string): Use =>
    fixable(use)
      ? { ...use, who: "shadowed", why: `the safe fix declines: ${why}` }
      : use;
  // Under every name the file has for aio's `schedule` (`import { schedule
  // as sch }`); a member named like an ALIAS is the object's own.
  const polls = file.names("schedule").flatMap((name) =>
    [
      ...bare.matchAll(
        new RegExp(
          `(?<![\\w$${name === "schedule" ? "" : ".#"}])${
            name.replace(/\$/g, "\\$")
          }\\s*\\.\\s*poll(?![\\w$])`,
          "g",
        ),
      ),
    ].map((m) => ({
      name,
      index: m.index,
      open: _callParen(bare, m.index + m[0].length),
    })).filter((c) => c.open !== -1)
  ).sort((a, b) => a.index - b.index);
  for (const m of polls) {
    const out: number[] = [];
    const odd: number[] = [];
    const open = m.open;
    const use = file.use(m.index, m.name, "schedule");
    if (flat[m.index] !== 1) {
      // In a template's `${…}` the arguments cannot be told apart here.
      const close = balancedEnd(bare, open, bare);
      if (
        /(?<![\w$.])backoff\s*:/.test(bare.slice(open, Math.max(open, close)))
      ) {
        calls.push({
          at: m.index,
          keys: [m.index],
          use: left(
            use,
            "this call sits in the `${…}` of a template literal, which the " +
              "fix does not edit — rename the key by hand",
          ),
        });
      }
      continue;
    }
    // The opts literal is argument 2 or 3 (0-based) — the arg-order migration
    // moved it from THIRD to FOURTH — and it is an object literal, never a call
    // that merely contains one. The ACTION is the object carrying a top-level
    // `type:` key, so an action payload is never taken for the opts.
    //
    // Argument 2 is the ACTION today, and "no `type:` key" does not make it the
    // opts: `{ type, backoff: 2 }` (shorthand), `{ ...tick, backoff: 2 }` and
    // `{ ["type"]: "T", backoff: 2 }` have none, and each had its own payload
    // field renamed. There it is the opts only when it says so itself — a
    // top-level `every:`, the one key the old order's opts always carried.
    for (const index of [2, 3]) {
      const span = argumentSpan(src, open, index);
      if (!span) continue;
      const text = src.slice(span[0], span[1]);
      const brace = span[0] + (text.length - text.trimStart().length);
      // The opts built elsewhere in the file (`const o = { every, backoff }`):
      // the same key, and where it is written is for a person to decide.
      const made = /^[\w$]+$/.test(text.trim())
        ? new RegExp(
          `\\b(?:const|let|var)\\s+${
            text.trim().replace(/\$/g, "\\$")
          }\\s*(?::[^=;]*)?=\\s*\\{`,
        ).exec(bare)
        : null;
      if (made) {
        const keys = _optionKeys(src, bare, made.index + made[0].length - 1);
        const mine = keys.filter((k) => k.name === "backoff");
        if (mine.length && keys.some((k) => k.name === "every")) {
          calls.push({
            at: m.index,
            keys: mine.map((k) => k.at),
            use: left(
              use,
              `the options of this call are built in \`${text.trim()}\` ` +
                `(line ${file.lineOf(made.index)}) — rename the key there ` +
                `by hand`,
            ),
          });
        }
        continue;
      }
      if (src[brace] !== "{") continue;
      if (
        ["type", '"type"', "'type'"].some((k) =>
          topLevelKeyOffsets(src, brace, k).length > 0
        )
      ) {
        continue; // the action, not the options
      }
      if (index === 2 && topLevelKeyOffsets(src, brace, "every").length === 0) {
        continue; // an action spelled without a literal `type:` key
      }
      out.push(...topLevelKeyOffsets(src, brace, "backoff"));
      odd.push(
        ..._optionKeys(src, bare, brace).filter((k) =>
          k.name === "backoff" && k.form !== "plain"
        ).map((k) => k.at),
      );
    }
    if (odd.length) {
      calls.push({
        at: m.index,
        keys: odd,
        use: left(
          use,
          "`backoff` is written as a shorthand, quoted or computed key " +
            "here — write `factor` by hand",
        ),
      });
    } else if (out.length) calls.push({ at: m.index, keys: out, use });
  }
  return calls;
}

/** `schedule.poll(... { backoff: n ... })` → `factor: n` (alpha52 key rename;
 *  the old key keeps working with a hint). Scoped to the OPTS object of a
 *  `schedule.poll(` call — its fourth argument, never an action payload. */
export function fixPollBackoffKey(
  filePath: string,
  kinds: SpecKinds = specKinds(),
): () => Promise<boolean> {
  return async () => {
    try {
      const src = await Deno.readTextFile(filePath);
      const sites = pollBackoffCalls(src, kinds)
        .filter((c) => fixable(c.use)).flatMap((c) => c.keys);
      if (sites.length === 0) return false;
      let out = src;
      // Right to left, so earlier offsets stay valid.
      for (const at of [...sites].sort((a, b) => b - a)) {
        out = out.slice(0, at) + "factor" + out.slice(at + "backoff".length);
      }
      if (out === src) return false;
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
      // CODE matches only — a doc string or comment spelling the same shape is
      // not a selector object.
      const out = replaceCode(src, re, (m) => {
        const whole = m[0],
          pre = m[1]!,
          depsBody = m[2]!,
          params = m[3]!,
          arrow = m[4]!;
        const depCount = depsBody.split(",").map((s) => s.trim())
          .filter(Boolean).length;
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
      });
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
export function fixUiKeyToVisible(
  filePath: string,
  kinds: SpecKinds = specKinds(),
): () => Promise<boolean> {
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
    const own = whose(src, kinds);
    // Absolute offsets of every top-level `ui` key to rename.
    const renames: number[] = [];
    const re =
      /\bcell\s*\(\s*["'`][\w\-]+["'`]\s*,\s*\{|\bcellDefaults\s*:\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // A `cell(` mentioned in a comment/string is blanked in the mask.
      if (!/[$\w]/.test(masked[m.index] ?? "")) continue;
      // A `cell(` that is not aio's has its own `ui` key.
      if (
        !m[0].startsWith("cellDefaults") &&
        cellUse(own(m.index, "cell")) !== ""
      ) continue;
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

/** Rename a TOP-LEVEL key inside `aio.run({ … })` — `killExisting` →
 *  `takeover` (alpha76).
 *
 *  Structure is read off the MASKED source (`codeText`), so `aio.run(` inside
 *  a comment or a template literal is not an anchor and a key spelled in a
 *  string is not a key; the offsets are applied to the RAW text, which is
 *  identical there because identifiers are code either way. Declines a block
 *  that already sets the NEW key — two spellings of one decision is what the
 *  rename exists to end, and picking a winner is the author's call.
 *
 *  Same shape as {@link fixUiKeyToVisible}; the anchor and the depth are what
 *  differ (`aio.run({` opens at depth 1, and only that level is a config key). */
export function fixRenameRunKey(
  filePath: string,
  from: string,
  to: string,
): () => Promise<boolean> {
  const topLevelKeyOffsets = (masked: string): number[] => {
    const offsets: number[] = [];
    let depth = 0;
    let hasNew = false;
    for (let i = 0; i < masked.length; i++) {
      const ch = masked[i]!;
      if ("({[".includes(ch)) depth++;
      else if (")}]".includes(ch)) depth--;
      else if (depth === 1 && /[$\w]/.test(ch)) {
        if (/[$\w.]/.test(masked[i - 1] ?? "")) continue;
        const m = /^([$\w]+)\s*:/.exec(masked.slice(i));
        if (m) {
          if (m[1] === to) hasNew = true;
          if (m[1] === from) offsets.push(i);
        }
        while (i + 1 < masked.length && /[$\w]/.test(masked[i + 1]!)) i++;
      }
    }
    return hasNew ? [] : offsets;
  };
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const masked = codeText(src);
    const renames: number[] = [];
    const re = /\baio\s*\.\s*run\s*\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (!/[$\w]/.test(masked[m.index] ?? "")) continue; // comment/string
      const open = m.index + m[0].length - 1;
      const end = balancedEnd(src, open, masked);
      if (end === -1) continue;
      for (const off of topLevelKeyOffsets(masked.slice(open, end + 1))) {
        renames.push(open + off);
      }
      re.lastIndex = end + 1;
    }
    if (renames.length === 0) return false;
    let out = "";
    let cursor = 0;
    for (const at of renames.sort((a, b) => a - b)) {
      out += src.slice(cursor, at) + to;
      cursor = at + from.length;
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
    const out = rewriteImportLists(src, (st, names) => {
      if (st.spec !== "aio/schedule" && st.spec !== "aio/selectors") {
        return null;
      }
      const isExtra = (n: string) => DEAD_ENTRY_EXTRAS.has(bareName(n));
      const extras = names.filter(isExtra);
      if (extras.length === 0) return { spec: "aio" };
      if (extras.length === names.length) return { spec: "aio/extras" };
      return {
        entries: names.map((n) => isExtra(n) ? null : n),
        spec: "aio",
        after: { names: extras, spec: "aio/extras" },
      };
    });
    if (out === null) return false;
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
    // A TOP-LEVEL `key:` only — the rule's own question (`_topLevelKeys`).
    // Any `key:` in the body used to decline, so `tls: { cert, key: "k.pem" }`
    // (the documented TLS option) made the fix refuse forever while the rule
    // kept reporting it `[fixable]`. Mask-aware, so a `key:` in a comment or a
    // string is nothing.
    if (topLevelKeyOffsets(src, open, "key").length > 0) return false;
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

/** Every `useCell(` this file CALLS — THE decider for the rule; the fix reads
 *  code the same way. A string, a comment and JSX text are the program's own
 *  words; a template's `${…}` is code ({@linkcode codeMaskDeep}); a
 *  DECLARATION (`function useCell(`) is not a use — and a file whose
 *  `useCell` is its own (declared here, or imported from another module) has
 *  none ({@linkcode whose}). A call under another local name (`import {
 *  useCell as use }`) or with type arguments (`useCell<T>(c)`) is a call:
 *  each match is the callee's name as the file writes it. Pure. */
export function useCellCalls(
  path: string,
  src: string,
  kinds: SpecKinds = specKinds(),
): RegExpMatchArray[] {
  const mask = codeMaskDeep(src);
  const file = _read(src, kinds);
  return file.names("useCell").flatMap((name) => [
    ...src.matchAll(
      new RegExp(
        `(?<!function\\s)(?<![\\w$${name === "useCell" ? "" : ".#"}])${
          name.replace(/\$/g, "\\$")
        }(?![\\w$])`,
        "g",
      ),
    ),
  ]).filter((m) =>
    mask[m.index] === 1 &&
    _callParen(file.bare, m.index + m[0].length) !== -1 &&
    !matchInJsxText(path, src, m) &&
    file.use(m.index, m[0], "useCell").who !== "other"
  ).sort((a, b) => a.index - b.index);
}

const isUseCell = (n: string) => /^(type\s+)?useCell$/.test(n);

/** `src` without its `useCell` import binding (other bindings kept); null
 *  when there is none to drop. */
function withoutUseCellImport(src: string): string | null {
  return rewriteImportLists(
    src,
    (_st, names) =>
      names.some(isUseCell)
        ? { entries: names.map((n) => isUseCell(n) ? null : n) }
        : null,
  );
}

/** Where this file imports `useCell` from aio — a name aio no longer exports
 *  — and whether the fix will remove that import: only when nothing else in
 *  the file names it ({@linkcode stillNamed}). Null when it is not imported.
 *  Pure. */
export function useCellImport(
  src: string,
  kinds: SpecKinds = specKinds(),
): { at: number; fixable: boolean } | null {
  const st = moduleStatements(src).find((st) =>
    st.kind === "import" && kinds(st.spec, "useCell") === "aio" &&
    (st.list?.entries.some((e) => isUseCell(e.text)) ?? false)
  );
  if (!st) return null;
  const rest = withoutUseCellImport(src);
  return {
    at: st.start,
    fixable: rest !== null && !stillNamed(rest, "useCell"),
  };
}

/** `useCell(cellRef).state.x` → `cellRef.x` — the mechanical form only
 *  (alpha52: useCell REMOVED). Its import binding is dropped too (other
 *  bindings kept) once the file no longer names `useCell` at all. */
export function fixUseCellStateReads(
  filePath: string,
  kinds: SpecKinds = specKinds(),
): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    // CODE matches only: the same spelling inside a string or comment is a
    // program's own text (a migration hint, a doc string), not a call.
    // …and so is the spelling in JSX text (`<code>useCell(c).state.x</code>`).
    // And aio's `useCell` only ({@linkcode Owner}): one the file declares, or
    // a method of its own object (`p.useCell(c)`), is not this fix's. Through
    // an aio namespace the prefix goes with the call, however it is joined:
    // `aio.useCell(c).state.x`, `aio!.useCell(…)`, `aio?.useCell(…)` are `c.x`.
    const own = whose(src, kinds);
    const rewritten = replaceCode(
      src,
      /(?:[$\w]+\s*!?\s*(?:\?\.|\.)\s*)?\buseCell\s*\(\s*([$\w]+)\s*\)\s*\.\s*state\s*\.(?=[$\w])/g,
      (m) => {
        const at = m.index! + m[0].indexOf("useCell");
        const one = { ...m, index: at } as RegExpMatchArray;
        return matchInJsxText(filePath, src, one) ||
            !fixable(own(at, "useCell"))
          ? m[0]
          : `${m[1]}.`;
      },
      codeMaskDeep(src),
    );
    // The import binding goes only when NOTHING still names it: a call this
    // fix has no rewrite for (`useCell<T>(c)`, `useCell(c)` kept whole), the
    // function passed as a value — or a use this fix did not recognise as
    // one. Asked of the file WITHOUT the binding, so the question cannot be
    // answered by the import itself.
    const dropped = withoutUseCellImport(rewritten);
    const out = dropped !== null && !stillNamed(dropped, "useCell")
      ? dropped
      : rewritten;
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
  const r = moveImportsIn(src, mv);
  return r.matched ? r.out : null;
}

/** {@linkcode moveImports} with the two facts kept apart: `matched` (the
 *  file needs the move — the RULE's question) and `declined` (a static
 *  import matched but its rewrite did not read back — so the fix must not
 *  claim it). Folding them made a declined rewrite either silence or a
 *  "fixed" that changed nothing. */
function moveImportsIn(
  src: string,
  mv: MovedImports,
): { out: string; matched: boolean; declined: boolean } {
  const spec = mv.from.replace(/[/.]/g, "\\$&");
  let matched = false;
  const moved = rewriteImportLists(src, (st, names) => {
    if (st.spec !== mv.from || (st.typeOnly && mv.valuesOnly)) return null;
    const moves = (n: string) =>
      mv.names.has(bareName(n)) && !(mv.valuesOnly && /^type\s/.test(n));
    const moving = names.filter(moves);
    if (moving.length === 0) return null;
    matched = true;
    // Everything moves: only the specifier changes; layout and comments stay.
    if (moving.length === names.length) return { spec: mv.to };
    return {
      entries: names.map((n) => moves(n) ? null : n),
      after: { names: moving, spec: mv.to },
    };
  });
  const declined = matched && moved === null;
  // The dynamic form: `const { a, b } = await import("aio")` — rewritten only
  // when EVERY destructured name moves (a split would need two awaits, which
  // is the reader's decision, not a rewriter's). A field report hit exactly
  // one of these after 20 static sites were rewritten cleanly.
  const dyn = new RegExp(
    `(\\{([^}]*)\\}\\s*=\\s*await\\s+import\\(\\s*)["']${spec}["'](\\s*\\))`,
    "g",
  );
  // CODE matches only: a dynamic import inside a string or template (a doc
  // string, a code sample) is not a statement to rewrite.
  const out = replaceCode(moved ?? src, dyn, (m) => {
    const whole = m[0], head = m[1]!, inner = m[2]!, tail = m[3]!;
    const names = inner.split(",").map((s) => s.trim()).filter(Boolean);
    if (
      names.length === 0 || !names.every((n) => mv.names.has(bareName(n)))
    ) {
      return whole;
    }
    matched = true;
    return `${head}"${mv.to}"${tail}`;
  });
  return { out, matched, declined };
}

/** `--safe-fix` half of {@linkcode moveImports}. A rewrite that declined is
 *  NOT fixed: nothing is written and the finding stays for a human. */
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
    const r = moveImportsIn(src, mv);
    if (!r.matched || r.declined) return false;
    await Deno.writeTextFile(filePath, r.out);
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
  return rewriteImportLists(src, (st, names) =>
    st.spec !== spec ? null : {
      entries: names.map((n) => {
        const m = /^(type\s+)?([$\w]+)(\s+as\s+([$\w]+))?$/.exec(n);
        if (!m || m[2] !== oldName) return n;
        return `${m[1] ?? ""}${newName} as ${m[4] ?? oldName}`;
      }),
    });
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
  kinds?: SpecKinds,
): string | null {
  let out = src;
  let changed = false;
  for (const [from, to] of renames) {
    const re = new RegExp(`\\b${from}\\b`, "g");
    // With `kinds`: only an occurrence that is aio's ({@linkcode wordUses}) —
    // an app's own `ExtractState`, or `x.connectDevTools()`, keeps its name.
    const mine = kinds &&
      new Set(
        wordUses(out, from, to, kinds).filter((u) => fixable(u.use))
          .map((u) => u.at),
      );
    // The mask is of the text THIS pass scans. `replace` hands the callback
    // offsets into its INPUT, never into the string being built, so no shift
    // applies within a pass — subtracting one read the mask at the wrong place
    // once the import had been lengthened, judged the call under a comment
    // "inside the comment", and renamed the import while orphaning the call.
    // Across passes the input DOES change (an earlier rename moved every later
    // offset), so the mask is recomputed per pass; a word-for-word identifier
    // rename never changes what is code.
    const mask = codeMask(out);
    out = out.replace(re, (whole, at: number) => {
      // The decider reads a template's `${…}` as code; the mask alone, as
      // text.
      if (mine ? !mine.has(at) : mask[at] !== 1) return whole;
      changed = true;
      return to;
    });
  }
  if (!changed) return null;
  return dedupeRenamedBindings(
    out,
    new Set(renames.map(([, to]) => to)),
    kinds,
  ) ?? out;
}

/** A rename can bind one name twice — `{ Access, type CellAccess }` becomes
 *  `{ Access, type Access }`, or two `aio` statements both import `Access` —
 *  and a duplicate import binding is a compile error, so the fix broke the
 *  file it fixed. Keep ONE binding per renamed-to name across the `aio…`
 *  imports (a VALUE binding when there is one: it also serves every type
 *  position) and drop the rest. Only names the rename produced are
 *  considered; every other statement is left as written. Null when nothing
 *  is duplicated. Pure. */
function dedupeRenamedBindings(
  src: string,
  targets: ReadonlySet<string>,
  kinds?: SpecKinds,
): string | null {
  const isAio = (spec: string, name: string) =>
    kinds ? kinds(spec, name) === "aio" : /^aio(?:\/[\w-]+)?$/.test(spec);
  type Ref = { at: number; i: number; value: boolean };
  const refs = new Map<string, Ref[]>();
  for (const st of moduleStatements(src)) {
    if (st.kind !== "import" || !st.list) continue;
    st.list.entries.filter((e) => e.text).forEach((e, i) => {
      const name = localName(e.text);
      if (!targets.has(name) || !isAio(st.spec, name)) return;
      const value = !st.typeOnly && !/^type\s/.test(e.text);
      refs.set(name, [...(refs.get(name) ?? []), { at: st.start, i, value }]);
    });
  }
  const drop = new Set<string>(); // `${statement start}:${entry index}`
  for (const list of refs.values()) {
    if (list.length < 2) continue;
    const keep = list.find((r) => r.value) ?? list[0]!;
    for (const r of list) if (r !== keep) drop.add(`${r.at}:${r.i}`);
  }
  if (drop.size === 0) return null;
  return rewriteImportLists(
    src,
    (st, names) =>
      names.some((_, i) => drop.has(`${st.start}:${i}`))
        ? {
          entries: names.map((n, i) => drop.has(`${st.start}:${i}`) ? null : n),
        }
        : null,
  );
}

/** `--safe-fix` half of {@linkcode renameWords}. */
export function fixRenameWords(
  filePath: string,
  renames: ReadonlyArray<readonly [string, string]>,
  kinds: SpecKinds = specKinds(),
): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const out = renameWords(src, renames, kinds);
    if (out === null) return false;
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}

/** Every `schedule.blocking(` this file calls, and whose it is — THE decider
 *  for the rule and its fix. Beyond {@linkcode whose} of its `schedule`, a
 *  use is rewritten only when the `blocking` the fix writes is aio's too:
 *  the module `schedule` came from hands out `blocking` as well, and
 *  `blocking` means nothing else in this file. Pure. */
export function blockingUses(
  src: string,
  kinds: SpecKinds = specKinds(),
): { at: number; len: number; use: Use }[] {
  const file = _read(src, kinds);
  const written = file.written("blocking");
  const taken = written.length > 0 && file.use(-1, "blocking").who !== "aio";
  // Under every name the file has for aio's `schedule`, with or without
  // type arguments; a member named like an ALIAS is the object's own.
  return file.names("schedule").flatMap((name) =>
    [
      ...file.bare.matchAll(
        new RegExp(
          `(?<![\\w$${name === "schedule" ? "" : ".#"}])${
            name.replace(/\$/g, "\\$")
          }\\s*\\.\\s*blocking(?![\\w$])`,
          "g",
        ),
      ),
    ].map((m) => ({
      name,
      index: m.index,
      len: m[0].length,
      paren: _callParen(file.bare, m.index + m[0].length),
    })).filter((m) => m.paren !== -1)
  ).sort((a, b) => a.index - b.index)
    .map((m) => {
      const use = file.use(m.index, m.name, "schedule");
      const why = !fixable(use)
        ? ""
        : kinds(use.spec!, "blocking", true) !== "aio"
        ? `"${use.spec}" hands out \`schedule\`, but as far as aiol can ` +
          `tell not \`blocking\` (it is in aio's main entry) — import it ` +
          `and make the change by hand`
        : !use.member && taken
        ? `\`blocking\` already means something else in this file (line ` +
          `${file.lineOf(written[0]!)}) — import aio's under another name ` +
          `(\`import { blocking as runBlocking }\`) and call that, by hand`
        : file.bare.slice(m.index + m.len, m.paren).trim() !== ""
        ? "this call passes type arguments, and `blocking` takes one " +
          "(`blocking<T>`) — make the change by hand"
        : "";
      return {
        at: m.index,
        len: m.len,
        use: why
          ? {
            ...use,
            who: "shadowed" as const,
            why: `the safe fix declines: ${why}`,
          }
          : use,
      };
    });
}

/** The uses of aio's `call` and `schedule` that the rules about them do not
 *  read — one per name, the first: `call` anywhere but as the callee of a
 *  call (`call.apply(…)`, `(0, call)(…)`, handed on as a value), `schedule`
 *  anywhere but before `.member` (`schedule?.blocking`, `schedule["poll"]`,
 *  `const { blocking } = schedule`, handed on), and `schedule.blocking` /
 *  `schedule.poll` that is not called on the spot (`.bind(…)`). Only where
 *  the file imports the name from aio: such a use may reach the removed
 *  `timeout` option, `schedule.blocking` or `backoff`, and nothing else
 *  says so. Pure. */
export function unreadUses(
  src: string,
  kinds: SpecKinds = specKinds(),
): { at: number; name: string; exported: "call" | "schedule" }[] {
  const file = _read(src, kinds);
  const { bare } = file;
  const out: { at: number; name: string; exported: "call" | "schedule" }[] = [];
  for (const exported of ["call", "schedule"] as const) {
    // A file the rules already report for this name is loud about it: there
    // a mention nothing reads (a parameter of the same name, say) is the
    // reason those findings give, not a second finding.
    const loud = exported === "call"
      ? callTimeoutScan(src, kinds).sites.length > 0
      : blockingUses(src, kinds).length + pollBackoffCalls(src, kinds).length >
        0;
    for (const name of file.names(exported)) {
      const who = file.use(-1, name, exported).who;
      if (who !== "aio" && who !== "shadowed") continue;
      for (const m of bare.matchAll(_token(name))) {
        const at = m.index;
        const end = at + name.length;
        // An import or export list hands the binding on by name: whoever
        // takes it from there is read in its own file.
        if (
          file.statements.some((st) => st.start <= at && at < st.end) ||
          /\bexport\s*(?:type\s*)?\{[^{}]*$/.test(bare.slice(0, at))
        ) continue;
        const role = _tokenRole(bare, at, name);
        // Another object's member; or a place that is no use at all (a
        // declaration, a key) — the rules about this name say so already.
        if (role === "member" || file.use(at, name, exported).who === "other") {
          continue;
        }
        const member = /^\s*\.\s*([\w$]+)/.exec(bare.slice(end));
        const read = exported === "call"
          ? _callParen(bare, end) !== -1
          : member !== null &&
            (!/^(?:blocking|poll)$/.test(member[1]!) ||
              _callParen(bare, end + member[0].length) !== -1);
        if (read || (role === "unknown" && loud)) continue;
        out.push({ at, name, exported });
        break;
      }
    }
  }
  return out;
}

/** `schedule.blocking(` → `blocking(` where {@linkcode blockingUses} says it
 *  is aio's, and `blocking` imported from the SAME module the file's
 *  `schedule` came from (added to that import, or a new import line of that
 *  specifier). Through a namespace (`ns.schedule.blocking(` → `ns.blocking(`)
 *  there is nothing to import. `schedule` itself is left imported — removing
 *  it needs a usage count, and an unused import is harmless where a missing
 *  one is not. Null on no-op. */
export function scheduleBlockingToTop(
  src: string,
  kinds: SpecKinds = specKinds(),
): string | null {
  const uses = blockingUses(src, kinds).filter((u) => fixable(u.use));
  if (uses.length === 0) return null;
  let out = src;
  // Right to left, so earlier offsets stay valid.
  for (const u of [...uses].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, u.at) + "blocking" + out.slice(u.at + u.len);
  }
  const from = uses.find((u) => !u.use.member)?.use.spec;
  if (from === undefined) return out;
  // Imported under its OWN name? `blocking as b` binds `b`, not `blocking` —
  // counting it as present left every rewritten `blocking(` unresolved.
  const bound = moduleStatements(out).some((st) =>
    st.kind === "import" && kinds(st.spec, "blocking", true) === "aio" &&
    !st.typeOnly &&
    (st.list?.entries ?? []).some((e) =>
      /^(?:blocking|blocking as blocking)$/.test(e.text)
    )
  );
  if (!bound) out = addToFirstImport(out, from, "blocking");
  return out;
}

/** `--safe-fix` half of {@linkcode scheduleBlockingToTop}. */
export function fixScheduleBlocking(
  filePath: string,
  kinds: SpecKinds = specKinds(),
): () => Promise<boolean> {
  return async () => {
    let src: string;
    try {
      src = await Deno.readTextFile(filePath);
    } catch {
      return false;
    }
    const out = scheduleBlockingToTop(src, kinds);
    if (out === null) return false;
    await Deno.writeTextFile(filePath, out);
    return true;
  };
}
