// server-only-specs.ts — THE list of aio's own entries that cannot run in a
// browser, and the reason each one is on it.
//
// Three files carried their own copy of this set: graph-validator.ts
// (`SERVER_ONLY_SPECS`), lint.ts and server-html-classify.ts. Each copy had a
// comment naming the other two, which is the repo admitting a fact was spelled
// three times rather than fixing it. They agreed on `aio/server` and on
// nothing else, because nothing else was ever there.
//
// What that cost: `aio/db` is the entry the docs tell every app to use for
// SQLite (`import { createDB } from "aio/db"`), it is absent from the browser
// import map on purpose, and it was on none of the three lists. So a component
// importing it fell through to the generic advice — "add `npm:aio/db` to
// deno.json" — which is the exact advice the comment beside each list calls
// actively harmful: that package does not exist, so the user edits deno.json,
// restarts, and lands on the same blank page. `aio/build`, `aio/ship` and
// `aio/testing` had the same gap.
//
// Membership means one thing: importing this from a browser-reachable file is
// a CATEGORY error the framework can name exactly, not a missing dependency.
// The documented dynamic escape hatch (`await import("aio/server")` inside a
// cell method) is unaffected — only a STATIC import from an eagerly-reachable
// file is reported.
//
// Deliberately NOT here: `aio/extras` and `aio/sync`. Both entries pull server
// code (`parseCli`/`instances`, `server-handler.ts`), so importing either from
// a page is a mistake, and dev and the bundle both refuse a static import of
// either (isBrowserEntry) — just not with the SERVER-entry wording.
// `tests/entry-classification.test.ts` holds them as a named, deliberate
// middle.

import { justifiedFor } from "../diagnostics/ok-marker.ts";
import { codeMask } from "../diagnostics/code-mask.ts";

/** aio's own entries that cannot resolve — or cannot run — in a browser. */
export const SERVER_ONLY_SPECS: ReadonlySet<string> = new Set([
  "aio/server", // SQLite, workers, the filesystem
  "aio/db", // createDB — the SQLite worker
  "aio/build", // esbuild, deno compile
  "aio/ship", // release signing, the filesystem
  "aio/cli", // Deno.stdin/stdout, a terminal — never a page
  "aio/testing", // the test harness, which boots servers
  // The MARKER a module imports to declare itself server-only. Listed here so
  // a page that reaches it is told the category — "aio/server-only is
  // server-only" is a tautology that reads as a joke, and it is still the
  // right answer: the module's whole purpose is to be unreachable from a
  // browser, and the build refuses the bundle before this ever runs.
  "aio/server-only",
  // CLI entrypoints. Meant for `deno run`, not for an import at all — but a
  // browser cannot run any of them, and "this is a server entry" is the right
  // thing to say to whoever tries. Cheaper than a third category that would
  // differ from this one only in prose.
  "aio/build-all",
  "aio/dev-android",
  "aio/android-install",
  "aio/electron-install",
  "aio/am",
  "aio/amui",
  "aio/doctor",
  "aio/aiol",
]);

/** aio's own browser-reachable entry files, by the tail of their path. The
 *  bundler names the RESOLVED file, not the specifier the author wrote. */
const ENTRY_FOR_FILE: ReadonlyArray<[string, string]> = [
  ["src/server-entry.ts", "aio/server"],
  ["src/db/mod.ts", "aio/db"],
  ["src/cell-test.ts", "aio/testing"],
  ["src/cli.ts", "aio/cli"],
  ["src/build.ts", "aio/build"],
  ["src/build/ship.ts", "aio/ship"],
];

/**
 * The bundler's "no matching export" error, said in aio's words.
 *
 * A component that does `import { route } from "aio/server"` — the single most
 * likely mistake a new author makes, because the API they want IS on that
 * entry — got esbuild's own sentence:
 *
 *     No matching export in "../../../../../../home/x/.aio/versions/v1.0.0-
 *     alpha72/src/server-entry.ts" for import "route"
 *
 * which names the rule nowhere, the fix nowhere, and a path with seven `../`
 * in it. The browser build maps `aio/server` to a browser-safe SUBSET, so the
 * import resolves and only the NAME is missing — which is why the server-only
 * specifier check never sees it and why the message that reaches the author is
 * the bundler's.
 *
 * Returns null for any error this does not recognise, so an unrelated failure
 * keeps its own words.
 */
