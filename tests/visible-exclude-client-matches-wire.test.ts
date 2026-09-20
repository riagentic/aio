// `visible: { exclude }` has THREE deciders — the wire filter
// (`deepExcludePaths`, state-filter.ts), the client read seam (cell-reactive.ts)
// and the surface's client view (server-surface.ts) — and only one of them is
// the documented rule. They drifted: a head segment the object does not have
// is a records-BY-ID container whose every value the path applies to, and the
// wire filter has read it that way since that hole was closed, while the two
// loud twins returned the object untouched. Measured, before this:
//
//   state    { accounts: { alice: { name, encSecKey } } }
//   visible  { exclude: ["accounts.encSecKey"] }
//   wire     { alice: { name } }
//   client   { alice: { name, encSecKey } }   ← and no warning
//
// On the wire path that gap is invisible (the field never arrives). Where
// there is no broadcast — standalone, Electron, testUI, `am surface` — the
// client seam IS the filter, so the secret was simply readable.
//
// This is the differential, not another example: the same generated shapes
// the wire filter is already held to (tests/deep-exclude-property.test.ts)
// must come out of the client seam with the same content. A fourth twin, or a
// fifth rule in any of them, fails here.
import { assert, assertEquals } from "@std/assert";
import { deepExcludePaths } from "../src/state/state-filter.ts";
import { cell } from "../src/state/cell-create.ts";
import { bindCellReactive } from "../src/state/cell-reactive.ts";
import { _resetSignals, getCellSignal } from "../src/state/state-signals.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

const SECRET = "SECRET-MUST-VANISH";
const DECOY = "DECOY-MUST-SURVIVE";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** The generator of tests/deep-exclude-property.test.ts, plus the records-map
 *  shape that is the whole reason this file exists. */
function build(segs: string[], rnd: () => number, depth = 0): unknown {
  if (segs.length === 0) return SECRET;
  const head = segs[0]!;
  const rest = segs.slice(1);
  const leaf = segs[segs.length - 1]!;
  const node: Record<string, unknown> = {};
  const r = rnd();
  node[head] = r < 0.2 && depth < 3
    ? [[build(rest, rnd, depth + 1)], [
      build(rest, rnd, depth + 1),
      build(rest, rnd, depth + 1),
    ]]
    : r < 0.4 && depth < 3
    ? [
      build(rest, rnd, depth + 1),
      { unrelated: 1 },
      7,
      null,
      build(rest, rnd, depth + 1),
    ]
    : r < 0.6 && depth < 3
    // records BY ID: the head is one level further down than it looks.
    ? { alice: build(segs, rnd, depth + 1), bob: { unrelated: 2 } }
    : build(rest, rnd, depth + 1);
  if (rnd() < 0.6) node["other"] = { [leaf]: DECOY };
  if (rnd() < 0.5) node["list"] = [{ [leaf]: DECOY }];
  if (rnd() < 0.4) node["plain"] = [1, "x", null, true];
  if (rnd() < 0.3) node["constructor"] = { [leaf]: DECOY };
  if (rnd() < 0.3) node["0"] = { [leaf]: DECOY };
  if (rnd() < 0.2) node["toString"] = DECOY;
  if (rnd() < 0.2) node[head + "x"] = { [leaf]: DECOY };
  return node;
}

Deno.test("visible.exclude: the client read seam answers what the wire filter answers", () => {
  _resetAioRuntime();
  _resetSignals();
  let shapes = 0;
  let records = 0;
  for (const seed of [1, 2, 3, 7, 8, 9, 10]) {
    const rnd = makeRng(seed);
    for (let i = 0; i < 40; i++) {
      const depth = 1 + Math.floor(rnd() * 3);
      const segs = Array.from({ length: depth }, (_, k) => `k${k}`);
      segs[segs.length - 1] = "secret";
      const value = build(segs, rnd);
      shapes++;
      if (JSON.stringify(value).includes('"alice"')) records++;

      const id = `vxw-${seed}-${i}`;
      // deno-lint-ignore no-explicit-any
      const c: any = cell(id, {
        state: { root: value },
        methods: {},
        visible: { exclude: [`root.${segs.join(".")}`] },
      });
      bindCellReactive(c);
      getCellSignal(id, c.__aio.state).set({ root: value });

      const where = `seed ${seed} #${i} on root.${segs.join(".")}`;
      const client = JSON.stringify(c.root);
      const wire = JSON.stringify(deepExcludePaths(value, [segs]));
      assert(
        !client.includes(SECRET),
        `${where}: a secret survived — ${client}`,
      );
      // Over-removal is the OTHER direction this can fail in, and it is the
      // wire filter's own property (tests/deep-exclude-property.test.ts) —
      // one rule, held in one place. What this file adds is that the client
      // seam answers that rule rather than a second one of its own, in both
      // directions at once.
      assertEquals(client, wire, `${where}: client read != wire filter`);
    }
  }
  // VERIFY THE INSTRUMENT: a generator that produced nothing would pass.
  assertEquals(shapes, 280, "the generator must actually produce shapes");
  // …and produce the shape this file exists for: a generator that stopped
  // emitting records-by-id maps would pass every assertion above while
  // covering nothing.
  assert(records > 40, `records-by-id shapes generated: ${records}`);
  _resetAioRuntime();
  _resetSignals();
});

Deno.test("visible.exclude: a records-by-id map is filtered on client reads too", () => {
  _resetAioRuntime();
  _resetSignals();
  const state = {
    accounts: {
      alice: { name: "a", encSecKey: "S3CRET" },
      bob: { name: "b", encSecKey: "T0PSECRET" },
    },
  };
  // deno-lint-ignore no-explicit-any
  const c: any = cell("vxw-records", {
    state,
    methods: {},
    visible: { exclude: ["accounts.encSecKey"] },
  });
  bindCellReactive(c);
  getCellSignal("vxw-records", c.__aio.state).set(state);

  assertEquals(JSON.parse(JSON.stringify(c.accounts)), {
    alice: { name: "a" },
    bob: { name: "b" },
  });
  // The tripwire reaches the row, not just the map.
  let threw = false;
  try {
    void c.accounts.alice.encSecKey;
  } catch (e) {
    threw = (e as Error).message.includes("vxw-records.accounts.encSecKey");
  }
  assert(threw, "reading the nested secret refuses by name");
  _resetAioRuntime();
  _resetSignals();
});
