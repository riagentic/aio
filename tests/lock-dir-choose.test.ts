// `_chooseLockDir` — THE answer to "where may this process put its lock files
// and control socket?", asked by the lock directory and by the long-path
// socket fallback alike (see socket-fallback-dir-private.test.ts).
//
// Three outcomes, each pinned: the shared `<base>/aio<scope>` when it can be
// made private; a uid-scoped sibling when it cannot (another account's
// directory — reproduced, as lock-dir-private.test.ts does, by a preferred
// path that is not a directory, which reaches the same branch); and a loud
// refusal when neither can, because a control socket placed hopefully is a
// socket another local user can dispatch through.
import { assertEquals, assertThrows } from "@std/assert";
import { _chooseLockDir } from "../src/server/single-instance-lock.ts";
import { selfUid } from "../src/server/dir-permissions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { permissiveUmask } from "./permissive-umask.ts";

const POSIX = Deno.build.os !== "windows";

Deno.test({
  name:
    "_chooseLockDir: the shared dir when private, the uid sibling when not, a refusal when neither",
  ignore: !POSIX || selfUid() === null,
  fn: () =>
    permissiveUmask(async () => {
      const base = await tempDir("aio-choose-lockdir-");
      try {
        const uid = selfUid()!;
        // 1. Fresh base: the shared directory, created 0700.
        assertEquals(_chooseLockDir(base, "-a"), `${base}/aio-a`);
        assertEquals(Deno.statSync(`${base}/aio-a`).mode! & 0o777, 0o700);

        // 2. The shared one is unusable: the uid-scoped sibling, also 0700.
        await Deno.writeTextFile(`${base}/aio-b`, "not a directory");
        assertEquals(_chooseLockDir(base, "-b"), `${base}/aio-u${uid}-b`);
        assertEquals(
          Deno.statSync(`${base}/aio-u${uid}-b`).mode! & 0o777,
          0o700,
        );

        // 3. Both unusable: refuse, never place the socket anyway.
        await Deno.writeTextFile(`${base}/aio-c`, "not a directory");
        await Deno.writeTextFile(`${base}/aio-u${uid}-c`, "not a directory");
        assertThrows(
          () => _chooseLockDir(base, "-c"),
          Error,
          "refusing to place a control socket",
        );
      } finally {
        await dropTempDir(base);
      }
    }),
});
