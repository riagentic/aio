// The shared op vocabulary for the cell-method differential fuzzers — ONE
// program interpreter, so `proxy-differential` (sync draft vs async live proxy)
// and `transaction-differential` (no transaction vs snapshot vs serializable)
// can never drift into testing different languages. Adding a proxy capability
// means adding a kind HERE, and both fuzzers exercise it the same day.

export type Data = {
  a: number;
  obj: Record<string, unknown>;
  nums: number[];
  items: { id: number; q: number }[];
  /** Depth: every path helper (overlay replay, watch keys, nested proxy cache)
   *  is indexed by a path ARRAY, and three levels is the shortest program that
   *  can tell a prefix bug from an exact-key bug. */
  deep: { l1: { l2: { l3: number[] } } };
  /** An array whose ELEMENTS are arrays — `Array.isArray()` decides the proxy
   *  target's kind, and a nested array behind an object target serializes as
   *  `{"0":…}`. Only a grid exercises that at depth ≥ 2. */
  grid: number[][];
};
export const initData = (): Data => ({
  a: 0,
  obj: { x: 1 },
  nums: [1, 2, 3],
  items: [{ id: 1, q: 10 }, { id: 2, q: 20 }],
  deep: { l1: { l2: { l3: [1, 2] } } },
  grid: [[1, 2], [3, 4]],
});

export type Op = { kind: string; i: number; v: number };

/** One program step, interpreted identically for both backends. Reads append
 *  PRIMITIVES to `log` (object reads would compare proxy vs draft identity,
 *  which is not the contract — values are). */
