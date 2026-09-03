// Docs-snippets drift gate — doc code blocks must TYPE-CHECK, not just have
// resolvable imports (doc-imports-gate.test.ts covers that). Stale samples
// survived twice in one week because prose gates can't see lies in code;
// this gate extracts every standalone ```ts/```tsx block across docs/ and
// README.md and runs `deno check` on all of them in ONE batch against the
// real repo entry points (via a generated import map).
//
// Multi-file example docs use a `// path/to/file.ts` first-line comment to
// name each snippet; snippets in the SAME doc are laid out as a mini-project
// so relative imports resolve to the real definitions (full type inference —
// e.g. testCell state typing). Unresolved relative imports fall back to
// permissive `any`-typed stubs.
//
// A block is checked when it imports from "aio…" or a relative path and has
// no ellipsis markers — OR when it is import-less but COMPLETE (it calls
// `cell(`, `aio.run(`, `testCell(` or `testUI(`). Docs write those blocks
// without an import line all the time, and that is exactly how three broken
// samples shipped at once (a `schedule.every(ms, fn)` that neither compiles
// nor schedules, a `catch (e) { e.message }` that is TS18046, a `state: {
// items: [] }` filtered on `o.userId`). For those, ONE import line is
// synthesized from the identifiers the block uses and the real export lists of
// `aio`, `aio/testing`, `aio/air` and `aio/ui`, so the reader's copy is
// checked against the same API their editor would resolve.
//
// Escape hatches (use SPARINGLY): fence info `no-check`, or the literal first
// line `// snippet: fragment` for true fragments.
import { assert } from "@std/assert";

const ROOT = new URL("..", import.meta.url);

const FENCE_RE = /```(ts|tsx)\b([^\n]*)\n([\s\S]*?)```/g;
// Matches the import clause + specifier of relative imports (incl. re-exports
// and side-effect imports) so stubs can export the right names.
const REL_IMPORT_RE =
  /(?:import|export)\s+(?:(type)\s+)?([\w$]+|\{[^}]*\}|[\w$]+\s*,\s*\{[^}]*\}|\*)?\s*(?:from\s*)?["'](\.[^"']+)["']/g;
