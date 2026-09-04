// Compacting a journal that does not exist yet is DONE, not failed.
//
// `setWatermark` reads the journal to keep its unpersisted tail. A journal that
// has never been appended to has no file, so the read threw NotFound into the
// catch below it and warned:
//
//   journal  could not compact <path> — NotFound: No such file or directory.
//   Nothing is replayed twice (the watermark decides that), but the file keeps
//   growing until this succeeds.
//
// …about a file that does not exist and is not growing. Measured on a fresh
// `journal: true` app: TWICE on the first boot, before any action was
// dispatched — so a developer's first sight of the feature was a durability
// warning about data they did not have.
//
// A warning that fires when nothing is wrong is how the ones that matter come
// to be ignored, and this one lives in the durability path: the SAME message,
// on a journal that really cannot be compacted, is the one that must be read.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createJournal } from "../src/server/journal.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

function capture() {
  const warns: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") warns.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  return { warns, restore: () => setLogger(prev) };
}

Deno.test("journal: a watermark before the first append says nothing", async () => {
  const dir = await tempDir("aio-journal-nothing-");
  const { warns, restore } = capture();
  try {
    const path = join(dir, "actions.journal");
    const j = createJournal(path);
    // The shape of a first boot: persistence reports a snapshot before any
    // action has been journaled.
    j.setWatermark(0);
    j.setWatermark(7);
    assertEquals(warns, [], "nothing to compact is not a failure");
    // …and it must not CREATE the journal either: an empty file where there
    // was none is a change of state, not a compaction. (The `.wm` watermark
    // beside it IS written — that is the point of `setWatermark`, and outside
    // an app it has nowhere else to live.)
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) =>
        !n.endsWith(".wm")
      ),
      [],
    );
    j.close();
  } finally {
    restore();
    await dropTempDir(dir);
  }
});

Deno.test("journal: a compaction that really fails is still loud", async () => {
  const dir = await tempDir("aio-journal-unwritable-");
  const { warns, restore } = capture();
  try {
    const path = join(dir, "actions.journal");
    const j = createJournal(path);
    j.append({ type: "c:m", payload: { n: 1 } }, 1);
    j.append({ type: "c:m", payload: { n: 2 } }, 2);
    // Take the directory's write permission away: the tmp file cannot be
    // written, so compaction genuinely cannot happen.
    if (Deno.build.os !== "windows") {
      Deno.chmodSync(dir, 0o500);
      try {
        j.setWatermark(1);
        assertEquals(warns.length, 1, `expected one warning: ${warns}`);
        assertStringIncludes(warns[0]!, "could not compact");
        assert(
          warns[0]!.includes(path),
          "the warning must name the journal it could not compact",
        );
      } finally {
        Deno.chmodSync(dir, 0o700);
      }
    }
    j.close();
  } finally {
    restore();
    await dropTempDir(dir);
  }
});

// ── and `am replay` explains an empty journal, rather than restating it ──
//
// The journal is the crash-recovery TAIL: every snapshot compacts away
// everything at or below the watermark, so a healthy app's live journal is
// empty nearly all the time. `am replay` against one therefore answers "no
// journal entries in range" every time — accurate, and it taught nothing about
// why, or where a journal worth replaying comes from.
Deno.test("am replay: an empty journal says why, and where to get a full one", async () => {
  const dir = await tempDir("aio-replay-empty-");
  try {
    const path = join(dir, "journal");
    await Deno.writeTextFile(path, "");
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "src/am.ts",
        "--json",
        "replay",
        "0..9",
        "--dry",
        `--from=${path}`,
      ],
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assert(r.code !== 0, `an empty journal must not report success: ${out}`);
    assertStringIncludes(out, "is empty");
    assertStringIncludes(out, "NOT yet in a snapshot");
    assertStringIncludes(out, "--from=");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am replay: a range with no rows names the range that HAS them", async () => {
  const dir = await tempDir("aio-replay-range-");
  try {
    const path = join(dir, "journal");
    await Deno.writeTextFile(
      path,
      [
        JSON.stringify({ seq: 4, ts: 1, type: "c:m", payload: {} }),
        JSON.stringify({ seq: 5, ts: 2, type: "c:m", payload: {} }),
      ].join("\n") + "\n",
    );
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "src/am.ts",
        "--json",
        "replay",
        "100..200",
        "--dry",
        `--from=${path}`,
      ],
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assert(r.code !== 0);
    assertStringIncludes(out, "2 entries");
    assertStringIncludes(out, "seq 4 to 5");
  } finally {
    await dropTempDir(dir);
  }
});
