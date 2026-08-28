// alpha70 — the last release allowed to break compatibility — in aiol's words.
//
// Four rules, each pinned both ways: the fixture that FIRES it, and the legal
// shape it must stay silent on (a rule that cries wolf teaches people to skim
// past the real ones). The removals rule reads src/state/removals.ts, so the
// message it prints is the registry's — migration AND `am pin` escape hatch.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import {
  checkAlpha70Removals,
  checkAlpha70Renames,
  checkOwnKeyIdentity,
  checkProxyEscape,
  checkSyncMethodIO,
} from "../aiol/checks.ts";
import type { Checker, Issue } from "../aiol/types.ts";
import { aliasRename, moveImports } from "../aiol/fixes.ts";

const DENO_JSON = JSON.stringify({
  imports: { aio: "jsr:@riagentic/aio@1.0.0" },
  tasks: { dev: "deno run -A src/app.ts" },
});

/** Run ONE rule over a fixture project; return its issues and (after every
 *  safe fix is applied) the files. */
async function run(
  check: Checker,
  files: Record<string, string>,
): Promise<{ issues: Issue[]; fixed: Record<string, string> }> {
  const dir = await Deno.makeTempDir({ prefix: "aiol-alpha70-" });
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "deno.json"), DENO_JSON);
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await check(ctx);
    for (const i of report.issues) if (i.safeFix) await i.safeFix(dir);
    const fixed: Record<string, string> = {};
    for (const rel of Object.keys(files)) {
      fixed[rel] = await Deno.readTextFile(join(dir, rel));
    }
    return { issues: report.issues, fixed };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const APP = `import { aio } from "aio";\nawait aio.run({ appId: "x" });\n`;

// ── 28. one import path per symbol ───────────────────────────────────

const MOVES: Array<[string, string, string]> = [
  // [old import line, what the fix must produce, the registry key it names]
  [
    'import { createDB, type DB } from "aio/db";',
    'import { type DB } from "aio/db";\nimport { createDB } from "aio/server";',
    "aio/db",
  ],
  [
    'import { shipApp, type ShipManifest } from "aio/build";',
    'import { shipApp, type ShipManifest } from "aio/ship";',
    "aio/build",
  ],
  [
    'import { appDirs, testUI } from "aio/testing";',
    'import { testUI } from "aio/testing";\nimport { appDirs } from "aio/server";',
    "appDirs",
  ],
  [
    'import { installUpdatesRuntime, testUI } from "aio/testing";',
    'import { testUI } from "aio/testing";\nimport { installUpdatesRuntime } from "aio/updates";',
    "installUpdatesRuntime",
  ],
  [
    'import { signal, testComponent } from "aio/air";',
    'import { signal } from "aio/air";\nimport { testComponent } from "aio/testing";',
    "testComponent",
  ],
  [
    'import { cell, testCell } from "aio";',
    'import { cell } from "aio";\nimport { testCell } from "aio/testing";',
    "testCell",
  ],
];

for (const [before, after, key] of MOVES) {
  Deno.test(`alpha70 removals: ${key} — fires with the registry message, and --safe-fix moves the import`, async () => {
    const { issues, fixed } = await run(checkAlpha70Removals, {
      "src/app.ts": APP,
      "src/x.ts": `${before}\nexport const y = 1;\n`,
    });
    const hit = issues.filter((i) => i.area === "upgrade");
    assertEquals(hit.length, 1, JSON.stringify(issues));
    assertEquals(hit[0]!.severity, "error");
    assertStringIncludes(hit[0]!.message, "src/x.ts:1");
    assertStringIncludes(hit[0]!.message, "removed in alpha70");
    assertStringIncludes(hit[0]!.message, "am pin v1.0.0-alpha69");
    assertEquals(fixed["src/x.ts"], `${after}\nexport const y = 1;\n`);
  });
}

Deno.test("alpha70 removals: a whole `import type` from aio/db is NOT a hit (types stay)", async () => {
  const { issues } = await run(checkAlpha70Removals, {
    "src/app.ts": APP,
    "src/x.ts":
      'import type { DB, createDB } from "aio/db";\nexport type Y = DB;\n',
  });
  assertEquals(issues.filter((i) => i.area === "upgrade"), []);
});

