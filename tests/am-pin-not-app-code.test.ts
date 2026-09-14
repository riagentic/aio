// `am pin`'s removed-API scan refused a compatible upgrade with 66 findings,
// every one false (report 9 §2). Two shapes:
//
//  (a) A plain object key read as cell config. `execute`, `machine`, `actions`
//      and `generators` are ordinary English words; a table mapping the names
//      models invent for the shell tool (`execute: "sh"`) and a record of
//      scope labels (`machine: { label }`) are not `cell(...)` config. A file
//      with no `cell(` in it counted EVERY line as config — that is the
//      contract for aiol's already-extracted block, not for a whole file.
//  (b) Code the app declares is not its own. A vendored copy of two other
//      projects under `examples/`, excluded in deno.json and untracked, gave
//      64 of the 66. deno.json `exclude` / `fmt.exclude` and top-level
//      `.gitignore` entries are the app saying so; the scan honours them.
//
// And (c): the refusal leads with the count per top-level directory, so
// "64 of these are under examples/" is a decision, not a wall.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type Blocker,
  blockerDirCounts,
  pinRefusal,
  preflight,
} from "../src/am/am-cmd-pin.ts";
import { scanMigrations } from "../src/am/am-cmd-migrate.ts";
import { removalsInFile } from "../src/state/removals.ts";

async function app(files: Record<string, string>): Promise<string> {
  const dir = await tempDir("aio-pin-scope-");
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return dir;
}

// Shaped like the report's two files: neither calls `cell(`.
const TOOLCALL =
  `// the names models invent for the shell tool, mapped onto the real one
const ALIASES = {
  runshellcommand: "sh",
  execute: "sh",
  terminal: "sh",
};
export const toolName = (n: string) => ALIASES[n as keyof typeof ALIASES] ?? n;
`;
const RUNVIEWS = `const SCOPES = {
  project: { label: "this project", title: "…" },
  machine: { label: "this machine", title: "…" },
};
export const scopes = SCOPES;
const generators = { actions: [] as string[] };
export default () => generators.actions.length;
`;
const LEGACY = `import { cell } from "aio";
export const app = cell("demo", {
  state: { n: 0 },
  execute: { run() {} },
});
`;

Deno.test("removalsInFile: a removed key OUTSIDE any cell config is not a hit (report 9 §2a)", () => {
  assertEquals(removalsInFile(TOOLCALL), []);
  assertEquals(removalsInFile(RUNVIEWS), []);
  // Inside the literal, a string holding the word is still nothing.
  assertEquals(
    removalsInFile(
      `cell("x", { state: { hint: "execute: is gone" }, methods: {} });\n`,
    ),
    [],
  );
});

Deno.test("removalsInFile: the key INSIDE a cell( literal hits, quoting the ORIGINAL line", () => {
  const one = `import { cell } from "aio";
export const app = cell("demo", { state: { n: 0 }, machine: { initial: "a" } });
`;
  const hits = removalsInFile(one);
  assertEquals(hits.map((h) => [h.removal.key, h.line]), [["machine", 2]]);
  assertStringIncludes(hits[0]!.text, "export const app = cell(");
});

Deno.test("removalsInFile: a config object bound to a name and handed to cell() still hits", () => {
  // Narrowing to `cell(` argument lists must not turn this common shape into a
  // miss — a miss is an app that boots and explodes on the version it was told
  // was safe.
  const byName = `import { cell } from "aio";
const config = {
  state: { n: 0 },
  generators: { tick: async function* () {} },
};
export const c = cell("c", config);
`;
  assertEquals(
    removalsInFile(byName).map((h) => [h.removal.key, h.line]),
    [["generators", 4]],
  );
  const spread = `import { cell } from "aio";
const base = { actions: { inc: {} } };
export const c = cell("c", { ...base, state: {} });
`;
  assertEquals(removalsInFile(spread).map((h) => h.removal.key), ["actions"]);
});

