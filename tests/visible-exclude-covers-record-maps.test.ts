// `visible: { exclude: ["accounts.secret"] }` must hide the field whatever
// shape the container is, and a no-op exclude must not switch the credential
// refusal off.
//
// Three holes, all in the same sentence — "this field is private":
//
//  1. `deepExclude` traverses ARRAYS element-wise and objects only by literal
//     key, so the exclude worked for `accounts: [{secret}]` and removed
//     NOTHING from `accounts: { alice: { secret } }` — a records-by-id map,
//     the most ordinary state shape there is. No warning fired either, because
//     the head segment IS a real top-level field. The value went to every
//     client with nothing said, and the documented example
//     ("accounts.encSecKey") reads as if it covers both.
//
//  2. The PATCH matcher skipped numeric segments only, so it and the
//     projection disagreed: the patch at `accounts.7.secret` was dropped and
//     the one at `accounts.alice.secret` was sent. For a numeric-keyed map a
//     developer watching a live app saw the field frozen and concluded it was
//     hidden — while it arrived in full on every connect and resync.
//
//  3. The credential BOOT REFUSAL had a one-character escape hatch: it asked
//     only whether some exclude path starts with `key + "."`, never whether it
//     removes anything. `exclude: ["apiKey.whatever"]` booted green with the
//     credential exposed, and not even the soft warning fired.
import { assert, assertEquals } from "@std/assert";
import { applyCellFieldFilter } from "../src/state/state-filter.ts";

const EX = { exclude: ["accounts.secret"] } as const;
const SECRET = "FAKE-NOT-REAL";

Deno.test("visible.exclude: a records-BY-ID map hides the field, like an array", () => {
  const asArray = { accounts: [{ secret: SECRET, label: "a" }] };
  const asMap = { accounts: { alice: { secret: SECRET, label: "a" } } };
  const asNumericMap = { accounts: { 7: { secret: SECRET, label: "a" } } };

  const shapes = Object.entries({ asArray, asMap, asNumericMap });
  assertEquals(shapes.length, 3, "all three container shapes are checked");
  let checked = 0;
  for (const [name, state] of shapes) {
    const out = JSON.stringify(applyCellFieldFilter(EX as never, state));
    assertEquals(
      out.includes(SECRET),
      false,
      `${name}: the excluded field reached the client — ${out}`,
    );
    assert(out.includes("label"), `${name}: the rest must survive — ${out}`);
    checked++;
  }
  assertEquals(checked, 3, "all three container shapes must be checked");
});

Deno.test("visible.exclude: a LITERAL key still wins over the container reading", () => {
  // The control — descending into every value unconditionally would remove
  // `x.b` when the author wrote `a.b` and `a` really has a `b`.
  const state = { a: { b: "gone", x: { b: "kept" } } };
  const out = applyCellFieldFilter({ exclude: ["a.b"] } as never, state) as {
    a: { b?: string; x: { b: string } };
  };
  assertEquals(out.a.b, undefined, "the literal path is removed");
  assertEquals(out.a.x.b, "kept", "…and a same-named field elsewhere is not");
});

Deno.test("visible.exclude: the PATCH filter agrees with the projection", async () => {
  const { filterPatchesByStrategy } = await import(
    "../src/state/state-filter.ts"
  );
  const strategies = new Map([["acct", "patch" as const]]);
  const fields = new Map([[
    "acct",
    {
      mode: "exclude" as const,
      fields: new Set<string>(),
      deepExcludes: [["accounts", "secret"]],
    },
  ]]);
  for (const key of ["alice", "7"]) {
    const kept = filterPatchesByStrategy(
      [{
        cell: "acct",
        // deno-lint-ignore no-explicit-any
        ops: [{
          op: "replace",
          path: ["accounts", key, "secret"],
          value: SECRET,
        }] as any,
      }],
      // deno-lint-ignore no-explicit-any
      strategies as any,
      fields,
    );
    assertEquals(
      JSON.stringify(kept).includes(SECRET),
      false,
      `a patch at accounts.${key}.secret must not be sent — the projection ` +
        `hides it, and a filter that disagrees with the projection is the ` +
        `worst of both: the field looks frozen in a live app and arrives in ` +
        `full on every resync`,
    );
  }
  // …and an unrelated patch still flows.
  const other = filterPatchesByStrategy(
    [{
      cell: "acct",
      // deno-lint-ignore no-explicit-any
      ops: [{
        op: "replace",
        path: ["accounts", "alice", "label"],
        value: "a",
      }] as any,
    }],
    // deno-lint-ignore no-explicit-any
    strategies as any,
    fields,
  );
  assertEquals(JSON.stringify(other).includes("label"), true);
});

// The third hole: a no-op exclude switched the credential refusal off.
//
// It asked only whether SOME exclude path starts with `key + "."`, never
// whether it removes anything. So `exclude: ["apiKey.whatever"]` — and even
// `["password."]` — booted green with the credential broadcast to every
// client, and not even the soft warning fired, because the `continue` skips
// both tiers. One character.
Deno.test("credentials: a no-op dot-path exclude does not disable the refusal", async () => {
  const { cell } = await import("../src/state/cell-create.ts");
  const { composeCells } = await import("../src/state/cell-compose.ts");
  const { refuseUnsafeComposition } = await import(
    "../src/server/aio-composition.ts"
  ) as unknown as {
    refuseUnsafeComposition: (c: unknown) => void;
  };

  const boot = (id: string, exclude?: string[]) => {
    const c = cell(id, {
      state: { apiKey: "FAKE-NOT-REAL", n: 0 },
      methods: {},
      ...(exclude ? { visible: { exclude } } : {}),
      // deno-lint-ignore no-explicit-any
    } as any);
    const composed = composeCells([c], { perfCheck: false });
    let refused = "";
    try {
      refuseUnsafeComposition(composed);
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    return refused;
  };

  assert(
    boot("credv1").includes("credential"),
    "the baseline must refuse an exposed apiKey",
  );
  assert(
    boot("credv2", ["apiKey.whatever"]).includes("credential"),
    "a sub-path of the credential itself removes nothing — the VALUE is the " +
      "secret, so no exclude under it can help",
  );
  assert(
    boot("credv3", ["apiKey."]).includes("credential"),
    "…nor does a trailing dot",
  );
  // The control: a REAL exclude of a nested credential still silences it —
  // warning about correctly-handled state is the thing the hatch exists for.
  const handled = cell("credv4", {
    state: { accounts: { alice: { apiKey: "FAKE-NOT-REAL" } }, n: 0 },
    methods: {},
    visible: { exclude: ["accounts.apiKey"] },
    // deno-lint-ignore no-explicit-any
  } as any);
  let ok = true;
  try {
    refuseUnsafeComposition(composeCells([handled], { perfCheck: false }));
  } catch {
    ok = false;
  }
  assert(ok, "a genuine deep exclude must still be accepted without a refusal");
});
