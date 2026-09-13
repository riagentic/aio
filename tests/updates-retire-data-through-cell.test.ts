// updates-retire-data-through-cell.test.ts — `updates.apply({ retireData: true })`
// through the CELL, not the runtime.
//
// docs/deploy/updates.md documents `retireData` as the second door for a
// blocked release. The runtime implemented it; the cell never let it through:
// its gate refused a blocked release unless `acceptDataLoss` came too, and it
// forwarded only `{ acceptDataLoss }` to `runtime.apply` — so the documented
// call was an error, and a release taken with both flags migrated the data
// instead of retiring it. A runtime-level test could not see either half.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { testCell } from "../src/cell-test.ts";
import {
  type ApplyOptions,
  type CheckResult,
  installUpdatesRuntime,
  updates,
  type UpdatesState,
} from "../src/updates.ts";

const cellDef = updates as unknown as Parameters<typeof testCell>[0];
type T = Parameters<Parameters<typeof testCell>[2]>[0];
const state = (t: T) => t.getState() as unknown as UpdatesState;

function install(
  kind: () => "blocked" | "offer",
  applies: (ApplyOptions | undefined)[],
) {
  installUpdatesRuntime({
    kind: "manifest",
    channel: "prod",
    current: "1.0.0",
    currentUnknown: null,
    exposed: false,
    check: () =>
      Promise.resolve<CheckResult>(
        kind() === "blocked"
          ? {
            kind: "blocked",
            blocked: {
              version: "2.0.0",
              blockers: ['cell "todos" cannot migrate from v1'],
            },
          }
          : {
            kind: "offer",
            update: {
              version: "2.0.0",
              reason: "newer",
              notes: null,
              size: null,
              releasedAt: null,
              migrates: false,
              signed: true,
              keyFingerprint: "abcdef012345",
              warnings: [],
            },
          },
      ),
    apply: (opts) => {
      applies.push(opts);
      return Promise.resolve();
    },
    setChannel: () => Promise.resolve(),
  });
}

testCell(
  cellDef,
  "updates.apply({ retireData: true }) installs a BLOCKED release and forwards retireData",
  async (t) => {
    const applies: (ApplyOptions | undefined)[] = [];
    install(() => "blocked", applies);
    try {
      await t.send.check!();
      assertEquals(state(t).status, "blocked");
      // The refusal names BOTH doors.
      await t.send.apply!({});
      assertEquals(applies.length, 0);
      assertStringIncludes(state(t).error!, "retireData: true");

      await t.send.apply!({ retireData: true });
      assertEquals(state(t).error, null);
      assertEquals(state(t).status, "staged");
      assertEquals(applies, [{ acceptDataLoss: false, retireData: true }]);
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(
  cellDef,
  "updates.apply({ retireData: true }) on an OFFER still reaches the runtime as retireData",
  async (t) => {
    const applies: (ApplyOptions | undefined)[] = [];
    install(() => "offer", applies);
    try {
      await t.send.check!();
      assertEquals(state(t).status, "available");
      await t.send.apply!({ retireData: true, acceptDataLoss: true });
      assertEquals(state(t).status, "staged");
      assertEquals(applies, [{ acceptDataLoss: true, retireData: true }]);
    } finally {
      installUpdatesRuntime(null);
    }
  },
);
