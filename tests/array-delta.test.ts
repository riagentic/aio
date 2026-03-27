import {
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { _applyPatch, _rebuildIdMaps } from "../src/browser.ts";

// ── $arr patch application (AIO-12) ─────────────────────────────

Deno.test("applyPatch $arr: update one element → only that ref changes", () => {
  const sol = { id: "SOL", price: 100 };
  const btc = { id: "BTC", price: 50000 };
  const prev = { fleet: { members: [sol, btc], status: "ok" } } as Record<
    string,
    unknown
  >;
  _rebuildIdMaps(prev);

  const patch = {
    $p: {
      fleet: {
        members: { $arr: true, "$id:SOL": { id: "SOL", price: 142 } },
      },
    },
  };
  const result = _applyPatch(prev, patch);
  const fleet = result.fleet as Record<string, unknown>;
  const members = fleet.members as Array<Record<string, unknown>>;
  assertEquals(members.length, 2);
  assertEquals(members[0], { id: "SOL", price: 142 });
  assertStrictEquals(members[1], btc);
  assertStrictEquals(fleet.status, "ok");
});

Deno.test("applyPatch $arr: add element → appended, existing refs intact", () => {
  const sol = { id: "SOL", price: 100 };
  const prev = { fleet: { members: [sol] } } as Record<string, unknown>;
  _rebuildIdMaps(prev);

  const patch = {
    $p: {
      fleet: {
        members: { $arr: true, "$id:BTC": { id: "BTC", price: 50000 } },
      },
    },
  };
  const result = _applyPatch(prev, patch);
  const members = (result.fleet as Record<string, unknown>).members as Array<
    Record<string, unknown>
  >;
  assertEquals(members.length, 2);
  assertStrictEquals(members[0], sol);
  assertEquals(members[1], { id: "BTC", price: 50000 });
});

Deno.test("applyPatch $arr: remove element → removed, others preserved", () => {
  const sol = { id: "SOL", price: 100 };
  const btc = { id: "BTC", price: 50000 };
  const prev = { fleet: { members: [sol, btc] } } as Record<string, unknown>;
  _rebuildIdMaps(prev);

  const patch = {
    $p: {
      fleet: {
        members: { $arr: true, $rm: ["BTC"] },
      },
    },
  };
  const result = _applyPatch(prev, patch);
  const members = (result.fleet as Record<string, unknown>).members as Array<
    Record<string, unknown>
  >;
  assertEquals(members.length, 1);
  assertStrictEquals(members[0], sol);
});

Deno.test("applyPatch $arr: update + add + remove in one patch", () => {
  const a = { id: "A", v: 1 };
  const b = { id: "B", v: 2 };
  const c = { id: "C", v: 3 };
  const prev = { feat: { items: [a, b, c] } } as Record<string, unknown>;
  _rebuildIdMaps(prev);

  const patch = {
    $p: {
      feat: {
        items: {
          $arr: true,
          "$id:A": { id: "A", v: 99 },
          "$id:D": { id: "D", v: 4 },
          $rm: ["B"],
        },
      },
    },
  };
  const result = _applyPatch(prev, patch);
  const items = (result.feat as Record<string, unknown>).items as Array<
    Record<string, unknown>
  >;
  assertEquals(items.length, 3);
  assertEquals(items[0], { id: "A", v: 99 });
  assertStrictEquals(items[1], c);
  assertEquals(items[2], { id: "D", v: 4 });
});

Deno.test("applyPatch $arr: full state rebuild → _idMaps reset", () => {
  const prev = { feat: { items: [{ id: "A", v: 1 }] } } as Record<
    string,
    unknown
  >;
  _rebuildIdMaps(prev);

  const fullState = { feat: { items: [{ id: "X", v: 99 }] } } as Record<
    string,
    unknown
  >;
  _rebuildIdMaps(fullState);

  const patch = {
    $p: {
      feat: {
        items: { $arr: true, "$id:X": { id: "X", v: 100 } },
      },
    },
  };
  const result = _applyPatch(fullState, patch);
  const items = (result.feat as Record<string, unknown>).items as Array<
    Record<string, unknown>
  >;
  assertEquals(items.length, 1);
  assertEquals(items[0], { id: "X", v: 100 });
});

Deno.test("applyPatch: non-$arr array patch → current atomic behavior (backward compat)", () => {
  const prev = { feat: { items: [1, 2, 3] } } as Record<string, unknown>;
  const patch = { $p: { feat: { items: [1, 2, 99] } } };
  const result = _applyPatch(prev, patch);
  const items = (result.feat as Record<string, unknown>).items;
  assertEquals(items, [1, 2, 99]);
});

Deno.test("applyPatch $arr: unchanged elements have ref identity (===)", () => {
  const sol = { id: "SOL", price: 100 };
  const btc = { id: "BTC", price: 50000 };
  const eth = { id: "ETH", price: 3000 };
  const prev = { fleet: { members: [sol, btc, eth] } } as Record<
    string,
    unknown
  >;
  _rebuildIdMaps(prev);

  const patch = {
    $p: {
      fleet: {
        members: { $arr: true, "$id:BTC": { id: "BTC", price: 51000 } },
      },
    },
  };
  const result = _applyPatch(prev, patch);
  const members = (result.fleet as Record<string, unknown>).members as Array<
    Record<string, unknown>
  >;
  assertStrictEquals(members[0], sol, "SOL ref preserved");
  assertNotStrictEquals(members[1], btc, "BTC ref changed");
  assertStrictEquals(members[2], eth, "ETH ref preserved");
});

Deno.test("applyPatch $arr: empty-array lifecycle — populated → all removed → repopulated", () => {
  // Phase 1: populated array
  const a = { id: "A", v: 1 };
  const b = { id: "B", v: 2 };
  const state1 = { feat: { items: [a, b] } } as Record<string, unknown>;
  _rebuildIdMaps(state1);

  // Phase 2: remove all elements
  const patch1 = {
    $p: { feat: { items: { $arr: true, $rm: ["A", "B"] } } },
  };
  const state2 = _applyPatch(state1, patch1);
  const items2 = (state2.feat as Record<string, unknown>).items as unknown[];
  assertEquals(items2, [], "all removed → empty array");

  // Phase 3: repopulate via delta (new elements)
  const patch2 = {
    $p: {
      feat: {
        items: {
          $arr: true,
          "$id:X": { id: "X", v: 10 },
          "$id:Y": { id: "Y", v: 20 },
        },
      },
    },
  };
  const state3 = _applyPatch(state2, patch2);
  const items3 = (state3.feat as Record<string, unknown>).items as Array<
    Record<string, unknown>
  >;
  assertEquals(items3.length, 2);
  assertEquals(items3[0], { id: "X", v: 10 });
  assertEquals(items3[1], { id: "Y", v: 20 });
});

Deno.test("_applyPatch: $arr identity patch survives contradicting $d deletion (defense-in-depth)", () => {
  const prev = { feat: { items: [{ id: "old", v: 1 }], count: 5 } };
  _rebuildIdMaps(prev);

  // Manually construct a contradicting patch:
  // $arr creates items, $d deletes items
  const patch = {
    $p: {
      feat: {
        items: {
          $arr: true,
          "$id:a": { id: "a", v: 1 },
          "$id:b": { id: "b", v: 2 },
        },
        $d: ["items"],
      },
    },
  };

  const result = _applyPatch(prev, patch);
  const feat = result.feat as Record<string, unknown>;

  // items MUST survive — $arr takes precedence over $d
  assertNotEquals(feat.items, undefined, "items must NOT be deleted");
  assertEquals(Array.isArray(feat.items), true, "items must be an array");
  assertEquals(
    (feat.items as unknown[]).length,
    3,
    "items must have 3 elements (1 existing + 2 from $arr patch)",
  );
  // count must be preserved
  assertEquals(feat.count, 5, "count must be preserved");
});