Deno.test("preflight: the report's two plain-object files do not refuse the pin (report 9 §2a)", async () => {
  const dir = await app({
    "src/lib/toolcall.ts": TOOLCALL,
    "src/ui/RunViews.tsx": RUNVIEWS,
  });
  try {
    assertEquals(await preflight(dir, "v1.0.0-beta"), []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("preflight: a directory the app excludes (deno.json exclude / fmt.exclude / .gitignore) is not scanned (report 9 §2b)", async () => {
  const dir = await app({
    "deno.json": JSON.stringify({
      exclude: ["./vendor/"],
      fmt: { exclude: ["examples/"] },
    }),
    ".gitignore": "# kept for reference\n/third_party/\nnode_modules/\n",
    "examples/opencode/src/cell.ts": LEGACY,
    "vendor/lib/cell.ts": LEGACY,
    "third_party/x/cell.ts": LEGACY,
    // …while the app's own code is still read.
    "src/cell.ts": LEGACY,
  });
  try {
    const found = await preflight(dir, "v1.0.0-beta");
    assertEquals(found.map((b) => b.where), [join("src", "cell.ts") + ":4"]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am migrate: reads the same scope as am pin (one answer to 'what is this app's source')", async () => {
  const dir = await app({
    "deno.json": JSON.stringify({ fmt: { exclude: ["examples"] } }),
    "examples/vendored/cell.ts": LEGACY,
    "src/lib/toolcall.ts": TOOLCALL,
    "src/cell.ts": LEGACY,
  });
  try {
    const found = await scanMigrations(dir, undefined);
    assertEquals(found.map((f) => [f.file, f.key]), [[
      join("src", "cell.ts"),
      "execute",
    ]]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("pin refusal: the hit count per top-level directory comes BEFORE the list (report 9 §2c)", () => {
  const b = (where: string): Blocker => ({
    where,
    fixture: false,
    hit: {
      line: 1,
      text: "execute: {}",
      removal: removalsInFile(LEGACY)[0]!.removal,
    },
  });
  const blockers = [
    b("examples/a/x.ts:3"),
    b("src/cell.ts:4"),
    b("examples/b/y.ts:9"),
    b("deno.json:2"),
  ];
  assertEquals(blockerDirCounts(blockers), [
    ["examples/", 2],
    ["src/", 1],
    [".", 1],
  ]);
  const text = pinRefusal("v1.0.0-beta", blockers);
  const summary = text.indexOf("examples/ 2");
  assert(summary > 0, text);
  assert(summary < text.indexOf("examples/a/x.ts:3"), "summary precedes list");
  assertStringIncludes(text, "--force");
});

Deno.test("removalsInFile: a removed key NESTED inside a cell config is not a hit (llama-master)", () => {
  // `perfBudget.reduce` is the current reduce budget and `state.machine` is app
  // data. Both sit inside `cell(...)`; neither is a top-level config key.
  const nested = `import { cell } from "aio";
export const c = cell("x", {
  state: { machine: { a: 1 }, execute: 2 },
  perfBudget: { reduce: 100 },
  methods: { go(s) { s.state = { generators: [] }; } },
});
`;
  assertEquals(removalsInFile(nested), []);
  const oneLine =
    `export const c = cell("x", { state: { machine: { a: 1 }, execute: 2 }, perfBudget: { reduce: 100 }, methods: {} });\n`;
  assertEquals(removalsInFile(oneLine), []);
  const byName = `import { cell } from "aio";
const config = { state: { actions: [] as string[] }, perfBudget: { reduce: 50 } };
export const c = cell("c", config);
`;
  assertEquals(removalsInFile(byName), []);
});

Deno.test("removalsInFile: a TOP-LEVEL removed key still hits beside nested look-alikes", () => {
  // Control: the narrowing must not turn a real legacy config into a miss.
  const inline = `import { cell } from "aio";
export const c = cell("x", {
  state: { machine: 1 },
  perfBudget: { reduce: 100 },
  reduce: { inc: (s) => s },
});
`;
  assertEquals(removalsInFile(inline).map((h) => [h.removal.key, h.line]), [[
    "reduce",
    5,
  ]]);
  const oneLine =
    `export const c = cell("x", { state: { execute: 2 }, machine: { initial: "a" } });\n`;
  assertEquals(removalsInFile(oneLine).map((h) => h.removal.key), ["machine"]);
  const byName = `import { cell } from "aio";
const config = {
  perfBudget: { reduce: 50 },
  machine: { initial: "idle" },
};
export const c = cell("c", config);
`;
  assertEquals(removalsInFile(byName).map((h) => [h.removal.key, h.line]), [[
    "machine",
    4,
  ]]);
  // A wrapper or a parenthesised cast still hands the object over.
  assertEquals(
    removalsInFile(`cell("x", ({ execute: {} }) as C);\n`).map((h) =>
      h.removal.key
    ),
    ["execute"],
  );
});
