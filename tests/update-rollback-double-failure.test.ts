// update-rollback-double-failure.test.ts — a rollback that cannot finish must
// say WHERE every artifact is now, and which command puts one back.
//
// The flat layout has a moment with nothing at the stable path: the build that
// failed is moved to `<current>.failed-<ts>`, then the version that worked is
// renamed in. When that second rename fails, the put-back fails for the same
// reason more often than not — a mount gone read-only, an install directory
// locked down — and `restoreArtifact` used to rethrow the FIRST error alone: a
// message about a rename of `previous`, with the stable path empty and the
// aside copy named nowhere. The boot log then added its own account on top —
// "`current` still holds <to>" — which was simply false.
//
// Every failure here is the kernel's, never a stub's. The one seam is a hook
// on `Deno.rename` that flips the directory read-only at the chosen moment
// and then lets the REAL rename go ahead and be refused — the failure a user
// actually gets, at the point in the sequence where it does the most harm.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  MAX_BOOT_ATTEMPTS,
  readPending,
  restoreArtifact,
  writePending,
} from "../src/server/updates-apply.ts";
import { judgePendingUpdate } from "../src/server/updates-boot.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import {
  dropTempDir,
  keepTempDir,
  tempDir,
  tempDirSync,
} from "../src/testing/temp-dir.ts";

/** A read-only directory does not refuse root, and Windows has no mode bits
 *  to flip — the chmod-based cases are visibly ignored there, not faked. */
const NO_CHMOD = Deno.build.os === "windows" || Deno.uid() === 0;

/** `/dev/shm` is its own filesystem on Linux, so a rename from it is a REAL
 *  `EXDEV` — the single-failure case with no seam at all. */
const SHM = "/dev/shm";
const NO_XDEV = (() => {
  try {
    const shm = Deno.statSync(SHM);
    const tmp = Deno.statSync(
      tempDirSync("aio-xdev-probe-"),
    );
    return !shm.isDirectory || shm.dev === tmp.dev;
  } catch {
    return true; // no /dev/shm — the case is ignored, and says so
  }
})();

/** Run `fn` with `Deno.rename` wrapped: `before(from, to)` runs ahead of each
 *  REAL rename. Nothing is faked — the hook only changes what the filesystem
 *  will permit, and the kernel does the refusing. */
async function withRenameHook(
  before: (from: string, to: string) => void,
  fn: () => Promise<void>,
): Promise<void> {
  const D = Deno as unknown as { rename: typeof Deno.rename };
  const real = D.rename;
  D.rename = (from, to) => {
    before(String(from), String(to));
    return real.call(Deno, from, to);
  };
  try {
    await fn();
  } finally {
    D.rename = real;
  }
}

async function thrown(fn: () => Promise<void>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the rollback to throw — it reported success");
}

function recorder(): Log & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (...a: unknown[]) => {
    lines.push(`${level} ${a.map(String).join(" ")}`);
  };
  return {
    lines,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("debug"),
    trace: push("trace"),
  } as unknown as Log & { lines: string[] };
}

const names = (dir: string) =>
  [...Deno.readDirSync(dir)].map((e) => e.name).sort();