export function explainServerOnlyImport(
  text: string,
  file?: string,
  line?: number,
): string | null {
  const m = /No matching export in "([^"]+)" for import "([^"]+)"/.exec(text);
  if (!m) return null;
  const resolved = m[1]!.replaceAll("\\", "/");
  const name = m[2]!;
  const hit = ENTRY_FOR_FILE.find(([tail]) => resolved.endsWith(tail));
  if (!hit) return null;
  const spec = hit[1];
  // esbuild sometimes THROWS an aggregate ("Build failed with 1 error:\n
  // src/App.tsx:2:9: ERROR: …") instead of returning structured errors, and
  // that string is all the caller has. The location is in it either way.
  if (!file) {
    const loc = /(^|\n)\s*([^\s:]+\.[jt]sx?):(\d+):\d+:/.exec(text);
    if (loc) {
      file = loc[2];
      line = Number(loc[3]);
    }
  }
  const at = file ? `${file}${line ? `:${line}` : ""}` : "a browser file";
  return `\`${name}\` is a SERVER API, and this is the browser bundle.\n` +
    `  ${at} imports { ${name} } from "${spec}", which a page cannot run — ` +
    `it needs the filesystem, workers or SQLite.\n` +
    `  • Server work belongs in a cell METHOD or the app entry; a component ` +
    `reads the result from cell state.\n` +
    `  • The documented escape hatch is a DYNAMIC import inside a method: ` +
    `\`await import("${spec}")\` — a static import from a component is not.\n` +
    `  • "${spec}" resolves in the browser build to the subset that CAN run ` +
    `there, which is why the file resolved and only the name did not.`;
}

/** Is `spec` one of aio's OWN entries? Broader than {@link SERVER_ONLY_SPECS}
 *  on purpose: that set is the hard, named subset, while `aio/extras` and
 *  `aio/sync` are deliberately outside it. Both families share ONE fact — the
 *  browser import map omits them and no npm package exists — so both must get
 *  the same truthful
 *  advice when a browser file cannot resolve one. They did not: `aio/extras`
 *  fell through to "add `npm:aio/extras` to deno.json", the exact advice this
 *  module's header calls actively harmful. */
export function isAioOwnSpec(spec: string): boolean {
  return spec === "aio" || spec.startsWith("aio/");
}

/** What to tell someone whose browser file imports an `aio/*` entry the
 *  browser import map does not carry. ONE wording, three call sites (the graph
 *  validator, the boot lint, the browser overlay). */
export function aioOwnSpecAdvice(spec: string): string {
  return `"${spec}" is one of aio's OWN entries, and the browser import map ` +
    `omits it deliberately (it pulls server code — the filesystem, workers, ` +
    `SQLite, a terminal). This is NOT a missing dependency: there is no ` +
    `\`npm:${spec}\` package, and editing deno.json will not help. Use it ` +
    `from a cell METHOD (\`const { … } = await import("${spec}")\` — methods ` +
    `run on the server), or from a *.server.ts module imported lazily.`;
}

/** `// aio-ok: server-only` — the acknowledgement path the warning had none of.
 *
 *  A field report ran for weeks with `⚠ src/cell/job.ts:292 — Deno.remove is
 *  server-only` on every launch, pointing at a `finally` block inside a method
 *  that only ever runs on the server, cleaning up a file it had itself created.
 *  The rule is right in general and wrong there, and with no way to say so the
 *  line became permanent noise printed next to the ✖ errors that genuinely
 *  break the client — which trains people to skim the one output they most need
 *  to read carefully. `aiol` already had this idiom (`// aiol-ok`).
 *
 *  Accepted on the flagged line, or on a comment line immediately above it
 *  (where the reason belongs, and where `deno fmt` cannot move it).
 *
 *  Deliberately NOT accepted for blocking categories: "this path never runs in
 *  the browser" is a claim a developer can make, "this import exists in the
 *  browser build" is not — that one is a guaranteed blank screen, and a
 *  silenceable one would be worse than the noise. */
export function isServerOnlySuppressed(
  lines: readonly string[],
  lineNum: number,
): boolean {
  // TWO SPELLINGS, both permanent. The original is `// aio-ok: server-only`,
  // which is what every existing suppression in the wild says and must keep
  // meaning. `// aio-ok(server-only): why` is the repo's general scoped form
  // (src/diagnostics/ok-marker.ts) and lands here too, so someone who learned
  // the marker anywhere else does not have to learn a second grammar.
  const legacy = /\/\/.*\baiol?-ok\b\s*[:\-—]?\s*server-only/;
  // `justifiedFor`, not `justified`: the scope is REQUIRED here. The
  // permissive form let an unscoped `// aio-ok: some other reason` silence a
  // server-only finding, which this function's own test forbids in so many
  // words — "a marker for one rule must not quietly cover another".
  const hit = (line: string) =>
    legacy.test(line) ||
    (line.includes("//") && justifiedFor(line, "server-only"));
  const own = lines[lineNum - 1] ?? "";
  if (hit(own)) return true;
  const above = (lines[lineNum - 2] ?? "").trim();
  return above.startsWith("//") && hit(above);
}

/** The DYNAMIC imports of aio entries a page cannot load (`isNonBrowser`)
 *  that `source` writes where the PAGE provably runs them — minus
 *  `// aio-ok: server-only` lines.
 *
 *  Dev and the bundle both leave such an import external (the server runs
 *  it). In a server cell's methods (however the object is spelled or where it
 *  lives), `onInit`/`onDestroy`, or a helper only those call (the `db()`
 *  pattern in docs/build/imports.md) that is right — and a regex scanner
 *  cannot tell such code from UI code. A warning there fired on every dev
 *  launch of a correct app: noise that trains people to skip the output. So
 *  only code that is browser code BY SYNTAX is reported:
 *  - a JSX event handler — `onClick={async () => (await import("aio/extras")).x()}`,
 *    or `onClick={save}` / `onClick={() => save()}` whose `save` this file
 *    declares;
 *  - anything inside a `cell(…)` call that says `scope: "client"` — its
 *    methods run in the tab.
 *  There the page runs the import and dies right then, in dev and in prod,
 *  with "Failed to resolve module specifier". Warned, not refused. ONE
 *  decider for dev and the build. Pure. */
export function dynamicImportsOutsideMethods(
  source: string,
  isNonBrowser: (spec: string) => boolean,
): { spec: string; line: number }[] {
  const mask = codeMask(source);
  // The offset of the bracket closing the one at `open` (code only).
  const close = (open: number) => {
    const o = source[open]!, c = o === "{" ? "}" : ")";
    let depth = 0, i = open;
    for (; i < source.length; i++) {
      if (!mask[i]) continue;
      if (source[i] === o) depth++;
      else if (source[i] === c && --depth === 0) break;
    }
    return i;
  };
  // Past a type argument list at `at` (`<` / `>` counted, `=>` is no
  // bracket) and the whitespace after it; `at` itself when there is none.
  const pastTypeArgs = (at: number) => {
    if (source[at] !== "<") return at;
    for (let depth = 0; at < source.length; at++) {
      if (!mask[at]) continue;
      if (source[at] === "<") depth++;
      else if (source[at] === ">" && source[at - 1] !== "=" && --depth === 0) {
        break;
      }
    }
    at++;
    while (/\s/.test(source[at] ?? "")) at++;
    return at;
  };
  // Where the declaration statement starting at `from` ends: a depth-0 `;`
  // or `,`, a bracket closing below it, or a depth-0 newline the expression
  // does not continue past (a trailing operator / `=>`, or a leading `.`/`?`/`:`).
  const statementEnd = (from: number) => {
    let depth = 0, i = from;
    for (; i < source.length; i++) {
      if (!mask[i]) continue;
      const c = source[i]!;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c) && --depth < 0) break;
      else if (depth === 0 && (c === ";" || c === ",")) break;
      else if (depth === 0 && c === "\n") {
        let k = i - 1; // the last CODE char — never a comment's
        while (k >= from) {
          if (!mask[k] || /\s/.test(source[k]!)) k--;
          else if (source[k] === "/" && source[k - 1] === "/") k -= 2;
          else if (source[k] === "/" && source[k - 1] === "*") {
            k = source.lastIndexOf("/*", k - 2) - 1;
          } else break;
        }
        const before = k < from ? "" : source[k]!;
        const after = source.slice(i).trimStart()[0] ?? "";
        if (!"=>+-*/?:&|".includes(before) && !".?:".includes(after)) break;
      }
    }
    return i;
  };
  const browser: [number, number][] = [];
  // Every called name → the handler brackets that call it (resolved once, below).
  const calls = new Map<string, number[]>();
  // A JSX attribute, not `const onSave = { … }` or `el.onFoo = {…}`.
  const handler = /(?<=\s)(?<!\b(?:const|let|var)\s+)on[A-Z]\w*\s*=\s*\{/g;
  for (const m of source.matchAll(handler)) {
    if (!mask[m.index]) continue;
    const open = m.index + m[0].length - 1, end = close(open);
    browser.push([open, end]);
    // `onClick={save}`, or `onClick={() => save()}` — a function this file
    // declares runs in the page too (one level: its own calls are not chased).
    const attr = source.slice(open, end + 1);
    const names = new Set<string>();
    const bare = /^\{\s*([A-Za-z_$][\w$]*)\s*\}$/.exec(attr)?.[1];
    if (bare) names.add(bare);
    else {
      // A bare CALL in code — `console.log()` / `api.save()` are members.
      for (const c of attr.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (mask[open + c.index]) names.add(c[1]!);
      }
    }
    for (const name of names) {
      calls.get(name)?.push(open) ?? calls.set(name, [open]);
    }
  }
  if (calls.size) resolveCalls();
  /** Mark the declaration each called name resolves to — the innermost one
   *  whose block also holds the handler (a same-named helper local to a
   *  server method is another binding) — as browser code. One linear scan. */
  function resolveCalls(): void {
    // The innermost `{` holding each offset (-1 = module level), and its `}`.
    const block = new Int32Array(source.length);
    const shut = new Map<number, number>();
    const stack: number[] = [];
    for (let i = 0; i < source.length; i++) {
      block[i] = stack.at(-1) ?? -1;
      if (!mask[i]) continue;
      if (source[i] === "{") stack.push(i);
      else if (source[i] === "}" && stack.length) shut.set(stack.pop()!, i);
    }
    const holds = (b: number, at: number) =>
      b < 0 || (b < at && (shut.get(b) ?? source.length) > at);
    const decls = new Map<string, RegExpExecArray[]>();
    const decl =
      /\b(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<])/g;
    for (const d of source.matchAll(decl)) {
      const name = d[1] ?? d[2]!;
      if (!mask[d.index] || !calls.has(name)) continue;
      decls.get(name)?.push(d) ?? decls.set(name, [d]);
    }
    const marked = new Set<RegExpExecArray>();
    for (const [name, all] of decls) {
      for (const h of calls.get(name)!) {
        // Every declaration in that innermost block (overloads share one).
        const seen = all.filter((d) => holds(block[d.index]!, h));
        const inner = Math.max(...seen.map((d) => block[d.index]!));
        for (const d of seen) if (block[d.index] === inner) marked.add(d);
      }
    }
    for (const d of marked) {
      const at = d.index + d[0].length;
      if (d[0].endsWith("=")) browser.push([at, statementEnd(at)]);
      else {
        // A generic `function f<T>(…)`: its parameters follow the `<…>`.
        const params = pastTypeArgs(at - 1);
        const body = source[params] === "("
          ? functionBody(close(params) + 1)
          : -1;
        if (body >= 0) browser.push([body, close(body)]);
      }
    }
  }
  /** The `{` of a function body after its parameter list — past a return
   *  type (`: { a: 1 }` is a type literal, not the body); -1 for a body-less
   *  signature (`declare function f(): void;`, an overload).
   *
   *  The rule is the type grammar's: at depth 0 a `{` is a type literal
   *  exactly where a TYPE operand is still expected — after the annotation
   *  `:`, a type operator (`|` `&` `=>`, a conditional's `?` / `:`, `keyof`,
   *  `readonly`, `extends`, `is`, `asserts … is`, `infer`, `typeof`). After a
   *  COMPLETE type (a name, a literal's closing quote, `)` `]` `}` `>`) the
   *  next `{` is the body. `in` and mapped types only occur inside braces. */
  function functionBody(from: number): number {
    const typeWord = /(?<![\w$.])(?:keyof|readonly|extends|is|infer|typeof)$/;
    let depth = 0, prev = -1; // the previous code char's offset
    for (let i = from; i < source.length; i++) {
      if (!mask[i] || /\s/.test(source[i]!)) continue;
      const c = source[i]!;
      if (
        depth === 0 && c === "{" &&
        !":|&,?".includes(source[prev] ?? " ") &&
        !(source[prev] === ">" && source[prev - 1] === "=") &&
        !typeWord.test(source.slice(Math.max(0, prev - 9), prev + 1))
      ) return i;
      if ("([{<".includes(c)) depth++;
      else if (")]}".includes(c) || (c === ">" && source[i - 1] !== "=")) {
        if (--depth < 0) return -1;
      } else if (depth === 0 && c === ";") return -1;
      prev = i;
    }
    return -1;
  }
  // A cell whose OPTIONS say `scope: "client"` — depth 1 inside the call, so
  // a state field `{ scope: "client" }` of a server cell is not it.
  for (const m of source.matchAll(/\bcell\s*(?=[<(])/g)) {
    if (!mask[m.index]) continue;
    // `cell<{ f: () => void }>(…)` is still this call.
    const open = pastTypeArgs(m.index + m[0].length);
    if (source[open] !== "(") continue;
    const end = close(open);
    let depth = 0;
    for (let i = open; i < end; i++) {
      if (!mask[i]) continue;
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      else if (
        depth === 1 &&
        /^scope\s*:\s*(["'])client\1/.test(source.slice(i, i + 20)) &&
        !/[\w$]/.test(source[i - 1]!)
      ) {
        browser.push([open, end]);
        break;
      }
    }
  }
  const lines = source.split("\n");
  const out: { spec: string; line: number }[] = [];
  for (const m of source.matchAll(/\bimport\s*\(\s*(["'])([^"'\n]+)\1/g)) {
    const spec = m[2]!;
    if (!mask[m.index] || !isNonBrowser(spec)) continue;
    if (!browser.some(([a, b]) => m.index > a && m.index < b)) continue;
    // A TYPE (`import("aio/db").DB`, `typeof import(…)`): erased, never runs.
    const after = source.slice(m.index + m[0].length);
    if (
      /^\s*\)\s*\.(?!\s*(?:then|catch|finally)\b)/.test(after) ||
      /\btypeof\s*$/.test(source.slice(0, m.index))
    ) continue;
    const line = source.slice(0, m.index).split("\n").length;
    if (!isServerOnlySuppressed(lines, line)) out.push({ spec, line });
  }
  return out;
}

/** What dev and the build both say about one of those imports. */
export function dynamicOutsideMethodsAdvice(
  spec: string,
): { message: string; fix: string } {
  return {
    message: `\`import("${spec}")\` sits in browser code (a JSX event ` +
      `handler or a \`scope: "client"\` cell) — a page cannot load ` +
      `"${spec}" (the browser import map omits it), so it fails right then ` +
      `with "Failed to resolve module specifier", in dev and in prod`,
    fix: `Move the import into a server cell's METHOD (those run on the ` +
      `server) and call the method from the page. If this path only ever runs on ` +
      `the server, say so: \`// aio-ok: server-only — <reason>\` on the line ` +
      `or the line above. See docs/build/imports.md.`,
  };
}
