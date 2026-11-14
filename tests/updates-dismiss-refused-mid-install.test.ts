// updates-dismiss-refused-mid-install.test.ts — "Not now" during an install is
// refused, and changes nothing about the install.
//
// dismiss() is a sync method, so the serialize mutex does not hold it off an
// in-flight apply(): mid-download it set status "idle", cleared `available`
// and PERSISTED the version being installed as dismissed. If that install
// then failed, every later check answered "current" for it — a failed install
// read as up to date.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testCell } from "../src/cell-test.ts";
import {
  type CheckResult,
  installUpdatesRuntime,
  updates,
  type UpdatesState,
} from "../src/updates.ts";

const cellDef = updates as unknown as Parameters<typeof testCell>[0];
type T = Parameters<Parameters<typeof testCell>[2]>[0];
const state = (t: T) => t.getState() as unknown as UpdatesState;
const offer = {
  version: "2.0.0",
  reason: "newer",
  notes: null,
  size: null,
  releasedAt: null,
  migrates: false,
  signed: true,
  keyFingerprint: "abcdef012345",
  warnings: [],
};

testCell(
  cellDef,
  "dismiss during an in-flight install is refused",
  async (t) => {
    let finish!: (ok: boolean) => void;
    installUpdatesRuntime({
      kind: "manifest",
      channel: "prod",
      current: "1.0.0",
      currentUnknown: null,
      exposed: false,
      check: (o) =>
        Promise.resolve<CheckResult>(
          o.dismissed === "2.0.0"
            ? { kind: "current", reason: "dismissed" }
            : { kind: "offer", update: offer },
        ),
      apply: () =>
        new Promise<void>((res, rej) => {
          finish = (ok) => ok ? res() : rej(new Error("disk full"));
        }),
      setChannel: () => Promise.resolve(),
    });
    try {
      await (t.send.check!() as Promise<CheckResult>);
      const p = t.send.apply!();
      await new Promise((r) => setTimeout(r, 10));
      assertEquals(state(t).status, "downloading");
      // Refused loudly: a throw, and nothing written — a write would land under
      // the in-flight apply() and break its commit.
      const err = await Promise.resolve().then(() => t.send.dismiss!()).then(
        () => null,
        (e: unknown) => e,
      );
      assert(err instanceof Error, "dismiss mid-install must refuse");
      assertStringIncludes(err.message, "being installed (downloading)");
      await new Promise((r) => setTimeout(r, 10));
      const mid = state(t);
      assertEquals(mid.status, "downloading", "dismiss rewrote a live install");
      assertEquals(mid.available?.version, "2.0.0");
      assertEquals(
        mid.dismissed,
        null,
        "the version being installed was dismissed",
      );
      assertEquals(mid.error, null);
      // The install fails: the failure stands, and the release is still offered.
      finish(false);
      await p;
      assertEquals(state(t).status, "error");
      assertEquals(state(t).error, "disk full");
      const r = await (t.send.check!() as Promise<CheckResult>);
      assert(
        r.kind !== "current" || r.reason !== "dismissed",
        JSON.stringify(r),
      );
      assertEquals(state(t).dismissed, null);
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(cellDef, "dismiss outside an install still works", async (t) => {
  installUpdatesRuntime({
    kind: "manifest",
    channel: "prod",
    current: "1.0.0",
    currentUnknown: null,
    exposed: false,
    check: () => Promise.resolve<CheckResult>({ kind: "offer", update: offer }),
    apply: () => Promise.resolve(),
    setChannel: () => Promise.resolve(),
  });
  try {
    await (t.send.check!() as Promise<CheckResult>);
    t.send.dismiss!();
    assertEquals(state(t).dismissed, "2.0.0");
    assertEquals(state(t).status, "idle");
    assertEquals(state(t).available, null);
    assertEquals(state(t).error, null);
  } finally {
    installUpdatesRuntime(null);
  }
});
