// The journal is owner-only (0600) — and stays that way.
//
// Compaction wrote `<journal>.tmp` with NO mode and renamed it over the
// journal, so the 0600 guarantee (asserted at creation by
// tests/action-redaction.test.ts) survived only until the first snapshot: from
// then on the file carried the process umask (0644/0664) forever, for every
// later append. The journal holds recent action PAYLOADS, and `dbPath` can put
// it outside the 0700 app directory, where that is a real leak.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createJournal } from "../src/server/journal.ts";

const modeOf = (p: string) => (Deno.statSync(p).mode ?? 0) & 0o777;

Deno.test("journal: compaction keeps the file owner-only (0600)", async () => {
  if (Deno.build.os === "windows") return; // POSIX modes only
  const dir = await Deno.makeTempDir({ prefix: "aio-journal-perms-" });
  try {
    const path = join(dir, "actions.journal");
    const j = createJournal(path);
    j.append({ type: "wallet:unlock", payload: { passphrase: "hunter2" } }, 1);
    j.append({ type: "wallet:send", payload: { to: "x" } }, 2);
    assertEquals(modeOf(path), 0o600, "created owner-only");

    // A snapshot lands → the journal is compacted (tmp file + rename).
    j.setWatermark(1);
    assertEquals(
      modeOf(path),
      0o600,
      "compaction must not widen the journal's permissions",
    );

    // …and it stays 0600 for every later append + compaction.
    j.append({ type: "wallet:send", payload: { to: "y" } }, 3);
    j.setWatermark(3);
    assertEquals(modeOf(path), 0o600);
    j.close();

    // No stray temp file is left behind holding the same payloads.
    const leftovers = [...Deno.readDirSync(dir)].map((e) => e.name);
    assert(
      !leftovers.includes("actions.journal.tmp"),
      `temp file left behind: ${leftovers.join(", ")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("journal: compaction still keeps the unpersisted tail", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-journal-compact-" });
  try {
    const path = join(dir, "actions.journal");
    const j = createJournal(path);
    j.append({ type: "a" }, 1);
    j.append({ type: "b" }, 2);
    j.append({ type: "c" }, 3);
    j.setWatermark(2);
    assertEquals(j.readSince(2).map((e) => e.type), ["c"]);
    j.close();
    assertEquals(
      createJournal(path).readSince(0).map((e) => e.type),
      ["c"],
      "the persisted prefix is compacted away, the tail survives a reopen",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
