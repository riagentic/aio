// A refused append that wrote PART of its line (ENOSPC/EIO after a short
// write) left the journal ending mid-line; the next append — acked — was
// glued onto it and the fused line was skipped as torn at the next boot. The
// open seal only covered a tear found at boot. The partial tail is now cut
// back to the last "\n" at the failure; where the cut is refused too, the next
// append starts on a fresh line.
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { createJournal, parseJournal } from "../src/server/journal.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type W = typeof Deno.writeTextFileSync;

/** Run `fn` with the next journal write torn: half its line lands, then it
 *  throws — what a disk that fills mid-write does. */
function withTornWrite(path: string, fn: () => void): void {
  const real = Deno.writeTextFileSync;
  let armed = true;
  (Deno as { writeTextFileSync: W }).writeTextFileSync = ((p, data, o) => {
    if (armed && p === path && typeof data === "string") {
      armed = false;
      real(p, data.slice(0, Math.floor(data.length / 2)), o);
      throw new Error("ENOSPC: No space left on device (simulated)");
    }
    return real(p, data, o);
  }) as W;
  try {
    fn();
  } finally {
    (Deno as { writeTextFileSync: W }).writeTextFileSync = real;
  }
}

async function scenario(refuseCut: boolean) {
  const dir = await tempDir("aio-journal-torn-");
  const realTruncate = Deno.truncateSync;
  try {
    const path = join(dir, "journal");
    const j = createJournal(path, {});
    j.append({ type: "c:a", payload: { args: [1] } }, Date.now());
    if (refuseCut) {
      (Deno as { truncateSync: typeof Deno.truncateSync }).truncateSync =
        () => {
          throw new Error("EIO (simulated)");
        };
    }
    withTornWrite(path, () => {
      assertThrows(() =>
        j.append({ type: "c:b", payload: { args: [2] } }, Date.now())
      );
    });
    j.append({ type: "c:c", payload: { args: [3] } }, Date.now()); // acked
    (Deno as { truncateSync: typeof Deno.truncateSync }).truncateSync =
      realTruncate;
    const text = Deno.readTextFileSync(path);
    return {
      lines: parseJournal(text, { quiet: true }).map((e) => e.type),
      reopened: createJournal(path, {}).readTail().map((e) => e.type),
      text,
    };
  } finally {
    (Deno as { truncateSync: typeof Deno.truncateSync }).truncateSync =
      realTruncate;
    await dropTempDir(dir);
  }
}

Deno.test("journal: a torn runtime append is cut back — the next acked line survives, whole", async () => {
  const r = await scenario(false);
  assertEquals(r.lines, ["c:a", "c:c"]);
  assertEquals(r.reopened, ["c:a", "c:c"]);
  assertEquals(r.text.includes('"c:b"'), false, "the partial line is gone");
});

Deno.test("journal: a torn runtime append that cannot be cut — the next line starts fresh", async () => {
  const r = await scenario(true);
  assertEquals(r.lines, ["c:a", "c:c"]);
  assertEquals(r.reopened, ["c:a", "c:c"]);
});
