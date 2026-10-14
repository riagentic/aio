// The lock dir is judged by ONE look at its own entry.
//
// It was three steps, each resolving the path again: a chmod, an `lstat`
// ("whose link is it"), a `stat` ("what mode, whose"). On the host the rule
// exists for — no `$XDG_RUNTIME_DIR`, base `/tmp`, a name any local account
// can make first — that left two ways in:
//
// - the chmod FOLLOWS a link: `/tmp/aio` planted as a link to a directory of
//   ours was narrowed to 0700 before the link was refused (measured: a 0755
//   target came back 0700);
// - a real directory of theirs passes the `lstat`, is swapped for a link to a
//   0700 directory of ours, and the `stat` follows it and finds nothing wrong
//   — the app's mutex, records and control socket then sit behind a name
//   somebody else can re-point.
//
// A test has one uid, so "theirs" is handed in through the `lstat` seam, as
// lock-dir-private.test.ts does it. Modes are read under `permissiveUmask`.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { selfUid } from "../src/server/dir-permissions.ts";
import {
  _chooseLockDir,
  _lockDeps,
  _prepareLockDir,
  createInLockDir,
} from "../src/server/single-instance-lock.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { permissiveUmask } from "./permissive-umask.ts";

const POSIX = Deno.build.os !== "windows";
const UID = POSIX && selfUid() !== null;
const mode = (p: string) => Deno.statSync(p).mode! & 0o777;
const NotFound = Deno.errors.NotFound;

Deno.test({
  name: "lock dir: a planted link is refused WITHOUT its target being chmodded",
  ignore: !UID, // a link's owner and a POSIX mode
  fn: () =>
    permissiveUmask(async () => {
      const root = await tempDir("aio-one-look-");
      try {
        const target = join(root, "victim");
        Deno.mkdirSync(target);
        Deno.chmodSync(target, 0o755);
        const dir = join(root, "aio");
        Deno.symlinkSync(target, dir);
        let chmods = 0;
        const why = _prepareLockDir(dir, {
          lstat: (p) =>
            ({ ...Deno.lstatSync(p), uid: selfUid()! + 1 }) as Deno.FileInfo,
          chmod: (p, m) => {
            chmods++;
            Deno.chmodSync(p, m);
          },
        });
        assertStringIncludes(why ?? "", "symbolic link owned by uid");
        assertEquals(chmods, 0, "a chmod was made through somebody's link");
        assertEquals(mode(target), 0o755, "the link's target was narrowed");
      } finally {
        await dropTempDir(root);
      }
    }),
});

Deno.test({
  name:
    "lock dir: a directory swapped for a link after the look is not looked at again",
  ignore: !UID,
  fn: () =>
    permissiveUmask(async () => {
      const root = await tempDir("aio-one-look-swap-");
      try {
        const victim = join(root, "victim"); // ours, 0700: passes every check
        Deno.mkdirSync(victim, { mode: 0o700 });
        const dir = join(root, "aio");
        Deno.mkdirSync(dir, { mode: 0o700 });
        const why = _prepareLockDir(dir, {
          // THEIR directory at the look — and the swap right after it.
          lstat: (p) => {
            const theirs = { ...Deno.lstatSync(p), uid: selfUid()! + 1 };
            if (!theirs.isSymlink) {
              Deno.removeSync(p);
              Deno.symlinkSync(victim, p);
            }
            return theirs as Deno.FileInfo;
          },
        });
        assertStringIncludes(
          why ?? "",
          `owned by uid ${selfUid()! + 1}`,
          "the swapped-in link was followed to a directory of ours",
        );
      } finally {
        await dropTempDir(root);
      }
    }),
});

Deno.test({
  name:
    "lock dir: somebody else's directory is refused and never chmodded; ours is narrowed",
  ignore: !UID,
  fn: () =>
    permissiveUmask(async () => {
      const root = await tempDir("aio-one-look-chmod-");
      try {
        const dir = join(root, "aio");
        Deno.mkdirSync(dir);
        Deno.chmodSync(dir, 0o755);
        let chmods = 0;
        const chmod = (p: string, m: number) => {
          chmods++;
          Deno.chmodSync(p, m);
        };
        const why = _prepareLockDir(dir, {
          lstat: (p) =>
            ({ ...Deno.lstatSync(p), uid: selfUid()! + 1 }) as Deno.FileInfo,
          chmod,
        });
        assertStringIncludes(why ?? "", "mode 755");
        assertEquals(chmods, 0);
        assertEquals(mode(dir), 0o755);
        assertEquals(_prepareLockDir(dir, { chmod }), null);
        assertEquals([chmods, mode(dir)], [1, 0o700]);
      } finally {
        await dropTempDir(root);
      }
    }),
});

