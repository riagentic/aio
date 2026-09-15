// `am agent` is the one page a model reads instead of the docs, so every fact
// on it is gated here against the thing it describes — never trusted:
//
//   · every `--flag` shown after `am <verb>` is accepted by THAT verb (am's own
//     flag table for gated verbs, the forwarding target's parser for the
//     PASSTHROUGH ones), and a scoped global flag only appears on a verb that
//     reads it;
//   · every `deno task <name>` is a task `am create` scaffolds, and every flag
//     shown after `deno task dev|build|compile` is one that process parses;
//   · the template / target tables are exactly the scaffolder's;
//   · the scaffolded layout the page describes is what `scaffold()` writes;
//   · `am expect` operators and `am trigger` actions are exactly the CLI's;
//   · every code snippet TYPE-CHECKS against the repo's real entries, and the
//     test snippet RUNS; every API name exists on the entry it is listed
//     under; the `cell()` / `aio.run()` / `ui` key tables are real keys AND
//     complete (a key the brief does not cover fails here);
//   · every call-like identifier and JSX component in the prose is a real
//     export (or a documented config key / placeholder);
//   · every `docs/…` page and `examples/…` directory it points at exists.
//
// A brief that names something aio does not have sends the reader to a dead
// end with full confidence; this file is what keeps that from shipping.
import { assert, assertEquals } from "@std/assert";
import {
  agentBrief,
  agentsMdScaffold,
  BRIEF_API,
  BRIEF_CELL_OPTIONS,
  BRIEF_RUN_KEYS,
  BRIEF_SECTIONS,
  BRIEF_SNIPPETS,
  BRIEF_TARGETS,
  BRIEF_TEMPLATES,
  BRIEF_UI_KEYS,
} from "../src/am/am-agent-text.ts";
import {
  GLOBAL_FLAGS,
  PASSTHROUGH,
  SCOPED_GLOBAL_FLAGS,
  VERB_FLAGS,
} from "../src/am/am-flags.ts";
import { CREATE_FLAGS, TARGETS, TEMPLATES } from "../src/am/am-help-text.ts";
import { DISPLAY_FLAG } from "../src/am/am-display.ts";
import { AIO_RUNTIME_FLAGS } from "../src/diagnostics/runtime-flags.ts";
import { scaffold, standardTasks } from "../src/am/am-cmd-create.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));
const ALL = agentBrief({ version: "test", task: "all" });
const SCAFFOLD = agentsMdScaffold("demo");
const body = (slug: string) =>
  BRIEF_SECTIONS.find((s) => s.slug === slug)!.body;

// ── flags, per verb ─────────────────────────────────────────────────────────

/** `am <verb> …` occurrences, each with the flags written in ITS segment. A
 *  segment ends where the prose moves on: the next `am <verb>`, a ` · `
 *  separator, a run of 2+ spaces (a description column), an opening paren
 *  (an aside), ` — `, `;` or `→`. Flags in an aside are not claimed for the
 *  verb (the whole-text check below still requires them to exist). */
/** A `--flag` as written (not a CSS custom property like `--aio-*`). */
const FLAG_RE = /(?<![\w-])(--[a-z][a-z0-9-]*[a-z0-9])(?![\w*-])/g;

