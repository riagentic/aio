// Every option, one page (feedback/frustration.md F9).
//
// The docs are ~280k words over 200+ pages, and an agent looks things up by
// NAME. This writes docs/basics/every-option.md: every `cell({ … })` option,
// every `aio.run({ … })` option and every `aio/air` export — signature, one
// line, an example when the source has one — generated from the source's own
// types and JSDoc, so it cannot drift from the code.
//
//   deno task update:reference            regenerate the page
//   deno task update:reference -- --check the release gate: fails when
//                                         the page is stale, an entry has no
//                                         one-line doc, or the count of
//                                         entries without an example rose
//
// The one line is REQUIRED (a name with no sentence is a wall). The example is
// a ratchet: MAX_WITHOUT_EXAMPLE may only go down — add an `@example` to the
// JSDoc and lower it.

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = "docs/basics/every-option.md";

/** Entries with no example today. Lower it when you add one; never raise it. */
const MAX_WITHOUT_EXAMPLE = 128;

// deno-lint-ignore no-explicit-any
type Json = any;

type Entry = {
  name: string;
  signature: string;
  line: string;
  example?: string;
  /** The example's fence language (`tsx` stays `tsx`). */
  exampleLang?: string;
  file: string;
};

type Section = { title: string; intro: string; entries: Entry[] };

// ─── Types → text ───────────────────────────────────────────────────────────

const MAX_TYPE = 90;

/** A deno-doc type node as TypeScript text — short, never wrong: a shape too
 *  long to read in one line is cut with `…`, not paraphrased. */
export function typeText(t: Json): string {
  if (!t) return "unknown";
  const full = rawType(t);
  return full.length > MAX_TYPE ? full.slice(0, MAX_TYPE - 1) + "…" : full;
}

function rawType(t: Json): string {
  if (!t) return "unknown";
  switch (t.kind) {
    case "keyword":
      return t.value;
    case "literal":
      // `repr` drops a string literal's quotes: `"client" | "server"` came
      // out as `client | server`, which reads as two type names.
      return t.value?.kind === "string"
        ? JSON.stringify(t.value.string)
        : t.value?.kind === "template"
        ? t.repr ? `\`${t.repr}\`` : "string"
        : t.repr || String(t.value?.number ?? t.value?.boolean);
    case "typeRef": {
      const args = t.value.typeParams?.length
        ? `<${t.value.typeParams.map(rawType).join(", ")}>`
        : "";
      return t.value.typeName + args;
    }
    case "union":
      return t.value.map(rawType).join(" | ");
    case "intersection":
      return t.value.map(rawType).join(" & ");
    case "array":
      return `${rawType(t.value)}[]`;
    case "tuple":
      return `[${t.value.map(rawType).join(", ")}]`;
    case "parenthesized":
      return `(${rawType(t.value)})`;
    case "optional":
      return `${rawType(t.value)}?`;
    case "rest":
      return `...${rawType(t.value)}`;
    case "typeOperator":
      return `${t.value.operator} ${rawType(t.value.tsType)}`;
    case "typeQuery":
      return `typeof ${t.repr || t.value}`;
    case "indexedAccess":
      return `${rawType(t.value.objType)}[${rawType(t.value.indexType)}]`;
    case "fnOrConstructor":
      return `(${paramsText(t.value.params)}) => ${rawType(t.value.tsType)}`;
    case "typeLiteral": {
      const keys = [
        ...(t.value.properties ?? []).map((p: Json) =>
          p.name + (p.optional ? "?" : "")
        ),
        ...(t.value.methods ?? []).map((m: Json) => `${m.name}()`),
      ];
      return keys.length ? `{ ${keys.join("; ")} }` : "{}";
    }
    case "conditional":
      return `${rawType(t.value.checkType)} extends ${
        rawType(t.value.extendsType)
      } ? … : …`;
    case "mapped": {
      const tp = t.value.typeParam;
      return `{ [${tp.name} in ${rawType(tp.constraint)}]${
        t.value.optional ? "?" : ""
      }: ${rawType(t.value.tsType)} }`;
    }
    case "typePredicate":
      return `${t.value.param?.name ?? "x"} is ${rawType(t.value.type)}`;
    case "this":
      return "this";
    default:
      return t.repr || "…";
  }
}

function paramText(p: Json): string {
  switch (p.kind) {
    case "identifier":
      return p.tsType
        ? `${p.name}${p.optional ? "?" : ""}: ${rawType(p.tsType)}`
        : p.name;
    case "rest":
      return `...${paramText(p.arg)}`;
    case "assign":
      return p.left.tsType
        ? paramText(p.left).replace(/: /, "?: ")
        : `${paramText(p.left)}?`;
    case "object":
      return `{ ${
        (p.props ?? []).map((x: Json) => x.key ?? x.name ?? "…").join(", ")
      } }${p.tsType ? `: ${rawType(p.tsType)}` : ""}`;
    case "array":
      return "[…]";
    default:
      return "…";
  }
}

