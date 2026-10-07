// A swap that was never MADE is not a bad release.
//
// Measured on Windows 11: an update clicked within ~30 s of the app's start
// could not move the install folder (a helper process still had it as its
// working directory). The old version came back with `could not be installed:
// the running version could not be moved aside` — and the release was
// DISMISSED, so it was never offered again. Dismissal exists to stop a release
// that ran and failed from being installed in a loop; this one never ran.
//
// The rule: such a release stays on offer, counted per release on the trust
// record; after MAX_FAILED_SWAPS in a row it is dismissed after all, with what
// to do about it. An unattended install does not try again in the boot that
// follows its own failure. A release that DID run and was put back is
// dismissed at once, as before.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  failedUpdatePath,
  type PendingUpdate,
  writePending,
  writeRecordAtomic,
} from "../src/server/updates-apply.ts";
import {
  _confirm,
  beginUpdates,
  confirmPendingUpdate,
  MAX_FAILED_SWAPS,
  startUpdates,
  swapAdvice,
} from "../src/server/updates-boot.ts";
import { readTrust, writeTrust } from "../src/server/updates-check.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const OLD_EXE = "1:100:4000:1600000000000";
const NEW_EXE = "1:200:5000:1700000099000";
// Nothing is there: the boot only compares the path.
const INSTALL = "/nonexistent-aio-test/notes";
const WHY = "the running version could not be moved aside";

function failedSwap(more: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    swapFailed: WHY,
    from: "1.0.0",
    to: "2.0.0",
    artifact: INSTALL,
    previous: `${INSTALL}.old-1.0.0`,
    fromExe: OLD_EXE,
    attempts: 0,
    startedAt: "2026-10-02T18:27:05.000Z",
    ...more,
  };
}

type Booted = {
  errors: string[];
  warns: string[];
  slot: UpdatesSlot & { rolledBack?: string };
  applied: () => number;
  stop: () => void;
};

/** One boot of the old version from the install folder, up to and including
 *  the moment the cells are bound (`beginUpdates`). `offer`: what every check
 *  answers; absent, polling is off and nothing is checked. */
function boot(
  data: string,
  { here = INSTALL as string | null, exe = OLD_EXE, auto = false, offer }: {
    here?: string | null;
    exe?: string;
    auto?: boolean;
    offer?: string;
  } = {},
): Booted {
  const errors: string[] = [];
  const warns: string[] = [];
  let applied = 0;
  const slot = {
    runtime: null,
    cell: {
      status: "idle",
      error: null,
      ready: () => {},
      check: () =>
        Promise.resolve({
          kind: "offer",
          update: { version: offer, migrates: false },
        }),
      apply: () => Promise.resolve(void applied++),
    },
  } as unknown as Booted["slot"];
  const started = startUpdates({
    updates: {
      source: "https://example.invalid/rel",
      check: offer ? 1000 : false,
      auto,
      canApply: () => true,
    },
    dataDir: data,
    appName: "notes",
    appVersion: "1.0.0",
    local: { schema: 1, cells: {} },
    exposed: false,
    log: {
      info() {},
      debug() {},
      error: (_c: string, m: string) => errors.push(m),
      warn: (_c: string, m: string) => warns.push(m),
    } as unknown as Log,
    argv: [],
    slot,
    exe,
    installDir: here,
  });
  beginUpdates(slot);
  return { errors, warns, slot, applied: () => applied, stop: started.stop };
}

/** Wait until `done()` — the boot does not await what it starts. */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