// Bare (non-relative, non-aio) specifiers — snippets needing unmapped deps
// (react/vue islands would need node_modules) are skip-listed, not checked.
const BARE_IMPORT_RE =
  /(?:import|export)[^"'\n]*from\s*["']([^."'][^"']*)["']/g;
// `// cell/notes/index.ts` first-line convention naming a snippet's file.
const DECL_PATH_RE = /^\/\/\s*([\w-][\w./-]*\.tsx?)\s*$/;

/** An import-less block is still a whole program when it calls one of these —
 *  a cell definition, an app boot, or a harness test. Anything smaller is a
 *  fragment and stays out (the reader is not copying it wholesale). */
const COMPLETE_RE =
  /\b(?:cell|testCell|testUI)\s*\(|\baio\.run\s*\(|^try\s*\{/m;

/** …and it is NOT a whole program when a line at column 0 is an object member
 *  — a `methods:` block or a bare `async add(s) {` shorthand pasted next to a
 *  complete cell ("// inside todos:"). Those do not parse, so checking them
 *  would report a SyntaxError instead of the type error the gate is for. */
const OBJECT_MEMBER_RE =
  /^(?:(?:async|get|set|static)\s+)?[A-Za-z_$][\w$]*\s*(?:\([^)]*\)\s*\{|:\s*[^:=\n])/m;

/** Entry modules whose exports a synthesized import line may draw on, in
 *  priority order — the specifiers a doc reader would type. */
const AUTO_MODULES: readonly (readonly [string, string])[] = [
  ["aio", "mod.ts"],
  ["aio/testing", "src/cell-test.ts"],
  ["aio/air", "src/air.ts"],
  ["aio/ui", "src/ui/mod.ts"],
  ["aio/server", "src/server-entry.ts"],
  ["aio/db", "src/db/mod.ts"],
  ["aio/sync", "src/sync/mod.ts"],
  ["aio/extras", "src/extras/mod.ts"],
  ["aio/updates", "src/updates.ts"],
  ["aio/feedback", "src/feedback.ts"],
];

/** VALUE exports of an entry module, following `export * from` — parsed from
 *  source rather than imported, because `aio/air` and `aio/ui` are browser
 *  modules and evaluating them here would need a DOM. A missed name only costs
 *  a clearer error ("Cannot find name"), never a false pass. */
async function valueExports(
  file: URL,
  seen = new Set<string>(),
): Promise<Set<string>> {
  const out = new Set<string>();
  if (seen.has(file.href)) return out;
  seen.add(file.href);
  const src = await Deno.readTextFile(file);
  for (const m of src.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    if (m[1]) continue; // `export type { … }`
    for (const part of m[2]!.split(",")) {
      const t = part.trim();
      if (!t || t.startsWith("type ")) continue;
      const name = (t.split(/\s+as\s+/)[1] ?? t).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  for (
    const m of src.matchAll(
      /export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/g,
    )
  ) out.add(m[1]!);
  for (const m of src.matchAll(/export\s+\*\s+from\s*["'](\.[^"']+)["']/g)) {
    for (const n of await valueExports(new URL(m[1]!, file), seen)) out.add(n);
  }
  return out;
}

/** name → the specifier that exports it; first module in AUTO_MODULES wins. */
async function buildAutoIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const [spec, file] of AUTO_MODULES) {
    for (const name of await valueExports(new URL(file, ROOT))) {
      if (!index.has(name)) index.set(name, spec);
    }
  }
  assert(
    index.get("cell") === "aio" && index.get("testCell") === "aio/testing" &&
      index.get("signal") === "aio/air",
    "export scan lost its anchors — the parse broke; fix it rather than " +
      "letting every import-less snippet silently go unchecked",
  );
  return index;
}

/** Names the snippet binds itself — never import over one of these. */
function declaredNames(code: string): Set<string> {
  const out = new Set<string>();
  for (
    const m of code.matchAll(
      /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/g,
    )
  ) out.add(m[1]!);
  // Destructured / array bindings, and every name in an import clause.
  for (
    const m of code.matchAll(
      /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g,
    )
  ) {
    for (const part of m[1]!.split(",")) {
      const n = (part.split(":").pop() ?? "").trim().replace(/^\.\.\./, "")
        .split("=")[0]!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) out.add(n);
    }
  }
  for (const m of code.matchAll(/import[^;\n]*from\s*["'][^"']+["']/g)) {
    for (const n of m[0].matchAll(/[\w$]+/g)) out.add(n[0]);
  }
  return out;
}

/** The ONE import line an import-less snippet is checked with: every framework
 *  name it uses and does not define, grouped by the specifier that exports it.
 *  Empty when it uses none — the block is then checked as plain TypeScript. */
function autoImportLine(code: string, index: Map<string, string>): string {
  const declared = declaredNames(code);
  const bySpec = new Map<string, Set<string>>();
  for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = m[0];
    if (declared.has(name)) continue;
    if (code[m.index - 1] === ".") continue; // `x.cell` is a property
    const spec = index.get(name);
    if (!spec) continue;
    let names = bySpec.get(spec);
    if (!names) bySpec.set(spec, names = new Set());
    names.add(name);
  }
  return [...bySpec]
    .map(([spec, names]) =>
      `import { ${[...names].sort().join(", ")} } from "${spec}";`
    ).join(" ");
}

/** Snippets whose imports can't resolve without node_modules — react/vue
 * island samples. Checking them would need a real npm install; skipped. */
const UNRESOLVABLE_OK = new Set(["react", "vue", "react-dom/client"]);

type Snippet = {
  doc: string; // repo-relative doc path
  line: number; // 1-based line of the fence's first code line
  lang: "ts" | "tsx";
  code: string;
  declPath?: string; // `// path.ts` first-line file name, if present
  file?: string; // absolute path the snippet was written to
  /** Import-less but complete — checked with a synthesized import line, so
   *  file line N is doc line `line + N - 2`. */
  auto?: boolean;
  /** Pass 2 added two more preamble lines of `declare const … : any` stubs. */
  stubbed?: boolean;
};

async function* markdownFiles(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    // upgrade/ + specs/ are historical (intentionally show old APIs).
    if (
      e.name === "api-ref" || e.name === "node_modules" ||
      e.name === "upgrade" || e.name === "specs" || e.name === "release-notes"
    ) continue;
    const child = new URL(e.isDirectory ? `${e.name}/` : e.name, dir);
    if (e.isDirectory) yield* markdownFiles(child);
    else if (e.name.endsWith(".md")) yield child;
  }
}

function isFragment(code: string): boolean {
  const first = code.trimStart().split("\n", 1)[0]!.trim();
  if (first === "// snippet: fragment") return true;
  if (code.includes("@ts-ignore-doc")) return true;
  // Ellipsis markers = intentionally elided code: `…`, a bare `...` line,
  // `// ...`, or `{ ... }` — but NOT spread syntax (`...x` has a name after).
  return code.includes("…") || /^\s*\.\.\.\s*$/m.test(code) ||
    /\/\/\s*\.\.\./.test(code) || /\.\.\.\s*[}\])]/.test(code);
}

