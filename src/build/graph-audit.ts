// graph-audit.ts — THE decider for "what is in the browser bundle, and why it
// is refused". Pure: it reads esbuild's metafile (the RESOLVED client graph,
// with every edge's kind and externality) plus a source reader, and returns
// findings with the message the build prints. Both consumers call it:
//
//   - `deno task build` (build-bundle.ts) — refuses the artifact;
//   - the dev server / `check:graph` (graph-validator.ts) — refuses the boot,
//     same finding, same words.
//
// Why one module: for two weeks a field app's `deno task check` said "no
// BLOCKING server-only imports — 190 notices, all behind dynamic imports"
// while `deno task build` refused the same source for seven leaks. The
// validator's rule was "ANY dynamic import is the escape hatch"; the bundler's
// truth is that ONLY a dynamic import of a `*.server.ts` module (or of aio's
// own server entries) is external — every other dynamic target is FOLLOWED by
// esbuild, and a static `@std/path` one hop past it lands in the bundle. Two
// deciders, one wrong. Now the rule is written once, against the graph esbuild
// actually built, and the validator asks the bundler.

import { isServerOnlyFile } from "../entries.ts";
import { codeText } from "../diagnostics/code-mask.ts";

/** esbuild's plugin namespace for the `@std/*` / `node:*` stub modules. A
 *  metafile input in this namespace is a server-only module the bundle
 *  reached; its kind of edge decides whether that is a leak. */
export const SERVER_ONLY_STUB_NS = "aio-server-only";

/** One edge of esbuild's metafile. `external: true` = NOT in the bundle. */
export type MetaImport = {
  path: string;
  kind: string;
  external?: boolean;
  original?: string;
};
/** `metafile.inputs` — every module esbuild read, keyed as esbuild keys it.
 *  `format` is esbuild's own verdict on how it PARSED the file — and for a
 *  `"cjs"` input it also says how esbuild REWRITES it (see {@link CJS_WRAPPED}). */
export type MetaInputs = Record<
  string,
  { imports?: MetaImport[]; format?: string }
>;

/** Node globals a browser does not have. A module-scope reference to one is a
 *  `ReferenceError` at load — the whole bundle dies, the page stays blank. */
export const NODE_GLOBALS: readonly string[] = [
  "Buffer",
  "process",
  "global",
  "__dirname",
  "__filename",
  "require",
  "module",
];

/** The two names esbuild's CommonJS wrapper SUPPLIES, so a `"cjs"` input
 *  referencing them is not a browser break.
 *
 *  esbuild wraps a CJS input as `__commonJS({ "p"(exports, module) { … } })` —
 *  `module` is a parameter, and a bare `require` is rewritten to esbuild's own
 *  `__require`. `module.exports = x` and `require("y")` are just how the file
 *  is SPELLED; the bundle defines both. Flagging them refuses every app that
 *  bundles an npm package written in CommonJS (risoto's client graph: 13 of 14
 *  findings, all of them from bs58 / bn.js / jayson / safe-buffer — and the
 *  bundle it refused evaluated clean in both shells).
 *
 *  The other Node globals are NOT supplied — `Buffer`, `process`, `global`,
 *  `__dirname`, `__filename` throw in a CJS input exactly as in an ESM one, so
 *  they are still scanned there. */
const CJS_WRAPPED: ReadonlySet<string> = new Set(["require", "module"]);

/** `load-error` is the evaluator's finding (graph-eval.ts): the bundle threw
 *  at module scope for a reason the static rules did not name. */
/** `// aio-ok: node-global <reason>` — see {@link scanNodeGlobals}. */
export const NODE_GLOBAL_OK_RE: RegExp =
  /\/\/.*\baio-ok\b\s*[:\-—]?\s*node-global\b/;

export type AuditRule = "server-only-leak" | "node-global" | "load-error";

export type AuditFinding = {
  rule: AuditRule;
  /** The module the finding is about: the IMPORTER of a leak, or the module
   *  that touches a Node global. A metafile key (cwd-relative). */
  file: string;
  /** What it reached (a specifier / file) or the global's name. */
  target: string;
  /** Static-import chain from the entry to `file` (entry first). */
  chain: string[];
  line?: number;
  message: string;
  fix: string;
};

export type AuditVerdict = {
  ok: boolean;
  findings: AuditFinding[];
  /** Every non-external module the entry reaches (metafile keys). */
  reached: string[];
};

const SERVER_FILE_FIX =
  "a *.server.ts module is server-only BY CONVENTION — the dev server " +
  "refuses to serve one, and anything it holds is readable by anyone who " +
  "opens dist/app.js. Import it dynamically from the cell method that needs " +
  'it (`const { x } = await import("./io.server.ts")`), never statically ' +
  "from client-reachable code — and check your import map for an alias that " +
  "resolves to one.";

