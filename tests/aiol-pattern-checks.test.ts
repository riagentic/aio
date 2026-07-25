// aiol checkPatterns — await-commit read hint (mdview) + .server.ts exemption
// in checkUI's dynamic-import check. Every await in an async method is a
// commit + render point; a post-await state read may see other actions'
// commits, so the linter hints (never errors) on the first such read.
import { assertEquals } from "@std/assert";
import { buildContext } from "../aiol/context.ts";
import { checkPatterns, checkUI } from "../aiol/checks.ts";
import { join } from "@std/path";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function project(dir: string, cellSource: string) {
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
      unstable: ["kv"],
    }),
  );
  await Deno.writeTextFile(join(dir, "src", "counter.ts"), cellSource);
}

async function runCheckPatterns(dir: string) {
  const { ctx, report } = await buildContext(dir);
  await checkPatterns(ctx);
  return report.issues;
}

const awaitReadIssues = (issues: { message: string; severity: string }[]) =>
  issues.filter((i) => i.message.includes("after an await"));

Deno.test("aiol: hints on state read after await in async method", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
import { cell } from 'aio'
export const counter = cell('counter', {
  state: { count: 0, status: 'idle' },
  methods: {
    async load(s) {
      s.status = 'loading'
      const data = await fetch('/x')
      if (s.status === 'cancelled') return
      s.count = 1
    },
  },
})
`,
    );
    const issues = awaitReadIssues(await runCheckPatterns(dir));
    assertEquals(issues.length, 1);
    assertEquals(issues[0]!.severity, "hint");
    assertEquals(issues[0]!.message.includes('"load"'), true);
  });
});

Deno.test("aiol: a transaction:true cell suppresses the read-after-await hint (risoto #2)", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
import { cell } from 'aio'
export const counter = cell('counter', {
  transaction: true,
  state: { count: 0, status: 'idle' },
  methods: {
    async load(s) {
      const data = await fetch('/x')
      if (s.status === 'cancelled') return
      s.count = s.count + 1
    },
  },
})
`,
    );
    // Reads see a stable snapshot across the await — the hint would be wrong.
    assertEquals(awaitReadIssues(await runCheckPatterns(dir)).length, 0);
  });
});

Deno.test("aiol: no hint when async method only writes after await", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
import { cell } from 'aio'
export const counter = cell('counter', {
  state: { count: 0, items: [] as string[] },
  methods: {
    async load(s) {
      const data = await fetch('/x')
      s.count = 2
      s.items.push('done')
    },
  },
})
`,
    );
    assertEquals(awaitReadIssues(await runCheckPatterns(dir)).length, 0);
  });
});

Deno.test("aiol: no hint on reads before the first await", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
import { cell } from 'aio'
export const counter = cell('counter', {
  state: { url: '/x', count: 0 },
  methods: {
    async load(s) {
      const target = s.url
      const data = await fetch(target)
      s.count = 1
    },
  },
})
`,
    );
    assertEquals(awaitReadIssues(await runCheckPatterns(dir)).length, 0);
  });
});

Deno.test("aiol: no hint for sync methods", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
import { cell } from 'aio'
export const counter = cell('counter', {
  state: { count: 0 },
  methods: {
    inc(s) { s.count = s.count + 1 },
  },
})
`,
    );
    assertEquals(awaitReadIssues(await runCheckPatterns(dir)).length, 0);
  });
});

Deno.test("aiol: hints once per method, covers name: async (s) style", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
import { cell } from 'aio'
export const counter = cell('counter', {
  state: { count: 0, total: 0 },
  methods: {
    refresh: async (s) => {
      await fetch('/x')
      console.info(s.count)
      console.info(s.total)
    },
  },
})
`,
    );
    const issues = awaitReadIssues(await runCheckPatterns(dir));
    assertEquals(issues.length, 1);
    assertEquals(issues[0]!.message.includes('"refresh"'), true);
  });
});

Deno.test("aiol: does NOT flag dynamic import of *.server.ts file", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
        unstable: ["kv"],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "io.server.ts"),
      `import { join } from '@std/path'
export const read = (p: string) => Deno.readTextFile(join('/', p))
`,
    );
    await Deno.writeTextFile(
      join(dir, "src", "counter.ts"),
      `
import { cell } from 'aio'
export const counter = cell('counter', {
  state: { count: 0 },
  methods: {
    async load(s) {
      const io = await import('./io.server.ts')
      s.count = 1
    },
  },
})
`,
    );
    const { ctx, report } = await buildContext(dir);
    await checkUI(ctx);
    assertEquals(
      report.issues.some((i) => i.message.includes("io.server.ts")),
      false,
    );
  });
});

// ── v2 Style-B detection (perfect-aio D10) ────────────────────────────
import { checkCells } from "../aiol/checks.ts";

Deno.test("aiol: removed legacy config keys report the migration mapping", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `import { cell } from "aio";
export const legacy = cell("legacy", {
  state: { x: 0 },
  actions: { go: () => ({}) },
  reduce: { go(s) { s.x = 1; } },
  machine: { initial: "idle", states: { idle: { go: "idle" } } },
  generators: { flow: function* (ctx) { yield* ctx.sleep("s", 1); } },
});
`,
    );
    const { ctx, report } = await buildContext(dir);
    checkCells({ ...ctx, ...report });
    const errors = report.issues.filter((i) =>
      i.severity === "error" &&
      i.message.includes("docs/upgrade/restructure.md")
    );
    // actions, generators, machine all detected
    assertEquals(errors.length >= 3, true, JSON.stringify(report.issues));
  });
});

Deno.test("aiol: flags core imports of symbols moved to aio/extras (B4c)", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
import { cell, deepFreeze, instances } from 'aio'
export const counter = cell('counter', {
  state: { count: 0 },
  methods: { inc(s) { s.count += 1 } },
})
`,
    );
    const { ctx, report } = await buildContext(dir);
    const { checkCells } = await import("../aiol/checks.ts");
    await checkCells(ctx);
    const hits = report.issues.filter((i) =>
      i.message.includes('moved to "aio/extras"')
    );
    assertEquals(hits.length, 1);
    assertEquals(hits[0]!.severity, "error");
    // names listed, cell itself NOT flagged
    assertEquals(hits[0]!.message.includes("deepFreeze, instances"), true);
    assertEquals(hits[0]!.message.includes("cell,"), false);
  });
});

Deno.test("aiol: setTimeout hint skips delay-0 yield + aiol-ok; await-read honors aiol-ok", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
import { cell } from 'aio'
export const c = cell('c', {
  state: { n: 0, mode: 'x' },
  methods: {
    async tick(s) {
      await new Promise((r) => setTimeout(r, 0))
      s.n += 1
    },
    async poll(s) {
      s.mode = 'polling'
      await fetch('/x')
      if (s.mode === 'cancelled') return // aiol-ok — deliberate re-read
      s.n += 1
    },
    slow(s) {
      setTimeout(() => { s.n = 9 }, 500) // aiol-ok
      s.n += 1
    },
  },
})
`,
    );
    const { ctx, report } = await buildContext(dir);
    await checkPatterns(ctx);
    const { checkPerformance } = await import("../aiol/checks.ts");
    if (typeof checkPerformance === "function") await checkPerformance(ctx);
    const timerHints = report.issues.filter((i) =>
      i.message.includes("setTimeout/setInterval")
    );
    const awaitHints = report.issues.filter((i) =>
      i.message.includes("after an await")
    );
    assertEquals(timerHints.length, 0, JSON.stringify(timerHints));
    assertEquals(awaitHints.length, 0, JSON.stringify(awaitHints));
  });
});
