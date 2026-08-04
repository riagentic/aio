// aiol checkPatterns — await-commit read hint + .server.ts exemption
// in checkUI's dynamic-import check. Every await in an async method is a
// commit + render point; a post-await state read may see other actions'
// commits, so the linter hints (never errors) on the first such read.
import { assert, assertEquals } from "@std/assert";
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

const awaitReadIssues = (
  issues: { message: string; severity: string; line?: number }[],
) => issues.filter((i) => i.message.includes("after an await"));

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

Deno.test("aiol: a transaction:true cell suppresses the read-after-await hint", async () => {
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
    // each name gets ITS home named; cell itself NOT flagged
    assertEquals(
      hits[0]!.message.includes('deepFreeze moved to "aio/extras"'),
      true,
    );
    assertEquals(
      hits[0]!.message.includes('instances moved to "aio/extras"'),
      true,
    );
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

// ── A mention is not a use (same class as the phantom-cell fix) ──

Deno.test("aiol: a legacy import path quoted in a string is not an import", async () => {
  await withTmpDir(async (dir) => {
    // A project's OWN lint rule may name the legacy path as data. Only a real
    // import/export statement should warn.
    await project(
      dir,
      `
const LEGACY = "from '../dep/aio/";
export function usesLegacy(src: string): boolean {
  return src.includes(LEGACY); // detection code, not an import
}
`,
    );
    const issues = await runCheckPatterns(dir);
    assertEquals(
      issues.filter((i) => i.message.includes("legacy import path")),
      [],
      "a quoted mention must not be reported as a legacy import",
    );
  });
});

Deno.test("aiol: a REAL legacy import still warns", async () => {
  await withTmpDir(async (dir) => {
    await project(dir, `import { cell } from "../dep/aio/mod.ts";\n`);
    const issues = await runCheckPatterns(dir);
    assertEquals(
      issues.filter((i) => i.message.includes("legacy import path")).length,
      1,
      "a real legacy import must still warn",
    );
  });
});

Deno.test("aiol: a Node API named in a comment or string is not a Node API use", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
// process.env is substituted by the bundler in the vendored source below.
const SHIM = "module.exports = {}";
export const shim = SHIM;
`,
    );
    const issues = await runCheckPatterns(dir);
    assertEquals(
      issues.filter((i) => i.message.includes("Node.js API")),
      [],
      "mentions in comments/strings must not be flagged",
    );
  });
});

Deno.test("aiol: a REAL Node API use is still flagged", async () => {
  await withTmpDir(async (dir) => {
    await project(dir, `export const home = process.env.HOME;\n`);
    const issues = await runCheckPatterns(dir);
    assertEquals(
      issues.filter((i) => i.message.includes("Node.js API")).length >= 1,
      true,
      "real process.env use must still be flagged",
    );
  });
});

Deno.test("aiol: state from a factory call is not 'empty state {}'", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
import { cell } from 'aio'
function initial() { return { n: 0 } }
export const c = cell('c', {
  state: initial(),
  methods: { inc(s) { s.n += 1 } },
})
`,
    );
    const { ctx, report } = await buildContext(dir);
    const { checkCells } = await import("../aiol/checks.ts");
    await checkCells(ctx);
    const hits = report.issues.filter((i) => i.message.includes("empty state"));
    assertEquals(hits.length, 0, JSON.stringify(report.issues));
  });
});

Deno.test("aiol: useCell() is flagged as deprecated", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `
import { cell } from 'aio'
import { useCell } from 'aio/air'
export const c = cell('c', { state: { n: 0 }, methods: {} })
export function App() { const { state } = useCell(c); return state.n }
`,
    );
    const { ctx, report } = await buildContext(dir);
    const { checkUseCell } = await import("../aiol/checks.ts");
    await checkUseCell(ctx);
    const hits = report.issues.filter((i) =>
      i.message.includes("useCell() is deprecated")
    );
    assertEquals(hits.length, 1, JSON.stringify(report.issues));
    assert(hits[0]!.message.includes("LIVE view"));
  });
});

// ── The post-await-read rule was almost exactly INVERTED ─────────────────
//
// It fired on the framework's own documented patterns and stayed silent on the
// shape it exists to catch. A hint that flags the documentation's code teaches
// people to stop reading hints, and the rest of this linter is load-bearing —
// so each of the three defects gets a case here.
Deno.test("aiol: post-await read is seen through a TYPE-ANNOTATED draft param", async () => {
  await withTmpDir(async (dir) => {
    // `METHOD_RE` demanded `,` or `)` straight after the param name, so
    // `async work(s: { … }, x)` — what real TypeScript looks like — never
    // matched and the entire method went unchecked. The one shape the rule
    // exists for was the one it skipped.
    await project(
      dir,
      `import { cell } from 'aio'
export const counter = cell('counter', {
  state: { mode: 'idle', n: 0 },
  methods: {
    async work(s: { mode: string; n: number }, x: number) {
      s.mode = 'working'
      await fetch('/x')
      if (s.mode === 'cancelled') return
      s.n += x
    },
  },
})
`,
    );
    const found = awaitReadIssues(await runCheckPatterns(dir));
    assertEquals(
      found.length,
      1,
      "a genuine post-await read must be reported even with a typed draft param",
    );
  });
});