function amSegments(
  text: string,
): { verb: string; flags: string[]; at: string }[] {
  const out: { verb: string; flags: string[]; at: string }[] = [];
  for (const line of text.split("\n")) {
    const hits = [...line.matchAll(/\bam ([a-z][a-zA-Z]*)/g)];
    for (const [i, m] of hits.entries()) {
      const start = m.index! + m[0].length;
      const next = hits[i + 1]?.index ?? line.length;
      let seg = line.slice(start, next);
      const stop = seg.search(/ · | {2,}|\(| — |;|→/);
      if (stop !== -1) seg = seg.slice(0, stop);
      const flags = [...seg.matchAll(FLAG_RE)].map((f) => f[1]!);
      out.push({ verb: m[1]!, flags, at: line.trim() });
    }
  }
  return out;
}

/** Does a source file parse this flag? The spellings aio's parsers use:
 *  `"--x"`, `--x=`, `flag("x")`, or an alternation inside a flag regex. */
function sourceParses(src: string, flag: string): boolean {
  const bare = flag.slice(2);
  return src.includes(`"${flag}"`) || src.includes(`${flag}=`) ||
    src.includes(`flag("${bare}")`) || src.includes(`${flag}|`) ||
    src.includes(`|${flag})`);
}

/** Where a PASSTHROUGH verb's surplus flags go — the parser that owns them. */
const PASSTHROUGH_SOURCES: Record<string, string[]> = {
  start: ["src/am/am-cmd-process.ts"],
  restart: ["src/am/am-cmd-process.ts"],
  watch: ["src/am/am-cmd-process.ts"],
  dev: ["src/am/am-cmd-build.ts"],
  build: ["src/build-all.ts", "src/am/am-cmd-build.ts"],
  compile: ["src/build-all.ts", "src/am/am-cmd-build.ts"],
  publish: ["src/am/am-cmd-publish.ts"],
  auth: ["src/am/am-cmd-auth.ts"],
  fix: ["src/am/am-cmd-fix.ts"],
  lab: ["src/am/am-cmd-lab.ts"],
};

/** am's own globals. `--instance` is consumed by `parseGlobalFlags` (and
 *  applied in am.ts) without being in GLOBAL_FLAGS — read from the parser so
 *  this stays a fact rather than an exception. */
function amGlobals(): Set<string> {
  const g = new Set(GLOBAL_FLAGS);
  if (read("src/am/am-utils.ts").includes(`"--instance"`)) g.add("--instance");
  return g;
}

Deno.test("am agent: every flag shown after `am <verb>` is accepted by that verb", () => {
  const globals = amGlobals();
  const segments = amSegments(ALL + "\n" + SCAFFOLD);
  const checked = segments.filter((s) => s.flags.length > 0);
  assert(
    checked.length > 40,
    `only ${checked.length} verb+flag segments — parser broke?`,
  );
  const bad: string[] = [];
  for (const { verb, flags, at } of checked) {
    for (const f of flags) {
      if (verb in PASSTHROUGH) {
        const ok = globals.has(f) ||
          (verb === "create" &&
            CREATE_FLAGS.some((c) => c.replace(/[=[].*$/, "") === f)) ||
          (["start", "restart", "watch", "dev"].includes(verb) &&
            (AIO_RUNTIME_FLAGS.has(f) || f === DISPLAY_FLAG)) ||
          (PASSTHROUGH_SOURCES[verb] ?? []).some((p) =>
            sourceParses(read(p), f)
          );
        if (!ok) bad.push(`am ${verb} ${f}   ← ${at}`);
        continue;
      }
      const own = VERB_FLAGS[verb];
      if (!own) {
        bad.push(`am ${verb}: verb has no flag table   ← ${at}`);
        continue;
      }
      if (!globals.has(f) && !own.includes(f)) {
        bad.push(`am ${verb} ${f} (not accepted)   ← ${at}`);
        continue;
      }
      const readers = SCOPED_GLOBAL_FLAGS[f];
      if (readers && !readers.includes(verb)) {
        bad.push(`am ${verb} ${f} (does nothing for ${verb})   ← ${at}`);
      }
    }
  }
  assertEquals(bad, [], "am agent shows flags the verb does not take");
});

Deno.test("am agent: `deno task` names and their flags are real", () => {
  const tasks = new Set([
    ...Object.keys(standardTasks(true, "electron")),
    ...Object.keys(standardTasks(true, "android")),
  ]);
  const buildSrc = read("src/build-all.ts");
  const bad: string[] = [];
  let seen = 0;
  for (const line of ALL.split("\n")) {
    for (const m of line.matchAll(/deno task ([a-z][a-z:-]*)([^·(;→]*)/g)) {
      seen++;
      const [name, rest] = [m[1]!, m[2]!.split(/ {2,}/)[0]!];
      if (!tasks.has(name)) bad.push(`deno task ${name}   ← ${line.trim()}`);
      for (const f of rest.matchAll(FLAG_RE)) {
        const flag = f[1]!;
        const ok = name === "dev"
          ? AIO_RUNTIME_FLAGS.has(flag)
          : ["build", "compile"].includes(name)
          ? sourceParses(buildSrc, flag)
          : true;
        if (!ok) bad.push(`deno task ${name} ${flag}   ← ${line.trim()}`);
      }
    }
  }
  assert(seen > 10, `only ${seen} deno task mentions — regex broke?`);
  assertEquals(
    bad,
    [],
    "am agent names tasks/flags a scaffolded app does not have",
  );
});

Deno.test("am agent: every flag anywhere in the brief is parsed by something", () => {
  const known = amGlobals();
  for (const f of Object.values(VERB_FLAGS).flat()) known.add(f);
  for (const c of CREATE_FLAGS) known.add(c.replace(/[=[].*$/, ""));
  for (const f of AIO_RUNTIME_FLAGS) known.add(f);
  known.add(DISPLAY_FLAG);
  const sources = [
    ...new Set(Object.values(PASSTHROUGH_SOURCES).flat()),
    "src/server/aio-cli.ts",
    // Brief documents `aiol --safe-fix` on purpose; that flag lives here.
    "aiol/mod.ts",
  ].map(read);
  // Flags that belong to OTHER programs, shown on purpose: Electron's own
  // switch (passed through AIO_ELECTRON_ARGS).
  const foreign = new Set(["--disable-gpu"]);
  const shown = [
    ...new Set(
      [...(ALL + SCAFFOLD).matchAll(FLAG_RE)].map((m) => m[1]!),
    ),
  ];
  assert(
    shown.length > 60,
    `brief shows too few flags to be checking: ${shown.length}`,
  );
  const orphans = shown.filter((f) =>
    !known.has(f) && !foreign.has(f) && !sources.some((s) => sourceParses(s, f))
  );
  assertEquals(orphans, [], "am agent shows flags nothing parses");
});

// ── tables that mirror the CLI ─────────────────────────────────────────────

Deno.test("am agent: templates and targets are exactly the scaffolder's", () => {
  assertEquals(Object.keys(BRIEF_TEMPLATES).sort(), [...TEMPLATES].sort());
  assertEquals(Object.keys(BRIEF_TARGETS).sort(), [...TARGETS].sort());
  const page = body("new");
  assert(TEMPLATES.length >= 2 && TARGETS.length >= 2);
  for (const t of TEMPLATES) {
    assert(page.includes(`${t} ${BRIEF_TEMPLATES[t]}`), t);
  }
  for (const t of TARGETS) assert(page.includes(`${t} ${BRIEF_TARGETS[t]}`), t);
  const shown = [...ALL.matchAll(/--template=([a-z]+)/g)].map((m) => m[1]!);
  assertEquals(
    shown.filter((n) => !(TEMPLATES as readonly string[]).includes(n)),
    [],
    "--template=<name> shown that the scaffolder refuses",
  );
});

Deno.test("am agent: the layout it describes is what am create writes", () => {
  const files = Object.keys(scaffold("demo", "counter", true));
  const page = body("new");
  const scaffoldLine = page.slice(
    page.indexOf("2 layout"),
    page.indexOf("3 tasks"),
  );
  const described = [
    ...new Set(
      [...scaffoldLine.matchAll(
        /\b((?:src|tests)\/[\w.]+\.tsx?|AGENTS\.md|CLAUDE\.md|deno\.json)\b/g,
      )]
        .map((m) => m[1]!),
    ),
  ];
  assert(described.length >= 6, `layout names too few files: ${described}`);
  assertEquals(
    described.filter((f) => !files.includes(f)),
    [],
    "layout names files am create does not write",
  );
  // …and every file the scaffold writes (bar dotfiles/README) is described.
  const undocumented = files.filter((f) =>
    !f.startsWith(".") && f !== "README.md" && !described.includes(f)
  );
  assertEquals(
    undocumented,
    [],
    "am create writes files the brief never explains",
  );
});

Deno.test("am agent: expect operators and trigger actions are the CLI's", () => {
  const stateSrc = read("src/am/am-cmd-state.ts");
  const ops = [
    ...stateSrc.slice(
      stateSrc.indexOf("const EXPECT_OPS"),
      stateSrc.indexOf("] as const"),
    )
      .matchAll(/"([a-z]+)"/g),
  ].map((m) => m[1]!);
  const shownOps = /am expect <path> ([a-z|]+)/.exec(body("tasks"))![1]!.split(
    "|",
  );
  assertEquals(shownOps.sort(), ops.sort());

  const inspect = read("src/am/am-cmd-inspect.ts");
  const from = inspect.indexOf("const actions = new Set([");
  const actions = [
    ...inspect.slice(from, inspect.indexOf("]);", from)).matchAll(
      /"([a-zA-Z]+)"/g,
    ),
  ]
    .map((m) => m[1]!);
  const tasks = body("tasks");
  const at = tasks.indexOf(`am trigger [idx] "App:AddButton" `);
  assert(at !== -1, "trigger line moved");
  const shownActions = tasks.slice(at).split("[text]")[0]!
    .replace(`am trigger [idx] "App:AddButton" `, "")
    .replace(/\s+/g, "")
    .split("|");
  assertEquals(shownActions.sort(), actions.sort());
});

// ── code and API, against the real compiler ────────────────────────────────

/** Import map: every published `aio/*` entry → the repo, plus the repo's own
 *  third-party imports (the same map `tests/docs-snippets-check.test.ts`
 *  builds). */
function importMap(): Record<string, string> {
  const cfg = JSON.parse(read("deno.json")) as {
    exports: Record<string, string>;
    imports: Record<string, string>;
    compilerOptions: Record<string, unknown>;
  };
  const imports: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.exports)) {
    imports[k === "." ? "aio" : "aio/" + k.slice(2)] = new URL(v, ROOT).href;
  }
  for (const [k, v] of Object.entries(cfg.imports)) {
    imports[k] ??= v.startsWith("./") ? new URL(v, ROOT).href : v;
  }
  return imports;
}

/** Leading identifier of an annotated key entry (`port (free by default)`). */
const keyOf = (entry: string) => /^[A-Za-z]+/.exec(entry)![0];

function keysCheckSource(): string {
  const cellKeys = BRIEF_CELL_OPTIONS.flatMap((o) => o.keys);
  const runKeys = BRIEF_RUN_KEYS.flatMap((g) => g.keys.map(keyOf));
  const uiKeys = BRIEF_UI_KEYS.map(keyOf);
  const both = (name: string, type: string, list: string[]) =>
    `const ${name} = ${JSON.stringify(list)} as const;\n` +
    `const _${name}Real: readonly (${type})[] = ${name};\n` +
    // `_`-prefixed keys are framework-internal plumbing, not app-facing.
    `type ${name}Missing = Exclude<${type}, typeof ${name}[number] | \`_\${string}\`>;\n` +
    // On failure the compiler prints the uncovered keys as the target type.
    `const _${name}All: [${name}Missing] extends [never] ? true : ` +
    `Exclude<${type}, typeof ${name}[number] | \`_\${string}\`> = true;\n`;
  return `import type { CellsConfig, MethodsCellConfig, UiConfig } from "aio";\n` +
    both(
      "cellKeys",
      "keyof MethodsCellConfig<string, Record<string, unknown>>",
      cellKeys,
    ) +
    both("runKeys", "keyof CellsConfig", runKeys) +
    both("uiKeys", "keyof UiConfig", uiKeys) +
    `export {};\n`;
}

Deno.test({
  name:
    "am agent: every snippet type-checks, the test snippet runs, every API name and key is real",
  // Two child processes against the full aio graph — cached type-check, a few
  // seconds warm; generous for a cold cache.
  sanitizeResources: true,
  fn: async () => {
    const dir = await tempDir("am-agent-snippets");
    try {
      const cfg = JSON.parse(read("deno.json")) as {
        compilerOptions: Record<string, unknown>;
      };
      const { jsx, jsxImportSource, lib } = cfg.compilerOptions;
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify({
          imports: importMap(),
          compilerOptions: { jsx, jsxImportSource, lib },
        }),
      );
      const files: string[] = [];
      for (const s of BRIEF_SNIPPETS) {
        const path = `${dir}/${s.path}`;
        await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(path, s.code);
        files.push(path);
      }
      // One file per entry: the same name may live on two (aio's SQL `table`,
      // aio/cli's `table`), and each claim is about ITS entry.
      for (const [i, g] of BRIEF_API.entries()) {
        await Deno.writeTextFile(
          `${dir}/api-${i}.ts`,
          `import type { ${
            g.names.join(", ")
          } } from "${g.entry}";\nexport {};\n`,
        );
        files.push(`${dir}/api-${i}.ts`);
      }
      await Deno.writeTextFile(`${dir}/keys.ts`, keysCheckSource());
      files.push(`${dir}/keys.ts`);

      const run = (args: string[]) =>
        new Deno.Command(Deno.execPath(), {
          args,
          cwd: dir,
          env: {
            ...Deno.env.toObject(),
            NO_COLOR: "1",
            AIO_APPS_DIR: `${dir}/.apps`,
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
      const dec = new TextDecoder();

      const checked = await run([
        "check",
        "--config",
        `${dir}/deno.json`,
        ...files,
      ]);
      assert(
        checked.success,
        `brief snippets / API names / key tables do not type-check:\n` +
          dec.decode(checked.stderr).split(dir).join("<brief>"),
      );

      const runnable = BRIEF_SNIPPETS.filter((s) => s.run).map((s) =>
        `${dir}/${s.path}`
      );
      assert(
        runnable.length > 0,
        "no runnable snippet — the test sample is unproven",
      );
      const tested = await run([
        "test",
        "-A",
        "--config",
        `${dir}/deno.json`,
        ...runnable,
      ]);
      const out = dec.decode(tested.stdout) + dec.decode(tested.stderr);
      assert(tested.success, `the brief's test snippet fails:\n${out}`);
      // deno colours the summary (`ok` is green); strip SGR so the contract
      // is the words, not the paint.
      // deno-lint-ignore no-control-regex
      const plain = out.replace(/\u001b\[[0-9;]*m/g, "");
      assert(
        /ok \| [1-9]\d* passed \| 0 failed/.test(plain),
        `no tests ran:\n${out}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

/** VALUE exports of an entry, following `export * from` — parsed from source
 *  (aio/air and aio/ui are browser modules; evaluating them needs a DOM). */
function valueExports(file: URL, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(file.href)) return out;
  seen.add(file.href);
  const src = Deno.readTextFileSync(file);
  for (const m of src.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    if (m[1]) continue;
    for (const part of m[2]!.split(",")) {
      const t = part.replace(/\/\*[\s\S]*?\*\//g, "").trim();
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
    for (const n of valueExports(new URL(m[1]!, file), seen)) out.add(n);
  }
  return out;
}

Deno.test("am agent: every call-like name and JSX component in the prose is real", () => {
  const cfg = JSON.parse(read("deno.json")) as {
    exports: Record<string, string>;
  };
  const known = new Set<string>();
  for (const path of Object.values(cfg.exports)) {
    for (const n of valueExports(new URL(path, ROOT))) known.add(n);
  }
  assert(
    known.has("cell") && known.has("useLocal") && known.has("Button"),
    "export scan broke",
  );
  for (const o of BRIEF_CELL_OPTIONS) for (const k of o.keys) known.add(k);
  for (const g of BRIEF_RUN_KEYS) for (const k of g.keys) known.add(keyOf(k));
  // Names the snippets declare themselves.
  for (const s of BRIEF_SNIPPETS) {
    for (
      const m of s.code.matchAll(
        /(?:function|const|let|class)\s+\[?(\w+)(?:,\s*(\w+))?/g,
      )
    ) {
      known.add(m[1]!);
      if (m[2]) known.add(m[2]);
    }
    for (const m of s.code.matchAll(/^\s+(?:async\s+)?(\w+)\(/gm)) {
      known.add(m[1]!);
    }
  }
  // The language's own, and placeholders the prose uses for "your component".
  const builtin = new Set([
    "import",
    "fetch",
    "setTimeout",
    "setInterval",
    "Error",
    "Promise",
  ]);
  const placeholders = new Set(["Kid", "U"]);

  const prose = BRIEF_SECTIONS.map((s) => s.body).join("\n")
    // the snippets are compiled for real above; scan only what is not code
    .split("\n").filter((l) =>
      !/^ {2}(?:\/\/ |import |export |[ \w].*[;{}]$)/.test(l) || l.includes("·")
    )
    .join("\n");
  const calls = [
    ...new Set(
      [...prose.matchAll(/(?<![.$\w])([A-Za-z_]\w*)\(/g)].map((m) => m[1]!),
    ),
  ];
  const components = [
    ...new Set(
      [...prose.matchAll(/(?<![\w])<([A-Z]\w*)(?=[\s/>])/g)].map((m) => m[1]!),
    ),
  ];
  assert(calls.length > 40, `only ${calls.length} call-like names scanned`);
  const unknown = [
    ...calls.filter((c) => !known.has(c) && !builtin.has(c)),
    ...components.filter((c) => !known.has(c) && !placeholders.has(c)).map((
      c,
    ) => `<${c}>`),
  ];
  assertEquals(
    unknown,
    [],
    "am agent names functions/components aio does not export",
  );
});

Deno.test("am agent: every docs page and example it points at exists", () => {
  const exists = (rel: string) => {
    try {
      Deno.statSync(new URL(rel, ROOT));
      return true;
    } catch {
      return false;
    }
  };
  const missing: string[] = [];
  let count = 0;
  for (const line of ALL.split("\n")) {
    for (const m of line.matchAll(/(?<![\w/])(docs\/[\w./-]*[\w/])/g)) {
      count++;
      if (!exists(m[1]!)) missing.push(m[1]!);
    }
    // `docs/state/   methods · scheduling` — the bare names are pages of that dir
    const dir = /^\s+(docs\/[\w-]+\/)\s{2,}(.*)$/.exec(line);
    if (dir) {
      for (const name of dir[2]!.split(/ · |\s{2,}/)) {
        const page = /^([a-z0-9-]+)(?:\s|$)/.exec(name.trim())?.[1];
        if (page) {
          count++;
          if (!exists(`${dir[1]}${page}.md`)) {
            missing.push(`${dir[1]}${page}.md`);
          }
        }
      }
    }
    const ex = /^\s+examples\/\s{2,}(.*)$/.exec(line);
    if (ex) {
      for (const name of ex[1]!.split(" · ")) {
        const d = /^([a-z0-9-]+)/.exec(name.trim())?.[1];
        if (d && !exists(`examples/${d}`)) missing.push(`examples/${d}`);
      }
    }
  }
  assert(count > 30, `only ${count} doc references checked`);
  assertEquals(missing, [], "am agent points at docs that do not exist");
});

Deno.test("am agent: the error catalogue is exactly the emitted AioErrorCode set", () => {
  const src = read("src/diagnostics/error.ts");
  const from = src.indexOf("export type AioErrorCode");
  // The union ends at its last member, the first `"CODE";` after the head.
  const end = src.slice(from).search(/"[A-Z_]+";/);
  const union = src.slice(
    from,
    from + end + src.slice(from + end).indexOf(";"),
  );
  const reservedAt = union.indexOf("Reserved");
  const emitted = [...union.slice(0, reservedAt).matchAll(/"([A-Z_]+)"/g)].map((
    m,
  ) => m[1]!);
  const reserved = [...union.slice(reservedAt).matchAll(/"([A-Z_]+)"/g)].map((
    m,
  ) => m[1]!);
  assert(
    emitted.length > 15 && reserved.length > 0,
    "AioErrorCode parse broke",
  );
  const shown = [
    ...new Set(
      [...body("errors").matchAll(/\b([A-Z]+(?:_[A-Z]+)+)\b/g)].map((m) =>
        m[1]!
      ),
    ),
  ];
  assertEquals(
    shown.filter((c) => !emitted.includes(c)),
    [],
    "brief lists codes aio never emits",
  );
  assertEquals(
    emitted.filter((c) => !shown.includes(c)),
    [],
    "brief omits emitted codes",
  );
});
