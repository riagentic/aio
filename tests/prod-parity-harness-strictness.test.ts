// Prod parity: the in-process harness fires the frozen-state tripwire.
//
// `bootCells` never passes `freezeState`, and an audit read that as "the
// in-process harness cannot fire the tripwire that dev and prod both fire".
// Right thing to suspect, wrong conclusion — and the reason it was worth
// checking is that the answer was nowhere written down. Measured, twice:
//
//   - the standalone runtime bootCells/testUI/testCell boot through defaults
//     `freezeState` ON (`src/standalone-air.ts`), and `testServer` gets the
//     dev default `!prod`;
//   - and underneath both, Immer's `autoFreeze` is NEVER disabled, so
//     committed state comes back frozen even with `freezeState: false`
//     forced — verified by forcing it.
//
// So the tripwire does fire in the harness. What was missing is the CHECK: the
// fact lived in a `??` and a library default that anyone could flip while every
// test stayed green. This file is that check — committed state is frozen in
// every in-process harness, so an illegal in-place mutation throws in a test
// exactly as it throws in dev and in production.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";
import { cell } from "../src/state/cell.ts";

/** A nested object is the shape that matters: a shallow freeze would leave
 *  `obj.n` writable and the tripwire would only look armed. */
function probeCell(name: string) {
  return cell(name, {
    state: { obj: { n: 0 }, list: [1] },
    methods: {
      touch(s: { obj: { n: number } }) {
        s.obj = { n: s.obj.n + 1 };
      },
    },
  });
}

/** Assert the committed state this cell exposes cannot be mutated in place. */
function assertFrozen(
  read: () => { obj: { n: number }; list: number[] },
  where: string,
) {
  const { obj, list } = read();
  assert(Object.isFrozen(obj), `${where}: committed object is not frozen`);
  assert(Object.isFrozen(list), `${where}: committed array is not frozen`);
  assertThrows(
    () => {
      (obj as { n: number }).n = 99;
    },
    TypeError,
    undefined,
    `${where}: an illegal in-place mutation of committed state SUCCEEDED — ` +
      `the harness is more permissive than dev and prod, so a bug of this ` +
      `class would ship green`,
  );
  assertEquals(obj.n, 1, `${where}: the mutation must not have landed`);
}

const boot = probeCell("frzBoot");
const srvCell = probeCell("frzServer");

Deno.test("harness strictness: bootCells freezes committed state", async () => {
  using h = await bootCells([boot]);
  await boot.touch();
  await h.settle();
  assertFrozen(
    () => ({ obj: boot.obj as { n: number }, list: boot.list as number[] }),
    "bootCells",
  );
});

Deno.test("harness strictness: testServer freezes committed state", async () => {
  await using srv = await testServer<
    { frzServer: { obj: { n: number }; list: number[] } }
  >({ cells: [srvCell] });
  await srvCell.touch();
  assertFrozen(() => srv.state().frzServer, "testServer");
});