Deno.test("alpha70 removals: a component importing createDB is [manual] — aio/server is no fix there", async () => {
  const { issues, fixed } = await run(checkAlpha70Removals, {
    "src/app.ts": APP,
    "src/App.tsx": 'import { createDB } from "aio/db";\nexport const A = 1;\n',
  });
  const hit = issues.find((i) => i.area === "upgrade")!;
  assert(hit.manual, "declined by design");
  assertEquals(hit.safeFix, undefined);
  assertStringIncludes(fixed["src/App.tsx"]!, '"aio/db"');
});

Deno.test("alpha70 removals: the old spelling in a comment or string is not a hit", async () => {
  const { issues } = await run(checkAlpha70Removals, {
    "src/app.ts": APP,
    "src/x.ts": [
      '// import { createDB } from "aio/db";',
      'const t = `import { testCell } from "aio";`;',
      'import { cell } from "aio";',
      "export { t, cell };",
    ].join("\n") + "\n",
  });
  assertEquals(issues.filter((i) => i.area === "upgrade"), []);
});

Deno.test("alpha70 removals: extras `lint` and `testgen` — the alias keeps its local name", async () => {
  const { issues, fixed } = await run(checkAlpha70Removals, {
    "src/app.ts": APP,
    "src/x.ts":
      'import { lint, parseCli } from "aio/extras";\nexport { lint, parseCli };\n',
    "src/y.ts":
      'import { testgen as gen } from "aio/testing";\nexport { gen };\n',
  });
  const hits = issues.filter((i) => i.area === "upgrade");
  assertEquals(hits.length, 2, JSON.stringify(issues));
  assertEquals(
    fixed["src/x.ts"],
    'import { checkCells as lint, parseCli } from "aio/extras";\nexport { lint, parseCli };\n',
  );
  assertEquals(
    fixed["src/y.ts"],
    'import { testGen as gen } from "aio/testing";\nexport { gen };\n',
  );
});

Deno.test("alpha70 removals: memory.gcStressRatio in the entry is refused by name, no auto-fix", async () => {
  const { issues } = await run(checkAlpha70Removals, {
    "src/app.ts":
      'import { aio } from "aio";\nawait aio.run({ appId: "x", memory: { gcStressRatio: 0.05 } });\n',
  });
  const hit = issues.find((i) => i.area === "upgrade")!;
  assert(hit, "fires");
  assertStringIncludes(
    hit.message,
    "memory.gcStressRatio was removed in alpha70",
  );
  assertStringIncludes(hit.message, "src/app.ts:2");
  assert(hit.manual);
});

Deno.test("alpha70 removals: clean project passes", async () => {
  const { issues } = await run(checkAlpha70Removals, {
    "src/app.ts": APP,
    "src/x.ts":
      'import { createDB } from "aio/server";\nimport type { DB } from "aio/db";\nexport { createDB };\nexport type { DB };\n',
  });
  assertEquals(issues.filter((i) => i.area === "upgrade"), []);
});

Deno.test("moveImports/aliasRename are pure and null on no-op", () => {
  assertEquals(
    moveImports('import { x } from "aio";', {
      from: "aio",
      to: "aio/testing",
      names: new Set(["y"]),
    }),
    null,
  );
  assertEquals(
    aliasRename(
      'import { a } from "aio/extras";',
      "aio/extras",
      "lint",
      "checkCells",
    ),
    null,
  );
  assertEquals(
    aliasRename(
      'import { lint as l } from "aio/extras";',
      "aio/extras",
      "lint",
      "checkCells",
    ),
    'import { checkCells as l } from "aio/extras";',
  );
});

// ── 29. the live draft escapes ───────────────────────────────────────

const cellWith = (methods: string, top = "") =>
  `import { cell } from "aio";\n${top}\nexport const c = cell("c", {\n  state: { n: 0, items: [] as string[] },\n  methods: {\n${methods}\n  },\n});\n`;

