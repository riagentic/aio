// `onMigrate` with no `version >= 1` is a DEAD hook — boot skips migration
// entirely at version 0 (the default), so the migration would silently never
// run against any persisted profile. cell() refuses the config at definition
// time, naming the cell and the one-line fix.

import { assert, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell.ts";

Deno.test("cell(): onMigrate without version throws at definition", () => {
  const err = assertThrows(
    () =>
      cell("mig-guard-unset", {
        state: { n: 0 },
        onMigrate: (s) => s,
        methods: { bump(_s) {} },
      }),
    Error,
  );
  assert(err.message.includes("mig-guard-unset"), err.message);
  assert(err.message.includes("onMigrate"), err.message);
  assert(err.message.includes("version: 1"), err.message);
});

Deno.test("cell(): onMigrate with version: 0 throws at definition", () => {
  const err = assertThrows(
    () =>
      cell("mig-guard-zero", {
        state: { n: 0 },
        version: 0,
        onMigrate: (s) => s,
        methods: {},
      }),
    Error,
  );
  assert(err.message.includes("mig-guard-zero"), err.message);
  assert(err.message.includes("never fire"), err.message);
});

Deno.test("cell(): version: 1 + onMigrate is accepted", () => {
  const c = cell("mig-guard-ok", {
    state: { n: 0 },
    version: 1,
    onMigrate: (s) => s,
    methods: {},
  });
  assert(c.__aio.version === 1);
});

Deno.test("cell(): version without onMigrate is accepted (boot warns, not cell())", () => {
  const c = cell("mig-guard-noop", {
    state: { n: 0 },
    version: 2,
    methods: {},
  });
  assert(c.__aio.version === 2);
});