// ── A WRITE is not a READ (field report llama-master #4) ────────────────
//
// `s.lastError = "…"` after the method's I/O is the one thing the method is
// SUPPOSED to do, and it was hinted as the hazard. There is no read there to
// declare deliberate, so `// aiol-ok` would have been a lie — "which is how
// useful lints get ignored". Each shape below is a separate way the old
// line-level test got it wrong, in BOTH directions.
Deno.test("aiol: a plain WRITE after an await is not a read — even wrapped by deno fmt", async () => {
  await withTmpDir(async (dir) => {
    // The report's line 189 was a long assignment; `deno fmt` breaks it after
    // the `=`, so the line the old check saw was a bare `s.lastError` with no
    // `=` on it at all. Classification must look past the end of the line.
    await project(
      dir,
      `import { cell } from 'aio'
export const conn = cell('conn', {
  state: { lastError: '', peers: [] as string[], meta: {} as Record<string, number> },
  methods: {
    async discover(s, url: string) {
      const res = await fetch(url)
      s.lastError =
        res.ok ? '' : 'discover failed: ' + res.status
      s.peers[0] = url
      s.meta['n'] = 1
      s.peers.push(url)
      delete s.meta['old']
    },
  },
})
`,
    );
    assertEquals(
      awaitReadIssues(await runCheckPatterns(dir)).map((i) => i.message),
      [],
      "assignment targets and mutations are writes, never post-await reads",
    );
  });
});

Deno.test("aiol: a read on the RHS of a post-await assignment IS flagged", async () => {
  await withTmpDir(async (dir) => {
    // The write on the line no longer covers for the read next to it.
    await project(
      dir,
      `import { cell } from 'aio'
export const c = cell('c', {
  state: { x: 0, y: 0 },
  methods: {
    async load(s) {
      await fetch('/x')
      s.x = s.y + 1
    },
  },
})
`,
    );
    const found = awaitReadIssues(await runCheckPatterns(dir));
    assertEquals(found.length, 1, JSON.stringify(found));
    assertEquals(found[0]!.line, 7, "reported on the RHS read's own line");
  });
});

Deno.test("aiol: a read inside an INDEX expression IS flagged", async () => {
  await withTmpDir(async (dir) => {
    // `s.items[s.idx] = v` — the target is a write, the index is a read.
    await project(
      dir,
      `import { cell } from 'aio'
export const c = cell('c', {
  state: { items: [] as string[], idx: 0 },
  methods: {
    async load(s, v: string) {
      await fetch('/x')
      s.items[s.idx] = v
    },
  },
})
`,
    );
    const found = awaitReadIssues(await runCheckPatterns(dir));
    assertEquals(found.length, 1, JSON.stringify(found));
    assertEquals(found[0]!.line, 7);
  });
});

Deno.test("aiol: a read passed as an ARGUMENT to a draft mutation IS flagged", async () => {
  await withTmpDir(async (dir) => {
    // `s.log.push(s.status)` — the push is a write, the argument is a read.
    await project(
      dir,
      `import { cell } from 'aio'
export const c = cell('c', {
  state: { log: [] as string[], status: 'idle' },
  methods: {
    async load(s) {
      await fetch('/x')
      s.log.push(s.status)
    },
  },
})
`,
    );
    assertEquals(awaitReadIssues(await runCheckPatterns(dir)).length, 1);
  });
});

Deno.test("aiol: compound assignment and ++ are writes, comparisons are reads", async () => {
  await withTmpDir(async (dir) => {
    // DELIBERATE: `s.n += 1` does read the old value, but it applies a DELTA to
    // whatever the field holds when it runs — a concurrent commit in the gap
    // makes it more current, not stale. `s.n >= 3` is a genuine read, and the
    // near-miss operators (`>=`, `===`) must not be mistaken for assignments.
    await project(
      dir,
      `import { cell } from 'aio'
export const c = cell('c', {
  state: { n: 0, hits: 0, name: '' },
  methods: {
    async bump(s) {
      await fetch('/x')
      s.n += 1
      s.hits++
      s.name ??= 'anon'
    },
    async guard(s) {
      await fetch('/x')
      if (s.n >= 3) return
      s.hits = 0
    },
  },
})
`,
    );
    const found = awaitReadIssues(await runCheckPatterns(dir));
    assertEquals(found.length, 1, JSON.stringify(found));
    assertEquals(found[0]!.message.includes('"guard"'), true);
  });
});

