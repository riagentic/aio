// aiol checkAlpha52 — the effect-channel deprecations and their safe-fixes:
// return-ed effects → s.$do; the transaction MIGRATION (insert
// `transaction: false,` into undeclared async cells); listensTo array form;
// selector deps spread → tuple; schedule.backoff/poll order + `backoff` key.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildContext } from "../aiol/context.ts";
import { checkAlpha52 } from "../aiol/checks.ts";
import { join } from "@std/path";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function project(dir: string, source: string) {
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
      unstable: ["kv"],
    }),
  );
  await Deno.writeTextFile(join(dir, "src", "cells.ts"), source);
}

async function run(dir: string) {
  const { ctx, report } = await buildContext(dir);
  await checkAlpha52(ctx);
  return report.issues.filter((i) => i.area === "alpha52");
}

async function runAndFix(dir: string) {
  const issues = await run(dir);
  for (const i of issues) {
    if (i.safeFix) await i.safeFix(dir);
  }
  return {
    issues,
    fixed: await Deno.readTextFile(join(dir, "src", "cells.ts")),
  };
}

Deno.test("aiol alpha52: `return schedule.X(...)` → s.$do(...) — tail return dropped", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `import { cell, schedule } from 'aio'
export const t = cell('t', {
  state: { n: 0 },
  methods: {
    arm(s) {
      s.n++;
      return schedule.after('t:next', 1000, { type: 't:arm' });
    },
    early(s, stop: boolean) {
      if (stop) {
        return schedule.cancel('t:next');
      }
      s.n++;
    },
  },
})
`,
    );
    const { issues, fixed } = await runAndFix(dir);
    assertEquals(issues.length, 2);
    assertStringIncludes(issues[0]!.message, "s.$do");
    assertStringIncludes(
      fixed,
      "s.$do(schedule.after('t:next', 1000, { type: 't:arm' }));",
    );
    assert(
      !/\$do\(schedule\.after[^;]*\);\n\s*return;/.test(fixed),
      "tail position: no dead bare return appended",
    );
    assert(
      /s\.\$do\(schedule\.cancel\('t:next'\)\);\n\s*return;/.test(fixed),
      "early-exit position: the bare return STAYS (control flow preserved)",
    );
    assert(!fixed.includes("return schedule."), "old spelling gone");
  });
});

Deno.test("aiol alpha52: `return [effects...]` array form rewrites; data arrays untouched", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `import { cell, schedule, own } from 'aio'
export const t = cell('t', {
  state: { n: 0 },
  methods: {
    arm(s) {
      return [schedule.after('a', 10, { type: 't:x' }), own.dispose('h')];
    },
    data(s) {
      return [1, 2, 3];
    },
  },
})
`,
    );
    const { issues, fixed } = await runAndFix(dir);
    assertEquals(issues.length, 1, "only the effect array is flagged");
    assertStringIncludes(
      fixed,
      "s.$do(schedule.after('a', 10, { type: 't:x' }), own.dispose('h'));",
    );
    assertStringIncludes(fixed, "return [1, 2, 3];", "data return untouched");
  });
});

// alpha57: `transaction` went back to opt-in, so the alpha52 migration that
// used to insert `transaction: false,` is GONE. An async cell that never
// declared it is correct as written — the linter must say nothing about it,
// and must certainly not edit it. (.katana/_aio.md — the default a cell never
// asked for cannot change under it.)
Deno.test("aiol alpha57: an async cell without `transaction` is NOT flagged and NOT rewritten", async () => {
  await withTmpDir(async (dir) => {
    const source = `import { cell } from 'aio'
export const jobs = cell('jobs', {
  state: { status: 'idle' },
  methods: {
    async run(s) {
      s.status = 'working';
      await new Promise((r) => setTimeout(r, 10));
      s.status = 'done';
    },
  },
})
export const plain = cell('plain', {
  state: { n: 0 },
  methods: { bump(s) { s.n++ } },
})
export const decided = cell('decided', {
  state: { n: 0 },
  transaction: true,
  methods: { async go(s) { await Promise.resolve(); s.n++ } },
})
`;
    await project(dir, source);
    const { issues, fixed } = await runAndFix(dir);
    assertEquals(
      issues.filter((i) => i.message.includes("transaction")).length,
      0,
      "no transaction finding — the migration retired with the default flip",
    );
    assertEquals(fixed, source, "the file is left exactly as written");
  });
});

