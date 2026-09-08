// `t.init()` reaches all the way down.
//
// `Partial<S>` only reaches the TOP level, so any nested object had to be
// supplied whole. A field report wrote a local `cfg()` helper in two test files
// purely to work around it, and every test that touched config then carried
// five fields it did not care about — exactly the noise that makes a test hard
// to read.
//
// WHY THIS IS SAFE UNDER THE FREEZE, precisely: today the parameter is
// `Partial<S>`, so a nested object must be supplied WHOLE — and when it is
// whole, a deep merge and a replace produce the same result. No test that
// COMPILES today can observe the change. The published `TestContext` keeps its
// `Partial<S>`; the private `TestCtxOf` the callback actually receives is what
// gets the deep type.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";

type Cfg = { baseUrl: string; retries: number; nested: { deep: boolean } };
type S = { config: Cfg; tags: string[]; when: Date };

const svc = cell("deepinit", {
  state: {
    config: { baseUrl: "https://a", retries: 3, nested: { deep: false } },
    tags: ["x", "y"],
    when: new Date(0),
  } as S,
  methods: { noop(_s: S) {} },
});

testCell(svc, "init: one nested field, the rest survive", (t) => {
  t.init({ config: { baseUrl: "http://x" } });
  t.expect.state((s) => {
    const c = (s as S).config;
    assertEquals(c.baseUrl, "http://x", "the field given wins");
    assertEquals(c.retries, 3, "a sibling the seed did not mention survives");
    assertEquals(c.nested.deep, false, "…and so does one a level further down");
    return true;
  });
});

testCell(svc, "init: it recurses — a grandchild alone", (t) => {
  t.init({ config: { nested: { deep: true } } });
  t.expect.state((s) => {
    const c = (s as S).config;
    assertEquals(c.nested.deep, true);
    assertEquals(c.baseUrl, "https://a", "its parent's siblings survive too");
    return true;
  });
});

testCell(svc, "init: an ARRAY replaces, it does not merge index-wise", (t) => {
  // A "partial array" is not a thing anyone means, and merging one index-wise
  // is how a fixture silently keeps an element it meant to drop.
  t.init({ tags: ["only"] });
  t.expect.state((s) => {
    assertEquals((s as S).tags, ["only"]);
    return true;
  });
});

testCell(
  svc,
  "init: a non-plain object replaces, it is not merged into",
  (t) => {
    const then = new Date(86_400_000);
    t.init({ when: then });
    t.expect.state((s) => {
      assert((s as S).when instanceof Date, "a Date must survive as a Date");
      assertEquals((s as S).when.getTime(), then.getTime());
      return true;
    });
  },
);

testCell(
  svc,
  "init: a WHOLE nested object still behaves exactly as before",
  (t) => {
    // The compatibility claim, asserted rather than argued: this is the only
    // shape the published `Partial<S>` type permits, and it must be unchanged.
    t.init({
      config: { baseUrl: "http://b", retries: 9, nested: { deep: true } },
    });
    t.expect.state((s) => {
      assertEquals((s as S).config, {
        baseUrl: "http://b",
        retries: 9,
        nested: { deep: true },
      });
      return true;
    });
  },
);

testCell(svc, "init: an unknown TOP-LEVEL key still throws", (t) => {
  // The existing guard must not be weakened by the deeper reach: a seed that
  // lands nowhere looks like a fixture and pins nothing.
  let msg = "";
  try {
    (t.init as (s: Record<string, unknown>) => void)({ nope: 1 });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(msg.includes("unknown state key"), msg || "(it did not throw)");
});