Deno.test("proxy escape: `s` assigned to a module-level binding fires", async () => {
  const { issues } = await run(checkProxyEscape, {
    "src/app.ts": APP,
    "src/c.ts": cellWith(
      `    keep(s) { last = s; },`,
      "let last: unknown = null;",
    ),
  });
  assertEquals(issues.length, 1, JSON.stringify(issues));
  assertEquals(issues[0]!.severity, "error");
  assertStringIncludes(issues[0]!.message, "c.keep()");
  assertStringIncludes(issues[0]!.message, "stores `s` itself");
});

Deno.test("proxy escape: a callback closing over `s`, stored outside, fires", async () => {
  const { issues } = await run(checkProxyEscape, {
    "src/app.ts": APP,
    "src/c.ts": cellWith(
      `    watch(s) { listeners.push(() => { s.n++; }); },\n    hook(s) { globalThis.onTick = () => s.n; },`,
      "const listeners: Array<() => void> = [];",
    ),
  });
  assertEquals(issues.length, 2, JSON.stringify(issues));
  for (const i of issues) {
    assertStringIncludes(i.message, "stores a callback that reads `s`");
  }
});

Deno.test("proxy escape: plain-data copies, locals, own.set and s.$do stay silent", async () => {
  const { issues } = await run(checkProxyEscape, {
    "src/app.ts": APP,
    "src/c.ts": cellWith(
      [
        "    snap(s) { last = { ...s }; },",
        "    count(s) { last = s.items.length; },",
        "    local(s) { const t = s; t.n++; },",
        "    cb(s) { listeners.push(() => c.snap()); },",
        "    eq(s) { if (last === s) return; },",
      ].join("\n"),
      "let last: unknown = null;\nconst listeners: Array<() => void> = [];",
    ),
  });
  assertEquals(issues, []);
});

// ── 30. I/O in a sync method ─────────────────────────────────────────

Deno.test("sync I/O: fetch / Deno.readTextFileSync in a sync method fire; async and nested callbacks do not", async () => {
  const { issues } = await run(checkSyncMethodIO, {
    "src/app.ts": APP,
    "src/c.ts": cellWith(
      [
        "    load(s) { const r = fetch('/x'); s.n = 1; },",
        "    read(s) { s.items = [Deno.readTextFileSync('a')]; },",
        "    async ok(s) { const r = await fetch('/x'); s.n = r.status; },",
        "    deferred(s) { s.$do(async () => { await fetch('/x'); }); },",
        "    env(s) { s.items = [Deno.cwd(), Deno.env.get('HOME') ?? '']; },",
      ].join("\n"),
    ),
  });
  assertEquals(issues.map((i) => i.severity), ["error", "error"]);
  assertStringIncludes(issues[0]!.message, "`c.load()`");
  assertStringIncludes(issues[0]!.message, "`fetch()`");
  assertStringIncludes(issues[1]!.message, "`Deno.readTextFileSync()`");
  assertStringIncludes(issues[1]!.message, "src/c.ts:7");
});

// ── 31. own.set keyed by a constant while the resource varies ────────

Deno.test("own key: a literal key inside a function taking a resource id that the factory uses fires", async () => {
  const { issues } = await run(checkOwnKeyIdentity, {
    "src/app.ts": APP,
    "src/c.ts": cellWith(
      `    watch(s, path: string) { return own.set("watcher", () => Deno.watchFs(path)); },`,
      'import { own } from "aio";',
    ),
  });
  assertEquals(issues.length, 1, JSON.stringify(issues));
  assertEquals(issues[0]!.severity, "warn");
  assertStringIncludes(issues[0]!.message, 'own.set("watcher", …)');
  assertStringIncludes(issues[0]!.message, "built from `path`");
  assertStringIncludes(issues[0]!.fix!, "own.set(`watcher:${path}`");
});

Deno.test("own key: template keys, id-free functions, and a factory that ignores the id stay silent", async () => {
  const { issues } = await run(checkOwnKeyIdentity, {
    "src/app.ts": APP,
    "src/c.ts": cellWith(
      [
        "    a(s, path: string) { return own.set(`watcher:${path}`, () => Deno.watchFs(path)); },",
        '    b(s) { return own.set("ticker", () => setInterval(() => {}, 1)); },',
        '    c(s, path: string) { return own.set("ticker", () => setInterval(() => {}, 1)); },',
        '    // aiol-ok: one watcher at a time\n    d(s, path: string) { return own.set("watcher", () => Deno.watchFs(path)); },',
      ].join("\n"),
      'import { own } from "aio";',
    ),
  });
  assertEquals(issues, []);
});