Deno.test("aiol: s.$signal and until()/race() are NOT post-await-read hints", async () => {
  await withTmpDir(async (dir) => {
    // `s.$signal.aborted` IS the documented cancellation check, and
    // `until(() => s.x)` IS the documented way to wait on live state —
    // re-reading is the entire point of the primitive. Draft meta
    // (`$signal`/`$live`/`$commit`) is framework surface, not app state a
    // concurrent action can move under you.
    await project(
      dir,
      `import { cell, until } from 'aio'
export const counter = cell('counter', {
  state: { mode: 'idle', n: 0 },
  cancelOn: { work: 'self' },
  methods: {
    async work(s, x) {
      s.mode = 'working'
      await fetch('/x')
      if (s.$signal.aborted) return
      await until(() => s.mode === 'working')
      s.n += x
    },
  },
})
`,
    );
    assertEquals(
      awaitReadIssues(await runCheckPatterns(dir)).map((i) => i.message),
      [],
      "the framework's own documented patterns must never be hinted",
    );
  });
});

// ── "use the aio logger" is an APP rule (field report llama-master #9) ────
//
// A developer command — the report's `sync-shared.ts`, a codegen script, a
// migration runner — prints to a terminal on purpose; it has no logger sinks
// and nobody greps its output by level. The scope answers one question the
// author can answer without reading the linter: is this file part of what the
// APP runs? Under `src/`/`cells/`, or declaring a cell / a component / the
// `aio.run(` boot → app. Otherwise (repo root, or a `#!` script) → tooling.
async function consoleHints(
  dir: string,
  files: Record<string, string>,
): Promise<string[]> {
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { "aio": "jsr:@riagentic/aio@1.0.0" } }),
  );
  for (const [rel, src] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, rel), src);
  }
  const { ctx, report } = await buildContext(dir);
  const { checkPerformance } = await import("../aiol/checks.ts");
  await checkPerformance(ctx);
  return report.issues
    .filter((i) => i.message.includes("console.log call(s)"))
    .map((i) => i.file ?? "");
}

Deno.test("aiol: console.log in a repo-root TOOLING script is not flagged", async () => {
  await withTmpDir(async (dir) => {
    assertEquals(
      await consoleHints(dir, {
        "sync-shared.ts": `// mirrors shared modules into client/src/shared
export async function sync(files: string[]) {
  for (const f of files) console.log('copied', f)
  console.log('done')
}
`,
      }),
      [],
      "a developer command prints on purpose",
    );
  });
});

Deno.test("aiol: console.log in a CELL is still flagged — wherever the file sits", async () => {
  await withTmpDir(async (dir) => {
    // Both files are OUTSIDE src/; the cell is app code by what it declares.
    const hits = await consoleHints(dir, {
      "src/counter.ts": `import { cell } from 'aio'
export const counter = cell('counter', {
  state: { n: 0 },
  methods: { inc(s) { console.log('inc', s.n); s.n += 1 } },
})
`,
      "root-cell.ts": `import { cell } from 'aio'
export const rooted = cell('rooted', {
  state: { n: 0 },
  methods: { inc(s) { console.log('inc'); s.n += 1 } },
})
`,
    });
    assertEquals(hits.sort(), ["root-cell.ts", "src/counter.ts"]);
  });
});

Deno.test("aiol: console.log in a COMPONENT and in the app entry is still flagged", async () => {
  await withTmpDir(async (dir) => {
    const hits = await consoleHints(dir, {
      "Widget.tsx": `export function Widget() {
  console.log('render')
  return <div>hi</div>
}
`,
      "app.ts": `import { aio } from 'aio'
console.log('booting')
await aio.run({ cells: [] })
`,
    });
    assertEquals(hits.sort(), ["Widget.tsx", "app.ts"]);
  });
});

Deno.test("aiol: a #! script inside src/ opts out; a plain src/ module does not", async () => {
  await withTmpDir(async (dir) => {
    // The shebang is a signal the AUTHOR writes — an actual executable — not
    // one the linter infers. A src/ module without one stays app code.
    const hits = await consoleHints(dir, {
      "src/gen-icons.ts": `#!/usr/bin/env -S deno run -A
console.log('generated 12 icons')
`,
      "src/report.ts": `export function summarize(n: number) {
  console.log('n =', n)
}
`,
    });
    assertEquals(hits, ["src/report.ts"]);
  });
});