const isStub = (p: string) => p.startsWith(SERVER_ONLY_STUB_NS + ":");
const stubSpec = (p: string) => p.slice(SERVER_ONLY_STUB_NS.length + 1);

/** The graph the entry reaches through NON-external edges — static AND
 *  dynamic alike, because esbuild follows both; only an external edge (a
 *  dynamic `*.server.ts` / `aio/server` import) is a boundary the bundle does
 *  not cross. `parent` records the first importer seen, for chains. */
function reach(
  entry: string,
  inputs: MetaInputs,
): { order: string[]; parent: Map<string, string | null> } {
  const parent = new Map<string, string | null>([[entry, null]]);
  const order: string[] = [];
  const queue = [entry];
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const imp of inputs[cur]?.imports ?? []) {
      if (imp.external || parent.has(imp.path)) continue;
      parent.set(imp.path, cur);
      queue.push(imp.path);
    }
  }
  return { order, parent };
}

function chainTo(
  file: string,
  parent: Map<string, string | null>,
): string[] {
  const out: string[] = [];
  for (let p: string | null | undefined = file; p; p = parent.get(p)) {
    out.unshift(p);
  }
  return out;
}

/** Node-global references at MODULE SCOPE, in masked source (comments and
 *  string bodies already blanked by `codeText`, offsets preserved).
 *
 *  Module scope ≈ brace depth 0, with two refinements: the body of an arrow
 *  function without braces (`x => Buffer.from(x)`) runs later, not at load,
 *  so text after `=>` up to the statement end is treated as nested; and a
 *  line that guards the name with `typeof` is a feature test, not a use. A
 *  name the module DECLARES or IMPORTS itself (`import { Buffer } from
 *  "buffer"`, `const process = …`) is its own binding, never the global.
 *  Property positions (`x.process`, `{ process: 1 }`) are not references.
 *
 *  This is the static floor. The truth is evaluation (graph-eval.ts) — a
 *  class field initializer or a top-level call into a function that touches
 *  the global is invisible here and caught there.
 *
 *  `// aio-ok: node-global <reason>` on the line (or the line above) silences
 *  THIS scan for that line — a heuristic can be wrong about scope. It does
 *  not silence the evaluation: a suppressed line that really throws at load
 *  is still refused there, so a wrong acknowledgement cannot ship a blank
 *  page. The reason is for the reader; the marker is what the scanner
 *  reads. */
export function scanNodeGlobals(
  source: string,
): Array<{ name: string; line: number }> {
  const masked = codeText(source);
  const declared = new Set<string>();
  for (const name of NODE_GLOBALS) {
    const decl = new RegExp(
      `\\b(?:const|let|var|function|class)\\s+${name}\\b|` +
        `\\bimport\\s+${name}\\b|` +
        `\\bimport\\s*(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from|` +
        `\\bimport\\s*\\*\\s*as\\s+${name}\\b`,
    );
    if (decl.test(masked)) declared.add(name);
  }
  const out: Array<{ name: string; line: number }> = [];
  const seen = new Set<string>();
  const RE = new RegExp(`(^|[^\\w$.])(${NODE_GLOBALS.join("|")})\\b`, "g");
  const GUARD_RE = new RegExp(
    `\\btypeof\\s+(?:${NODE_GLOBALS.join("|")})\\b|` +
      `["'](?:${NODE_GLOBALS.join("|")})["']\\s+in\\s+globalThis`,
  );
  // Depth walk: `{`/`}` nest; a brace-less arrow body nests until `;`.
  let depth = 0;
  let arrowDepth = 0; // pending brace-less arrow bodies
  const lines = masked.split("\n");
  // The acknowledgement lives in a COMMENT — read from the raw source, since
  // the mask blanked every comment body.
  const raw = source.split("\n");
  const acked = (li: number) =>
    NODE_GLOBAL_OK_RE.test(raw[li] ?? "") ||
    (/^\s*\/\//.test(raw[li - 1] ?? "") &&
      NODE_GLOBAL_OK_RE.test(raw[li - 1]!));
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li]!;
    const guarded = GUARD_RE.test(text) || acked(li);
    RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const hits: Array<{ idx: number; name: string }> = [];
    while ((m = RE.exec(text)) !== null) {
      hits.push({ idx: m.index + m[1]!.length, name: m[2]! });
    }
    // Walk the line's braces so a hit knows its depth.
    let d = depth;
    let ad = arrowDepth;
    let hi = 0;
    for (let i = 0; i <= text.length; i++) {
      while (hi < hits.length && hits[hi]!.idx === i) {
        const h = hits[hi++]!;
        const tail = text.slice(i + h.name.length);
        const after = tail.match(/^\s*(\S)/)?.[1];
        const isKey = after === ":" &&
          /[{,]\s*$/.test(text.slice(0, i));
        // esbuild DEFINES `process.env.NODE_ENV` for platform:browser (to
        // "production" under minify) — every npm dual build reads it at
        // module scope, and it never reaches a browser as `process`.
        const defined = h.name === "process" &&
          /^\.env\.NODE_ENV\b/.test(tail);
        if (
          d + ad === 0 && !guarded && !isKey && !defined &&
          !declared.has(h.name) && !seen.has(h.name)
        ) {
          seen.add(h.name);
          out.push({ name: h.name, line: li + 1 });
        }
      }
      const c = text[i];
      if (c === "{") d++;
      else if (c === "}") d = Math.max(0, d - 1);
      else if (c === "=" && text[i + 1] === ">") {
        const rest = text.slice(i + 2).match(/^\s*(\S)/)?.[1];
        if (rest !== "{") ad++;
        i++;
      } else if (c === ";" && ad > 0) ad = 0;
    }
    depth = d;
    // A brace-less arrow body ends at `;`. Without one it carries into the
    // next line — erring towards a MISS (evaluation catches it) rather than
    // a false refusal.
    arrowDepth = ad;
  }
  return out;
}

