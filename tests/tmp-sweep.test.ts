// A crash between an atomic rewrite's write and its rename leaves its tmp
// behind, and the tmp names are random (a fixed one could be pre-planted as
// a symlink) — so without a sweep, every crash left one more (measured: 50
// SIGKILLs, 50 orphans). Each owner sweeps its own at open, and ONLY its own:
// the exact tmp pattern next to a file it owns, a regular file (a symlink is
// never touched or followed), owned by this user, older than this process.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { purgeDisabledArtifacts } from "../src/diagnostics/mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const U = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const OLD = new Date(Date.now() - 3_600_000);
const NEW = new Date(Date.now() + 3_600_000); // written after this boot

function plant(dir: string, name: string, when: Date): void {
  Deno.writeTextFileSync(join(dir, name), "x");
  Deno.utimeSync(join(dir, name), when, when);
}
/** Open the owner in a FRESH process: everything planted here is older than
 *  it — the planted symlinks included (their own mtime cannot be set back). */
async function openInChild(code: string, dir: string): Promise<void> {
  const src = `
    import { createJournal } from ${
    JSON.stringify(new URL("../src/server/journal.ts", import.meta.url).href)
  };
    import { createCheckpoint } from ${
    JSON.stringify(
      new URL("../src/diagnostics/checkpoint.ts", import.meta.url).href,
    )
  };
    const dir = ${JSON.stringify(dir)};
    ${code}
  `;
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--config",
      new URL("../deno.json", import.meta.url).pathname,
      src,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}
const names = (dir: string) =>
  [...Deno.readDirSync(dir)].map((e) => e.name).sort();

async function withDirs(
  fn: (dir: string, victim: string) => void | Promise<void>,
) {
  const dir = await tempDir("aio-tmp-sweep-");
  const outside = await tempDir("aio-tmp-sweep-victim-");
  try {
    const victim = join(outside, "victim");
    Deno.writeTextFileSync(victim, "keep");
    await fn(dir, victim);
    assertEquals(Deno.readTextFileSync(victim), "keep");
  } finally {
    await dropTempDir(dir);
    await dropTempDir(outside);
  }
}

Deno.test("tmp sweep: the journal clears its own crash leftovers — nothing else", async () => {
  if (Deno.build.os === "windows") return;
  await withDirs(async (dir, victim) => {
    for (
      const n of [
        `journal.${U}.tmp`,
        `journal.base.${U}.tmp`,
        `journal.wm.${U}.tmp`,
        "journal.tmp",
        "journal.wm.tmp",
      ]
    ) {
      plant(dir, n, OLD);
    }
    plant(dir, `journal.${U.replace("0f", "1a")}.tmp`, NEW); // a live writer's
    for (
      const n of [
        "journal.notes.tmp",
        `other.${U}.tmp`,
        `journal.${U}.tmp.bak`,
        "journal.tmpx",
      ]
    ) {
      plant(dir, n, OLD); // not ours
    }
    Deno.symlinkSync(victim, join(dir, `journal.${U.replace("0f", "2b")}.tmp`));
    await openInChild(`createJournal(dir + "/journal", {}).close();`, dir);
    assertEquals(
      names(dir),
      [
        `journal.${U.replace("0f", "1a")}.tmp`,
        `journal.${U.replace("0f", "2b")}.tmp`,
        `journal.${U}.tmp.bak`,
        "journal.notes.tmp",
        "journal.tmpx",
        `other.${U}.tmp`,
      ].sort(),
    );
  });
});

Deno.test("tmp sweep: the checkpoint clears its own crash leftovers, and a disabled checkpoint's purge takes them too", async () => {
  if (Deno.build.os === "windows") return;
  await withDirs(async (dir, victim) => {
    plant(dir, `checkpoint.json.tmp.${U}`, OLD);
    plant(dir, "checkpoint.json.tmp", OLD);
    plant(dir, `checkpoint.json.tmp.${U.replace("0f", "1a")}`, NEW);
    plant(dir, "checkpoint.json.tmpx", OLD);
    Deno.symlinkSync(
      victim,
      join(dir, `checkpoint.json.tmp.${U.replace("0f", "2b")}`),
    );
    await openInChild(`createCheckpoint(dir, 0);`, dir);
    assertEquals(
      names(dir),
      [
        `checkpoint.json.tmp.${U.replace("0f", "1a")}`,
        `checkpoint.json.tmp.${U.replace("0f", "2b")}`,
        "checkpoint.json.tmpx",
      ].sort(),
    );
    plant(dir, `checkpoint.json.tmp.${U}`, OLD);
    const removed = purgeDisabledArtifacts(dir, {
      actionLog: true,
      checkpoint: false,
    });
    assertEquals(
      removed.includes(`checkpoint.json.tmp.${U}`),
      true,
      removed.join(),
    );
    assertEquals(names(dir).includes(`checkpoint.json.tmp.${U}`), false);
  });
});