// ── 28b. alpha70 word renames + the air Action alias + schedule.blocking ──

Deno.test("alpha70 renames: CellAccess/ServerFnAccess/ExtractState/connectDevTools are rewritten in code only, duplicates collapsed", async () => {
  const { issues, fixed } = await run(checkAlpha70Renames, {
    "src/app.ts": APP,
    "src/x.ts": [
      'import type { Access, CellAccess, ExtractState, ServerFnAccess } from "aio";',
      'import { connectDevTools, disconnectDevTools } from "aio/air";',
      "// CellAccess stays in this comment",
      'const note = "ExtractState in a string";',
      "export type A = CellAccess | ServerFnAccess | Access;",
      "export type S = ExtractState<typeof note>;",
      "export const on = () => { connectDevTools(); disconnectDevTools(); };",
      "",
    ].join("\n"),
  });
  const hits = issues.filter((i) => i.area === "upgrade");
  assertEquals(hits.length, 4, JSON.stringify(hits.map((h) => h.message)));
  assertEquals(
    fixed["src/x.ts"],
    [
      'import type { Access, StateOf } from "aio";',
      'import { connectReduxDevTools, disconnectReduxDevTools } from "aio/air";',
      "// CellAccess stays in this comment",
      'const note = "ExtractState in a string";',
      "export type A = Access | Access | Access;",
      "export type S = StateOf<typeof note>;",
      "export const on = () => { connectReduxDevTools(); disconnectReduxDevTools(); };",
      "",
    ].join("\n"),
  );
});

Deno.test("alpha70 renames: `type Action` from aio/air keeps its local name; an app's own Action is untouched", async () => {
  const { issues, fixed } = await run(checkAlpha70Renames, {
    "src/app.ts": APP,
    "src/x.ts":
      'import { h, type Action } from "aio/air";\nexport type Action2 = Action;\nexport { h };\n',
    "src/y.ts": "export type Action = { kind: string };\n",
  });
  assertEquals(issues.filter((i) => i.area === "upgrade").length, 1);
  assertEquals(
    fixed["src/x.ts"],
    'import { h, type NodeAction as Action } from "aio/air";\nexport type Action2 = Action;\nexport { h };\n',
  );
  assertEquals(fixed["src/y.ts"], "export type Action = { kind: string };\n");
});

Deno.test("alpha70 renames: schedule.blocking( → blocking( and the import is added once", async () => {
  const { issues, fixed } = await run(checkAlpha70Renames, {
    "src/app.ts": APP,
    "src/x.ts":
      'import { cell, schedule } from "aio";\nexport const e = schedule.blocking("id", () => 1, 0);\nexport const f = schedule.blocking("id2", () => 2, 0);\nexport { cell };\n',
    "src/y.ts": 'export const e = schedule.blocking("id", () => 1, 0);\n',
  });
  assertEquals(issues.filter((i) => i.area === "upgrade").length, 2);
  assertEquals(
    fixed["src/x.ts"],
    'import { cell, schedule, blocking } from "aio";\nexport const e = blocking("id", () => 1, 0);\nexport const f = blocking("id2", () => 2, 0);\nexport { cell };\n',
  );
  assertEquals(
    fixed["src/y.ts"],
    'import { blocking } from "aio";\nexport const e = blocking("id", () => 1, 0);\n',
  );
});

Deno.test("alpha70 renames: a modern file is silent", async () => {
  const { issues } = await run(checkAlpha70Renames, {
    "src/app.ts": APP,
    "src/x.ts":
      'import type { Access, StateOf } from "aio";\nimport { blocking } from "aio";\nexport type A = Access;\nexport const e = blocking("id", () => 1, 0);\n',
  });
  assertEquals(issues.filter((i) => i.area === "upgrade"), []);
});