/** Run the audit over a bundle's resolved graph.
 *
 *  `entry` is the metafile key of the bundle entry; `source(path)` returns a
 *  reached module's source (or `undefined` when it cannot be read — stub and
 *  virtual inputs never are). `hideEntry` drops the generated entry from
 *  printed chains (the app's own entry is the first thing a reader knows). */
export function auditClientGraph(opts: {
  entry: string;
  inputs: MetaInputs;
  source: (path: string) => string | undefined;
  hideEntry?: boolean;
}): AuditVerdict {
  const { entry, inputs } = opts;
  const { order, parent } = reach(entry, inputs);
  const findings: AuditFinding[] = [];
  const show = (chain: string[]) =>
    opts.hideEntry && chain[0] === entry ? chain.slice(1) : chain;

  // ── Rule 1: server-only modules IN the bundle ──
  for (const cur of order) {
    for (const imp of inputs[cur]?.imports ?? []) {
      if (imp.external) continue;
      const isStatic = imp.kind !== "dynamic-import";
      // The FILE, since the specifier may not say (an import-map alias).
      const target = imp.original && imp.original !== imp.path
        ? `${imp.path} (imported as "${imp.original}")`
        : imp.path;
      if (isServerOnlyFile(imp.path)) {
        // Any edge: a `*.server.*` file esbuild READ is in dist/app.js —
        // keys, tokens, queries, readable by anyone. (A dynamic import of one
        // is external and never gets here; this is the static form, the
        // `.server.tsx` twin, an import-map alias, a computed `import()`.)
        findings.push({
          rule: "server-only-leak",
          file: cur,
          target,
          chain: show(chainTo(cur, parent)),
          message:
            `"${target}" is a *.server.* module and it is IN the browser bundle` +
            (isStatic
              ? " (statically imported)"
              : " (esbuild inlined the import)"),
          fix: "a *.server.ts module is server-only BY CONVENTION — the dev " +
            "server refuses to serve one, and anything it holds is readable " +
            "by anyone who opens dist/app.js. Import it dynamically from " +
            'the cell method that needs it (`const { x } = await import("./io.server.ts")`), ' +
            "never statically from client-reachable code — and check your " +
            "import map for an alias that resolves to one.",
        });
      } else if (isStub(imp.path) && isStatic) {
        // A STATIC `@std/*` / `node:*` import in a module the bundle reaches.
        // The stub is correct for the DYNAMIC form (dead code in a method
        // body); statically it is LIVE code that throws at first use — a
        // blank page with "1 module error", nowhere near the import. And the
        // module may itself sit behind a dynamic import: esbuild followed
        // that edge, so the static import one hop further is in the bundle
        // all the same. Only a dynamic import OF A `*.server.ts` module is
        // the escape hatch.
        const spec = stubSpec(imp.path);
        findings.push({
          rule: "server-only-leak",
          file: cur,
          target: spec,
          chain: show(chainTo(cur, parent)),
          message:
            `"${spec}" is server-only and statically imported by the BROWSER bundle`,
          fix:
            "it does not exist in a browser; the bundle would build and then " +
            "throw at first use, showing a blank page. Load it inside the " +
            `method that needs it (\`const { x } = await import("${spec}")\` ` +
            "is server-side and stays out of the client graph) or move the " +
            "code into a `*.server.ts` module and import THAT dynamically. " +
            "A dynamic import of any OTHER module is followed by the bundler " +
            "— only a dynamic import of a *.server.ts module is external.",
        });
      }
    }
  }

  // Rule 1b: a `*.server.*` file esbuild READ that no edge above reaches —
  // a computed `import(\`./${n}.server.ts\`)` becomes a glob import whose
  // matches are inlined without a plain edge. It is in dist/app.js all the
  // same; the RESOLVED input list is the truth.
  const reachedSet = new Set(order);
  for (const key of Object.keys(inputs).sort()) {
    if (reachedSet.has(key) || !isServerOnlyFile(key)) continue;
    findings.push({
      rule: "server-only-leak",
      file: key,
      target: key,
      chain: [],
      message:
        `"${key}" is a *.server.* module and it is IN the browser bundle (esbuild inlined it — a computed import() resolves to every match)`,
      fix: SERVER_FILE_FIX,
    });
  }

  // ── Rule 2: Node globals at module scope ──
  //
  // The STATIC floor, and only that: a finding here is a suspicion, and
  // `judgeClientBundle` puts it to the evaluator before refusing anything. A
  // module-scope `Buffer` that a shim imported earlier already defined is a
  // legitimate app (aio's own fix names it), and it evaluates clean.
  for (const cur of order) {
    if (isStub(cur)) continue;
    const src = opts.source(cur);
    if (src === undefined) continue;
    const wrapped = inputs[cur]?.format === "cjs";
    for (const hit of scanNodeGlobals(src)) {
      if (wrapped && CJS_WRAPPED.has(hit.name)) continue;
      findings.push({
        rule: "node-global",
        file: cur,
        target: hit.name,
        line: hit.line,
        chain: show(chainTo(cur, parent)),
        message:
          `${hit.name} is referenced at module scope — a browser has no ${hit.name}, ` +
          `so the whole bundle dies at load with "ReferenceError: ${hit.name} is not defined"`,
        fix: "aio does not polyfill Node globals (esbuild platform:browser " +
          "supplies none). Keep the module server-side — a `*.server.ts` " +
          "module, dynamic-imported from a cell method — or provide the " +
          `global yourself from a module imported BEFORE it (e.g. \`globalThis.${hit.name} = …\` ` +
          "from an npm polyfill) if the dependency truly must run in the browser.",
      });
    }
  }

  return { ok: findings.length === 0, findings, reached: order };
}

