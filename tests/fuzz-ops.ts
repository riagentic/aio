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
};
export const initData = (): Data => ({
  a: 0,
  obj: { x: 1 },
  nums: [1, 2, 3],
  items: [{ id: 1, q: 10 }, { id: 2, q: 20 }],
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
];
