// updates-cell.test.ts — the `updates` cell against a stub runtime, through
// the seam `aio/testing` exports for exactly this (`installUpdatesRuntime`).
//
// Its own file: importing `src/updates.ts` registers the cell, which
// updates-optin.test.ts asserts does NOT happen from the server machinery.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testCell } from "../src/cell-test.ts";
import {
  type ApplyOptions,
  type CheckOptions,
  type CheckResult,
  installUpdatesRuntime,
  updates,
  type UpdatesRuntime,
  type UpdatesState,
} from "../src/updates.ts";

// `UpdatesCell` is the app-facing shape (methods + readable state), not the
// `CellDef` generic `testCell` is typed over — so the harness sees it through
// its runtime shape, and the state is read back as what it is.
const cellDef = updates as unknown as Parameters<typeof testCell>[0];
type T = Parameters<Parameters<typeof testCell>[2]>[0];
const state = (t: T) => t.getState() as unknown as UpdatesState;
const check = (t: T) => t.send.check!() as Promise<CheckResult>;

const offer = (version: string, over: Record<string, unknown> = {}) => ({
  version,
  reason: `${version} is newer`,
  notes: null,
  size: null,
  releasedAt: null,
  migrates: false,
  signed: true,
  keyFingerprint: "abcdef012345",
  warnings: [],
  ...over,
});

/** A runtime that offers `version` unless the cell says it was dismissed —
 *  the same rule the real one applies, and it records what it was asked. */
function stub(version: string, asked: CheckOptions[]): UpdatesRuntime {
  return {
    kind: "manifest",
    channel: "prod",
    current: "1.0.0",
    exposed: false,
    check: (opts) => {
      asked.push(opts);
      return Promise.resolve(
        opts.dismissed === version
          ? { kind: "current" as const, reason: `${version} was dismissed` }
          : { kind: "offer" as const, update: offer(version) },
      );
    },
    apply: () => Promise.resolve(),
    setChannel: () => Promise.resolve(),
  };
}