Deno.test("aiol alpha52: listensTo array form is reported (no safe-fix — needs a handler)", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `import { cell } from 'aio'
export const t = cell('t', {
  state: { n: 0 },
  listensTo: ['other:bump'],
  methods: {},
})
`,
    );
    const issues = await run(dir);
    assertEquals(issues.length, 1);
    assertStringIncludes(issues[0]!.message, "use the object form");
    assertEquals(issues[0]!.safeFix, undefined);
  });
});

Deno.test("aiol alpha52: selector deps spread → tuple safe-fix (untyped params only)", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `import { cell } from 'aio'
export const t = cell('t', {
  state: { n: 0 },
  methods: {},
  selectors: {
    scaled: { deps: ['other'], fn: (s, other) => s.n * other.factor },
    twoDeps: { deps: ['a', 'b'], fn: (s, a, b) => a.x + b.y },
  },
})
`,
    );
    const { issues, fixed } = await runAndFix(dir);
    assertEquals(issues.length, 2);
    assertStringIncludes(fixed, "fn: (s, [other]) =>");
    assertStringIncludes(fixed, "fn: (s, [a, b]) =>");
  });
});

Deno.test("aiol alpha52: schedule old arg order reported; poll `backoff` key safe-fixed to `factor`", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `import { cell, schedule } from 'aio'
export const t = cell('t', {
  state: { attempt: 0 },
  methods: {
    tick(s) {
      return schedule.poll('rpc', s.attempt, { every: 5000, backoff: 2 }, { type: 't:tick' });
    },
  },
})
`,
    );
    const { issues, fixed } = await runAndFix(dir);
    const order = issues.filter((i) =>
      i.message.includes("swap the last two arguments")
    );
    const key = issues.filter((i) =>
      i.message.includes("schedule.poll({ backoff }) was removed")
    );
    assertEquals(order.length, 1);
    assertEquals(key.length, 1);
    assertStringIncludes(fixed, "factor: 2");
    assert(!fixed.includes("backoff: 2"));
  });
});

// ── The release-blocker regression: safe-fix output must pass the app's own
// gates (deno check AND deno lint). The rewrite used to leave the effect
// return-type annotation (`: ScheduleEffect`, `: Promise<CellEffect | void>` —
// the TS7022 workarounds self() retires) in place over a bare `return;` —
// TS2322 after migration — and stripping it orphans the type import
// (no-unused-vars). Pinned by running the real gates over the fixed files.

const REPO = new URL("../", import.meta.url).pathname;

async function gateProject(dir: string, source: string) {
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: { "aio": `${REPO}mod.ts` },
      unstable: ["kv"],
      // The lib set every scaffolded app carries — mod.ts pulls renderer
      // types, which need the DOM lib to type-check.
      compilerOptions: {
        lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      },
    }),
  );
  await Deno.writeTextFile(join(dir, "src", "cells.ts"), source);
}

