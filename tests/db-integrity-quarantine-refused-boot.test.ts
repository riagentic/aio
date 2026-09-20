// A damaged database that cannot be moved aside refuses the boot — by name.
//
// `checkAndRecover` closes the damaged database before it moves it. When the
// move itself failed (the quarantine rename refused, or its record could not
// be written) it returned "unavailable" — the same word it uses for "nothing
// was checked" — and the boot took that as "use the handle you have": a
// handle the check had just CLOSED. The first query then failed as "this
// handle is CLOSED", reported as "persistence unavailable" with advice to turn
// on checkIntegrityOnBoot — which was on, and was what had found the damage.
// The boot now refuses at the site, saying the file is damaged, where it is,
// and why it could not be moved.
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("integrity: a damaged database whose quarantine fails refuses the boot, naming why", async () => {
  const dir = await tempDir("aio-quarantine-refused-");
  const appId = `quarantine-refused-${Deno.pid}`;
  const boot = (check: boolean) =>
    aio.run({
      cells: [cell("box", { state: { n: 0, pad: "" }, methods: {} })],
      appId,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      port: freePort(),
      appDir: dir,
      checkIntegrityOnBoot: check,
    });
  const rename = Deno.rename;
  try {
    const app = await boot(false);
    await app.close();
    const dbPath = join(dir, "data", "state.db");
    const bytes = await Deno.readFile(dbPath);
    bytes.fill(0x5a, 100, bytes.length);
    await Deno.writeFile(dbPath, bytes);

    // The quarantine rename is refused (a read-only mount, a Windows lock…).
    Deno.rename = ((from: string | URL, to: string | URL) =>
      String(to).includes(".corrupt-")
        ? Promise.reject(new Deno.errors.PermissionDenied("EACCES (injected)"))
        : rename(from, to)) as typeof Deno.rename;
    const err = await assertRejects(() =>
      boot(true)
    );
    const msg = String(err);
    assert(!msg.includes("handle is CLOSED"), msg);
    assertStringIncludes(msg, "EACCES (injected)");
    assertStringIncludes(msg, dbPath);
  } finally {
    Deno.rename = rename;
    await dropTempDir(dir);
  }
});
