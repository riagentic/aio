// A journal file another process keeps open: the app stays usable, nothing
// acknowledged is lost, and the journal set aside on a hole is never deleted.
//
// The rename helper waits up to 1.3 s for a held file. The journal replaces
// its file on every persist, so a file held LONGER than that cost every
// persist another 1.3 s of blocked event loop — measured: 20 dispatches took
// 25 s. The helper now remembers a target that stayed held and fails fast on
// it; these tests pin what the journal does with that.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  _renameDeps,
  RENAME_BACKOFF_MS,
} from "../src/diagnostics/rename-over.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { createJournal } from "../src/server/journal.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const DENIED = (to: string) =>
  new Deno.errors.PermissionDenied(`Access is denied. (os error 5): ${to}`);

/** Run `fn` with renames onto a target matching `held()` refused. Returns
 *  the ms the helper blocked and the log lines (`level category message`). */
function withHeld<T>(
  o: { windows: boolean; held: (to: string) => boolean },
  fn: () => T,
): { out: T; blocked: number; said: string[] } {
  const real = { ..._renameDeps };
  const said: string[] = [];
  let blocked = 0;
  _renameDeps.reset();
  _renameDeps.windows = () => o.windows;
  _renameDeps.pause = (ms) => void (blocked += ms);
  _renameDeps.rename = (from, to) => {
    if (o.held(to)) throw DENIED(to);
    real.rename(from, to);
  };
  setLogger({
    pub: (lvl: string, cat: string, msg: string) =>
      void said.push(`${lvl} ${cat} ${msg}`),
  } as unknown as LogSink);
  try {
    return { out: fn(), blocked, said };
  } finally {
    Object.assign(_renameDeps, real);
    _renameDeps.reset();
    setLogger(null);
  }
}

const BOUND = RENAME_BACKOFF_MS.reduce((a, b) => a + b, 0);
const tmps = (dir: string) =>
  [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) =>
    n.endsWith(".tmp")
  );

Deno.test("journal held open for 20 persists: one bound of waiting, one warning, every entry still there", async () => {
  const dir = await tempDir("journal-held-");
  try {
    const path = join(dir, "actions.journal");
    const j = createJournal(path);
    let free = false;
    const r = withHeld(
      { windows: true, held: (to) => !free && to === path },
      () => {
        for (let seq = 1; seq <= 20; seq++) {
          j.append({ type: "counter:inc", payload: { args: [seq] } }, seq);
          // The store persisted everything but this entry: compaction wants
          // to rewrite the journal, and cannot.
          j.setWatermark(seq - 1);
        }
        const during = {
          tail: j.readSince(0).map((e) => e.seq),
          tmps: tmps(dir),
        };
        // The holder lets go: the next persist compacts.
        free = true;
        j.setWatermark(19);
        return during;
      },
    );
    assertEquals(r.blocked, BOUND, "ONE full wait for 20 failing persists");
    assertEquals(r.out.tail, Array.from({ length: 20 }, (_, i) => i + 1));
    assertEquals(r.out.tmps, [], "no temp file per failed persist");
    const compact = r.said.filter((l) => l.includes("could not compact"));
    assertEquals(compact.length, 1, r.said.join("\n"));
    assert(compact[0]!.startsWith("warn journal "), compact[0]);
    assertEquals(
      r.said.filter((l) => l.includes("replaced again after")).length,
      1,
      r.said.join("\n"),
    );
    assertEquals(j.readSince(0).map((e) => e.seq), [20]);
    j.close();
    assertEquals(createJournal(path).readSince(0).map((e) => e.seq), [20]);
  } finally {
    await dropTempDir(dir);
  }
});