async function runGates(dir: string): Promise<void> {
  const file = join(dir, "src", "cells.ts");
  for (const args of [["check", file], ["lint", file]]) {
    const p = await new Deno.Command(Deno.execPath(), {
      args,
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!p.success) {
      throw new Error(
        `deno ${args[0]} FAILED on safe-fix output:\n` +
          new TextDecoder().decode(p.stderr) +
          new TextDecoder().decode(p.stdout) +
          `\n--- fixed file ---\n` + await Deno.readTextFile(file),
      );
    }
  }
}

Deno.test("aiol alpha52 safe-fix output passes deno check + lint: simple annotated effect return", async () => {
  await withTmpDir(async (dir) => {
    await gateProject(
      dir,
      `import { cell, schedule, type ScheduleEffect } from "aio";
export const cycle = cell("cycle", {
  state: { n: 0 },
  methods: {
    tick(s: { n: number }) {
      s.n += 1;
    },
    skip(s: { n: number }): ScheduleEffect {
      return schedule.after("cycle.next", 10, { type: "cycle:tick" });
    },
  },
});
`,
    );
    const { issues, fixed } = await runAndFix(dir);
    assertEquals(issues.length, 1);
    assert(!fixed.includes(": ScheduleEffect"), "annotation stripped");
    assert(
      !fixed.includes("ScheduleEffect"),
      "orphaned type import pruned too",
    );
    assertStringIncludes(
      fixed,
      "s: { n: number } & MethodDraftServed",
      "annotated s gains the served draft members",
    );
    assertStringIncludes(fixed, 'type MethodDraftServed } from "aio"');
    await runGates(dir);
  });
});

Deno.test("aiol alpha52 safe-fix output passes deno check + lint: async Promise<CellEffect | void>", async () => {
  await withTmpDir(async (dir) => {
    await gateProject(
      dir,
      `import { cell, type CellEffect, schedule } from "aio";
export const poller = cell("poller", {
  state: { n: 0 },
  methods: {
    async poll(s: { n: number }): Promise<CellEffect | void> {
      await Promise.resolve();
      s.n += 1;
      return schedule.after("poller.retry", 500, { type: "poller:poll" });
    },
  },
});
`,
    );
    const { issues, fixed } = await runAndFix(dir);
    // ONE finding: the return-ed effect. (Until alpha57 there was a second —
    // the transaction MIGRATION — which retired with the default flip.)
    assertEquals(issues.length, 1);
    assert(!fixed.includes("CellEffect"), "annotation AND import gone");
    assertStringIncludes(fixed, "& MethodDraftServed");
    assert(
      !fixed.includes("transaction"),
      "an async cell is never given a transaction key it did not ask for",
    );
    await runGates(dir);
  });
});

Deno.test("aiol alpha52 safe-fix output passes deno check + lint: mixed returns narrow the union", async () => {
  await withTmpDir(async (dir) => {
    await gateProject(
      dir,
      `import { cell, type CellEffect, schedule } from "aio";
export const mix = cell("mix", {
  state: { n: 0 },
  methods: {
    maybe(s: { n: number }, done: boolean): CellEffect | string {
      if (done) {
        return "finished";
      }
      return schedule.after("mix.next", 10, { type: "mix:maybe" });
    },
  },
});
`,
    );
    const { issues, fixed } = await runAndFix(dir);
    assertEquals(issues.length, 1);
    assertStringIncludes(
      fixed,
      ": string | void",
      "union narrowed to the value arm + void (the rewritten path returns nothing)",
    );
    assert(!fixed.includes("CellEffect"), "effect member + import gone");
    assertStringIncludes(fixed, 'return "finished";', "value return untouched");
    await runGates(dir);
  });
});

Deno.test("aiol alpha52 safe-fix: an OPAQUE effect-annotation alias leaves the method unfixed", async () => {
  await withTmpDir(async (dir) => {
    const source = `import { cell, type CellEffect, schedule } from "aio";
type Fx = CellEffect;
export const alias = cell("alias", {
  state: { n: 0 },
  methods: {
    skip(s: { n: number }): Fx {
      s.n += 1;
      return schedule.after("alias.next", 10, { type: "alias:skip" });
    },
  },
});
`;
    await gateProject(dir, source);
    const { issues, fixed } = await runAndFix(dir);
    assertEquals(issues.length, 1, "still reported");
    assertEquals(fixed, source, "not confidently rewritable — untouched");
    // The UNFIXED file still passes its gates (deprecated channel works).
    await runGates(dir);
  });
});

Deno.test("aiol alpha52: a CORRECTLY-migrated poll/backoff call (object-literal action 3rd) yields ZERO findings", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `import { cell, schedule } from 'aio'
export const t = cell('t', {
  state: { attempt: 0 },
  methods: {
    tick(s) {
      s.$do(schedule.poll('rpc', s.attempt, { type: 't:tick' }, { every: 5000, factor: 2 }));
      s.$do(schedule.backoff('retry', s.attempt, { type: 't:tick', payload: { backoff: 1 } }, { base: 1000 }));
    },
  },
})
`,
    );
    const issues = await run(dir);
    assertEquals(
      issues.map((i) => i.message),
      [],
      "the new spelling must never be flagged — not the order, not the payload's own backoff field",
    );
  });
});

Deno.test("aiol alpha52: `backoff` key rename is global across poll calls and never touches an action payload", async () => {
  await withTmpDir(async (dir) => {
    await project(
      dir,
      `import { cell, schedule } from 'aio'
export const t = cell('t', {
  state: { a: 0, b: 0 },
  methods: {
    one(s) {
      return schedule.poll('one', s.a, { every: 1000, backoff: 2 }, { type: 't:one' });
    },
    two(s) {
      return schedule.poll('two', s.b, { backoff: 3, every: 2000 }, { type: 't:two', payload: { backoff: 9 } });
    },
  },
})
`,
    );
    const { fixed } = await runAndFix(dir);
    assertStringIncludes(fixed, "{ every: 1000, factor: 2 }");
    assertStringIncludes(
      fixed,
      "{ factor: 3, every: 2000 }",
      "key-first order renamed too",
    );
    assertStringIncludes(
      fixed,
      "payload: { backoff: 9 }",
      "the action payload's own backoff field is DATA — untouched",
    );
  });
});
