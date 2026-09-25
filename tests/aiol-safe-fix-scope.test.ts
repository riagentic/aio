// `--safe-fix` promises "Never changes behavior". Each case here is a site the
// rule reported and the fix rewrote into DIFFERENT behaviour (or refused
// forever while the report kept saying [fixable]):
//
//   • a non-aio task's `--key=` flag was rewritten to `--tls-key=`
//   • `const { aio, createDB } = await import("aio")` was repointed whole to
//     `aio/server`, which does not export `aio`
//   • a `return schedule.after(…)` inside a `.map` callback became `s.$do(…)`
//   • `schedule.blocking(` became `blocking(` in a file that imports it `as b`
//   • `fn.call({ timeout: 5 })` (Function.prototype.call) was rewritten
//   • `tls: { key }` made the `key: false` migration decline forever
//   • a commented `timeout:` option was invisible to the removed-option rule
//   • a `cell(` / `setTimeout(` mentioned only in a comment made a finding
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { lintProject } from "../aiol/mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const DENO = {
  title: "fixme",
  version: "0.1.0",
  nodeModulesDir: "auto",
  compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
  imports: { aio: "jsr:@riagentic/aio@1.0.0" },
  tasks: { dev: "deno run -A src/app.ts", test: "deno test -A tests/" },
};
const APP =
  `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "fixme", cells: { counter } });\n`;
const CELL =
  `import { cell } from "aio";\nexport const counter = cell("counter", {\n  state: { count: 0 },\n  methods: { increment(s: { count: number }) { s.count++; } },\n});\n`;

