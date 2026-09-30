// Journal admit (per-key watermark): OWN keys only.
//
// `k in p` is true for every Object.prototype name, so a watermark-blocked
// top-level key named `toString`/`valueOf`/… that prev lacked was put back as
// the native function instead of deleted — the same class as the
// unpersistedFromBase / sync-merge / persist-exclude pins.
import { assertEquals } from "@std/assert";
import { replayJournal } from "../src/server/journal.ts";

Deno.test("replayJournal admit: a watermark-blocked prototype-named key is deleted, not the native", () => {
  type S = Record<string, unknown>;
  const prev: S = { acct: { bal: 1 } };
  const reduce = (s: S, a: { type: string }) => ({
    state: a.type === "add-proto" ? { ...s, toString: { score: 99 } } : s,
  });
  // Watermark already covers `toString` — the entry's change to it must NOT
  // be taken. Prev never owned the key, so admit must DELETE it from next,
  // not assign Object.prototype.toString.
  const r = replayJournal(
    prev,
    [{ seq: 1, type: "add-proto", ts: 0 }],
    reduce,
    (k) => (k === "toString" ? 10 : 0),
  );
  assertEquals(
    Object.hasOwn(r.state, "toString"),
    false,
    String(r.state.toString),
  );
  assertEquals(r.state, { acct: { bal: 1 } });
});
