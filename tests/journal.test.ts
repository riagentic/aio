// risoto #3 — durable action journal + replay. The snapshot covers state up to
// the last persist; the journal covers actions AFTER it, replayed at boot so a
// SIGKILL / power cut in the debounce window loses nothing.
import { assert, assertEquals } from "@std/assert";
import {
  createJournal,
  parseJournal,
  replayJournal,
} from "../src/server/journal.ts";
import { join } from "@std/path";

// A tiny counter reducer to prove replay reconstructs state.
type S = { n: number };
const reduce = (s: S, a: { type: string; payload?: unknown }) => ({
  state: a.type === "add" ? { n: s.n + (a.payload as number) } : s,
});

async function withDir(fn: (dir: string) => void | Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("journal: append is durable and readSince returns the tail in order", async () => {
  await withDir((dir) => {
    const j = createJournal(join(dir, "j.log"));
    j.append({ type: "add", payload: 1 }, 1);
    j.append({ type: "add", payload: 2 }, 2);
    j.append({ type: "add", payload: 3 }, 3);
    const all = j.readSince(0);
    assertEquals(all.map((e) => e.payload), [1, 2, 3]);
    assertEquals(all.map((e) => e.seq), [1, 2, 3]);
  });
});

Deno.test("replayJournal: reconstructs exact state from snapshot + tail", () => {
  const snapshot: S = { n: 10 };
  const entries = [
    { seq: 1, type: "add", payload: 5, ts: 0 },
    { seq: 2, type: "add", payload: 7, ts: 0 },
  ];
  assertEquals(replayJournal(snapshot, entries, reduce), { n: 22 });
});

Deno.test("journal: watermark prunes the persisted prefix", async () => {
  await withDir((dir) => {
    const path = join(dir, "j.log");
    const j = createJournal(path);
    j.append({ type: "add", payload: 1 }, 1); // seq 1
    j.append({ type: "add", payload: 2 }, 2); // seq 2
    j.setWatermark(2); // state up to seq 2 is persisted
    j.append({ type: "add", payload: 3 }, 3); // seq 3 (unpersisted)
    assertEquals(j.readSince(j.watermark()).map((e) => e.payload), [3]);
    // On disk, the pruned journal keeps only the tail.
    assertEquals(parseJournal(Deno.readTextFileSync(path)).map((e) => e.seq), [
      3,
    ]);
  });
});

Deno.test("journal: crash recovery — reopen replays the unpersisted tail", async () => {
  await withDir((dir) => {
    const path = join(dir, "j.log");
    // Run 1: persist watermark at seq 1, then two more actions, then "crash"
    // (no further watermark advance — the debounce window).
    const j1 = createJournal(path);
    j1.append({ type: "add", payload: 1 }, 1);
    j1.setWatermark(1); // snapshot reflects n=... up to seq 1
    j1.append({ type: "add", payload: 10 }, 2);
    j1.append({ type: "add", payload: 100 }, 3);
    j1.close(); // SIGKILL — seq 2,3 never made it into a snapshot

    // Run 2 (boot): the restored snapshot reflects seq 1 (n=1 here); replay the
    // journal tail on top → exact pre-crash state.
    const j2 = createJournal(path);
    const snapshotAfterSeq1: S = { n: 1 };
    const recovered = replayJournal(
      snapshotAfterSeq1,
      j2.readSince(j2.watermark()),
      reduce,
    );
    assertEquals(recovered, { n: 111 }, "1 + 10 + 100");
  });
});

Deno.test("parseJournal: a torn final line (crash mid-write) is dropped", () => {
  const text = `{"seq":1,"type":"add","payload":1,"ts":0}
{"seq":2,"type":"add","payload":2,"ts":0}
{"seq":3,"type":"ad`; // torn write
  const entries = parseJournal(text);
  assertEquals(entries.map((e) => e.seq), [1, 2]);
});

Deno.test("journal: sync mode fsyncs each append (power-cut durability)", async () => {
  await withDir((dir) => {
    const j = createJournal(join(dir, "j.log"), { sync: true });
    j.append({ type: "add", payload: 1 }, 1);
    assertEquals(j.readSince(0).length, 1);
  });
});