Deno.test({
  name:
    "rollback: both renames fail — the error names the aside copy, all three paths, and the mv that gets one back",
  ignore: NO_CHMOD,
  async fn() {
    const dir = await tempDir("aio-rollback-double-");
    const current = join(dir, "app");
    const previous = join(dir, "app.old-1.0.0");
    await Deno.writeTextFile(current, "v2-broken");
    await Deno.writeTextFile(previous, "v1-good");
    let err: Error;
    try {
      err = await thrown(() =>
        withRenameHook(
          // The instant the version that worked is about to go in, the
          // directory stops accepting writes — so that rename AND the put-back
          // of the failed build are both refused, for real.
          (from) => {
            if (from === previous) Deno.chmodSync(dir, 0o555);
          },
          () => restoreArtifact(current, previous),
        )
      );
    } finally {
      await Deno.chmod(dir, 0o755);
    }

    const left = names(dir);
    const asideName = left.find((n) => n.startsWith("app.failed-"));
    assert(asideName, `the failed build was moved aside — left: ${left}`);
    const aside = join(dir, asideName);

    // (a) all three paths, the honest state, and the recovery — one command
    //     for each of the two things the user might want back.
    assertStringIncludes(err.message, current);
    assertStringIncludes(err.message, previous);
    assertStringIncludes(err.message, aside);
    assertStringIncludes(err.message, `NOTHING is at ${current}`);
    assertStringIncludes(err.message, `mv ${aside} ${current}`);
    assertStringIncludes(err.message, `mv ${previous} ${current}`);
    // (b) the aside copy is intact, byte for byte.
    assertEquals(await Deno.readTextFile(aside), "v2-broken");
    // (c) nothing else was touched: the stable path is empty (as the message
    //     says), the version that worked is where it was, and nothing was
    //     deleted.
    assertEquals(left, [asideName, "app.old-1.0.0"]);
    assertEquals(await Deno.readTextFile(previous), "v1-good");
    await dropTempDir(dir);
  },
});

Deno.test({
  name:
    "rollback: the version that worked is on another filesystem — the failed build is put back and the error says so",
  ignore: NO_XDEV,
  async fn() {
    const dir = await tempDir("aio-rollback-xdev-");
    const far = keepTempDir(
      // This one must live on /dev/shm — another filesystem, so the rename is
      // aio-ok: a REAL EXDEV — and tempDir() has no `dir` option
      await Deno.makeTempDir({ dir: SHM, prefix: "aio-rollback-xdev-" }),
    );
    const current = join(dir, "app");
    const previous = join(far, "app.old-1.0.0");
    await Deno.writeTextFile(current, "v2-broken");
    await Deno.writeTextFile(previous, "v1-good");

    const err = await assertRejects(
      () => restoreArtifact(current, previous),
      Error,
    );
    assertStringIncludes(err.message, previous);
    assertStringIncludes(err.message, current);
    assertStringIncludes(err.message, "the build that failed was put back");
    assertStringIncludes(err.message, `mv ${previous} ${current}`);
    // The single-failure state: everything back where it started, no
    // `.failed-` copy left lying beside the app.
    assertEquals(await Deno.readTextFile(current), "v2-broken");
    assertEquals(await Deno.readTextFile(previous), "v1-good");
    assertEquals(names(dir), ["app"]);
    await dropTempDir(dir);
    await dropTempDir(far);
  },
});

/** The `run.sh` layout: the stable name is a link into `versions/`. `root` is
 *  resolved because `versionedInstall` compares REAL paths. */
async function versioned(): Promise<
  { root: string; link: string; v1: string; v2: string }
> {
  const root = await Deno.realPath(await tempDir("aio-rollback-versioned-"));
  const v1 = join(root, "versions", "1.0.0", "app");
  const v2 = join(root, "versions", "2.0.0", "app");
  await Deno.mkdir(join(root, "versions", "1.0.0"), { recursive: true });
  await Deno.mkdir(join(root, "versions", "2.0.0"), { recursive: true });
  await Deno.writeTextFile(v1, "v1-good");
  await Deno.writeTextFile(v2, "v2-broken");
  const link = join(root, "app");
  await Deno.symlink(v2, link);
  return { root, link, v1, v2 };
}

Deno.test("rollback (versioned): a `.rollback` that is not our symlink is named, never deleted, and nothing is changed", async () => {
  const { root, link, v1, v2 } = await versioned();
  // Something that is NOT the module's own leftover link wears the name it
  // needs. A non-empty directory cannot be removed non-recursively — and it
  // must not be removed recursively, because it is not ours.
  const inTheWay = `${link}.rollback`;
  await Deno.mkdir(inTheWay);
  await Deno.writeTextFile(join(inTheWay, "keep"), "not ours");

  const err = await assertRejects(() => restoreArtifact(link, v1), Error);
  assertStringIncludes(err.message, inTheWay);
  assertStringIncludes(err.message, "nothing was changed");
  assertStringIncludes(err.message, `still points at ${v2}`);
  assertStringIncludes(err.message, `rm -rf ${inTheWay}`);
  // And it IS unchanged: the link, the thing in the way, both versions.
  assertEquals(await Deno.realPath(link), v2);
  assertEquals(await Deno.readTextFile(join(inTheWay, "keep")), "not ours");
  assertEquals(await Deno.readTextFile(v1), "v1-good");
  assertEquals(await Deno.readTextFile(v2), "v2-broken");
  await dropTempDir(root);
});

