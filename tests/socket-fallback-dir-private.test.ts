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
import { assertMatch, assertNotEquals, assertThrows } from "@std/assert";
import { _fallbackSocketName, resolveSocketPath } from "../src/server/paths.ts";
import { selfUid } from "../src/server/dir-permissions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { permissiveUmask } from "./permissive-umask.ts";

const POSIX = Deno.build.os !== "windows";
// A name long enough that the socket path cannot fit in the lock dir — the
// only way into the fallback branch.
const LONG = "s".repeat(120);

Deno.test({
  name: "socket fallback: the directory is created 0700",
  ignore: !POSIX,
  fn: () =>
    permissiveUmask(async () => {
      const base = await tempDir("aio-sockfb-ok-");
      try {
        const p = resolveSocketPath(LONG, undefined, "linux", base);
        assertMatch(p, new RegExp(`^${base}/aio/s{40}-[0-9a-f]{8}\\.sock$`));
        assertEquals(Deno.statSync(`${base}/aio`).mode! & 0o777, 0o700);
      } finally {
        await dropTempDir(base);
      }
    }),
});

Deno.test({
  name: "socket fallback: a directory that is not ours is never used",
  ignore: !POSIX || selfUid() === null,
  fn: () =>
    permissiveUmask(async () => {
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
    }),
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

// The fallback NAME was `<appId><suffix>` — so two instances of one appId
// (two homes, or two `AIO_APPS_DIR` scopes) shared `/tmp/aio/<appId>.sock`,
// and the second unlinked the first's live socket at bind. Any appId past
// ~13 characters under a scoped runtime dir lands here.
Deno.test("socket fallback name: hashes the whole intended path, fits the limit", () => {
  const a = _fallbackSocketName(
    LONG,
    "/run/aio-scopeA/" + LONG + ".sock",
    ".sock",
  );
  const b = _fallbackSocketName(
    LONG,
    "/run/aio-scopeB/" + LONG + ".sock",
    ".sock",
  );
  const h = _fallbackSocketName(
    LONG,
    "/run/aio-scopeA/" + LONG + "@0badf00d.sock",
    ".sock",
  );
  assertNotEquals(a, b, "two scopes, one name");
  assertNotEquals(a, h, "two homes, one name");
  assert(
    `/tmp/aio-u4294967295/${a.replace(".sock", ".http.sock")}`.length <= 100,
  );
});

Deno.test({
  name: "socket fallback: two AIO_APPS_DIR scopes of one appId get two sockets",
  ignore: !POSIX,
  fn: async () => {
    const base = await tempDir("aio-sockfb-2-");
    const prev = Deno.env.get("AIO_APPS_DIR");
    try {
      const at = (apps: string) => {
        Deno.env.set("AIO_APPS_DIR", `${base}/${apps}`);
        return resolveSocketPath(LONG, undefined, "linux", base);
      };
      const one = at("one");
      const two = at("two");
      assertNotEquals(one, two);
      assert(one.startsWith(`${base}/aio/`) && two.startsWith(`${base}/aio/`));
    } finally {
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
      await dropTempDir(base);
    }
  },
});
