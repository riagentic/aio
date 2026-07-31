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
// no ellipsis markers. Escape hatches (use SPARINGLY): fence info `no-check`,
// or the literal first line `// snippet: fragment` for true fragments.
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
    if (!/(?:import|export)[^\n]*from\s*["'](?:aio|\.)/.test(code!)) continue;
    if (isFragment(code!)) continue;
    const first = code!.trimStart().split("\n", 1)[0]!.trim();
    out.push({
      doc,
      line: text.slice(0, m.index).split("\n").length + 1,
      lang: lang as "ts" | "tsx",
      code: code!,
      declPath: first.match(DECL_PATH_RE)?.[1],
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
        await Deno.writeTextFile(sn.file, sn.code);
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

    // ONE batched check — the aio graph is type-checked once for all snippets.
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--config", `${tmp}/deno.json`, ...checkFiles],
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (!out.success) {
      // Remap temp snippet paths back to doc + fence line for the report.
      let report = new TextDecoder().decode(out.stderr);
      for (const [path, sn] of byFile) {
        report = report.replaceAll(
          `file://${path}`,
          `${sn.doc} (snippet at line ${sn.line}; error line is relative)`,
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