/** Attribute a runtime `ReferenceError: X is not defined` (from evaluating the
 *  bundle) to the reached modules whose source mentions `X` at all — the
 *  static scan's depth rule may have missed a class field or a top-level call
 *  chain, and "which module?" is the whole question. */
export function attributeReference(
  name: string,
  reached: readonly string[],
  source: (path: string) => string | undefined,
): string[] {
  const re = new RegExp(`(^|[^\\w$.])${name}\\b`);
  return reached.filter((p) => {
    if (isStub(p)) return false;
    const s = source(p);
    return s !== undefined && re.test(codeText(s));
  });
}

/** The lines the build prints for a verdict — the ONE wording. Every
 *  finding's `message` and `fix` appear verbatim; the dev server prints the
 *  same strings as `✖ file:line — message / FIX:`. `rel` renders a metafile
 *  key for the reader. */
export function formatAudit(
  v: AuditVerdict,
  rel: (p: string) => string = (p) => p,
): string[] {
  const out: string[] = [];
  const groups: Array<[AuditRule, string]> = [
    [
      "server-only-leak",
      "✗ server-only module(s) reached by the BROWSER bundle:",
    ],
    [
      "node-global",
      "✗ Node global(s) touched at module scope by the BROWSER bundle:",
    ],
    ["load-error", "✗ the BROWSER bundle cannot load:"],
  ];
  for (const [rule, head] of groups) {
    const fs = v.findings.filter((f) => f.rule === rule);
    if (!fs.length) continue;
    out.push(head);
    for (const f of fs) {
      out.push(
        `       ${rel(f.file)}${f.line ? `:${f.line}` : ""} — ${f.message}`,
      );
      if (f.chain.length > 1) {
        out.push(`         via ${f.chain.map(rel).join(" → ")}`);
      }
    }
    // One fix block per distinct fix (two leak shapes, two fixes).
    for (const fix of new Set(fs.map((f) => f.fix))) {
      out.push(`       fix: ${fix}`);
    }
  }
  return out;
}
