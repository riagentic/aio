// A clock that went BACKWARDS (a board with no RTC booting before NTP, a
// manual time fix) makes the integrity recovery delete the copy it has JUST
// quarantined: prune orders copies by their ISO stamp, so the newest damaged
// database — the only record of everything written since the snapshot — sorts
// as the "oldest" and is removed in the same call that kept it.
import { assert } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  checkAndRecover,
  QUARANTINE_KEEP,
  quarantinePathFor,
} from "../src/server/db-integrity.ts";

Deno.test("integrity: a clock that went back never prunes the copy just quarantined", async () => {
  const dir = await tempDir("qclk-");
  try {
    const path = `${dir}/state.db`;
    // QUARANTINE_KEEP earlier casualties, stamped under the (correct) clock.
    for (let i = 0; i < QUARANTINE_KEEP; i++) {
      Deno.writeTextFileSync(
        quarantinePathFor(path, new Date(Date.UTC(2026, 10, 1 + i))),
        `old ${i}`,
      );
    }
    // The live database: damaged now, holding the newest data.
    Deno.writeTextFileSync(path, "NEWEST DAMAGED DB");
    const out: string[] = [];
    const log = {
      info: (m: string) => out.push(m),
      warn: (m: string) => out.push(m),
      error: (m: string) => out.push(m),
    };
    const db = {
      checkIntegrity: () =>
        Promise.resolve({ ok: false, problems: ["page 3: btree damaged"] }),
      close: () => Promise.resolve(),
    } as unknown as Parameters<typeof checkAndRecover>[0]["db"];
    // The clock now reads earlier than those stamps.
    const now = new Date(Date.UTC(2025, 0, 1));
    const outcome = await checkAndRecover({ db, dbPath: path, log, now });
    const to = outcome.quarantinedTo!;
    let kept = false;
    try {
      kept = Deno.readTextFileSync(to) === "NEWEST DAMAGED DB";
    } catch { /* deleted */ }
    assert(
      kept,
      `the database quarantined THIS boot (${to}) was deleted by the prune ` +
        `in the same call:\n  ${out.join("\n  ")}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});
