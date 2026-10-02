// Two file replaces used to fail without a word: `meta.json` at boot, and the
// log rotation at start. Both now go through the shared rename helper (which
// waits out a Windows process holding the file) and, when the rename still
// fails, say so — without ever failing the boot.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { _renameDeps } from "../src/diagnostics/rename-over.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { rotateFile } from "../src/diagnostics/logger-rotate.ts";
import { appDirs, writeAppMeta } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** Run `fn` with every rename refused by `err()`; returns the log lines. */
async function refused<T>(
  err: () => Error,
  fn: () => T | Promise<T>,
): Promise<{ out: T; said: string[] }> {
  const real = { ..._renameDeps };
  const said: string[] = [];
  _renameDeps.rename = () => {
    throw err();
  };
  _renameDeps.renameAsync = () => Promise.reject(err());
  setLogger({
    pub: (lvl: string, cat: string, msg: string) =>
      void said.push(`${lvl} ${cat} ${msg}`),
  } as unknown as LogSink);
  try {
    return { out: await fn(), said };
  } finally {
    Object.assign(_renameDeps, real);
    setLogger(null);
  }
}

const DENIED = () => new Deno.errors.PermissionDenied("planted (os error 13)");

Deno.test("meta.json: a write that cannot land is a warning — never a throw, never a tmp left", async () => {
  const dir = await tempDir("meta-loud-");
  try {
    const dirs = appDirs("meta-loud", dir);
    Deno.mkdirSync(dirs.data, { recursive: true });
    const info = { appId: "meta-loud", aio: "1.0.0" };
    const r = await refused(DENIED, () => writeAppMeta(dirs, info));
    assertEquals(r.said.length, 1, r.said.join("\n"));
    assertStringIncludes(r.said[0]!, "warn meta ");
    assertStringIncludes(r.said[0]!, dirs.meta);
    assertStringIncludes(r.said[0]!, "planted (os error 13)");
    assertEquals([...Deno.readDirSync(dirs.data)].map((e) => e.name), []);

    // …and when it lands, nothing is said.
    const ok = await refused(DENIED, () => {
      _renameDeps.rename = (from, to) => Deno.renameSync(from, to);
      writeAppMeta(dirs, info);
    });
    assertEquals(ok.said, []);
    assertEquals(
      JSON.parse(Deno.readTextFileSync(dirs.meta)).appId,
      "meta-loud",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("log rotation: an archive that cannot be moved is said; one that is not there is not", async () => {
  const dir = await tempDir("rot-loud-");
  try {
    const base = join(dir, "app.log");
    await Deno.writeTextFile(base, "the previous run\n");
    await Deno.writeTextFile(`${base}.1`, "older\n");
    const warned: string[] = [];
    const r = await refused(
      DENIED,
      () => rotateFile(base, 7, (m) => void warned.push(m)),
    );
    assertEquals(r.out, false, "nothing was archived");
    assertEquals(warned.length, 2, warned.join("\n")); // `.1` and the live file
    assertStringIncludes(warned[1]!, `${base} was not archived`);
    assertStringIncludes(warned[1]!, "planted (os error 13)");
    assertEquals(await Deno.readTextFile(base), "the previous run\n");
    assertEquals(await Deno.readTextFile(`${base}.1`), "older\n");

    // Without a callback the warning goes to the log, with a level.
    const viaLog = await refused(DENIED, () => rotateFile(base, 7));
    assert(
      viaLog.said.every((l) => l.startsWith("warn logger ")) &&
        viaLog.said.length === 2,
      viaLog.said.join("\n"),
    );

    // A file that vanished between the look and the move is not a failure.
    const gone = await refused(
      () => new Deno.errors.NotFound("gone"),
      () => rotateFile(base, 7, (m) => void warned.push(m)),
    );
    assertEquals(gone.out, false);
    assertEquals(warned.length, 2, "NotFound must not warn");
  } finally {
    await dropTempDir(dir);
  }
});
