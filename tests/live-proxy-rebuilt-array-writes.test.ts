// Writes through the elements a REBUILT-ARRAY read method hands back.
//
// `map`/`filter`/`slice`/`concat`/`toSorted` used to return DETACHED clones in
// an async method, so this — the single most common bulk-update idiom in
// JavaScript —
//
//     const rows = s.items.filter(r => r.on);
//     for (const r of rows) r.q = 0;
//
// silently did nothing, while the byte-identical SYNC body (an Immer draft,
// whose `filter` yields drafts) updated every row. A production consumer
// running live money distilled the symptom into a memorized law — "mutate in
// ONE contiguous block, writes interleaved between awaits drop" — which was
// never the actual rule; they had learned to avoid the shape that dropped.
//
// The class is pinned by the differential fuzzer (tests/fuzz-ops.ts:
// objarr_map_write / objarr_filter_write / objarr_slice_write / …). These are
// the named regressions, so a failure reads as a sentence instead of a seed.
import { assertEquals } from "@std/assert";
import { cell } from "aio";
import { testCell } from "aio/testing";

const rows = () => [{ id: 1, q: 0 }, { id: 2, q: 0 }, { id: 3, q: 0 }];

const c = cell("rebuilt", {
  state: { items: rows(), tags: ["a", "b"] },
  methods: {
    async viaMap(s) {
      const r = s.items.map((x) => x);
      await Promise.resolve();
      r[0]!.q = 7;
    },
    async viaFilter(s) {
      for (const r of s.items.filter((x) => x.id !== 2)) r.q = 8;
    },
    async viaSlice(s) {
      await Promise.resolve();
      s.items.slice(1).forEach((r) => {
        r.q = 9;
      });
    },
    async viaToSorted(s) {
      s.items.toSorted((a, b) => b.id - a.id)[0]!.q = 10;
    },
    async viaConcat(s) {
      s.items.concat([])[2]!.q = 11;
    },
    // Identity: a read method's elements ARE `s.items[i]`.
    async identity(s) {
      return [
        s.items.indexOf(s.items[0]!),
        s.items.includes(s.items[1]!),
        s.items.map((x) => x)[0] === s.items[0],
      ];
    },
    // The return crosses the transport seam — proxies must materialize.
    async returnsRebuilt(s) {
      return s.items.filter((x) => x.id > 1);
    },
    // Stringifying reads stay on plain data (String(proxy) throws).
    async joins(s) {
      return s.tags.join("-");
    },
  },
});

testCell(c, "map() elements are live — a post-await write lands", async (t) => {
  await t.send.viaMap!();
  await t.settle();
  assertEquals(t.getState().items[0]!.q, 7);
});

testCell(c, "filter() elements are live", async (t) => {
  await t.send.viaFilter!();
  await t.settle();
  assertEquals(t.getState().items.map((r) => r.q), [8, 0, 8]);
});

testCell(c, "slice() elements are live", async (t) => {
  await t.send.viaSlice!();
  await t.settle();
  assertEquals(t.getState().items.map((r) => r.q), [0, 9, 9]);
});

testCell(c, "toSorted() elements are live", async (t) => {
  await t.send.viaToSorted!();
  await t.settle();
  assertEquals(t.getState().items[2]!.q, 10);
});

testCell(c, "concat() elements are live", async (t) => {
  await t.send.viaConcat!();
  await t.settle();
  assertEquals(t.getState().items[2]!.q, 11);
});

testCell(c, "read-method elements keep s.items[i] identity", async (t) => {
  assertEquals(await t.send.identity!(), [0, true, true]);
});

testCell(
  c,
  "a rebuilt array returned to the caller is plain data",
  async (t) => {
    assertEquals(await t.send.returnsRebuilt!(), [
      { id: 2, q: 0 },
      { id: 3, q: 0 },
    ]);
  },
);

testCell(c, "join() still stringifies (never String(proxy))", async (t) => {
  assertEquals(await t.send.joins!(), "a-b");
});