function extractSnippets(doc: string, text: string): Snippet[] {
  const out: Snippet[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const [, lang, info, code] = m;
    if (info!.includes("no-check")) continue;
    const imported = /(?:import|export)[^\n]*from\s*["'](?:aio|\.)/.test(code!);
    if (!imported && !COMPLETE_RE.test(code!)) continue;
    if (!imported && OBJECT_MEMBER_RE.test(code!)) continue;
    if (isFragment(code!)) continue;
    const first = code!.trimStart().split("\n", 1)[0]!.trim();
    out.push({
      doc,
      line: text.slice(0, m.index).split("\n").length + 1,
      lang: lang as "ts" | "tsx",
      code: code!,
      declPath: first.match(DECL_PATH_RE)?.[1],
      auto: !imported,
    });
  }
  return out;
}

/** Import-map entries: "aio" → mod.ts + every subpath from repo exports,
 * plus the repo's own third-party imports (immer, @std/*, …). */
function buildImports(): Record<string, string> {
  const cfg = JSON.parse(Deno.readTextFileSync(new URL("deno.json", ROOT))) as {
    exports: Record<string, string>;
    imports: Record<string, string>;
  };
  const imports: Record<string, string> = {};
  for (const [key, target] of Object.entries(cfg.exports)) {
    const spec = key === "." ? "aio" : "aio/" + key.slice(2);
    imports[spec] = new URL(target, ROOT).href;
  }
  for (const [key, target] of Object.entries(cfg.imports)) {
    if (imports[key]) continue; // aio entries already mapped from exports
    imports[key] = target.startsWith("./")
      ? new URL(target, ROOT).href
      : target;
  }
  return imports;
}

/** Permissive stub for an unresolved relative import: every name is an `any`
 * const AND an `any` type alias (value + type namespaces are separate). */
function stubSource(names: Set<string>, hasDefault: boolean): string {
  const lines = ["// deno-lint-ignore-file no-explicit-any"];
  for (const n of names) {
    lines.push(`export const ${n}: any = undefined;`);
    lines.push(`export type ${n} = any;`);
  }
  if (hasDefault) {
    lines.push("const __default: any = undefined;");
    lines.push("export default __default;");
  }
  if (lines.length === 1) lines.push("export {};");
  return lines.join("\n") + "\n";
}

/** Parses one import clause into stub requirements. */
function clauseNames(
  clause: string | undefined,
): { names: string[]; hasDefault: boolean } {
  if (!clause || clause === "*") return { names: [], hasDefault: false };
  const names: string[] = [];
  let hasDefault = false;
  const braced = clause.match(/\{([^}]*)\}/);
  const before = clause.replace(/\{[^}]*\}/, "").replace(",", "").trim();
  if (before) hasDefault = true; // `Foo` or `Foo, {…}` — default import
  if (braced) {
    for (const part of braced[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!
        .trim();
      if (name) names.push(name);
    }
  }
  return { names, hasDefault };
}

