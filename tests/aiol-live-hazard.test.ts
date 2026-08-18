// The `$live` hazard, turned into a lint line.
//
// Under `transaction: true` a method's reads are PINNED at entry, so a method
// that reads a field, awaits, then writes that field conflicts the moment any
// other action commits it mid-flight — and the commit is REJECTED. The runtime
// error for that is excellent; its timing is not. A field report hit it on the
// first live run of a desktop app, from `onStart` firing two async methods
// concurrently, and called fixing it "the single highest-value change on this
// list" — because the shape is statically visible and aiol already walks the
// cell.
//
// A rule that cries wolf is worse than no rule, so the negative cases below
// carry as much weight as the positive one.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkLiveHazard } from "../aiol/checks.ts";

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
    await checkLiveHazard(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const HAZARD = `import { cell } from "aio";
export const issues = cell("issues", {
  transaction: true,
  state: { issues: [] as string[], scanning: false },
  methods: {
    async scan(s: { issues: string[]; scanning: boolean }) {
      const found = s.issues.length;
      await new Promise((r) => setTimeout(r, 1));
      s.issues = [...s.issues, String(found)];
    },
  },
});
`;

Deno.test("aiol: a pinned read written after an await is flagged", async () => {
  const found = await issues({ "src/issues.ts": HAZARD });
  assertEquals(found.length, 1);
  const m = found[0]!.message;
  assert(m.includes("issues.scan()"), `names the method: ${m}`);
  assert(m.includes("s.issues"), `names the FIELD, not just the method: ${m}`);
  assert(m.includes("pinned"), `explains the mechanism: ${m}`);
  assert(m.includes("$live"), `offers the fix: ${m}`);
  assertEquals(found[0]!.severity, "warn");
});

Deno.test("aiol: reading through $live silences it — the author chose", async () => {
  const found = await issues({
    "src/issues.ts": HAZARD.replace(
      "s.issues = [...s.issues, String(found)];",
      "s.issues = [...s.$live.issues, String(found)];",
    ),
  });
  assertEquals(found.length, 0);
});

Deno.test("aiol: a NON-transactional cell has no pinned reads to conflict", async () => {
  const found = await issues({
    "src/issues.ts": HAZARD.replace("  transaction: true,\n", ""),
  });
  assertEquals(found.length, 0, "live reads cannot go stale-then-conflict");
});

Deno.test("aiol: a contiguous read+write after the await is fine", async () => {
  // The documented remedy — gather async results first, then read and write in
  // one block — must not be reported as the hazard it fixes.
  const found = await issues({
    "src/issues.ts": `import { cell } from "aio";
export const issues = cell("issues", {
  transaction: true,
  state: { issues: [] as string[] },
  methods: {
    async scan(s: { issues: string[] }) {
      const extra = await Promise.resolve("x");
      s.issues = [...s.issues, extra];
    },
  },
});
`,
  });
  assertEquals(found.length, 0);
});

Deno.test("aiol: a method with no await is not a hazard", async () => {
  const found = await issues({
    "src/issues.ts": `import { cell } from "aio";
export const issues = cell("issues", {
  transaction: true,
  state: { issues: [] as string[] },
  methods: {
    // deno-lint-ignore require-await
    async touch(s: { issues: string[] }) {
      const n = s.issues.length;
      s.issues = [String(n)];
    },
  },
});
`,
  });
  assertEquals(found.length, 0);
});

Deno.test("aiol: writing a DIFFERENT field than it read is not a hazard", async () => {
  const found = await issues({
    "src/issues.ts": `import { cell } from "aio";
export const issues = cell("issues", {
  transaction: true,
  state: { issues: [] as string[], count: 0 },
  methods: {
    async scan(s: { issues: string[]; count: number }) {
      const n = s.issues.length;
      await Promise.resolve();
      s.count = n;
    },
  },
});
`,
  });
  assertEquals(found.length, 0, "only a read-then-write of the SAME field");
});

Deno.test("aiol: WRITE→await→WRITE is not a hazard — a write is not a read", async () => {
  // The framework's own feedback/updates cells have exactly this shape
  // (`s.status = "capturing"; await …; s.status = "saved"`), and the first cut
  // of the rule flagged all three. The runtime's conflict detector pins READS
  // alone — the set trap records writes, never reads — so this cannot
  // conflict, and warning on it would train people to ignore the rule.
  const found = await issues({
    "src/issues.ts": `import { cell } from "aio";
export const fb = cell("fb", {
  transaction: true,
  state: { status: "idle", error: null as string | null, items: [] as string[] },
  methods: {
    async report(s: { status: string; error: string | null; items: string[] }) {
      s.status = "capturing";
      s.error = null;
      s.items.push("started");
      await Promise.resolve();
      s.status = "saved";
      s.error = null;
      s.items.push("done");
    },
  },
});
`,
  });
  assertEquals(found.length, 0);
});

Deno.test("aiol: a nested-path assignment LHS is a write, not a read", async () => {
  const found = await issues({
    "src/issues.ts": `import { cell } from "aio";
export const nest = cell("nest", {
  transaction: true,
  state: { meta: { count: 0 } },
  methods: {
    async touch(s: { meta: { count: number } }) {
      s.meta.count = 1;
      await Promise.resolve();
      s.meta.count = 2;
    },
  },
});
`,
  });
  assertEquals(found.length, 0);
});

Deno.test("aiol: a COMPARISON before the await is a real read and still flags", async () => {
  // `==`/`===`/`=>` must not be mistaken for assignment — a guard that reads
  // the field is exactly the pinned read the rule exists for.
  const found = await issues({
    "src/issues.ts": `import { cell } from "aio";
export const g = cell("g", {
  transaction: true,
  state: { status: "idle" },
  methods: {
    async run(s: { status: string }) {
      if (s.status === "busy") return;
      await Promise.resolve();
      s.status = "busy";
    },
  },
});
`,
  });
  assertEquals(found.length, 1);
});
