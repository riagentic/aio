// The journal's and the checkpoint's atomic rewrites (tmp → rename) used a
// FIXED tmp name with remove-then-write — no O_EXCL. Wherever the directory
// is writable by someone else (a `dbPath` in a shared dir), a symlink planted
// at `<file>.tmp` was followed: the journal's payloads written wherever it
// pointed. The tmp is now an unpredictable name the write must CREATE
// (`createNew`, owner-only), then renamed; a crash-path write that has to
// replace its file in place creates it the same way.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createJournal } from "../src/server/journal.ts";
import { createCheckpoint } from "../src/diagnostics/checkpoint.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const VICTIM = "victim — must never be written through a planted link";

async function withPlanted(
  names: string[],
  fn: (dir: string) => Promise<void> | void,
): Promise<void> {
  const dir = await tempDir("aio-tmp-symlink-");
  const outside = await tempDir("aio-tmp-symlink-victim-");
  try {
    const victim = join(outside, "victim");
    Deno.writeTextFileSync(victim, VICTIM);
    for (const n of names) Deno.symlinkSync(victim, join(dir, n));
    await fn(dir);
    assertEquals(
      Deno.readTextFileSync(victim),
      VICTIM,
      "the link was followed",
    );
    for (const n of names) {
      assert(
        Deno.lstatSync(join(dir, n)).isSymlink,
        `${n} was replaced or removed`,
      );
    }
  } finally {
    await dropTempDir(dir);
    await dropTempDir(outside);
  }
}

Deno.test("journal: compaction, its base and its watermark never follow a planted tmp symlink", async () => {
  if (Deno.build.os === "windows") return;
  await withPlanted(
    ["journal.tmp", "journal.base.tmp", "journal.wm.tmp"],
    (dir) => {
      const path = join(dir, "journal");
      const j = createJournal(path, {});
      j.append({ type: "c:a", payload: { args: ["secret"] } }, 1);
      j.append({ type: "c:b", payload: { args: ["secret"] } }, 2);
      j.setWatermark(1); // compaction + the legacy `.wm` side file
      j.close();
      assertEquals(Deno.statSync(path).mode! & 0o777, 0o600);
      assertEquals(Deno.statSync(path + ".wm").mode! & 0o777, 0o600);
      const stray = [...Deno.readDirSync(dir)].filter((e) =>
        e.isFile && e.name.includes(".tmp")
      );
      assertEquals(stray.map((e) => e.name), [], "no tmp left behind");
    },
  );
});

Deno.test("checkpoint: write, rewriteNow and the crash-path writeSync never follow a planted symlink", async () => {
  if (Deno.build.os === "windows") return;
  await withPlanted(["checkpoint.json.tmp"], async (dir) => {
    const cp = createCheckpoint(dir, 0);
    const data = (ts: number) => ({
      ts,
      state: { a: { n: ts } },
      recentActions: [],
      cells: {},
    });
    await cp.write(data(1));
    cp.rewriteNow(data(2));
    cp.writeSync(data(3));
    const file = join(dir, "checkpoint.json");
    assertEquals(JSON.parse(Deno.readTextFileSync(file)).ts, 3);
    assertEquals(Deno.statSync(file).mode! & 0o777, 0o600);
  });
});

// The names above are unpredictable, so a link planted at `<file>.tmp` is
// never where the write goes — which alone proves nothing about `createNew`.
// Here the name IS predicted (the UUID is pinned), a link waits at exactly
// that path, and the write must refuse to follow it.
const PINNED = "00000000-0000-4000-8000-000000000000";
async function withPinnedUuid(fn: () => Promise<void>): Promise<void> {
  const real = crypto.randomUUID;
  crypto.randomUUID = () => PINNED;
  try {
    await fn();
  } finally {
    crypto.randomUUID = real;
  }
}