Deno.test({
  name:
    "rollback (versioned): when re-pointing the link fails, the error says the link is unchanged and a `.rollback` link was left behind",
  ignore: NO_CHMOD,
  async fn() {
    const { root, link, v1, v2 } = await versioned();
    const tmpLink = `${link}.rollback`;
    let err: Error;
    try {
      err = await thrown(() =>
        withRenameHook(
          // The link was made; the directory goes read-only before it can be
          // moved into place.
          (from) => {
            if (from === tmpLink) Deno.chmodSync(root, 0o555);
          },
          () => restoreArtifact(link, v1),
        )
      );
    } finally {
      await Deno.chmod(root, 0o755);
    }
    assertStringIncludes(err.message, link);
    assertStringIncludes(err.message, `still points at ${v2}`);
    assertStringIncludes(err.message, `${tmpLink} → ${v1} was left behind`);
    // `ln -sfn`, not `mv`: on the electron-zip layout the target is a
    // directory, and `mv` would move the link INTO it.
    assertStringIncludes(err.message, `ln -sfn ${v1} ${link}`);
    assertEquals(await Deno.realPath(link), v2, "the stable link is unchanged");
    assert((await Deno.lstat(tmpLink)).isSymlink, "the leftover IS a link");
    assertEquals(await Deno.readLink(tmpLink), v1);
    assertEquals(await Deno.readTextFile(v1), "v1-good");
    assertEquals(await Deno.readTextFile(v2), "v2-broken");
    await dropTempDir(root);
  },
});

Deno.test({
  name:
    "boot: ROLLBACK FAILED carries restoreArtifact's account verbatim — the aside path and the mv reach the log and the marker",
  ignore: NO_CHMOD,
  async fn() {
    const dir = await tempDir("aio-rollback-boot-double-");
    const data = await tempDir("aio-rollback-boot-double-data-");
    const current = join(dir, "app");
    const previous = join(dir, "app.old-1.0.0");
    await Deno.writeTextFile(current, "v2-broken");
    await Deno.writeTextFile(previous, "v1-good");
    writePending(data, {
      from: "1.0.0",
      to: "2.0.0",
      previous,
      artifact: current,
      attempts: MAX_BOOT_ATTEMPTS,
      startedAt: "2026-09-04T00:00:00.000Z",
    });

    const log = recorder();
    let result: boolean | undefined;
    try {
      await withRenameHook(
        (from) => {
          if (from === previous) Deno.chmodSync(dir, 0o555);
        },
        async () => {
          result = await judgePendingUpdate(data, log);
        },
      );
    } finally {
      await Deno.chmod(dir, 0o755);
    }
    assertEquals(result, false, "the boot continues — never brick on top");

    const asideName = names(dir).find((n) => n.startsWith("app.failed-"));
    assert(asideName, "the failed build was moved aside");
    const aside = join(dir, asideName);
    const line = log.lines.find((l) =>
      l.startsWith("error") && l.includes("ROLLBACK FAILED")
    );
    assert(line, `it screams: ${log.lines.join(" | ")}`);
    // The human reads the WHOLE account: where the artifact went, and the
    // command — not a paraphrase that was true on a different day.
    assertStringIncludes(line, aside);
    assertStringIncludes(line, `mv ${aside} ${current}`);
    assertStringIncludes(line, `mv ${previous} ${current}`);
    assert(
      !line.includes(`${current} still holds`),
      `the stable path is EMPTY — the log must not claim otherwise: ${line}`,
    );
    // And the marker, which is what the NEXT boot reads back out loud.
    const kept = readPending(data);
    assert(kept?.rollbackFailed, "the marker records the failure");
    assertStringIncludes(kept.rollbackFailed, aside);
    await dropTempDir(dir);
    await dropTempDir(data);
  },
});
