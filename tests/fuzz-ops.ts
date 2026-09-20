// The shared op vocabulary for the cell-method differential fuzzers — ONE
// program interpreter, so `proxy-differential` (sync draft vs async live proxy)
// and `transaction-differential` (no transaction vs snapshot vs serializable)
// can never drift into testing different languages. Adding a proxy capability
// means adding a kind HERE, and both fuzzers exercise it the same day.
//
// ONE forbidden shape: an op must never capture a nested reference, overwrite
// its container, and then use the reference — the live proxy THROWS there by
// design (stale-capture detection, R-1) while the sync draft keeps the
// old object. That deliberate divergence is pinned in
// tests/proxy-stale-capture.test.ts, not here.

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

/** Names that are ordinary state keys yet also resolve on the prototype chain. */
const RESERVED_WORDS = ["constructor", "prototype", "toString", "valueOf"];

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
    // A comparator with a SIDE EFFECT, then reads — the shape the fuzzer could
    // not see. Every sort op here used a pure `(a, b) => a - b`, so an async
    // method that re-ran the comparator on every later read produced the same
    // array and the differential stayed green while the comparator ran 4 times
    // sync and 28 times async. The counter is IN STATE, so a divergence is a
    // divergence in the committed value, which is what this fuzzer compares.
    case "arr_sort_counting":
      d.nums.sort((a, b) => {
        d.a += 1;
        return a - b;
      });
      // …and READS after it, which is when the replay used to happen.
      d.a += d.nums.length;
      d.a += d.nums.length;
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
    // ── what a mutator RETURNS ──────────────────────────────────────
    // Every kind above throws the return value away, and that is exactly
    // where the alphabet had a hole: `sort`/`reverse`/`fill`/`copyWithin`
    // return the receiver and `pop`/`shift`/`splice` return elements OF the
    // state, so the value handed back has to be as live as the array it came
    // from. It was not — the async side returned a detached copy, so a write
    // through it was silently dropped (and the method read its own write back
    // from the copy, so nothing looked wrong), while a removed row came back
    // FROZEN and mutating it threw. Both are ordinary app code.
    case "arr_sort_ret_write": {
      const r = d.nums.sort((a, b) => a - b);
      if (r.length) r[op.i % r.length] = op.v;
      break;
    }
    case "arr_reverse_ret_push": {
      const r = d.nums.reverse();
      r.push(op.v);
      break;
    }
    case "arr_fill_ret_write": {
      if (!d.nums.length) break;
      const r = d.nums.fill(op.v, 0, op.i % d.nums.length);
      r[0] = op.v + 1;
      break;
    }
    case "arr_copy_within_ret_write": {
      if (d.nums.length <= 1) break;
      const r = d.nums.copyWithin(0, 1);
      r[r.length - 1] = op.v;
      break;
    }
    case "arr_sort_ret_len": {
      // The return value is the array itself, so its length tracks later
      // writes. A detached copy's does not.
      const r = d.nums.sort((a, b) => a - b);
      d.nums.push(op.v);
      log.push(r.length);
      break;
    }
    case "objarr_shift_write_push": {
      // The queue idiom: take a row, stamp it, put it somewhere else.
      const row = d.items.shift();
      if (row) {
        row.q = op.v;
        d.items.push(row);
      }
      break;
    }
    case "objarr_pop_write_push": {
      const row = d.items.pop();
      if (row) {
        row.q = op.v;
        d.items.unshift(row);
      }
      break;
    }
    case "objarr_splice_ret_write": {
      if (!d.items.length) break;
      const removed = d.items.splice(op.i % d.items.length, 1);
      const row = removed[0];
      if (row) {
        row.q = op.v;
        d.items.push(row);
      }
      break;
    }
    case "objarr_shift_read_after": {
      // A removed row is DETACHED: writing to it must not reach back into
      // the array it came from.
      const row = d.items.shift();
      if (row) {
        row.q = op.v;
        log.push(d.items.length, JSON.stringify(d.items.map((x) => x.q)));
      }
      break;
    }
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
    // A map keyed by user words, reserved-looking names included, guarded the
    // standard way. The async write-set used to refuse `constructor` and
    // `prototype` by name, and the live view's `Object.hasOwn` answered `true`
    // for every inherited name (tests/async-constructor-key.test.ts,
    // tests/async-hasown-inherited-key.test.ts).
    case "count_reserved_word": {
      const w = ["constructor", "prototype", "toString", "valueOf"][op.i % 4]!;
      const had = Object.hasOwn(d.obj, w);
      log.push(had);
      d.obj[w] = (had ? d.obj[w] as number : 0) + op.v;
      break;
    }
    // The same reserved names as a PATH segment, not only a leaf: a nested
    // write walks an OWN `constructor`/`prototype` object (the async gate's
    // walkOwn must let it through, and nothing may reach a real prototype).
    // Boxes live under `deep.l1`, numbers under `obj` — never `object + n`,
    // which the live proxy refuses by design (valueOf on live state).
    case "reserved_nested_write": {
      const w = RESERVED_WORDS[op.i % 4]!;
      const l1 = d.deep.l1 as Record<string, unknown>;
      const cur = Object.hasOwn(l1, w) ? l1[w] : undefined;
      if (cur === null || typeof cur !== "object") l1[w] = { n: 0 };
      const box = l1[w] as { n: number };
      box.n += op.v;
      log.push(box.n);
      break;
    }
    case "reserved_delete": {
      const w = RESERVED_WORDS[op.i % 4]!;
      delete d.obj[w];
      log.push(Object.hasOwn(d.obj, w));
      break;
    }
    // Every own-key question a guard might ask, answered for a reserved name.
    case "reserved_own_reads": {
      const w = RESERVED_WORDS[op.i % 4]!;
      log.push(
        w in d.obj,
        Object.prototype.hasOwnProperty.call(d.obj, w),
        Object.prototype.propertyIsEnumerable.call(d.obj, w),
        JSON.stringify(Object.getOwnPropertyDescriptor(d.obj, w)?.value),
        Object.keys(d.obj).includes(w),
        JSON.stringify(Object.entries(d.obj).filter(([k]) => k === w)),
      );
      break;
    }
    // A reserved key on an array ELEMENT and on a deep object.
    case "reserved_item_field": {
      const w = RESERVED_WORDS[op.i % 4]!;
      const it = d.items[op.i % 3];
      if (it) (it as Record<string, unknown>)[w] = op.v;
      const l1 = d.deep.l1 as Record<string, unknown>;
      log.push(Object.hasOwn(l1, w));
      l1[w] = { n: op.v };
      break;
    }
    case "reserved_spread_back": {
      const w = RESERVED_WORDS[op.i % 4]!;
      d.obj = { ...d.obj, [w]: op.v };
      log.push(JSON.stringify(d.obj));
      break;
    }
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
    // A loop that GROWS or SHRINKS the array it walks. An array iterator reads
    // `length` at every step (the Immer draft does too), so a worklist visits
    // what it enqueued. The async proxy captured the length when the loop
    // began and stopped short — the same body visited 6 nodes sync and 4
    // async. The 64-step cap keeps a pathological program finite; values
    // pushed are ≥ 100, so they are never re-enqueued.
    case "arr_for_of_push": {
      let seen = 0;
      for (const n of d.nums) {
        if (++seen > 64) break;
        if (n < 100) d.nums.push(n + 100);
      }
      log.push(seen);
      break;
    }
    case "arr_entries_push": {
      let seen = 0;
      for (const [i, n] of d.nums.entries()) {
        if (++seen > 64) break;
        if (n < 100 && i % 2 === op.i % 2) d.nums.push(n + 100);
      }
      log.push(seen);
      break;
    }
    case "arr_keys_pop": {
      let seen = 0;
      for (const _i of d.nums.keys()) {
        seen++;
        if (d.nums.length > 1) d.nums.pop();
      }
      log.push(seen);
      break;
    }
    case "objarr_values_push": {
      let seen = 0;
      for (const it of d.items.values()) {
        if (++seen > 64) break;
        if (it.id < 100) d.items.push({ id: it.id + 100, q: op.v });
      }
      log.push(seen);
      break;
    }
    // A loop that REPLACES the array it walks. The sync draft's iterator holds
    // the old array — the assignment only detaches it — so the walk finishes
    // over what it started on. The async walk went by path, so its next step
    // read the NEW array through a stale reference and threw half-way, after
    // the first reassignment had committed: `[1,3,4]` + a rejection where
    // sync gave `[1]`. Rows are READ after the replacement, never written:
    // whether a write to a detached row lands depends on whether the new
    // array kept it, and the async side refuses that write by name
    // (tests/live-array-iteration-survives-reassign.test.ts).
    case "arr_values_reassign_filter":
      for (const n of d.nums.values()) {
        log.push(n);
        d.nums = d.nums.filter((y) => y !== n + (op.i % 3));
      }
      break;
    case "arr_keys_reassign":
      for (const k of d.nums.keys()) {
        log.push(k);
        if (k === op.i % 3) d.nums = [op.v];
      }
      break;
    case "arr_for_of_reassign_spread":
      for (const n of d.nums) {
        log.push(n);
        if (n % 2 === op.i % 2) d.nums = [...d.nums, op.v];
      }
      break;
    case "objarr_entries_reassign_read":
      for (const [i, it] of d.items.entries()) {
        const id = it.id;
        log.push(i, id, it.q);
        if (i === op.i % 2) d.items = d.items.filter((x) => x.id !== id);
      }
      break;
    case "deep_for_of_replace_mid":
      for (const n of d.deep.l1.l2.l3) {
        log.push(n);
        d.deep.l1.l2 = { l3: [n + op.v] };
      }
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
    // ── aliases: ONE object reachable at TWO paths ──────────────────
    // Plain JavaScript, and the Immer draft a sync method runs on, both make
    // `s.sel = s.items[0]` an ALIAS: a later write through either name is
    // visible through the other, until the commit separates them. The live
    // async proxy used to COPY at record time, so the identical method body
    // committed two different states depending on whether it was declared
    // `async` — silently (audit a8, G1). These pin the parity; see ALIAS_KINDS
    // for why they are legal here and nowhere else.
    case "alias_assign_write": {
      if (!d.items.length) break;
      d.obj.sel = d.items[0];
      (d.obj.sel as { q: number }).q = op.v;
      log.push(d.items[0]!.q);
      break;
    }
    case "alias_push_self_write": {
      if (!d.items.length) break;
      d.items.push(d.items[0]!);
      d.items[d.items.length - 1]!.q = op.v;
      log.push(d.items[0]!.q);
      break;
    }
    case "alias_deep_then_write": {
      d.obj.dref = d.deep.l1;
      d.deep.l1.l2.l3.push(op.v);
      log.push(
        (d.obj.dref as { l2: { l3: number[] } }).l2.l3.length,
      );
      break;
    }
    // A LOCAL object (not a live reference) written to two paths. Plain
    // JavaScript and the Immer draft keep it one object, so a write through
    // either name shows through the other until the commit. The async write
    // path cloned each install separately and committed two objects.
    case "local_obj_two_slots": {
      const o = { v: op.v };
      d.obj.sh1 = o;
      d.obj.sh2 = o;
      (d.obj.sh1 as { v: number }).v = op.v + 1;
      log.push((d.obj.sh2 as { v: number }).v);
      break;
    }
    case "local_arr_two_slots": {
      const a = [op.v];
      d.obj.sa1 = a;
      d.obj.sa2 = a;
      (d.obj.sa1 as number[]).push(op.i);
      log.push((d.obj.sa2 as number[]).length);
      break;
    }
    case "local_obj_push_twice": {
      const row = { id: 70 + (op.i % 3), q: op.v };
      d.items.push(row);
      d.items.push(row);
      d.items[d.items.length - 2]!.q = op.v + 1;
      log.push(d.items[d.items.length - 1]!.q);
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
    // ── a WRITE and a copy-READ at the SAME path, back to back ──────
    //
    // The read-your-writes overlay used to hand every read a fresh clone, so
    // "the array is the same object" proved "its contents did not move". It
    // now applies each new write INTO the array it already handed out, which
    // makes that proof false and every per-path read memo a place a stale
    // answer can hide. `toSorted` after a push is the one that was caught;
    // these are the rest of the family — one op per intercepted copy-method,
    // each preceded by an in-place mutation of the very array it reads, at
    // depth 1 (`nums`/`items`), depth 3 (`deep.l1.l2.l3`) and inside a nested
    // array (`grid[0]`), because the memo is keyed by PATH.
    case "push_then_to_spliced":
      d.nums.push(op.v);
      log.push(d.nums.toSpliced(0, 1).join(","));
      break;
    case "push_then_to_sorted":
      d.nums.push(op.v);
      log.push(d.nums.toSorted((x, y) => x - y).join(","));
      break;
    case "push_then_to_reversed":
      d.nums.push(op.v);
      log.push(d.nums.toReversed().join(","));
      break;
    case "push_then_flat_map":
      d.nums.push(op.v);
      log.push(d.nums.flatMap((n) => [n, n + 1]).join(","));
      break;
    case "push_then_every":
      d.nums.push(op.v);
      log.push(d.nums.every((n) => n >= 0));
      break;
    case "push_then_reduce_right":
      d.nums.push(op.v);
      log.push(d.nums.reduceRight((a, n) => a * 2 + n, 0));
      break;
    case "push_then_last_index_of":
      d.nums.push(op.v);
      log.push(d.nums.lastIndexOf(op.v));
      break;
    case "push_then_slice_join":
      d.nums.push(op.v);
      log.push(d.nums.slice(1).join(","));
      break;
    case "splice_then_to_sorted":
      d.nums.splice(op.i % (d.nums.length + 1), 0, op.v);
      log.push(d.nums.toSorted((x, y) => x - y).join(","));
      break;
    case "sort_then_map_join":
      d.nums.sort((x, y) => x - y);
      log.push(d.nums.map((n) => n + 1).join(","));
      break;
    case "reverse_then_index_of":
      d.nums.reverse();
      log.push(d.nums.indexOf(op.v % 4));
      break;
    case "fill_then_to_sorted":
      d.nums.fill(op.v, 0, 1);
      log.push(d.nums.toSorted((x, y) => x - y).join(","));
      break;
    case "unshift_then_concat_len":
      d.nums.unshift(op.v);
      log.push(d.nums.concat([op.i]).length);
      break;
    case "set_idx_then_to_sorted":
      // Guarded: `arr_set_length` can leave `nums` empty, and a write at a
      // non-index key (`NaN`) is the sparse-array shape that has no parity
      // target — see the note on `arr_set_length`.
      if (d.nums.length > 0) d.nums[op.i % d.nums.length] = op.v;
      log.push(d.nums.toSorted((x, y) => x - y).join(","));
      break;
    case "objarr_push_then_map_q":
      d.items.push({ id: 60 + (op.i % 3), q: op.v });
      log.push(d.items.map((x) => x.q).join(","));
      break;
    case "objarr_push_then_to_sorted_q":
      d.items.push({ id: 61 + (op.i % 3), q: op.v });
      log.push(d.items.toSorted((x, y) => x.q - y.q).map((x) => x.q).join(","));
      break;
    case "objarr_write_then_filter_len":
      if (d.items.length > 0) d.items[op.i % d.items.length]!.q = op.v;
      log.push(d.items.filter((x) => x.q > op.v / 2).length);
      break;
    case "deep_push_then_to_sorted":
      d.deep.l1.l2.l3.push(op.v);
      log.push(d.deep.l1.l2.l3.toSorted((x, y) => x - y).join(","));
      break;
    case "deep_push_then_map":
      d.deep.l1.l2.l3.push(op.v);
      log.push(d.deep.l1.l2.l3.map((n) => n * 2).join(","));
      break;
    case "grid_inner_push_then_flat":
      if (d.grid.length > 0) d.grid[op.i % d.grid.length]!.push(op.v);
      log.push(d.grid.flat().join(","));
      break;
    case "grid_inner_push_then_inner_to_sorted": {
      const row = d.grid.length > 0 ? d.grid[op.i % d.grid.length]! : [];
      row.push(op.v);
      log.push(row.toSorted((x, y) => x - y).join(","));
      break;
    }
    // A write to an UNRELATED path between a read and its repeat: the memo is
    // invalidated by the write-set cursor, which grows for every write no
    // matter where it lands, so this must still answer the same value twice.
    case "read_write_elsewhere_read": {
      const a = d.nums.map((n) => n).join(",");
      d.obj[`u${op.i % 3}`] = op.v;
      log.push(a);
      log.push(d.nums.map((n) => n).join(","));
      break;
    }
    // Object path: a key written, then the whole object re-read two ways.
    case "obj_set_then_reread":
      d.obj[`k${op.i % 3}`] = op.v;
      log.push(JSON.stringify(d.obj));
      d.obj[`k${op.i % 3}`] = op.v + 1;
      log.push(JSON.stringify(d.obj));
      break;
    case "obj_del_then_reread":
      delete d.obj[`k${op.i % 3}`];
      log.push(Object.keys(d.obj).sort().join(","));
      break;
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
  "arr_sort_counting",
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
  "count_reserved_word",
  "reserved_nested_write",
  "reserved_delete",
  "reserved_own_reads",
  "reserved_item_field",
  "reserved_spread_back",
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
  "arr_for_of_push",
  "arr_entries_push",
  "arr_keys_pop",
  "objarr_values_push",
  "arr_values_reassign_filter",
  "arr_keys_reassign",
  "arr_for_of_reassign_spread",
  "objarr_entries_reassign_read",
  "deep_for_of_replace_mid",
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
  "alias_assign_write",
  "alias_push_self_write",
  "alias_deep_then_write",
  "local_obj_two_slots",
  "local_arr_two_slots",
  "local_obj_push_twice",
  "arr_sort_ret_write",
  "arr_reverse_ret_push",
  "arr_fill_ret_write",
  "arr_copy_within_ret_write",
  "arr_sort_ret_len",
  "objarr_shift_write_push",
  "objarr_pop_write_push",
  "objarr_splice_ret_write",
  "objarr_shift_read_after",
  // A write and a copy-READ at the same path, back to back — see the block of
  // the same name in `applyOp`.
  "push_then_to_spliced",
  "push_then_to_sorted",
  "push_then_to_reversed",
  "push_then_flat_map",
  "push_then_every",
  "push_then_reduce_right",
  "push_then_last_index_of",
  "push_then_slice_join",
  "splice_then_to_sorted",
  "sort_then_map_join",
  "reverse_then_index_of",
  "fill_then_to_sorted",
  "unshift_then_concat_len",
  "set_idx_then_to_sorted",
  "objarr_push_then_map_q",
  "objarr_push_then_to_sorted_q",
  "objarr_write_then_filter_len",
  "deep_push_then_to_sorted",
  "deep_push_then_map",
  "grid_inner_push_then_flat",
  "grid_inner_push_then_inner_to_sorted",
  "read_write_elsewhere_read",
  "obj_set_then_reread",
  "obj_del_then_reread",
];

/** Ops whose value is a row REMOVED from an array — `pop`/`shift`/`splice`.
 *
 *  A removed row is detached from state, and the two backends detach it
 *  differently. The sync draft hands back a draft that is still the SAME
 *  object as any other slot pointing at it, so writing to a popped row also
 *  changes the copy still in the array. The async proxy hands back a mutable
 *  clone, so it does not. Both are defensible and only ONE op can tell them
 *  apart: `arr_fill_object` is the only kind that puts one object in two
 *  slots. The combination is excluded from the sync/async differential for
 *  the same reason {@linkcode ALIAS_KINDS} is excluded from the transaction
 *  one — an alias is a regime of its own — and the exact divergence is PINNED
 *  rather than hidden, in `tests/proxy-detached-row.test.ts`. */
export const DETACHING_KINDS = [
  "objarr_shift_write_push",
  "objarr_pop_write_push",
  "objarr_splice_ret_write",
  "objarr_shift_read_after",
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
export const ALIAS_KINDS = [
  "arr_fill_object",
  "alias_assign_write",
  "alias_push_self_write",
  "alias_deep_then_write",
  "local_obj_two_slots",
  "local_arr_two_slots",
  "local_obj_push_twice",
];