function typeParamsText(tps: Json[] = []): string {
  return tps.length ? `<${tps.map((tp) => tp.name).join(", ")}>` : "";
}

function paramsText(ps: Json[] = []): string {
  return ps.map(paramText).join(", ");
}

// ─── JSDoc → one line + example ─────────────────────────────────────────────

/** The first paragraph, on one line, and at most two sentences. */
export function oneLine(doc: string | undefined): string {
  if (!doc) return "";
  const para = doc.split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim();
  const cut = para.match(/^(.{40,}?[.!?])\s(?=[A-Z`(])/);
  return (cut ? cut[1]! : para).replace(/\{@link(?:code)? ([^}]+)\}/g, "`$1`");
}

/** An `@example` tag, else the first fenced block in the doc body. */
export function exampleOf(jsDoc: Json): string | undefined {
  const tag = jsDoc?.tags?.find((t: Json) => t.kind === "example")?.doc;
  const text: string | undefined = tag ?? jsDoc?.doc;
  const fence = text?.match(/```(\w*)\n([\s\S]*?)```/);
  const body = fence ? fence[2]! : tag;
  return body?.trim() ? dedent(body) : undefined;
}

/** The example's fence language — `tsx` stays `tsx` (the snippet checker
 *  and a reader's editor both need it); `ts` when none is given. */
export function exampleLangOf(jsDoc: Json): string {
  const tag = jsDoc?.tags?.find((t: Json) => t.kind === "example")?.doc;
  const text: string | undefined = tag ?? jsDoc?.doc;
  return text?.match(/```(\w+)\n/)?.[1] ?? "ts";
}

/** Remove the indent every non-blank line shares (JSDoc keeps a space). */
export function dedent(text: string): string {
  const lines = text.replace(/^\n+|\s+$/g, "").split("\n");
  const pad = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length),
  );
  return lines.map((l) => l.slice(pad)).join("\n");
}

// ─── Source → entries ───────────────────────────────────────────────────────

async function docJson(path: string): Promise<Json[]> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", path],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `deno doc --json ${path} failed:\n${new TextDecoder().decode(stderr)}`,
    );
  }
  const parsed = JSON.parse(new TextDecoder().decode(stdout));
  return Object.values(parsed.nodes as Record<string, Json>).flatMap((m) =>
    m.symbols
  );
}

const rel = (loc: Json): string =>
  String(loc?.filename ?? "").replace(`file://${ROOT}`, "");

/** Properties of an exported object type, public ones only. */
export function optionsOf(sym: Json): Entry[] {
  const decl = sym.declarations[0];
  const props: Json[] = decl.def.tsType?.value?.properties ?? [];
  return props
    .filter((p) => !p.name.startsWith("_") && !isDeprecated(p.jsDoc))
    .map((p) => ({
      name: p.name,
      signature: `${p.name}${p.optional ? "?" : ""}: ${typeText(p.tsType)}`,
      line: oneLine(p.jsDoc?.doc),
      example: exampleOf(p.jsDoc),
      exampleLang: exampleLangOf(p.jsDoc),
      file: rel(p.location),
    }));
}

function isDeprecated(jsDoc: Json): boolean {
  return jsDoc?.tags?.some((t: Json) => t.kind === "deprecated") ?? false;
}