// The base is written with the first entry, and again on every append until
// it lands. Held open, it failed without a word (the append itself works) and
// cost each append the full wait: measured, 20 dispatches took 50 s.
Deno.test("journal base held open for 20 appends: one bound of waiting, said once, written once it is free", async () => {
  const dir = await tempDir("journal-base-held-");
  try {
    const path = join(dir, "actions.journal");
    const base = `${path}.base`;
    const j = createJournal(path, { storedWatermark: 0 });
    let free = false;
    const r = withHeld(
      { windows: true, held: (to) => !free && to === base },
      () => {
        for (let seq = 1; seq <= 20; seq++) {
          j.append({ type: "counter:inc", payload: { args: [seq] } }, seq);
          j.setWatermark(seq - 1);
        }
        const during = j.readSince(0).map((e) => e.seq);
        free = true;
        j.append({ type: "counter:inc", payload: { args: [21] } }, 21);
        return during;
      },
    );
    assertEquals(r.blocked, BOUND, "ONE full wait for 20 failing appends");
    assertEquals(r.out, Array.from({ length: 20 }, (_, i) => i + 1));
    const warned = r.said.filter((l) => l.startsWith("warn "));
    assertEquals(warned.length, 1, r.said.join("\n"));
    assert(
      warned[0]!.startsWith(`warn journal could not write ${base} — `),
      warned[0],
    );
    assertEquals(
      r.said.filter((l) => l.includes("replaced again after")).length,
      1,
      r.said.join("\n"),
    );
    assertEquals(tmps(dir), []);
    assert(Deno.statSync(base).isFile);
    j.close();
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal quarantine: a move that fails leaves the journal and its base where they were", async () => {
  const dir = await tempDir("journal-quar-");
  try {
    const path = join(dir, "actions.journal");
    // As under an app: the store owns the watermark, so the journal keeps a
    // compaction base beside it.
    const j = createJournal(path, { storedWatermark: 0 });
    for (let seq = 1; seq <= 4; seq++) j.append({ type: "a" }, seq);
    j.setWatermark(2); // compacts, and records the base
    const base = `${path}.base`;
    const before = {
      journal: Deno.readTextFileSync(path),
      base: Deno.readTextFileSync(base),
    };
    const aside = join(dir, "actions.journal.hole");
    // The journal itself cannot be moved, then only its base cannot — on
    // POSIX (the error as it is) and on Windows (after the wait).
    for (const windows of [false, true]) {
      for (const stuck of [aside, `${aside}.base`]) {
        const r = withHeld(
          { windows, held: (to) => to === stuck },
          () => assertThrows(() => j.quarantine(aside)),
        );
        assert(String(r.out).includes("os error 5"), String(r.out));
        const kept = stuck === aside ? path : base;
        assert(
          (() => {
            try {
              return Deno.statSync(kept).isFile;
            } catch {
              return false;
            }
          })(),
          `${kept} was deleted by a failed move (windows=${windows})`,
        );
        // Put back whatever DID move, for the next round.
        if (stuck !== aside) Deno.renameSync(aside, path);
        assertEquals(Deno.readTextFileSync(path), before.journal);
        assertEquals(Deno.readTextFileSync(base), before.base);
      }
    }
    j.close();
  } finally {
    await dropTempDir(dir);
  }
});

// A journal that refuses its appends for a while (a program holding it): each
// refused append also tried to cut a torn tail, failed, and said so — once
// per append. Said once until a line lands again.
Deno.test("journal refused for 5 appends: the torn-tail note is said once, and again only after a line landed", async () => {
  const dir = await tempDir("journal-cut-once-");
  const said: string[] = [];
  setLogger({
    pub: (lvl: string, cat: string, msg: string) =>
      void said.push(`${lvl} ${cat} ${msg}`),
  } as unknown as LogSink);
  try {
    const path = join(dir, "actions.journal");
    const j = createJournal(path);
    j.append({ type: "c:inc", payload: { args: [0] } }, 1);
    // Unwritable AND unreadable: a directory where the file was.
    Deno.removeSync(path);
    Deno.mkdirSync(path);
    for (let seq = 2; seq <= 6; seq++) {
      assertThrows(() =>
        j.append({ type: "c:inc", payload: { args: [seq] } }, seq)
      );
    }
    const cut = () => said.filter((l) => l.includes("could not cut")).length;
    assertEquals(cut(), 1, said.join("\n"));
    // It frees; a line lands; a new episode is said again.
    Deno.removeSync(path);
    j.append({ type: "c:inc", payload: { args: [7] } }, 7);
    Deno.removeSync(path);
    Deno.mkdirSync(path);
    assertThrows(() => j.append({ type: "c:inc", payload: { args: [8] } }, 8));
    assertEquals(cut(), 2, said.join("\n"));
    j.close();
  } finally {
    setLogger(null);
    await dropTempDir(dir);
  }
});