export function applyOp(s: { data: Data }, op: Op, log: unknown[]): void {
  const d = s.data;
  switch (op.kind) {
    case "set_scalar":
      d.a = op.v;
      break;
    case "rmw_scalar": {
      const cur = d.a;
      log.push(cur);
      d.a = cur + op.v;
      break;
    }
    case "set_nested":
      d.obj.x = op.v;
      break;
    case "set_new_key":
      d.obj[`k${op.i % 4}`] = op.v;
      break;
    case "del_nested":
      delete d.obj.x;
      break;
    case "read_keys":
      log.push(Object.keys(d.obj).sort().join(","));
      break;
    case "read_in":
      log.push("x" in d.obj);
      break;
    case "arr_push":
      d.nums.push(op.v);
      break;
    case "arr_pop":
      log.push(d.nums.pop());
      break;
    case "arr_unshift":
      d.nums.unshift(op.v);
      break;
    case "arr_shift":
      log.push(d.nums.shift());
      break;
    case "arr_splice":
      d.nums.splice(op.i % (d.nums.length + 1), op.i % 2, op.v);
      break;
    case "arr_set_idx":
      if (d.nums.length) d.nums[op.i % d.nums.length] = op.v;
      break;
    case "arr_reassign_filter":
      d.nums = d.nums.filter((n) => n % 2 === op.i % 2);
      break;
    case "arr_reassign_spread":
      d.nums = [...d.nums, op.v];
      break;
    case "read_join":
      log.push(d.nums.join(","));
      break;
    case "read_spread_len":
      log.push([...d.nums].length);
      break;
    case "read_length":
      log.push(d.nums.length);
      break;
    case "objarr_push":
      d.items.push({ id: op.i, q: op.v });
      break;
    case "objarr_write_idx": {
      const len = d.items.length;
      log.push(len);
      if (len) d.items[op.i % len]!.q = op.v;
      break;
    }
    case "objarr_find_write": {
      const it = d.items.find((x) => x.id === op.i % 5);
      log.push(it !== undefined);
      if (it) it.q = op.v;
      break;
    }
    case "read_map":
      log.push(d.items.map((x) => x.q).join("|"));
      break;
    case "read_leaf":
      log.push(d.items[0]?.q);
      break;
    // The historically-forbidden idiom: reassigning a value derived from the
    // proxy itself. Recorded values are cloned to plain data on install now,
    // so this must simply WORK, identically to the Immer draft.
    case "objarr_reassign_spread":
      d.items = [...d.items, { id: op.i, q: op.v }];
      break;
    case "objarr_reassign_filter":
      d.items = d.items.filter((x) => x.id !== op.i % 5);
      break;
    case "obj_reassign_spread":
      d.obj = { ...d.obj, [`y${op.i % 3}`]: op.v };
      break;
    case "obj_then_deep_write":
      d.obj = { nest: { v: op.v } };
      (d.obj as { nest: { v: number } }).nest.v = op.v + 1;
      break;
    case "arr_sort":
      d.nums.sort((a, b) => a - b);
      break;
    case "arr_reverse":
      d.nums.reverse();
      break;
    case "arr_fill":
      if (d.nums.length) d.nums.fill(op.v, 0, op.i % d.nums.length);
      break;
    case "read_includes":
      log.push(d.nums.includes(op.v));
      break;
    case "read_indexOf":
      log.push(d.nums.indexOf(op.v));
      break;
    case "read_slice":
      log.push(d.nums.slice(0, 2).join(","));
      break;
    case "read_some":
      log.push(d.nums.some((n) => n > op.v));
      break;
    case "read_reduce":
      log.push(d.nums.reduce((a, n) => a + n, 0));
      break;
    case "read_findIndex":
      log.push(d.items.findIndex((x) => x.id === op.i % 5));
      break;
    case "read_entries":
      log.push(Object.entries(d.obj).length);
      break;
    case "push_then_write_pushed": {
      d.items.push({ id: 90 + (op.i % 3), q: op.v });
      const idx = d.items.length - 1;
      d.items[idx]!.q = op.v + 1;
      break;
    }
    // ── length ──────────────────────────────────────────────────────
    // `arr.length = n` is a SET trap on an array path, not an array op — it
    // takes the object write path with a non-index key, which nothing else in
    // the alphabet reached. TRUNCATION only, and that bound is load-bearing:
    //
    // anything that makes an array SPARSE — `delete arr[i]`, growing `length`,
    // writing past the end — has no parity target to fuzz against, because
    // IMMER densifies holes and plain JavaScript does not. `produce([1,2,3], d
    // => { delete d[0] })` yields `[undefined,2,3]` with `Object.keys` = 0,1,2,
    // so `.reduce` is NaN; plain JS (and the live proxy, which applies the same
    // mutation to a real array) keeps a hole that `.reduce`/`.map` skip. Immer
    // is not even self-consistent: on a plain array the method assigned into
    // the draft moments earlier, `delete` DOES leave a hole. So the sync side
    // is the one that departs from JavaScript, and no async behaviour can match
    // both halves of it. Post-commit the question is moot (a hole and an
    // `undefined` both serialize to `null`), so the divergence lives only in
    // in-method reads. Use `splice` when you mean "remove".
    case "arr_set_length":
      d.nums.length = op.i % (d.nums.length + 1);
      break;
    case "arr_copy_within":
      if (d.nums.length > 1) d.nums.copyWithin(0, 1);
      break;
    // ── depth ───────────────────────────────────────────────────────
    case "deep_push":
      d.deep.l1.l2.l3.push(op.v);
      break;
    case "deep_set_idx":
      if (d.deep.l1.l2.l3.length) {
        d.deep.l1.l2.l3[op.i % d.deep.l1.l2.l3.length] = op.v;
      }
      break;
    case "deep_replace_mid":
      d.deep.l1.l2 = { l3: [op.v] };
      break;
    case "read_deep":
      log.push(d.deep.l1.l2.l3.join(","));
      break;
    // ── arrays of arrays ────────────────────────────────────────────
    case "grid_inner_push":
      if (d.grid.length) d.grid[op.i % d.grid.length]!.push(op.v);
      break;
    case "grid_push_row":
      d.grid.push([op.v, op.i]);
      break;
    case "grid_write_cell": {
      const row = d.grid[op.i % (d.grid.length || 1)];
      if (row && row.length) row[op.i % row.length] = op.v;
      break;
    }
    case "read_grid_json":
      log.push(JSON.stringify(d.grid));
      break;
    case "read_flat":
      log.push(d.grid.flat().join(","));
      break;
    // ── key shapes the object write path has to survive ─────────────
    // A numeric-string key changes Object.keys ORDER (integer keys sort
    // first); a key that shadows a prototype member has to stay ordinary data.
    case "set_numeric_key":
      d.obj[String(op.i % 4)] = op.v;
      break;
    case "set_shadow_key":
      d.obj[op.i % 2 === 0 ? "toString" : "hasOwnProperty"] = op.v;
      break;
    case "set_undefined":
      d.obj.x = undefined;
      break;
    case "set_null":
      d.obj[`n${op.i % 2}`] = null;
      break;
    case "set_nan":
      d.a = op.i % 2 === 0 ? NaN : Infinity;
      break;
    case "del_item_field":
      if (d.items.length) {
        delete (d.items[op.i % d.items.length] as {
          q?: number;
        }).q;
      }
      break;
    // ── whole-object reads ──────────────────────────────────────────
    case "read_obj_spread":
      log.push(JSON.stringify({ ...d.obj }));
      break;
    case "read_json_root":
      log.push(JSON.stringify(d));
      break;
    // `Object.values` resolves each key through [[Get]], so nested objects come
    // back as live proxies — JSON.stringify them (a `String(proxy)` would hit
    // the documented "not supported on live async state" throw, which is a
    // deliberate, loud divergence and not what this op is measuring).
    case "read_values":
      log.push(JSON.stringify(Object.values(d.obj)));
      break;
    case "read_for_in": {
      const ks: string[] = [];
      for (const k in d.obj) ks.push(k);
      log.push(ks.sort().join(","));
      break;
    }
    case "obj_assign":
      Object.assign(d.obj, { [`a${op.i % 3}`]: op.v, [`b${op.i % 3}`]: op.i });
      break;
    // ── more array shapes ───────────────────────────────────────────
    case "arr_splice_tail":
      if (d.nums.length) d.nums.splice(d.nums.length - 1, 1);
      break;
    case "arr_splice_head":
      if (d.nums.length) d.nums.splice(0, 1);
      break;
    case "arr_sort_default":
      d.nums.sort();
      break;
    // The shortest way to put ONE object at two indices — see ALIAS_KINDS.
    case "arr_fill_object":
      d.items.fill({ id: op.i, q: op.v });
      break;
    case "read_to_sorted":
      log.push(d.nums.toSorted((x, y) => x - y).join(","));
      break;
    case "read_to_reversed":
      log.push(d.nums.toReversed().join(","));
      break;
    // `at`/`findLast` are NOT in ARRAY_READ_METHODS — the proxy hands the raw
    // prototype function back and it runs against the proxy itself. That is a
    // second, unintercepted read path, so it needs its own coverage.
    case "read_at":
      log.push(d.nums.at(-1));
      break;
    case "read_find_last":
      log.push(d.items.findLast((x) => x.id === op.i % 5)?.q);
      break;
    case "read_array_from":
      log.push(Array.from(d.nums).join(","));
      break;
    // Writing THROUGH an element a read method handed the callback. `for…of`
    // and `find` always did this; `forEach` silently dropped it.
    case "objarr_foreach_write":
      d.items.forEach((it) => {
        it.q = op.v;
      });
      break;
    case "objarr_values_write":
      for (const it of d.items.values()) it.q = op.v + 1;
      break;
    case "objarr_entries_write":
      for (const [i, it] of d.items.entries()) it.q = op.v + i;
      break;
    // Writing through elements a REBUILT-ARRAY read method handed back.
    // `map`/`filter`/`slice` used to return detached snapshot clones, so these
    // writes vanished in an async method while the identical sync body applied
    // them — the framework's worst silent divergence (see
    // ARRAY_SNAPSHOT_READ_METHODS in cell-impl.ts).
    case "objarr_map_write": {
      const rows = d.items.map((x) => x);
      log.push(rows.length);
      if (rows.length) rows[op.i % rows.length]!.q = op.v;
      break;
    }
    case "objarr_filter_write": {
      const rows = d.items.filter((x) => x.id !== op.i % 5);
      log.push(rows.length);
      for (const r of rows) r.q = op.v;
      break;
    }
    case "objarr_slice_write": {
      const rows = d.items.slice(0, 2);
      log.push(rows.length);
      if (rows.length) rows[0]!.q = op.v;
      break;
    }
    case "objarr_to_sorted_write": {
      const rows = d.items.toSorted((x, y) => x.q - y.q);
      log.push(rows.length);
      if (rows.length) rows[0]!.q = op.v;
      break;
    }
    case "objarr_concat_write": {
      const rows = d.items.concat([]);
      log.push(rows.length);
      if (rows.length) rows[rows.length - 1]!.q = op.v;
      break;
    }
    // The single most common list idiom: rebuild the array from a map over
    // itself. Every element spread is a proxy spread on the async side.
    case "objarr_map_reassign":
      d.items = d.items.map((x) => ({ ...x, q: x.q + op.v }));
      break;
    // A rebuilt array serialized — proxies must stringify like plain data.
    case "read_map_json":
      log.push(JSON.stringify(d.items.map((x) => x)));
      break;
    // Identity through a read method: `indexOf(s.items[0])` is 0 on the draft
    // and was -1 through the detached snapshot.
    case "read_indexof_self":
      log.push(d.items.length ? d.items.indexOf(d.items[0]!) : -2);
      break;
    case "read_includes_self":
      log.push(d.items.length ? d.items.includes(d.items[0]!) : false);
      break;
    case "read_some_write": {
      // a predicate that also writes — `some` short-circuits, so the write
      // lands on a PREFIX of the array and the stopping index must agree too
      let n = 0;
      log.push(d.items.some((it) => {
        n++;
        it.q = op.v;
        return it.id === op.i % 5;
      }));
      log.push(n);
      break;
    }
    // ── whole-root replacement ──────────────────────────────────────
    case "root_spread":
      s.data = { ...d, a: op.v };
      break;
    // ── the effect channel (alpha52): s.$do interleaved with mutations ──
    // The effect never fires (far-future one-shot on the virtual clock); what
    // this op pins is that $do exists on BOTH backends, that calling it
    // mid-program perturbs NO other op's semantics (the sync side serves it
    // through a forwarding wrapper over the Immer draft), and that a payload
    // referencing live state is accepted on both sides (draft detach vs proxy
    // materialization).
    case "do_effect": {
      const doFn = (s as { $do?: (...fx: unknown[]) => void }).$do;
      log.push(typeof doFn);
      doFn?.({
        type: "__schedule",
        kind: "after",
        id: `fz:${op.i % 4}`,
        ms: 600_000,
        action: { type: "fznoop:tick", payload: { snap: d.items } },
      });
      break;
    }
  }
}