Deno.test("doc ts/tsx code blocks type-check against the real API", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "aio-doc-snippets-" });
  try {
    const files: URL[] = [new URL("README.md", ROOT)];
    for await (const f of markdownFiles(new URL("docs/", ROOT))) files.push(f);
    assert(files.length > 30, "doc walk found too few files — walker broke?");

    const byDoc = new Map<string, Snippet[]>();
    for (const file of files) {
      const rel = file.href.slice(ROOT.href.length);
      const sns = extractSnippets(rel, await Deno.readTextFile(file));
      if (sns.length) byDoc.set(rel, sns);
    }
    const count = [...byDoc.values()].reduce((n, s) => n + s.length, 0);
    assert(count > 50, `only ${count} snippets extracted — regex broke?`);

    const imports = buildImports();
    const autoIndex = await buildAutoIndex();
    // resolved-but-missing relative import URL → stub requirements
    const stubs = new Map<
      string,
      { names: Set<string>; hasDefault: boolean }
    >();
    const checkFiles: string[] = [];
    const byFile = new Map<string, Snippet>(); // written path → origin

    let proj = 0;
    for (const snippets of byDoc.values()) {
      const dir = `${tmp}/p${proj++}`;
      // Pass 1 — assign file locations. First claim of a declared path wins;
      // later versions of the same file check standalone at the same depth.
      const claimed = new Set<string>();
      let sid = 0;
      for (const sn of snippets) {
        const bare = [...sn.code.matchAll(BARE_IMPORT_RE)].map((m) => m[1]!);
        const unresolvable = bare.filter((s) =>
          !s.startsWith("aio") && !imports[s] &&
          !Object.keys(imports).some((k) => s.startsWith(k + "/"))
        );
        if (unresolvable.length) {
          assert(
            unresolvable.every((s) => UNRESOLVABLE_OK.has(s)),
            `${sn.doc}:${sn.line} imports unknown specifier(s) ` +
              `${unresolvable.join(", ")} — not an aio entry, not stubbed`,
          );
          continue;
        }
        let rel: string;
        if (sn.declPath && !claimed.has(sn.declPath)) {
          claimed.add(sn.declPath);
          rel = sn.declPath;
        } else if (sn.declPath) {
          rel = sn.declPath.replace(/([\w-]+)\.(tsx?)$/, `$1.v${++sid}.$2`);
        } else {
          rel = `__s${++sid}.${sn.lang}`;
        }
        sn.file = `${dir}/${rel}`;
      }
      const projFiles = new Set(
        snippets.filter((s) => s.file).map((s) => s.file!),
      );
      // Pass 2 — write snippets; wire relative imports to same-doc files
      // (exact or extensionless via import map) or to permissive stubs.
      for (const sn of snippets) {
        if (!sn.file) continue;
        for (const m of sn.code.matchAll(REL_IMPORT_RE)) {
          const [, , clause, spec] = m;
          const resolved = new URL(spec!, `file://${sn.file}`).pathname;
          if (projFiles.has(resolved)) continue; // plain relative import works
          const hit = [".ts", ".tsx", "/index.ts", "/index.tsx"]
            .map((ext) => resolved + ext).find((p) => projFiles.has(p));
          if (hit) {
            imports[`file://${resolved}`] = `file://${hit}`;
            continue;
          }
          const stub = stubs.get(resolved) ??
            { names: new Set<string>(), hasDefault: false };
          const { names, hasDefault } = clauseNames(clause);
          for (const n of names) stub.names.add(n);
          stub.hasDefault ||= hasDefault;
          stubs.set(resolved, stub);
        }
        await Deno.mkdir(sn.file.slice(0, sn.file.lastIndexOf("/")), {
          recursive: true,
        });
        // An import-less complete block gets its imports synthesized on ONE
        // line, so file line N is doc line `sn.line + N - 2`.
        const head = sn.auto ? autoImportLine(sn.code, autoIndex) + "\n" : "";
        await Deno.writeTextFile(sn.file, head + sn.code);
        byFile.set(sn.file, sn);
        checkFiles.push(sn.file);
      }
    }

    await Deno.mkdir(`${tmp}/stubs`);
    let stubId = 0;
    for (const [resolved, req] of stubs) {
      const stubPath = `${tmp}/stubs/${++stubId}.ts`;
      await Deno.writeTextFile(
        stubPath,
        stubSource(req.names, req.hasDefault),
      );
      imports[`file://${resolved}`] = `file://${stubPath}`;
    }

    const repoCfg = JSON.parse(
      Deno.readTextFileSync(new URL("deno.json", ROOT)),
    ) as { compilerOptions: Record<string, unknown> };
    const { jsx, jsxImportSource, lib } = repoCfg.compilerOptions;
    await Deno.writeTextFile(
      `${tmp}/deno.json`,
      JSON.stringify(
        { imports, compilerOptions: { jsx, jsxImportSource, lib } },
        null,
        2,
      ),
    );

    assert(
      checkFiles.length > 50,
      `only ${checkFiles.length} snippets actually checked — skip logic broke?`,
    );
    // The import-less half is the half that shipped broken samples, and it is
    // the half a regex change can silently switch off. Counted separately so
    // "the gate went quiet" fails instead of passing.
    const autoCount = [...byFile.values()].filter((s) => s.auto).length;
    assert(
      autoCount > 60,
      `only ${autoCount} import-less snippets checked — COMPLETE_RE / ` +
        `OBJECT_MEMBER_RE / isFragment stopped seeing them?`,
    );

    const check = async () =>
      await new Deno.Command(Deno.execPath(), {
        args: ["check", "--config", `${tmp}/deno.json`, ...checkFiles],
        // NO_COLOR: the report is remapped by regex, and ANSI escapes sit
        // between the path and its `:line:col`.
        env: { NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();

    // ONE batched check — the aio graph is type-checked once for all snippets.
    let out = await check();
    let stderr = new TextDecoder().decode(out.stderr);

    // Pass 2, for import-less snippets only: a doc block routinely uses a cell
    // an EARLIER block defined (`counter`, `myCell`, `wallet`), or a helper the
    // prose describes in words. Those are elided context, not a lie — so the
    // names the compiler could not find are re-declared `any` (the same
    // permissive-stub policy unresolved relative imports already get) and the
    // batch is checked again. What survives is a claim about the aio API
    // itself, which is the class this gate exists to catch.
    if (!out.success) {
      const unknown = new Map<string, Set<string>>();
      for (
        const m of stderr.matchAll(
          /(?:Cannot find name '([\w$]+)'|No value exists in scope for the shorthand property '([\w$]+)')[\s\S]*?\n\s+at (file:\/\/[^\s:]+):\d+:\d+/g,
        )
      ) {
        const file = new URL(m[3]!).pathname;
        if (!byFile.get(file)?.auto) continue;
        (unknown.get(file) ?? unknown.set(file, new Set()).get(file)!)
          .add((m[1] ?? m[2])!);
      }
      if (unknown.size) {
        for (const [file, names] of unknown) {
          const sn = byFile.get(file)!;
          sn.stubbed = true;
          const body0 = await Deno.readTextFile(file);
          const decl = [...names].sort().map((n) =>
            // `connectCli<AppState>(…)` needs a stub with a type parameter —
            // a type argument on an `any`-typed callee is TS2347. Everything
            // else stays a plain `any`, which is assignable to the real
            // parameter types the surrounding aio call expects.
            new RegExp(`\\b${n}\\s*<[^<>()]*>\\s*\\(`).test(body0)
              ? `declare function ${n}<T = unknown>(...a: any[]): any; ` +
                `type ${n} = any;`
              : `declare const ${n}: any; type ${n} = any;`
          ).join(" ");
          await Deno.writeTextFile(
            file,
            `// deno-lint-ignore-file no-explicit-any\n${decl}\n${body0}`,
          );
        }
        out = await check();
        stderr = new TextDecoder().decode(out.stderr);
      }
    }

    if (!out.success) {
      // Point at the DOC line, not the temp file's — a snippet's line N is
      // doc line `sn.line + N - 1`, less the synthesized preamble lines.
      let report = stderr;
      for (const [path, sn] of byFile) {
        const off = (sn.auto ? 1 : 0) + (sn.stubbed ? 2 : 0);
        report = report.replaceAll(
          new RegExp(
            `file://${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}:(\\d+):(\\d+)`,
            "g",
          ),
          (_m, l: string, c: string) =>
            `${sn.doc}:${sn.line + Number(l) - 1 - off}:${c}`,
        );
        report = report.replaceAll(
          `file://${path}`,
          `${sn.doc} (snippet at line ${sn.line})`,
        );
      }
      assert(
        false,
        `doc code snippet(s) fail deno check — copy-pasting these docs ` +
          `breaks:\n${report}\n` +
          `Fix the sample (keep its teaching intent). For a true fragment ` +
          `only, add \`// snippet: fragment\` as its first line.`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
