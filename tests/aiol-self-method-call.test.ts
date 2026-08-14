// The framework's subtlest trap, turned into a squiggle.
//
// `job.foo()` from inside `job.bar()` runs as its OWN transaction against
// COMMITTED state, so it cannot see the write `bar` is mid-way through making.
// Correct, documented, and invisible at the call site — a field report lost
// real debugging time to it (choosing a file left the estimate empty) and ended
// up carrying a standing warning in their CLAUDE.md plus a convention of plain
// helper functions. A standing warning in a project doc is a lint rule nobody
// wrote yet.
//
// The rule has to be conservative, or people learn to ignore it: the tests
// below pin what must NOT fire as hard as what must.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkSelfMethodCall } from "../aiol/checks.ts";

async function issues(files: Record<string, string>) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await checkSelfMethodCall(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("aiol: a same-cell method call inside a method is flagged, with the fix", async () => {
  const found = await issues({
    "src/job.ts": `import { cell } from "aio";
export const job = cell("job", {
  state: { input: "", estimate: 0 },
  methods: {
    setInput(s: { input: string }, p: string) {
      s.input = p;
      job.estimateSize();     // ← reads COMMITTED state: input is still ""
    },
    estimateSize(s: { input: string; estimate: number }) {
      s.estimate = s.input.length;
    },
  },
});
`,
  });
  assertEquals(found.length, 1);
  assert(found[0]!.message.includes("job.estimateSize()"));
  assert(
    found[0]!.message.includes("COMMITTED state"),
    "the message must explain WHY, not just point",
  );
  assert(
    found[0]!.message.includes("applyEstimateSize"),
    "and name the shape of the fix — a plain helper both methods call",
  );
  assertEquals(found[0]!.line, 7);
});

Deno.test("aiol: a call inside $do() is NOT flagged — effects run after commit", async () => {
  const found = await issues({
    "src/job2.ts": `import { cell } from "aio";
export const job2 = cell("job2", {
  state: { n: 0 },
  methods: {
    start(s: { n: number; $do: (f: () => void) => void }) {
      s.n = 1;
      s.$do(() => { job2.finish(); });   // after the commit — the documented way
    },
    finish(s: { n: number }) { s.n = 2; },
  },
});
`,
  });
  assertEquals(
    found.length,
    0,
    "flagging the documented workaround would teach people to ignore the rule",
  );
});

Deno.test("aiol: calling the cell from OUTSIDE its literal is not the trap", async () => {
  const found = await issues({
    "src/job3.ts": `import { cell } from "aio";
export const job3 = cell("job3", {
  state: { n: 0 },
  methods: { bump(s: { n: number }) { s.n++; } },
});

export function onClick() {
  job3.bump();   // ordinary call site — its own transaction is correct here
}
`,
  });
  assertEquals(found.length, 0);
});

Deno.test("aiol: another cell's method is not a SELF call", async () => {
  const found = await issues({
    "src/two.ts": `import { cell } from "aio";
export const other = cell("other", {
  state: { x: 0 },
  methods: { touch(s: { x: number }) { s.x++; } },
});
export const main = cell("main", {
  state: { y: 0 },
  methods: {
    go(s: { y: number }) {
      s.y++;
      other.touch();   // cross-cell — a different transaction is the POINT
    },
  },
});
`,
  });
  assertEquals(found.length, 0);
});

Deno.test("aiol: `// aiol-ok` above the line silences it", async () => {
  const found = await issues({
    "src/job4.ts": `import { cell } from "aio";
export const job4 = cell("job4", {
  state: { n: 0 },
  methods: {
    a(s: { n: number }) {
      // aiol-ok — b() only reads committed state, which is what we want here
      job4.b();
    },
    b(s: { n: number }) { s.n++; },
  },
});
`,
  });
  assertEquals(found.length, 0);
});

Deno.test("aiol: a commented-out self call is not code", async () => {
  const found = await issues({
    "src/job5.ts": `import { cell } from "aio";
export const job5 = cell("job5", {
  state: { n: 0 },
  methods: {
    a(s: { n: number }) {
      // job5.b();  — removed, it read stale state
      s.n++;
    },
    b(s: { n: number }) { s.n++; },
  },
});
`,
  });
  assertEquals(found.length, 0);
});

// Both of the following were caught by `tests/examples-lint.test.ts` — the
// gate that requires every shipped example to be clean under the linter it
// ships with. They are the two ways this rule could have become noise.

Deno.test("aiol: a state FIELD sharing the cell's name is not a self call", async () => {
  // `examples/contacts` — the cell is `contacts` and so is its array field, so
  // `s.contacts.push(...)` read as a call on the binding. Three flagged lines
  // in a shipped example, none of them the trap.
  const found = await issues({
    "src/contacts.ts": `import { cell } from "aio";
export const contacts = cell("contacts", {
  state: { contacts: [] as string[] },
  methods: {
    create(s: { contacts: string[] }, name: string) {
      s.contacts.push(name);
    },
    remove(s: { contacts: string[] }, name: string) {
      s.contacts = s.contacts.filter((c) => c !== name);
    },
  },
});
`,
  });
  assertEquals(found, []);
});

Deno.test("aiol: a self call with NO prior draft write is a deliberate supersession", async () => {
  // `examples/disk` — `up()` computes a path and awaits `disk.open(parent)`.
  // The nested call running as its own transaction is the POINT (it supersedes
  // the running scan via cancelOn), and there is no in-progress write for it to
  // miss. The trap is specifically "I wrote, then called, and the callee did
  // not see it" — so that is exactly when it fires.
  const found = await issues({
    "src/disk.ts": `import { cell } from "aio";
export const disk = cell("disk", {
  state: { path: "/", scanning: false },
  cancelOn: { open: "self" },
  methods: {
    async open(s: { path: string; scanning: boolean }, p: string) {
      s.path = p;
      s.scanning = true;
    },
    async up(s: { path: string }) {
      const parent = s.path.replace(/\\/[^/]+\\/?$/, "") || "/";
      if (parent !== s.path) await disk.open(parent);
    },
  },
});
`,
  });
  assertEquals(
    found,
    [],
    "flagging a supersession call would flag the documented answer",
  );
});

Deno.test("aiol: an async method calling itself's sibling is flagged too", async () => {
  const found = await issues({
    "src/job6.ts": `import { cell } from "aio";
export const job6 = cell("job6", {
  state: { pct: 0, path: "" },
  methods: {
    async colorize(s: { pct: number; path: string }) {
      s.path = "/tmp/x";
      await job6.prepare();
      s.pct = 100;
    },
    prepare(s: { path: string }) { s.path = s.path + "/work"; },
  },
});
`,
  });
  assertEquals(found.length, 1);
  assert(found[0]!.message.includes("job6.prepare()"));
});
