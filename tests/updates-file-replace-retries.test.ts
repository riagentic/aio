// Every file an update replaces goes through the rename that waits.
//
// On Windows a rename fails with "access denied" for as long as another
// process has the file open — and a scanner opens exactly the files an update
// has just written: the trust store, the rollback record, the first-boot
// token, the downloaded artifact. One refused rename there was a lost pin, a
// swap with no way back, or a verified download thrown away. Each site is
// driven here with a rename that is refused ONCE, as if on Windows; the site
// must end with the file in place, and the refusal must have been seen by the
// shared helper (a site that renames on its own never meets it).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { sha256Hex } from "../src/build/ship.ts";
import { _renameDeps } from "../src/diagnostics/rename-over.ts";
import {
  firstBootPath,
  pendingPath,
  readPending,
  swapArtifact,
  swapDirectoryDetached,
  writePending,
} from "../src/server/updates-apply.ts";
import {
  downloadArtifact,
  readTrust,
  writeTrust,
} from "../src/server/updates-check.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** Run `fn` as if on Windows, with the first rename INTO a path ending in
 *  `into` refused the way a held-open file is. Returns how many renames were
 *  refused: 1 when the site went through the helper, 0 when it did not. */
async function heldOnce(
  into: string,
  fn: () => unknown,
): Promise<number> {
  const real = { ..._renameDeps };
  let refused = 0;
  const refuse = (to: string) => {
    if (!to.endsWith(into) || refused > 0) return;
    refused++;
    throw new Deno.errors.PermissionDenied(
      "Access is denied. (os error 5): rename",
    );
  };
  _renameDeps.windows = () => true;
  _renameDeps.pause = () => {};
  _renameDeps.sleep = () => Promise.resolve();
  _renameDeps.debug = () => {};
  _renameDeps.rename = (from, to) => (refuse(to), real.rename(from, to));
  _renameDeps.renameAsync = (from, to) => {
    refuse(to);
    return real.renameAsync(from, to);
  };
  try {
    await fn();
    return refused;
  } finally {
    Object.assign(_renameDeps, real);
  }
}

const PENDING = {
  from: "1.0.0",
  to: "2.0.0",
  artifact: "/nonexistent-aio-test/app",
  previous: "/nonexistent-aio-test/app.old-1.0.0",
  attempts: 0,
  startedAt: "2026-01-01T00:00:00.000Z",
};

Deno.test("updates: the trust store is written through a held-open moment", async () => {
  const dir = await tempDir("aio-upd-held-");
  try {
    const refused = await heldOnce(
      "update-trust.json",
      () => writeTrust(dir, { etag: '"abc"' }),
    );
    assertEquals(refused, 1);
    assertEquals(readTrust(dir).etag, '"abc"');
    assertEquals([...Deno.readDirSync(dir)].length, 1, "no tmp left behind");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("updates: the rollback record is written through a held-open moment", async () => {
  const dir = await tempDir("aio-upd-held-");
  try {
    const refused = await heldOnce(
      "update-pending.json",
      () => writePending(dir, PENDING),
    );
    assertEquals(refused, 1);
    assertEquals(readPending(dir)?.to, "2.0.0");
    assertEquals([...Deno.readDirSync(dir)].length, 1, "no tmp left behind");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("updates: the first-boot token is written through a held-open moment", async () => {
  const dir = await tempDir("aio-upd-held-");
  try {
    const data = join(dir, "data");
    await Deno.mkdir(data);
    const current = join(dir, "app"), staged = join(dir, "app.staged-2.0.0");
    await Deno.mkdir(current);
    await Deno.mkdir(staged);
    const token = firstBootPath(data);
    const refused = await heldOnce(token, () =>
      swapDirectoryDetached({
        current,
        staged,
        fromVersion: "1.0.0",
        pending: { dataDir: data, from: "1.0.0", to: "2.0.0" },
        // Nothing is spawned: the helper script it wrote goes too.
        spawn: (_c, args) =>
          Deno.build.os !== "windows" && Deno.removeSync(args[0]!),
      }));
    assertEquals(refused, 1);
    assertEquals(
      await Deno.readTextFile(token),
      await Deno.readTextFile(pendingPath(data)),
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("updates: a verified download reaches its name through a held-open moment", async () => {
  const dir = await tempDir("aio-upd-held-");
  const body = new TextEncoder().encode("ARTIFACT-".repeat(500));
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(body.buffer as ArrayBuffer),
  );
  try {
    const dest = join(dir, "app.new-2.0.0");
    let got: Awaited<ReturnType<typeof downloadArtifact>> | undefined;
    const refused = await heldOnce(dest, async () => {
      got = await downloadArtifact({
        url: `http://127.0.0.1:${port}/app`,
        dest,
        expectSha256: await sha256Hex(body),
        expectSize: body.length,
      });
    });
    assert(got?.ok, got && !got.ok ? got.error : "no result");
    assertEquals(refused, 1);
    assertEquals((await Deno.readFile(dest)).length, body.length);
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});

for (const strategy of ["rename-self-aside", "rename-over"] as const) {
  Deno.test(`updates: the new build moves in through a held-open moment (${strategy})`, async () => {
    const dir = await tempDir("aio-upd-held-");
    try {
      const current = join(dir, "app.exe"), staged = join(dir, "app.new");
      await Deno.writeTextFile(current, "v1");
      await Deno.writeTextFile(staged, "v2");
      let previous = "";
      const refused = await heldOnce(current, async () => {
        ({ previous } = await swapArtifact({
          current,
          staged,
          fromVersion: "1.0.0",
          strategy,
          smoke: false,
        }));
      });
      assertEquals(refused, 1);
      assertEquals(await Deno.readTextFile(current), "v2");
      assertEquals(await Deno.readTextFile(previous), "v1");
    } finally {
      await dropTempDir(dir);
    }
  });
}

Deno.test({
  name:
    "updates: the new build moves into a versioned install through a held-open moment",
  ignore: Deno.build.os === "windows", // the layout is a symlink
  fn: async () => {
    const dir = await tempDir("aio-upd-held-");
    try {
      const v1 = join(dir, "versions", "1.0.0", "notes");
      await Deno.mkdir(join(dir, "versions", "1.0.0"), { recursive: true });
      await Deno.writeTextFile(v1, "v1");
      const link = join(dir, "notes");
      await Deno.symlink(v1, link);
      const staged = join(dir, "notes.new");
      await Deno.writeTextFile(staged, "v2");
      const v2 = join("versions", "2.0.0", "notes");
      const refused = await heldOnce(v2, () =>
        swapArtifact({
          current: link,
          staged,
          fromVersion: "1.0.0",
          toVersion: "2.0.0",
          smoke: false,
        }));
      assertEquals(refused, 1);
      assertEquals(await Deno.readTextFile(link), "v2");
      assertEquals(await Deno.readTextFile(v1), "v1");
    } finally {
      await dropTempDir(dir);
    }
  },
});