async function lintAndFix(
  files: Record<string, string>,
  deno: Record<string, unknown> = {},
  omit: string[] = [],
) {
  const all: Record<string, string> = {
    "deno.json": JSON.stringify({ ...DENO, ...deno }, null, 2),
    "src/app.ts": APP,
    "src/cell.ts": CELL,
    ...files,
  };
  for (const rel of omit) delete all[rel];
  const dir = await tempDir("aiol-fix-scope-");
  try {
    for (const [rel, src] of Object.entries(all)) {
      const p = join(dir, rel);
      await Deno.mkdir(p.replace(/[^/\\]+$/, ""), { recursive: true });
      await Deno.writeTextFile(p, src);
    }
    const report = await lintProject(dir);
    for (const i of report.issues.filter((i) => i.safeFix)) {
      await i.safeFix!(dir);
    }
    const out: Record<string, string> = {};
    for (const rel of Object.keys(all)) {
      out[rel] = await Deno.readTextFile(join(dir, rel));
    }
    const after = await lintProject(dir);
    return { report, files: out, after };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("aiol task flags: a non-app task's --key= is neither reported nor rewritten", async () => {
  const sign = "deno run -A scripts/sign.ts --key=prod.pem --cert=c.pem";
  const { report, files } = await lintAndFix({}, {
    tasks: { ...DENO.tasks, sign },
  });
  assert(
    !report.issues.some((i) => i.message.includes('task "sign"')),
    "a task that does not run the app carries no aio flags",
  );
  const tasks = JSON.parse(files["deno.json"]!).tasks;
  assertEquals(tasks.sign, sign, "--safe-fix rewrote another program's flags");
});

Deno.test("aiol task flags: the app's own run task is still migrated", async () => {
  const { files } = await lintAndFix({}, {
    tasks: {
      ...DENO.tasks,
      dev: "deno run -A src/app.ts --cert=c.pem --key=k.pem",
    },
  });
  assertEquals(
    JSON.parse(files["deno.json"]!).tasks.dev,
    "deno run -A src/app.ts --tls-cert=c.pem --tls-key=k.pem",
  );
});

Deno.test("aiol task flags: an entry that is a SUBSTRING of another script's path is not that script", async () => {
  // `src/app.ts` is inside `scripts/mysrc/app.ts` — a substring scope made
  // that program's `--key=` "the app's" and --safe-fix rewrote it.
  const sign = "deno run -A scripts/mysrc/app.ts --key=prod.pem";
  const { report, files } = await lintAndFix({}, {
    tasks: { ...DENO.tasks, dev: "deno run -A ./src/app.ts --key=k.pem", sign },
  });
  assert(!report.issues.some((i) => i.message.includes('task "sign"')));
  const tasks = JSON.parse(files["deno.json"]!).tasks;
  assertEquals(tasks.sign, sign, "--safe-fix rewrote another program's flags");
  assertEquals(
    tasks.dev,
    "deno run -A ./src/app.ts --tls-key=k.pem",
    "a `./`-prefixed entry is still the app",
  );
});

Deno.test("aiol task flags: with no detectable entry a renamed flag is still reported, as [manual]", async () => {
  const dev = "deno run -A main.ts --cert=a.pem";
  const { report, files } = await lintAndFix(
    { "main.ts": APP.replace("./cell.ts", "./src/cell.ts") },
    { tasks: { ...DENO.tasks, dev } },
    ["src/app.ts"],
  );
  const hit = report.issues.find((i) =>
    i.message.includes('task "dev"') && i.message.includes("--tls-cert")
  );
  assert(hit, "the renamed flag went unreported");
  assert(!hit.safeFix, "no entry → the rewrite cannot tell app from program");
  assert(hit.manual?.includes("entry"), `manual names the fix: ${hit.manual}`);
  assertEquals(JSON.parse(files["deno.json"]!).tasks.dev, dev);
});

Deno.test("aiol dynamic aio/server fix: a mixed destructure is [manual], never repointed", async () => {
  const app =
    `const { aio, createDB } = await import("aio");\nimport { counter } from "./cell.ts";\nawait createDB("x");\nawait aio.run({ appId: "fixme", cells: { counter } });\n`;
  const { report, files } = await lintAndFix({ "src/app.ts": app });
  const hit = report.issues.find((i) =>
    i.message.includes('dynamic `import("aio")`')
  );
  assert(hit, "the server-only symbol is still reported");
  assert(!hit.safeFix, "must not offer a fix that makes `aio` undefined");
  assert(
    hit.manual?.includes("aio"),
    `the decline names the name: ${hit.manual}`,
  );
  assertEquals(files["src/app.ts"], app, "the file was rewritten");
});

Deno.test("aiol dynamic aio/server fix: an all-server destructure is still repointed", async () => {
  const app =
    `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nconst { createDB } = await import("aio");\nawait createDB("x");\nawait aio.run({ appId: "fixme", cells: { counter } });\n`;
  const { files } = await lintAndFix({ "src/app.ts": app });
  assert(files["src/app.ts"]!.includes(`await import("aio/server")`));
});

Deno.test("aiol return-effects fix: a return inside a nested callback is not rewritten", async () => {
  const cell = `import { cell, schedule } from "aio";
export const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    tick(s) {
      s.count++;
    },
    start(s) {
      const fx = [1, 2].map((n) => {
        return schedule.after(n * 1000, "tick");
      });
      s.count = fx.length;
    },
  },
});
`;
  const { report, files } = await lintAndFix({ "src/cell.ts": cell });
  const hit = report.issues.find((i) => i.message.includes("return effect"));
  assert(hit, "the site is still reported");
  assert(!hit.safeFix, "a callback's return value is not the method's");
  assert(hit.manual?.includes("nested"), `decline reason: ${hit.manual}`);
  assertEquals(files["src/cell.ts"], cell, "the callback was rewritten");
});

Deno.test("aiol return-effects fix: a method's own return inside an if-block is still rewritten", async () => {
  const cell = `import { cell, schedule } from "aio";
export const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    tick(s) {
      s.count++;
    },
    start(s) {
      if (s.count > 0) {
        return schedule.after(1000, "tick");
      }
      s.count = 1;
    },
  },
});
`;
  const { files } = await lintAndFix({ "src/cell.ts": cell });
  assert(
    files["src/cell.ts"]!.includes(`s.$do(schedule.after(1000, "tick"));`),
    files["src/cell.ts"],
  );
});

Deno.test("aiol schedule.blocking fix: an aliased `blocking as b` import still gets `blocking` bound", async () => {
  const cell = `import { cell, schedule, blocking as b } from "aio";
export const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    async go(s) {
      await schedule.blocking(() => 1);
      await b(() => 2);
    },
  },
});
`;
  const { files } = await lintAndFix({ "src/cell.ts": cell });
  const out = files["src/cell.ts"]!;
  assert(out.includes("await blocking(() => 1)"), out);
  const spec = /import\s*\{([^}]*)\}\s*from\s*"aio"/.exec(out)![1]!;
  assert(
    spec.split(",").some((n) => n.trim() === "blocking"),
    `\`blocking(\` is called but never bound:\n${out}`,
  );
});

Deno.test("aiol call-timeout rule: a member `.call({ timeout })` is not aio's call", async () => {
  const cell = `import { cell } from "aio";
function f(this: { timeout: number }) { return this.timeout; }
export const n = f.call({ timeout: 5 });
export const counter = cell("counter", {
  state: { count: 0 },
  methods: { increment(s: { count: number }) { s.count++; } },
});
`;
  const { report, files } = await lintAndFix({ "src/cell.ts": cell });
  assert(
    !report.issues.some((i) => i.message.includes("call({ timeout })")),
    "Function.prototype.call was reported as aio's removed option",
  );
  assertEquals(files["src/cell.ts"], cell);
});

Deno.test("aiol call-timeout rule: a commented `timeout:` option is still found", async () => {
  const cell = `import { call, cell } from "aio";
export const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    async go(s: { count: number }) {
      s.count = await call({
        // the slow path
        timeout: 5000,
      }, () => Promise.resolve(1));
    },
  },
});
`;
  const { report, files } = await lintAndFix({ "src/cell.ts": cell });
  assert(
    report.issues.some((i) => i.message.includes("call({ timeout })")),
    "a removed option after a comment line was reported clean",
  );
  assert(files["src/cell.ts"]!.includes("timeoutMs: 5000"));
});

Deno.test("aiol key:false migration: a nested tls.key does not make the fix decline", async () => {
  const app = `import { aio } from "aio";
import { counter } from "./cell.ts";
await aio.run({
  appId: "fixme",
  tls: { cert: "c.pem", key: "k.pem" },
  cells: { counter },
});
`;
  const { files, after } = await lintAndFix({ "src/app.ts": app }, {
    imports: { aio: "jsr:@riagentic/aio@1.0.0-alpha40" },
    tasks: { dev: "deno run -A src/app.ts --expose", test: "x" },
  });
  assert(files["src/app.ts"]!.includes("key: false,"), files["src/app.ts"]);
  assert(
    !after.issues.some((i) => i.message.includes("no `key`")),
    "still reported after --safe-fix",
  );
});

Deno.test("aiol timer hint: `cell(` and `setTimeout(` only in comments are not cell code", async () => {
  const helper = `// Finds where \`cell("x", …)\` is defined.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export { sleep };
`;
  const { report } = await lintAndFix({ "src/helper.ts": helper });
  assert(
    !report.issues.some((i) =>
      i.file === "src/helper.ts" && i.message.includes("setTimeout")
    ),
    "a file with no cell got the in-cell timer hint",
  );
});

Deno.test("aiol dynamic aio/server fix: the fix itself declines a mixed destructure", async () => {
  const { fixDynamicServerEntryImport } = await import("../aiol/fixes.ts");
  const dir = await tempDir("aiol-fix-dyn-");
  try {
    const p = join(dir, "app.ts");
    const src =
      `const { aio, createDB } = await import("aio");\nexport { aio, createDB };\n`;
    await Deno.writeTextFile(p, src);
    assertEquals(await fixDynamicServerEntryImport(p)(), false);
    assertEquals(await Deno.readTextFile(p), src, "`aio` would be undefined");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("aiol dynamic aio/server rule: a browser-safe destructure inside a function body is not flagged", async () => {
  // `\{([^}]*)\}` started at the FUNCTION's `{`, so a `createDB` mentioned
  // earlier in the body counted as destructured — and the fix repointed a
  // `{ cell }` import to aio/server, where `cell` does not exist.
  const lazy = `import { createDB } from "aio/server";
export async function f() {
  const make = createDB;
  const { cell } = await import("aio");
  return [make, cell];
}
`;
  const { report, files } = await lintAndFix({ "src/lazy.ts": lazy });
  assert(
    !report.issues.some((i) => i.message.includes('dynamic `import("aio")`')),
    "a `{ cell }` destructure was reported as server-only",
  );
  assertEquals(files["src/lazy.ts"], lazy);
});

Deno.test("aiol dynamic aio/server fix: a server-only destructure inside a function body is repointed", async () => {
  const { fixDynamicServerEntryImport } = await import("../aiol/fixes.ts");
  const dir = await tempDir("aiol-fix-dyn-fn-");
  try {
    const p = join(dir, "cache.ts");
    await Deno.writeTextFile(
      p,
      `export async function open() {\n  const { createDB } = await import("aio");\n  return createDB("x");\n}\n`,
    );
    assertEquals(await fixDynamicServerEntryImport(p)(), true);
    assert((await Deno.readTextFile(p)).includes(`await import("aio/server")`));
  } finally {
    await dropTempDir(dir);
  }
});