Deno.test("failed swap: the release stays on offer, counted — it is not dismissed", async () => {
  const data = await tempDir("aio-swap-retry-");
  try {
    writeRecordAtomic(failedUpdatePath(data), failedSwap());
    const b = boot(data);
    b.stop();
    assertEquals(b.errors.length, 1, b.errors.join("\n"));
    assertStringIncludes(
      b.errors[0]!,
      `update 1.0.0 → 2.0.0 could not be installed: ${WHY}, so 1.0.0 was ` +
        `started again — 2.0.0 stays on offer (failed attempt 1 of ` +
        `${MAX_FAILED_SWAPS})`,
    );
    assertEquals(b.slot.rolledBack, undefined, "2.0.0 was dismissed");
    assertEquals(
      b.warns.filter((m) => m.includes("Dismissed")),
      [],
    );
    assertEquals(readTrust(data).failedSwaps, { to: "2.0.0", count: 1 });
    // Said and counted once: the next boot does not count it again.
    assertEquals(exists(failedUpdatePath(data)), false);
    const again = boot(data);
    again.stop();
    assertEquals(again.errors, []);
    assertEquals(readTrust(data).failedSwaps, { to: "2.0.0", count: 1 });
  } finally {
    await dropTempDir(data);
  }
});

Deno.test("failed swap: the count is per release, and the last allowed failure dismisses it with what to do", async () => {
  const data = await tempDir("aio-swap-retry-");
  try {
    // Another release's failures do not count against this one.
    // The bound is a number, written out: a loop that ran to the constant
    // would run for ever with a constant that is not one.
    assertEquals(MAX_FAILED_SWAPS, 3);
    writeTrust(data, { failedSwaps: { to: "1.9.0", count: 2 } });
    for (const n of [1, 2]) {
      writeRecordAtomic(failedUpdatePath(data), failedSwap());
      const b = boot(data);
      b.stop();
      assertStringIncludes(b.errors[0]!, `(failed attempt ${n} of 3)`);
      assertEquals(b.slot.rolledBack, undefined, `dismissed at failure ${n}`);
    }
    writeRecordAtomic(failedUpdatePath(data), failedSwap());
    const last = boot(data);
    last.stop();
    assertEquals(last.slot.rolledBack, "2.0.0", "still offered, for ever");
    assert(!last.errors[0]!.includes("stays on offer"), last.errors[0]);
    const said = last.warns.find((m) => m.includes("Dismissed"));
    assertStringIncludes(
      said ?? "",
      `not installing 2.0.0 again — it could not be put in place on this ` +
        `machine 3 times in a row. Dismissed. ` +
        swapAdvice({ artifact: INSTALL, previous: "" }),
    );
    assertStringIncludes(said ?? "", "`undismiss()` then offers it again");
    // The record goes once the dismissal is committed, as for a rollback.
    await until(
      () => !exists(failedUpdatePath(data)),
      "the failed record removed",
    );
    // The count ended with the dismissal: un-dismissed, the release gets its
    // tries afresh — the next failure is the first of three, not "4 in a row".
    await until(
      () => readTrust(data).failedSwaps === undefined,
      "the count cleared with the dismissal",
    );
    writeRecordAtomic(failedUpdatePath(data), failedSwap());
    const again = boot(data);
    again.stop();
    assertStringIncludes(again.errors[0]!, "(failed attempt 1 of 3)");
    assertEquals(again.slot.rolledBack, undefined);
  } finally {
    await dropTempDir(data);
  }
});

Deno.test("failed swap: the dismissal names the path that was held, in this OS's words", () => {
  const prev = `${INSTALL}.old-1.0.0`;
  const moved = { swapFailed: WHY, artifact: INSTALL, previous: prev };
  const copy = {
    ...moved,
    swapFailed: `an earlier copy of the app (${prev}) could not be removed ` +
      `(rm: cannot remove '${prev}/locked/f': Permission denied)`,
  };
  assertEquals(
    [
      swapAdvice(moved, "windows"),
      swapAdvice(copy, "windows"),
      swapAdvice(moved, "linux"),
      swapAdvice(copy, "darwin"),
      swapAdvice({ swapFailed: WHY, previous: "" }, "linux"),
    ],
    [
      `Close whatever is open in ${INSTALL} (a program started from it, an ` +
      `Explorer window, an antivirus scan) or restart the computer`,
      `Close whatever is open in ${prev} (a program started from it, an ` +
      `Explorer window, an antivirus scan) or restart the computer`,
      `Make sure this user may move and remove ${INSTALL} (its permissions, ` +
      `and those of the folder it is in) and that no program runs from it`,
      `Make sure this user may move and remove ${prev} (its permissions, ` +
      `and those of the folder it is in) and that no program runs from it`,
      `Make sure this user may move and remove the install folder (its ` +
      `permissions, and those of the folder it is in) and that no program ` +
      `runs from it`,
    ],
  );
});