testCell(
  cellDef,
  "enabled is false until a runtime answers a check",
  async (t) => {
    installUpdatesRuntime(null);
    try {
      assertEquals(state(t).enabled, false);
      const r = await check(t);
      assertEquals(r.kind, "error");
      assertEquals(state(t).enabled, false);
      assertEquals(state(t).status, "error");
      // The message names the FIX, not just the fact: "not configured" sent
      // people looking for a missing file when the answer is one key in run().
      assertStringIncludes(state(t).error!, "not configured");
      assertStringIncludes(state(t).error!, "aio.run");
      assertStringIncludes(state(t).error!, "updates:");
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(
  cellDef,
  "a configured runtime turns enabled on, with kind/channel/current",
  async (t) => {
    const asked: CheckOptions[] = [];
    installUpdatesRuntime(stub("2.0.0", asked));
    try {
      await check(t);
      const s = state(t);
      assertEquals(s.enabled, true);
      assertEquals(s.kind, "manifest");
      assertEquals(s.channel, "prod");
      assertEquals(s.current, "1.0.0");
      assertEquals(s.status, "available");
      assertEquals(s.available?.version, "2.0.0");
      // Transparency travels with the offer: an app can say whether the
      // release was signed and by which key, not just that it exists.
      assertEquals(s.available?.signed, true);
      assertEquals(s.available?.keyFingerprint, "abcdef012345");
      assertEquals(asked, [{ dismissed: null }]);
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(
  cellDef,
  "dismiss() reaches the runtime on the next check, and a newer version is still offered",
  async (t) => {
    const asked: CheckOptions[] = [];
    installUpdatesRuntime(stub("2.0.0", asked));
    try {
      await check(t);
      await t.send.dismiss!();
      assertEquals(state(t).dismissed, "2.0.0");
      assertEquals(state(t).available, null);

      // Past the next poll: the cell hands its dismissal to the runtime, and
      // the offer does not come back.
      const again = await check(t);
      assertEquals(again.kind, "current");
      if (again.kind === "current") {
        assertStringIncludes(again.reason, "2.0.0 was dismissed");
      }
      assertEquals(asked.at(-1), { dismissed: "2.0.0" });
      assertEquals(state(t).status, "idle");
      assertEquals(state(t).available, null);

      // A newer release is not covered by the No.
      installUpdatesRuntime(stub("2.1.0", asked));
      const newer = await check(t);
      assertEquals(newer.kind, "offer");
      assertEquals(state(t).available?.version, "2.1.0");
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

// ── the doors that had no handle on the inside ──────────────────────────────

testCell(
  cellDef,
  "undismiss() puts the offer back within reach",
  async (t) => {
    const asked: CheckOptions[] = [];
    installUpdatesRuntime(stub("2.0.0", asked));
    try {
      await check(t);
      await t.send.dismiss!();
      assertEquals(state(t).dismissed, "2.0.0");
      // Without an inverse, "Not now" was a permanent No for that version: the
      // runtime is handed the dismissal on every later check, so the release
      // simply never appears again from inside the app.
      await t.send.undismiss!();
      assertEquals(state(t).dismissed, null);
      const again = await check(t);
      assertEquals(again.kind, "offer");
      assertEquals(state(t).available?.version, "2.0.0");
      assertEquals(asked.at(-1), { dismissed: null });
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(
  cellDef,
  "dismiss() hides a BLOCKED release too",
  async (t) => {
    installUpdatesRuntime({
      kind: "manifest",
      channel: "prod",
      current: "1.0.0",
      exposed: false,
      check: (opts) =>
        Promise.resolve(
          opts.dismissed === "3.0.0"
            ? { kind: "current" as const, reason: "3.0.0 was dismissed" }
            : {
              kind: "blocked" as const,
              blocked: { version: "3.0.0", blockers: ["cell todos"] },
            },
        ),
      apply: () => Promise.resolve(),
      setChannel: () => Promise.resolve(),
    });
    try {
      await check(t);
      assertEquals(state(t).status, "blocked");
      assertEquals(state(t).blocked?.version, "3.0.0");
      // A notice the user cannot act on and cannot put away is a notice they
      // learn to ignore. `dismiss()` was inert here, on every boot, forever.
      await t.send.dismiss!();
      assertEquals(state(t).blocked, null);
      assertEquals(state(t).dismissed, "3.0.0");
      assertEquals(state(t).status, "idle");
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

// ── the in-flight guards ────────────────────────────────────────────────────

testCell(
  cellDef,
  "two checks never overlap — the runtime is never re-entered",
  async (t) => {
    let inside = 0;
    let maxOverlap = 0;
    installUpdatesRuntime({
      kind: "manifest",
      channel: "prod",
      current: "1.0.0",
      exposed: false,
      check: async () => {
        inside++;
        maxOverlap = Math.max(maxOverlap, inside);
        await new Promise((r) => setTimeout(r, 5));
        inside--;
        return { kind: "current" as const, reason: "1.0.0 is the latest" };
      },
      apply: () => Promise.resolve(),
      setChannel: () => Promise.resolve(),
    });
    try {
      // The boot check plus a click on "Check now". These used to race one
      // mutable `offered` slot in the runtime, so `apply()` could be handed a
      // manifest nobody was ever shown.
      await Promise.all([check(t), check(t), check(t)]);
      assertEquals(maxOverlap, 1);
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(
  cellDef,
  "a second apply() is refused instead of downloading the release twice",
  async (t) => {
    const applies: (ApplyOptions | undefined)[] = [];
    installUpdatesRuntime({
      kind: "manifest",
      channel: "prod",
      current: "1.0.0",
      exposed: false,
      check: () =>
        Promise.resolve({ kind: "offer" as const, update: offer("2.0.0") }),
      apply: async (opts) => {
        applies.push(opts);
        await new Promise((r) => setTimeout(r, 5));
      },
      setChannel: () => Promise.resolve(),
    });
    try {
      await check(t);
      await t.send.apply!();
      // The swap is done and the handover is scheduled: staged, not idle, and
      // certainly not "available" again.
      assertEquals(state(t).status, "staged");
      assertEquals(state(t).progress, 1);
      assertEquals(applies.length, 1);

      // A double click. The second must not start a second download into the
      // same staged path.
      await t.send.apply!();
      assertEquals(applies.length, 1);
      assertStringIncludes(state(t).error!, "already being installed");
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(
  cellDef,
  "a poll that lands mid-install does not clear the offer under the applier",
  async (t) => {
    let checks = 0;
    installUpdatesRuntime({
      kind: "manifest",
      channel: "prod",
      current: "1.0.0",
      exposed: false,
      check: () => {
        checks++;
        return Promise.resolve({
          kind: "offer" as const,
          update: offer("2.0.0"),
        });
      },
      apply: () => new Promise((r) => setTimeout(r, 5)),
      setChannel: () => Promise.resolve(),
    });
    try {
      await check(t);
      assertEquals(checks, 1);
      await t.send.apply!();
      assertEquals(state(t).status, "staged");
      // The poll timer does not stop for an install. A check here would ask the
      // runtime to re-fetch and clear the manifest the applier is mid-way
      // through installing.
      const r = await check(t);
      assertEquals(checks, 1);
      assertEquals(r.kind, "current");
      if (r.kind === "current") {
        assertStringIncludes(r.reason, "an update is being installed");
      }
      assertEquals(state(t).status, "staged");
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

// ── the one-way door ────────────────────────────────────────────────────────

testCell(
  cellDef,
  "a blocked release is only installable with acceptDataLoss, and says so",
  async (t) => {
    const applies: (ApplyOptions | undefined)[] = [];
    installUpdatesRuntime({
      kind: "manifest",
      channel: "prod",
      current: "1.0.0",
      exposed: false,
      check: () =>
        Promise.resolve({
          kind: "blocked" as const,
          blocked: {
            version: "3.0.0",
            blockers: ['cell "todos" cannot migrate your data'],
          },
        }),
      apply: (opts) => {
        applies.push(opts);
        return Promise.resolve();
      },
      setChannel: () => Promise.resolve(),
    });
    try {
      await check(t);
      assertEquals(state(t).status, "blocked");

      // The default is unchanged: there is no path from blocked to installed.
      await t.send.apply!();
      assertEquals(applies.length, 0);
      assertEquals(state(t).status, "error");
      assertStringIncludes(state(t).error!, "cannot migrate your data");
      // …and the refusal names the door, so a mis-published contract is not a
      // permanent block on every future release of that app.
      assertStringIncludes(state(t).error!, "acceptDataLoss: true");

      await t.send.apply!({ acceptDataLoss: true });
      assertEquals(applies, [{ acceptDataLoss: true }]);
      assertEquals(state(t).status, "staged");
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(
  cellDef,
  "with nothing found at all, apply() says to check first",
  async (t) => {
    installUpdatesRuntime({
      kind: "manifest",
      channel: "prod",
      current: "1.0.0",
      exposed: false,
      check: () =>
        Promise.resolve({ kind: "current" as const, reason: "latest" }),
      apply: () => Promise.reject(new Error("must not be called")),
      setChannel: () => Promise.resolve(),
    });
    try {
      await check(t);
      await t.send.apply!();
      assertEquals(state(t).status, "error");
      assertStringIncludes(state(t).error!, "updates.check()");
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

// ── the state machine has no unreachable members ────────────────────────────

Deno.test("every UpdateStatus is actually assigned somewhere in src/", async () => {
  // `staged` and `applying` were declared, documented, and never written — a
  // type promising states no client could ever observe. This is the guard that
  // keeps the union honest: add a member, assign it, or delete it.
  const decl = await Deno.readTextFile("src/state/updates-cell.ts");
  const union = decl.slice(
    decl.indexOf("export type UpdateStatus ="),
    decl.indexOf(";", decl.indexOf("export type UpdateStatus =")),
  );
  const members = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
  assert(members.length >= 8, `parsed the union: ${members.join(",")}`);

  const sources: string[] = [];
  for await (const e of Deno.readDir("src/state")) {
    if (e.isFile && e.name.endsWith(".ts")) {
      sources.push(await Deno.readTextFile(`src/state/${e.name}`));
    }
  }
  for await (const e of Deno.readDir("src/server")) {
    if (e.isFile && e.name.endsWith(".ts")) {
      sources.push(await Deno.readTextFile(`src/server/${e.name}`));
    }
  }
  const all = sources.join("\n");
  for (const m of members) {
    const assigned = new RegExp(
      `(status = "${m}"|status: "${m}"|phase\\("${m}"\\)|setPhase\\("${m}"\\))`,
    );
    assert(
      assigned.test(all),
      `UpdateStatus "${m}" is declared but never assigned in src/ — ` +
        `assign it, or delete it from the union`,
    );
  }
});

// ── the states a client can actually see ────────────────────────────────────

testCell(
  cellDef,
  "status: checking (and enabled) are OBSERVABLE while the check is in flight",
  async (t) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    installUpdatesRuntime({
      kind: "manifest",
      channel: "stable",
      current: "1.0.0",
      exposed: false,
      check: async () => {
        await held;
        return { kind: "current" as const, reason: "1.0.0 is the latest" };
      },
      apply: () => Promise.resolve(),
      setChannel: () => Promise.resolve(),
    });
    try {
      const pending = check(t);
      // `transaction` buffers the whole write-set to one commit at return, so
      // without a mid-method publish `status: "checking"` existed only inside
      // the function: no client ever saw it, and the spinner bound to it in
      // examples/updates could never render. Measured, not assumed.
      await new Promise((r) => setTimeout(r, 0));
      assertEquals(state(t).status, "checking");
      // `enabled` is a fact about the CONFIGURATION, so it is true the moment
      // a check begins — not one network round-trip later, which is how long
      // the chip stayed blank at every boot.
      assertEquals(state(t).enabled, true);
      assertEquals(state(t).channel, "stable");
      assertEquals(state(t).current, "1.0.0");
      release();
      await pending;
      assertEquals(state(t).status, "idle");
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(
  cellDef,
  "progress does not rewind: the reset lands before the applier's reports",
  async (t) => {
    const seen: number[] = [];
    installUpdatesRuntime({
      kind: "manifest",
      channel: "prod",
      current: "1.0.0",
      exposed: false,
      check: () =>
        Promise.resolve({ kind: "offer" as const, update: offer("2.0.0") }),
      apply: async () => {
        // The applier reporting on itself, exactly as the real one does.
        seen.push(state(t).progress);
        await (updates as unknown as { setProgress(f: number): void })
          .setProgress(0.5);
        await new Promise((r) => setTimeout(r, 0));
        seen.push(state(t).progress);
        throw new Error("network died");
      },
      setChannel: () => Promise.resolve(),
    });
    try {
      await check(t);
      await t.send.apply!();
      // The reset was published BEFORE the download began (0), and the
      // applier's 0.5 survived it. Buffered to the end, `progress = 0`
      // committed AFTER every setProgress — so a failed apply visibly rewound
      // the bar to zero and a successful one never showed one at all.
      assertEquals(seen, [0, 0.5]);
      assertEquals(state(t).status, "error");
      assertStringIncludes(state(t).error!, "network died");
      assertEquals(state(t).progress, 0.5);
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(
  cellDef,
  "readyUpdates() publishes the configuration before any check answers",
  async (t) => {
    const { readyUpdates } = await import("../src/state/updates-cell.ts");
    installUpdatesRuntime({
      kind: "git",
      channel: "main",
      current: "1.2.3",
      exposed: false,
      // An app with `check: false` never runs a boot check, so this must not
      // depend on one: without it such an app reported `enabled: false` —
      // "updates are not configured" — for its entire life.
      check: () => Promise.reject(new Error("must not be called")),
      apply: () => Promise.resolve(),
      setChannel: () => Promise.resolve(),
    });
    try {
      assertEquals(state(t).enabled, false);
      readyUpdates();
      await t.settle?.();
      const s = state(t);
      assertEquals(s.enabled, true);
      assertEquals(s.kind, "git");
      assertEquals(s.channel, "main");
      assertEquals(s.current, "1.2.3");
      assertEquals(s.status, "idle");
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

// The pre-migration backup path stops being a log line.
//
// The applier already computed it, logged it, and wrote it into the pending
// marker so a rollback could name it — and it stopped there, so no UI could
// show it. After a rollback, or after an `acceptDataLoss` install, the file
// holding the user's data was named only in `~/.<app>/logs`. For an app holding
// anything a person would miss, that is the one sentence you want on screen.
testCell(
  cellDef,
  "setBackupPath puts the pre-migration backup where a UI can read it",
  async (t) => {
    installUpdatesRuntime(stub("2.0.0", []));
    try {
      assertEquals(state(t).backupPath, null, "nothing taken yet");
      await t.send.setBackupPath!("/home/u/.app/backups/pre-1.0.0-state.db");
      assertEquals(
        state(t).backupPath,
        "/home/u/.app/backups/pre-1.0.0-state.db",
      );
      // Crossing channels drops everything derived from the old one, and a
      // backup taken for an install on another channel is one of those things.
      await t.send.setChannel!("test");
      assertEquals(state(t).backupPath, null);
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testCell(
  cellDef,
  "setBackupPath refuses a value that is not a path",
  async (t) => {
    installUpdatesRuntime(stub("2.0.0", []));
    try {
      // A silent no-op here would leave the UI showing "backed up" with nothing
      // behind it — the exact shape this field exists to remove.
      let threw = "";
      await (t.send.setBackupPath!("") as Promise<void>).catch((e: Error) => {
        threw = e.message;
      });
      assertStringIncludes(threw, "non-empty string");
      assertEquals(state(t).backupPath, null);
    } finally {
      installUpdatesRuntime(null);
    }
  },
);