Deno.test("journal: a link planted at the exact tmp name is refused, not followed", async () => {
  if (Deno.build.os === "windows") return;
  await withPinnedUuid(() =>
    withPlanted(
      [
        `journal.${PINNED}.tmp`,
        `journal.base.${PINNED}.tmp`,
        `journal.wm.${PINNED}.tmp`,
      ],
      (dir) => {
        const j = createJournal(join(dir, "journal"), {});
        j.append({ type: "c:a", payload: { args: ["secret"] } }, 1);
        j.append({ type: "c:b", payload: { args: ["secret"] } }, 2);
        try {
          j.setWatermark(1);
        } catch { /* refused — the point; withPlanted checks the victim */ }
        j.close();
        // The compaction was refused: the journal is still both lines.
        assertEquals(
          Deno.readTextFileSync(join(dir, "journal")).trim().split("\n")
            .length,
          2,
        );
      },
    )
  );
});

Deno.test("checkpoint: a link planted at the exact tmp name is refused, not followed", async () => {
  if (Deno.build.os === "windows") return;
  await withPinnedUuid(() =>
    withPlanted([`checkpoint.json.tmp.${PINNED}`], async (dir) => {
      const cp = createCheckpoint(dir, 0);
      const data = (ts: number) => ({
        ts,
        state: { a: { n: ts } },
        recentActions: [],
        cells: {},
      });
      for (
        const write of [
          () => cp.write(data(1)),
          () => cp.rewriteNow(data(2)),
        ]
      ) {
        try {
          await write();
        } catch { /* refused */ }
      }
      // Both refused: nothing was written anywhere, the checkpoint included.
      assert(
        ![...Deno.readDirSync(dir)].some((e) => e.name === "checkpoint.json"),
        "a checkpoint was written through the planted name",
      );
    })
  );
});

// A write that fails AFTER creating its tmp — a full disk, a file-size limit
// (`ulimit -f`): the create succeeded, the bytes did not all land. The tmp
// used to stay behind, one per compaction / checkpoint tick. Injected here:
// the write creates the file, then throws the way ENOSPC does.
async function withFailingTmpWrites(fn: () => Promise<void>): Promise<void> {
  const sync = Deno.writeTextFileSync;
  const async_ = Deno.writeTextFile;
  const fail = (path: string | URL) => {
    Deno.writeFileSync(path, new Uint8Array(0), { createNew: true });
    throw new Error("No space left on device (os error 28)");
  };
  const isTmp = (p: string | URL) => String(p).includes(".tmp");
  (Deno as { writeTextFileSync: unknown }).writeTextFileSync = (
    p: string | URL,
    d: string,
    o?: Deno.WriteFileOptions,
  ) => isTmp(p) ? fail(p) : sync(p, d, o);
  (Deno as { writeTextFile: unknown }).writeTextFile = (
    p: string | URL,
    d: string,
    o?: Deno.WriteFileOptions,
  ) => isTmp(p) ? Promise.resolve().then(() => fail(p)) : async_(p, d, o);
  try {
    await fn();
  } finally {
    (Deno as { writeTextFileSync: unknown }).writeTextFileSync = sync;
    (Deno as { writeTextFile: unknown }).writeTextFile = async_;
  }
}

const tmps = (dir: string) =>
  [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) =>
    n.includes(".tmp")
  );

Deno.test("journal: a compaction whose tmp write fails after creating it leaves no tmp behind", async () => {
  const dir = await tempDir("aio-tmp-failed-write-");
  try {
    const j = createJournal(join(dir, "journal"), {});
    j.append({ type: "c:a", payload: { args: [1] } }, 1);
    j.append({ type: "c:b", payload: { args: [2] } }, 2);
    await withFailingTmpWrites(() => {
      for (let i = 0; i < 3; i++) {
        try {
          j.setWatermark(1);
        } catch { /* refused — the point is what it leaves */ }
      }
      return Promise.resolve();
    });
    j.close();
    assertEquals(tmps(dir), []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("checkpoint: a write whose tmp fails after creating it leaves no tmp behind", async () => {
  const dir = await tempDir("aio-tmp-failed-write-");
  try {
    const cp = createCheckpoint(dir, 0);
    const data = (ts: number) => ({
      ts,
      state: { a: { n: ts } },
      recentActions: [],
      cells: {},
    });
    await withFailingTmpWrites(async () => {
      for (let i = 0; i < 3; i++) {
        await cp.write(data(i)).catch(() => {/* refused */});
        cp.rewriteNow(data(10 + i));
      }
    });
    assertEquals(tmps(dir), []);
  } finally {
    await dropTempDir(dir);
  }
});