Deno.test("failed swap: only a swap that moved NOTHING is offered again", async () => {
  const cases: [string, PendingUpdate, { here?: string; exe?: string }][] = [
    // The release ran and was put back: the rule it has always had.
    ["rolled back after two boots", {
      ...failedSwap({ swapFailed: undefined }),
      attempts: 2,
    }, {}],
    // Neither folder could be moved back: the old copy runs from where it was
    // set aside, and the install's name holds nothing that works.
    ["old copy started where it was set aside", failedSwap(), {
      here: `${INSTALL}.old-1.0.0`,
    }],
    // Another executable than the one the update was to replace is running.
    ["another build runs", failedSwap(), { exe: NEW_EXE }],
    // A record staged by a build that did not note which file it replaced.
    ["no identity on the record", failedSwap({ fromExe: undefined }), {}],
  ];
  for (const [name, record, how] of cases) {
    const data = await tempDir("aio-swap-retry-");
    try {
      writeRecordAtomic(failedUpdatePath(data), record);
      const b = boot(data, how);
      b.stop();
      assertEquals(b.slot.rolledBack, "2.0.0", `${name}: not dismissed`);
      assertEquals(readTrust(data).failedSwaps, undefined, name);
      assert(!b.errors.join("\n").includes("stays on offer"), name);
    } finally {
      await dropTempDir(data);
    }
  }
});

Deno.test({
  name:
    "failed swap: a count that cannot be kept dismisses — a retry nothing counts never ends",
  ignore: Deno.build.os === "windows", // a folder nothing can be written in, by mode bits: a Windows directory has none
  fn: async () => {
    const data = await tempDir("aio-swap-retry-");
    try {
      writeRecordAtomic(failedUpdatePath(data), failedSwap());
      await Deno.chmod(data, 0o555);
      const b = boot(data);
      b.stop();
      assertEquals(b.slot.rolledBack, "2.0.0");
      assert(!b.errors[0]!.includes("stays on offer"), b.errors[0]);
    } finally {
      await Deno.chmod(data, 0o755);
      await dropTempDir(data);
    }
  },
});

Deno.test("failed swap (auto): not installed again in the boot that follows the failure — at the next check", async () => {
  const data = await tempDir("aio-swap-retry-");
  try {
    writeRecordAtomic(failedUpdatePath(data), failedSwap());
    const b = boot(data, { auto: true, offer: "2.0.0" });
    try {
      await until(
        () => b.warns.some((m) => m.includes("tried again at the next check")),
        "the boot check deferring the install",
      );
      assertEquals(b.applied(), 0, "installed again at once: a restart loop");
      // The poll (1 s) is the later check.
      await until(() => b.applied() === 1, "the next check installing it");
    } finally {
      b.stop();
    }
    // Control: with no failed swap, the boot check installs.
    const clean = await tempDir("aio-swap-retry-");
    try {
      const c = boot(clean, { auto: true, offer: "2.0.0" });
      try {
        await until(() => c.applied() === 1, "the boot check installing it");
      } finally {
        c.stop();
      }
    } finally {
      await dropTempDir(clean);
    }
  } finally {
    await dropTempDir(data);
  }
});

Deno.test("failed swap: a confirmed update ends the count", async () => {
  const data = await tempDir("aio-swap-retry-");
  try {
    writeTrust(data, { failedSwaps: { to: "2.0.0", count: 2 } });
    writePending(data, {
      from: "1.0.0",
      to: "2.0.0",
      previous: join(data, "none.old-1.0.0"),
      attempts: 1,
      startedAt: "2026-10-02T18:30:00.000Z",
    });
    confirmPendingUpdate(
      data,
      { info() {}, debug() {}, warn() {}, error() {} } as unknown as Log,
    );
    await _confirm.pruned; // its background prune, read to the end
    assertEquals(readTrust(data).failedSwaps, undefined);
  } finally {
    await dropTempDir(data);
  }
});
