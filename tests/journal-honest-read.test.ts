// The journal's open-time reads say WHY they found nothing. NotFound is the
// one honest "no journal yet"; a journal (or watermark) that EXISTS but cannot
// be read is exactly the state recovery is for — a bare `catch {}` used to
// read it as "nothing to replay" and boot on, silently.
import { assert, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { createJournal } from "../src/server/journal.ts";
import { noRedaction } from "../src/diagnostics/redact.ts";

Deno.test("journal: a missing journal is 'nothing yet' — an unreadable one throws by name", async () => {
  const dir = await Deno.makeTempDir({ prefix: "journal-honest-" });
  try {
    // Missing: opens at seq 0, no complaint.
    const j = createJournal(join(dir, "none.journal"), { redact: noRedaction });
    j.close?.();
    // Present but unreadable (a directory where the file should be — EISDIR,
    // deterministic for root and non-root alike).
    const asDir = join(dir, "dir.journal");
    await Deno.mkdir(asDir);
    const err = assertThrows(
      () => createJournal(asDir, { redact: noRedaction }),
      Error,
    );
    assert(err.message.includes("could not read the journal"), err.message);
    assert(err.message.includes(asDir), err.message);
    assert(err.message.includes("permissions"), err.message);
    // Same for the watermark file beside a fine journal.
    const wmDir = join(dir, "wm.journal.wm");
    await Deno.mkdir(wmDir);
    const err2 = assertThrows(
      () => createJournal(join(dir, "wm.journal"), { redact: noRedaction }),
      Error,
    );
    assert(err2.message.includes("could not read the watermark"), err2.message);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