// What stays as it was: a link the user made themselves, and a link ABOVE
// the dir (macOS: `/tmp` is one, to `/private/tmp`).
Deno.test({
  name:
    "lock dir: a link of OURS is followed and its target judged; a link in the parent path is no link at all",
  ignore: !UID,
  fn: () =>
    permissiveUmask(async () => {
      const root = await tempDir("aio-one-look-own-");
      try {
        const target = join(root, "mine");
        Deno.mkdirSync(target);
        Deno.chmodSync(target, 0o755);
        const dir = join(root, "aio");
        Deno.symlinkSync(target, dir);
        assertEquals(_prepareLockDir(dir), null);
        assertEquals(
          mode(target),
          0o700,
          "our own target is narrowed, as ever",
        );
        assert(Deno.lstatSync(dir).isSymlink, "the link stays a link");
        // Its target is still judged: a FILE behind it is no lock dir.
        const file = join(root, "file");
        Deno.writeTextFileSync(file, "");
        const toFile = join(root, "aio-file");
        Deno.symlinkSync(file, toFile);
        assertStringIncludes(
          _prepareLockDir(toFile) ?? "",
          "is not a directory",
        );
        // The parent path goes through a link.
        const real = join(root, "private-tmp");
        Deno.mkdirSync(real);
        const tmp = join(root, "tmp");
        Deno.symlinkSync(real, tmp);
        const under = join(tmp, "aio");
        assertEquals(_prepareLockDir(under), null);
        assertEquals(mode(join(real, "aio")), 0o700);
        assertEquals(_chooseLockDir(tmp, "-x"), join(tmp, "aio-x"));
      } finally {
        await dropTempDir(root);
      }
    }),
});

// 1.0.19's retry had no pause and no end but the clock: a link of ours to
// nothing cost 2 000 ms and 102 653 `stat` calls (measured), at every start.
Deno.test({
  name: "lock dir: a link to nothing is refused at once, not waited for",
  ignore: !POSIX, // a link to a directory needs a privilege on Windows (a junction's target must exist)
  async fn() {
    const root = await tempDir("aio-one-look-dangling-");
    const real = { ..._lockDeps };
    try {
      const dir = join(root, "aio");
      Deno.symlinkSync(join(root, "nope", "x"), dir);
      let looks = 0;
      let pauses = 0;
      _lockDeps.pause = () => void pauses++;
      const why = _prepareLockDir(dir, {
        stat: (p) => {
          looks++;
          return Deno.statSync(p);
        },
      });
      assertStringIncludes(why ?? "", "symbolic link to nothing usable");
      assertEquals([looks, pauses], [1, 0], "one look, and no wait at all");
    } finally {
      Object.assign(_lockDeps, real);
      await dropTempDir(root);
    }
  },
});

// A dir that keeps being pruned at the look is made again WITH a pause (it
// ran hot), until the caller's own bound.
Deno.test({
  name:
    "lock dir: the wait for a pruned dir pauses, and ends at the bound given",
  async fn() {
    const root = await tempDir("aio-one-look-bound-");
    const real = { ..._lockDeps };
    try {
      const dir = join(root, "aio");
      // The clock is the test's (`_lockDeps`): what is counted is what was
      // DONE — every look but the last is followed by one 1 ms pause — and
      // no machine's load changes that.
      let clock = 5_000;
      const pauses: number[] = [];
      _lockDeps.now = () => clock;
      _lockDeps.pause = (ms) => {
        pauses.push(ms);
        clock += ms;
      };
      let looks = 0;
      const why = _prepareLockDir(dir, {
        lstat: (p) => {
          looks++;
          throw new NotFound(`No such file or directory: ${p}`);
        },
        until: clock + 300,
      });
      assertStringIncludes(why ?? "", "cannot be created or read");
      assertEquals(clock, 5_300, "it ended AT the bound given");
      assertEquals(pauses, Array(300).fill(1), "a pause before every look");
      assertEquals(looks, 301);
    } finally {
      Object.assign(_lockDeps, real);
      await dropTempDir(root);
    }
  },
});

