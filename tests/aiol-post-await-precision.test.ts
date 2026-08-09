// The post-await rule, made precise.
//
// A hint that fires on code which is fine is worse than no hint: people learn
// to scroll past it, and then miss the real one. Three imprecisions, each with
// its own shape of false positive or blind spot.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkPatterns, draftReadOffsets, pollSpans } from "../aiol/checks.ts";

async function hintsFor(cellSource: string): Promise<string[]> {
  const dir = await Deno.makeTempDir({ prefix: "aiol-postawait-" });
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "c.ts"), cellSource);
    const { ctx, report } = await buildContext(dir);
    checkPatterns(ctx);
    return report.issues
      .filter((i) => i.message.includes("after an await"))
      .map((i) => i.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("post-await: the genuine case still fires", () => {
  // Guard the guard — every exemption below is only meaningful if the rule
  // itself still works.
  return hintsFor(`import { cell } from "aio";
export const c = cell("c", {
  state: { a: 1, b: 2 },
  methods: {
    async go(s) {
      await fetch("/x");
      s.b = s.a + 1;
    },
  },
});`).then((h) => assertEquals(h.length, 1, "a real post-await read"));
});

Deno.test("post-await: draft META is not app state", async () => {
  // `s.$signal` cannot be moved by another action — it is framework surface.
  const hints = await hintsFor(`import { cell } from "aio";
export const c = cell("c", {
  state: { a: 1 },
  methods: {
    async go(s) {
      await fetch("/x");
      if (s.$signal.aborted) return;
      s.$commit();
    },
  },
});`);
  assertEquals(hints, []);
});

Deno.test("post-await: the poll exemption belongs to the CALL, not the line", async () => {
  // `until(() => s.ready)` re-reads on purpose — but a genuine read sharing the
  // line used to be excused with it.
  const exempt = await hintsFor(`import { cell, until } from "aio";
export const c = cell("c", {
  state: { ready: false, value: 0 },
  methods: {
    async go(s) {
      await until(() => s.ready);
    },
  },
});`);
  assertEquals(exempt, [], "the sanctioned re-read stays silent");

  const shared = await hintsFor(`import { cell, until } from "aio";
export const c = cell("c", {
  state: { ready: false, value: 0, out: 0 },
  methods: {
    async go(s) {
      await until(() => s.ready); s.out = s.value;
    },
  },
});`);
  assertEquals(shared.length, 1, "the read AFTER it on the same line is real");
});

Deno.test("post-await: a callback that reuses the draft's name is not the draft", async () => {
  // The classic false positive: `items.map((s) => s.id)` inside a method whose
  // draft is also called `s`. That `s` is the callback's.
  const hints = await hintsFor(`import { cell } from "aio";
export const c = cell("c", {
  state: { items: [] },
  methods: {
    async go(s) {
      const rows = await fetch("/x").then((r) => r.json());
      const ids = rows.map((s) => s.id);
      return ids;
    },
  },
});`);
  assertEquals(hints, []);
});

Deno.test("pollSpans: the argument list, not the whole line", () => {
  const line = `      await until(() => s.ready); s.out = s.value;`;
  const spans = pollSpans(line);
  assertEquals(spans.length, 1);
  const [a, b] = spans[0]!;
  assert(line.slice(a, b + 1).startsWith("until("), line.slice(a, b + 1));
  assert(!line.slice(a, b + 1).includes("s.out"), "stops at the closing paren");
});

Deno.test("draftReadOffsets: meta is exempt, an ordinary field is not", () => {
  assertEquals(draftReadOffsets("s.$signal.aborted", "s").length, 0);
  assertEquals(draftReadOffsets("s.$live.count", "s").length, 0);
  assertEquals(draftReadOffsets("const x = s.count", "s").length, 1);
  // Not a blanket $-exemption: only the four names the framework defines.
  assertEquals(draftReadOffsets("const x = s.$mine", "s").length, 1);
});
