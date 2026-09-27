// A dotted `visible.include` (reachable through `cellDefaults.visible`, which
// aio-composition.ts notes is copied onto cells without cell()'s dotted-include
// refusal — "NOT dead") is projected on the FULL FRAME by `pickPath`, which
// reads the path LITERALLY: `include: ["profile.name"]` keeps exactly
// `profile.name`. The DELTA path (`filterPatchesByStrategy`, include mode)
// matches with `matchDeepPath`, a SUBSEQUENCE matcher built for exclude's
// records-by-id reading — so an op at `profile.billing.name` counts as
// "within" the included path and is sent whole, and a replace of
// `profile.billing` is projected to its `name` sub-branch and sent. Neither
// value is in the frame; both reach the client on the next keystroke.
import { assertEquals } from "@std/assert";
import {
  applyCellFieldFilter,
  filterPatchesByStrategy,
} from "../src/state/state-filter.ts";

const include = { include: ["profile.name"] };
const ff = new Map([["c", {
  mode: "include" as const,
  fields: new Set<string>(),
  deepIncludes: [["profile", "name"]],
}]]);
const strat = new Map([["c", "filter" as const]]);

function deltaFor(path: (string | number)[], value: unknown) {
  return filterPatchesByStrategy(
    // deno-lint-ignore no-explicit-any
    [{ cell: "c", ops: [{ op: "replace", path, value }] as any }],
    strat,
    ff,
  );
}

Deno.test("include-deep frame keeps only profile.name", () => {
  const state = {
    profile: { name: "Ann", billing: { name: "CARDHOLDER-SECRET" } },
  };
  // The frame: only profile.name survives.
  assertEquals(applyCellFieldFilter(include, state), {
    profile: { name: "Ann" },
  });
});

Deno.test("include-deep delta at profile.billing.name is not sent", () => {
  const kept = deltaFor(["profile", "billing", "name"], "CARDHOLDER-SECRET");
  assertEquals(kept, [], `delta leaked: ${JSON.stringify(kept)}`);
});

Deno.test("include-deep replace of profile.billing carries nothing", () => {
  const kept = deltaFor(["profile", "billing"], { name: "CARDHOLDER-SECRET" });
  assertEquals(kept, [], `delta leaked: ${JSON.stringify(kept)}`);
});
