// One LOCAL object written to two paths of state is one object until the
// commit — on the Immer draft a sync method runs on, and now in an async one.
//
//   const o = { v: 1 }; s.obj.p = o; s.obj.q = o; s.obj.p.v = 2;
//
//   sync   p.v 2, q.v 2
//   async  p.v 2, q.v 1   ← each install was cloned separately
//
// CLAUDE.md names tests/proxy-differential.test.ts the sync/async parity
// contract; `local_obj_two_slots` / `local_arr_two_slots` /
// `local_obj_push_twice` in tests/fuzz-ops.ts put this shape into it. This file
// is the one-line repro.
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const bodies: Record<string, (s: Any, log: unknown[]) => void> = {
  objectTwice: (s, log) => {
    const o = { v: 1 };
    s.obj.p = o;
    s.obj.q = o;
    s.obj.p.v = 2;
    log.push(s.obj.q.v);
  },
  arrayTwice: (s, log) => {
    const a = [1];
    s.obj.p = a;
    s.obj.q = a;
    s.obj.p.push(2);
    log.push(s.obj.q.length);
  },
  pushedTwice: (s, log) => {
    const row = { v: 1 };
    s.list.push(row);
    s.list.push(row);
    s.list[0].v = 3;
    log.push(s.list[1].v);
  },
  // Replacing one slot must NOT drag the other along — the alias is the
  // object, not the path.
  overwriteOne: (s, log) => {
    const o = { v: 1 };
    s.obj.p = o;
    s.obj.q = o;
    s.obj.p = { v: 9 };
    s.obj.q.v = 4;
    log.push(s.obj.p.v);
  },
};

for (const [name, body] of Object.entries(bodies)) {
  Deno.test(`local object in two slots (${name}): async commits what sync commits`, async () => {
    const init = () => ({ obj: {} as Any, list: [] as Any[] });
    const slog: unknown[] = [];
    const alog: unknown[] = [];
    const sc = cell(`twoslot_s_${name}`, {
      state: init(),
      methods: { run: (s: Any) => body(s, slog) },
    } as Any) as Any;
    const ac = cell(`twoslot_a_${name}`, {
      state: init(),
      methods: {
        // deno-lint-ignore require-await
        async run(s: Any) {
          body(s, alog);
        },
      },
    } as Any) as Any;
    const h = await bootCells([sc, ac]);
    try {
      await sc.run();
      await ac.run();
      await h.settle();
      const snap = (c: Any) =>
        JSON.parse(JSON.stringify({ obj: c.obj, list: c.list }));
      assertEquals(snap(ac), snap(sc), "committed state");
      assertEquals(alog, slog, "reads inside the method");
    } finally {
      h.dispose();
    }
  });
}