/** Callable exports (functions, components, consts) of an entry module. */
export function exportsOf(syms: Json[]): Entry[] {
  return syms
    .filter((s) =>
      ["function", "variable"].includes(s.declarations[0].kind) &&
      !s.name.startsWith("_") &&
      !isDeprecated(s.declarations[0].jsDoc)
    )
    .map((s) => {
      const decls: Json[] = s.declarations;
      const withDoc = decls.find((d) => d.jsDoc?.doc) ?? decls[0];
      const sigs = [
        ...new Set(
          decls.map((d) =>
            d.kind === "function"
              ? `${s.name}${typeParamsText(d.def.typeParams)}(${
                paramsText(d.def.params)
              }): ${typeText(d.def.returnType)}`
              : `${s.name}: ${typeText(d.def.tsType)}`
          ),
        ),
      ];
      return {
        name: s.name,
        signature: sigs.join("\n"),
        line: oneLine(withDoc.jsDoc?.doc),
        example: exampleOf(withDoc.jsDoc),
        exampleLang: exampleLangOf(withDoc.jsDoc),
        file: rel(withDoc.location),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Entries → page ─────────────────────────────────────────────────────────

export function renderPage(sections: Section[]): string {
  const total = sections.reduce((n, s) => n + s.entries.length, 0);
  const out = [
    "# Every option, one page",
    "",
    `> Generated from the source by \`deno task update:reference\` — do not edit`,
    `> by hand; \`check:release\` fails when it is stale. ${total} entries: the`,
    "> signature, what it does, an example when the source has one, and the",
    "> file it lives in. The guides explain; this page is for looking a name up.",
    "",
    ...sections.map((s) =>
      `- [${s.title}](#${anchor(s.title)}) — ${s.entries.length}`
    ),
    "",
  ];
  for (const s of sections) {
    out.push(`## ${s.title}`, "", s.intro, "");
    for (const e of s.entries) {
      out.push(`### \`${e.name}\``, "", "```ts", e.signature, "```", "");
      out.push(`${e.line} <sub>${e.file}</sub>`, "");
      if (e.example) {
        out.push("```" + (e.exampleLang ?? "ts"), e.example, "```", "");
      }
    }
  }
  return out.join("\n");
}

/** The heading anchor GitHub (and the docs site) derive from a title. */
export function anchor(title: string): string {
  return title.toLowerCase().replace(/[^\w\- ]/g, "").trim().replace(
    / /g,
    "-",
  );
}

/** What is wrong with the entries, as lines — empty when nothing is. */
export function problems(sections: Section[], maxNoExample: number): string[] {
  const all = sections.flatMap((s) =>
    s.entries.map((e) => ({ ...e, where: s.title }))
  );
  const noLine = all.filter((e) => !e.line).map((e) =>
    `no one-line doc: ${e.where} › ${e.name} (${e.file}) — add a JSDoc sentence`
  );
  const noExample = all.filter((e) => !e.example).length;
  return noExample > maxNoExample
    ? [
      ...noLine,
      `${noExample} entries have no example, the ceiling is ${maxNoExample} — ` +
      `add an \`@example\` to the new one's JSDoc`,
    ]
    : noLine;
}

async function fmtMarkdown(text: string): Promise<string> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--ext=md", "-"],
    cwd: ROOT,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(text));
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`deno fmt failed:\n${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout);
}

async function sections(): Promise<Section[]> {
  const cfg = await docJson("src/state/cell-config-types.ts");
  const run = await docJson("src/server/aio-types.ts");
  const air = await docJson("src/air.ts");
  const find = (syms: Json[], name: string) => {
    const s = syms.find((x) => x.name === name);
    if (!s) throw new Error(`gen-reference: ${name} not found — renamed?`);
    return s;
  };
  return [
    {
      title: "cell options",
      intro: "`cell(name, { … })` — the keys a cell takes. " +
        "Guide: [cells](../state/cells.md).",
      entries: optionsOf(find(cfg, "MethodsCellConfig")),
    },
    {
      title: "aio.run options",
      intro: "`aio.run({ … })` — the keys an app takes. " +
        "Guide: [lifecycle](../state/lifecycle.md).",
      entries: optionsOf(find(run, "CellsConfig")),
    },
    {
      title: "aio/air",
      intro: '`import { … } from "aio/air"` — hooks, components and ' +
        "helpers for the UI. Guide: [AIR](../ui/air-setup.md), " +
        "[React hooks](../ui/react.md).",
      entries: exportsOf(air),
    },
  ];
}

if (import.meta.main) {
  const secs = await sections();
  const bad = problems(secs, MAX_WITHOUT_EXAMPLE);
  const noExample = secs.flatMap((s) => s.entries).filter((e) => !e.example)
    .length;
  // Through `deno fmt` here, not after: the page is under `deno fmt --check`
  // too, and a page fmt rewrites could never pass this check again.
  const page = await fmtMarkdown(renderPage(secs));
  const path = ROOT + OUT;
  if (Deno.args.includes("--check")) {
    const onDisk = await Deno.readTextFile(path).catch(() => "");
    const stale = onDisk !== page
      ? [`${OUT} is stale — run \`deno task update:reference\``]
      : [];
    const all = [...bad, ...stale];
    if (noExample < MAX_WITHOUT_EXAMPLE) {
      all.push(
        `only ${noExample} entries lack an example — lower ` +
          `MAX_WITHOUT_EXAMPLE in scripts/gen-reference.ts to ${noExample}`,
      );
    }
    if (all.length) {
      console.error(`✗ every-option reference:\n  ${all.join("\n  ")}`);
      Deno.exit(1);
    }
    console.log(`✓ ${OUT} is current (${noExample} without an example)`);
  } else {
    await Deno.writeTextFile(path, page);
    console.log(`✓ wrote ${OUT}`);
    if (bad.length) console.error(`⚠ ${bad.join("\n⚠ ")}`);
  }
}