// One START STEP waits once. A create in the lock dir had its own 2 s, and
// making the dir again inside it had another: a dir that went wrong late in
// the first wait cost a second one — about 4 s, with nothing said.
Deno.test({
  name:
    "create in the lock dir: making the dir again ends at the create's own bound, and the wait is said once",
  async fn() {
    const root = await tempDir("aio-one-look-deadline-");
    const dir = join(root, "locks");
    const path = join(dir, "a.sock");
    _lockDeps.chosen.add(dir);
    const real = { ..._lockDeps };
    const prev = getLogger();
    const warns: string[] = [];
    setLogger(
      {
        ...(prev ?? {}),
        pub: (lvl: string, _cat: string, msg: string) => {
          if (lvl === "warn") warns.push(msg);
        },
      } as unknown as Parameters<typeof setLogger>[0],
    );
    try {
      // The test's clock: a pause is the only thing that moves it, so the
      // time the step "took" is exact on any machine, and nothing waits.
      const t0 = 9_000;
      let clock = t0;
      _lockDeps.now = () => clock;
      _lockDeps.pause = (ms) => void (clock += ms);
      _lockDeps.saidSlow = false; // once a PROCESS: an earlier test may have
      // Late in the wait the dir stops being there at the look, for good.
      _lockDeps.lstat = (p) => {
        if (p === dir && clock - t0 > 1_700) {
          throw new NotFound(`No such file or directory: ${p}`);
        }
        return real.lstat(p);
      };
      let tries = 0;
      const e = assertThrows(() =>
        createInLockDir(path, () => {
          tries++;
          throw new NotFound("No such file or directory (os error 2)");
        })
      );
      // 2 000 ms from the create's first try — not that and 2 000 more.
      assertEquals(clock - t0, 2_000, "the dir's wait had a bound of its own");
      assertEquals(tries, 1_701, "one try per millisecond until the dir went");
      // The dir's refusal is what is said; the create's error is its cause.
      assert(e instanceof Error && /cannot be created or read/.test(e.message));
      assert((e as Error).cause instanceof NotFound, "the create's own error");
      assertEquals(
        warns.filter((w) => w.includes("waiting for the lock directory"))
          .length,
        1,
        warns.join("\n"),
      );
    } finally {
      Object.assign(_lockDeps, real);
      _lockDeps.chosen.delete(dir);
      if (prev) setLogger(prev);
      await dropTempDir(root);
    }
  },
});

// Deno has no `openat`: the dir is resolved to be judged and again by the
// create. A scoped dir is REMOVED by whoever leaves it empty, and in that gap
// the name is anybody's. So the entry is looked at again after the create.
Deno.test({
  name:
    "create in the lock dir: a dir replaced under the create is refused and what was made removed; one a sibling made again is kept",
  ignore: !UID,
  async fn() {
    const root = await tempDir("aio-one-look-after-");
    const dir = join(root, "locks");
    const path = join(dir, "watch-1.tmp");
    _lockDeps.chosen.add(dir);
    const real = { ..._lockDeps };
    const make = () => Deno.openSync(path, { createNew: true, write: true });
    try {
      // A sibling pruned it and made it again: another directory, still ours.
      createInLockDir(path, () => {
        Deno.removeSync(dir);
        Deno.mkdirSync(dir, { mode: 0o700 });
        return make();
      }).close();
      assert(Deno.statSync(path).isFile, "kept: the dir is ours as before");
      Deno.removeSync(path);
      // Replaced by SOMEBODY ELSE's: the look after the create says so.
      let created = false;
      let undone = 0;
      _lockDeps.lstat = (p) => {
        const at = real.lstat(p);
        return p === dir && created
          ? { ...at, ino: (at.ino ?? 0) + 1, uid: selfUid()! + 1 }
          : at;
      };
      const e = assertThrows(
        () =>
          createInLockDir(path, () => {
            const f = make();
            created = true;
            return f;
          }, (f) => {
            undone++;
            f.close();
          }),
        Error,
        "was replaced while",
      );
      assertStringIncludes(e.message, `owned by uid ${selfUid()! + 1}`);
      assertStringIncludes(e.message, path);
      assertEquals(undone, 1, "what was made is closed");
      assertThrows(
        () => Deno.statSync(path),
        NotFound,
        undefined,
        "and removed",
      );
    } finally {
      Object.assign(_lockDeps, real);
      _lockDeps.chosen.delete(dir);
      await dropTempDir(root);
    }
  },
});

// Windows has no mode or owner to read, so the dir is made and used — and
// "made" was not looked at: a dir that could not be made was answered "fine".
Deno.test("lock dir: on Windows a dir that cannot be made is refused, with its path", async () => {
  const root = await tempDir("aio-one-look-win-");
  const real = { ..._lockDeps };
  try {
    _lockDeps.windows = () => true;
    const file = join(root, "file");
    await Deno.writeTextFile(file, "");
    const under = join(file, "sub", "aio");
    const why = _prepareLockDir(under, { until: performance.now() + 200 });
    assertStringIncludes(why ?? "", `${under} cannot be created or read`);
    assertStringIncludes(_prepareLockDir(file) ?? "", "is not a directory");
    assertEquals(_prepareLockDir(join(root, "aio")), null);
  } finally {
    Object.assign(_lockDeps, real);
    await dropTempDir(root);
  }
});
