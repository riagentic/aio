import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { mergeField } from "../../src/sync/merge.ts";
import type { HLC } from "../../src/sync/types.ts";

const earlier: HLC = [1000, 0, "c1"];
const later: HLC = [2000, 0, "c2"];

describe("mergeField", () => {
  describe("lww", () => {
    it("takes value with later HLC", () => {
      assertEquals(mergeField("lww", 10, earlier, 20, later), {
        value: 20,
        conflict: true,
      });
    });

    it("takes local if local is later", () => {
      assertEquals(mergeField("lww", 20, later, 10, earlier), {
        value: 20,
        conflict: true,
      });
    });

    it("no conflict if values are equal", () => {
      assertEquals(mergeField("lww", 10, earlier, 10, later), {
        value: 10,
        conflict: false,
      });
    });
  });

  describe("counter", () => {
    it("adds deltas (both incremented)", () => {
      assertEquals(mergeField("counter", 3, earlier, 5, later, 0), {
        value: 8,
        conflict: false,
      });
    });

    it("handles negative deltas", () => {
      assertEquals(mergeField("counter", -2, earlier, 3, later, 0), {
        value: 1,
        conflict: false,
      });
    });
  });

  describe("lww-per-key", () => {
    it("merges each key independently by HLC", () => {
      const local = { a: 1, b: 2 };
      const remote = { a: 10, c: 3 };
      const result = mergeField("lww-per-key", local, earlier, remote, later);
      assertEquals(result.value, { a: 10, b: 2, c: 3 });
      assertEquals(result.conflict, true);
    });

    it("local wins when local is later", () => {
      const local = { a: 1 };
      const remote = { a: 10 };
      const result = mergeField("lww-per-key", local, later, remote, earlier);
      assertEquals(result.value, { a: 1 });
    });
  });

  describe("set-add (add wins)", () => {
    it("union of both sets — concurrent add + remove keeps item", () => {
      const local = [{ id: "a" }, { id: "b" }];
      const remote = [{ id: "b" }, { id: "c" }];
      const result = mergeField("set-add", local, earlier, remote, later);
      const ids = (result.value as { id: string }[]).map((i) => i.id).sort();
      assertEquals(ids, ["a", "b", "c"]);
      assertEquals(result.conflict, false);
    });
  });

  describe("set-remove (remove wins)", () => {
    it("intersection behavior — concurrent add + remove removes item", () => {
      const base = [{ id: "a" }, { id: "b" }, { id: "c" }];
      const local = [{ id: "a" }, { id: "b" }]; // removed c
      const remote = [{ id: "b" }, { id: "c" }, { id: "d" }]; // removed a, added d
      const result = mergeField(
        "set-remove",
        local,
        earlier,
        remote,
        later,
        base,
      );
      const ids = (result.value as { id: string }[]).map((i) => i.id).sort();
      // b survives (in both), d added by remote, a removed by remote, c removed by local
      assertEquals(ids, ["b", "d"]);
      assertEquals(result.conflict, false);
    });
  });
});

// ── set-remove: what the rule IS, and what it now reports ────────────────────
// The ds4 audit read `if (inBase && !inLocal) continue` as "a remote re-add is
// silently dropped". Read whole, the rule is SYMMETRIC remove-wins: an item in
// base that either side dropped is gone. That is a deliberate set-merge choice,
// and a 3-way ARRAY diff cannot do better — "remote re-added it" and "remote
// left it alone" produce the identical array. Telling those apart needs
// per-item tombstones this structure does not carry.
//
// What it CAN tell apart is remove-vs-EDIT, and resolving THAT silently was the
// real half of the finding.

const H = (n: number): HLC => [n, 0, "s"];

Deno.test("setRemove: a remove beats an untouched item, on either side", () => {
  const base = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
  // local removed "a"; remote left everything alone.
  const l = mergeField(
    "set-remove",
    [{ id: "b", v: 1 }],
    H(2),
    base,
    H(1),
    base,
  );
  assertEquals(l.value, [{ id: "b", v: 1 }]);
  assertEquals(l.conflict, false, "a remove racing NOTHING is not a conflict");

  // …and the mirror: remote removed, local untouched.
  const r = mergeField(
    "set-remove",
    base,
    H(1),
    [{ id: "b", v: 1 }],
    H(2),
    base,
  );
  assertEquals(r.value, [{ id: "b", v: 1 }], "symmetric — same outcome");
  assertEquals(r.conflict, false);
});

Deno.test("setRemove: a remove racing an EDIT still removes — but says so", () => {
  // The two sides made incompatible decisions about the same item. The value
  // stays predictable (remove wins), and `onConflict` finally hears about it.
  const base = [{ id: "a", v: 1 }];
  const res = mergeField(
    "set-remove",
    [],
    H(1),
    [{ id: "a", v: 99 }],
    H(2),
    base,
  );
  assertEquals(res.value, [], "remove-wins is unchanged");
  assertEquals(
    res.conflict,
    true,
    "a remove that races an edit is a disagreement, not a quiet resolution",
  );
});

Deno.test("setRemove: the mirror case reports too", () => {
  const base = [{ id: "a", v: 1 }];
  const res = mergeField(
    "set-remove",
    [{ id: "a", v: 99 }],
    H(2),
    [],
    H(1),
    base,
  );
  assertEquals(res.value, []);
  assertEquals(res.conflict, true);
});