export const KINDS = [
  "set_scalar",
  "rmw_scalar",
  "set_nested",
  "set_new_key",
  "del_nested",
  "read_keys",
  "read_in",
  "arr_push",
  "arr_pop",
  "arr_unshift",
  "arr_shift",
  "arr_splice",
  "arr_set_idx",
  "arr_reassign_filter",
  "arr_reassign_spread",
  "read_join",
  "read_spread_len",
  "read_length",
  "objarr_push",
  "objarr_write_idx",
  "objarr_find_write",
  "read_map",
  "read_leaf",
  "objarr_reassign_spread",
  "objarr_reassign_filter",
  "obj_reassign_spread",
  "obj_then_deep_write",
  "arr_sort",
  "arr_reverse",
  "arr_fill",
  "read_includes",
  "read_indexOf",
  "read_slice",
  "read_some",
  "read_reduce",
  "read_findIndex",
  "read_entries",
  "push_then_write_pushed",
  "arr_set_length",
  "arr_copy_within",
  "deep_push",
  "deep_set_idx",
  "deep_replace_mid",
  "read_deep",
  "grid_inner_push",
  "grid_push_row",
  "grid_write_cell",
  "read_grid_json",
  "read_flat",
  "set_numeric_key",
  "set_shadow_key",
  "set_undefined",
  "set_null",
  "set_nan",
  "del_item_field",
  "read_obj_spread",
  "read_json_root",
  "read_values",
  "read_for_in",
  "obj_assign",
  "arr_splice_tail",
  "arr_splice_head",
  "arr_sort_default",
  "arr_fill_object",
  "read_to_sorted",
  "read_to_reversed",
  "read_at",
  "read_find_last",
  "read_array_from",
  "root_spread",
  "do_effect",
  "objarr_foreach_write",
  "objarr_values_write",
  "objarr_entries_write",
  "read_some_write",
  "objarr_map_write",
  "objarr_filter_write",
  "objarr_slice_write",
  "objarr_to_sorted_write",
  "objarr_concat_write",
  "objarr_map_reassign",
  "read_map_json",
  "read_indexof_self",
  "read_includes_self",
];

/** Ops that leave ONE object reachable at TWO paths.
 *
 *  Legal for the sync/async differential — both sides see the same commit
 *  boundaries, so the alias behaves identically. NOT legal for the transaction
 *  differential, and the reason is a property of immutable state rather than a
 *  bug in either: an alias does not survive a commit. Once a write-set is
 *  finalized, two paths pointing at one frozen object are copied independently
 *  the next time both are written, so `[X,X]` + `items[0].q=67; items[1].q=68`
 *  ends `[68,68]` inside one commit and `[67,68]` across two. Every mode agrees
 *  on that — two sync methods, a plain async method with an `await` between the
 *  writes, and a transactional one with `s.$commit()` between them all give
 *  `[67,68]`. `$commit`'s whole job is to MOVE a commit boundary, so with an
 *  alias in play it legitimately changes the outcome, and "transaction is
 *  observationally a no-op" cannot hold. */
export const ALIAS_KINDS = ["arr_fill_object"];
