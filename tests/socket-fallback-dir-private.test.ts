// The >100-char UDS fallback places a CONTROL SOCKET in a shared `/tmp`.
//
// `lockDir()` already applies the rule this needs — create 0700, then LOOK,
// and refuse rather than place a control socket where another local account
// can reach it. The fallback in `resolveSocketPath` had only the first half:
// it mkdir'ed `/tmp/aio` and chmod'ed 0700 best-effort, and a chmod on a
// directory you do not own returns EPERM, so a pre-existing `/tmp/aio` owned
// by somebody else was used exactly as if the chmod had worked. Whoever
// connects to a control socket can dispatch methods into the app.
//
// One decider: the fallback asks `_chooseLockDir` the same question the lock
// directory asks. A test has one uid, so "somebody else's" is reproduced the
// way `lock-dir-private.test.ts` does it — a preferred path that exists and is
// not a directory reaches the same branch for the same reason.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { assertThrows } from "@std/assert";
import { resolveSocketPath } from "../src/server/paths.ts";
import { selfUid } from "../src/server/dir-permissions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const POSIX = Deno.build.os !== "windows";
// A name long enough that the socket path cannot fit in the lock dir — the
// only way into the fallback branch.
const LONG = "s".repeat(120);

Deno.test({
  name: "socket fallback: the directory is created 0700",
  ignore: !POSIX,
  fn: async () => {
    const base = await tempDir("aio-sockfb-ok-");
    try {
      const p = resolveSocketPath(LONG, undefined, "linux", base);
      assertEquals(p, `${base}/aio/${LONG}.sock`);
      assertEquals(Deno.statSync(`${base}/aio`).mode! & 0o777, 0o700);
    } finally {
      await dropTempDir(base);
    }
  },
});

Deno.test({
  name: "socket fallback: a directory that is not ours is never used",
  ignore: !POSIX || selfUid() === null,
  fn: async () => {
    const base = await tempDir("aio-sockfb-theirs-");
    try {
      // Unusable for a reason a test can create; the production case is
      // "another uid owns it", and both land on the same branch.
      await Deno.writeTextFile(`${base}/aio`, "not a directory");
      const p = resolveSocketPath(LONG, "http", "linux", base);
      assert(
        !p.startsWith(`${base}/aio/`),
        `placed a control socket in a directory it could not make private: ${p}`,
      );
      assertStringIncludes(p, `${base}/aio-u${selfUid()}/`);
      assert(p.endsWith(".http.sock"), p);
      assertEquals(
        Deno.statSync(`${base}/aio-u${selfUid()}`).mode! & 0o777,
        0o700,
      );
    } finally {
      await dropTempDir(base);
    }
  },
});

Deno.test({
  name: "socket fallback: with no private directory available it REFUSES",
  ignore: !POSIX || selfUid() === null,
  fn: async () => {
    const base = await tempDir("aio-sockfb-refuse-");
    try {
      await Deno.writeTextFile(`${base}/aio`, "not a directory");
      await Deno.writeTextFile(`${base}/aio-u${selfUid()}`, "nor is this");
      const e = assertThrows(
        () => resolveSocketPath(LONG, undefined, "linux", base),
        Error,
      );
      assertStringIncludes(e.message, "control socket");
      assertStringIncludes(e.message, `${base}/aio`);
    } finally {
      await dropTempDir(base);
    }
  },
});
