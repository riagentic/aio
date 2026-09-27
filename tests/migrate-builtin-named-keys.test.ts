// `onMigrate` is documented (cell-migrate.ts) to see "the declared shape PLUS
// whatever the store still holds", so a rename migration can read the old
// field. `reattachUndeclared` decides "already declared" with `k in out`,
// which walks the PROTOTYPE chain, and additionally hard-skips `constructor` /
// `prototype`. So a stored key that happens to name an Object.prototype member
// (`toString`, `valueOf`, `constructor`, `hasOwnProperty`, …) is never handed
// to the hook and is lost by the migration — exactly the class deep-merge.ts
// fixed for restore ("Keys are DATA … a per-username record for a user called
// `constructor` vanished on restart, silently").
import { assertEquals } from "@std/assert";
import {
  applyCellMigrations,
  reattachUndeclared,
} from "../src/state/cell-migrate.ts";

const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  // deno-lint-ignore no-explicit-any
} as any;

Deno.test("onMigrate is handed every undeclared stored key, prototype-named ones too", () => {
  // v1 kept per-user scores flat on the slice; v2 moves them under `scores`.
  const stored = {
    scores: {},
    alice: 3,
    constructor: 7, // a user called "constructor"
    toString: 9, // a user called "toString"
  };
  const restored = { scores: {} }; // deepMerge dropped the undeclared keys
  const state: Record<string, unknown> = { users: restored };
  let seen: string[] = [];
  applyCellMigrations(
    state,
    new Map([["users", {
      version: 2,
      initialState: { scores: {} },
      onMigrate: (s: Record<string, unknown>) => {
        seen = Object.keys(s).filter((k) => k !== "scores").sort();
        return s;
      },
    }]]),
    { users: 1 },
    log,
    { users: stored },
    { users: { scores: {} } },
  );
  assertEquals(seen, ["alice", "constructor", "toString"]);
});

Deno.test("reattachUndeclared keeps a stored key named like a prototype member", () => {
  const out = reattachUndeclared({ a: 1 }, { a: 1, valueOf: 2, toString: 3 });
  assertEquals(Object.hasOwn(out, "valueOf"), true);
  assertEquals(Object.hasOwn(out, "toString"), true);
});
