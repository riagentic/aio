// A shutdown removes ITS control credential, never the one beside it.
//
// Two instances of one data home (`singleton: false`, a documented dev shape)
// each mint `<data>/control.key` at boot — the second over the first. The
// first to stop then deleted the file outright, and `am` lost the credential
// of the instance still running ("no local control credential … restart").
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { controlKeyPath, mintControlKey } from "../src/server/app-key.ts";
import {
  armLocalControl,
  disarmLocalControl,
} from "../src/server/server-auth.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("control key: a stopping instance leaves another's credential alone", async () => {
  const prev = Deno.env.get("AIO_APPS_DIR");
  const dir = await tempDir("ctl-own-only-");
  Deno.env.set("AIO_APPS_DIR", dir);
  try {
    const appId = "ctl-own-only";
    armLocalControl({ appId });
    const path = controlKeyPath(appId);
    assert(Deno.readTextFileSync(path).trim().length === 64);
    // The second instance boots and mints over it.
    const other = mintControlKey(appId);
    assert(other.error === undefined, other.error);
    disarmLocalControl(appId); // the first one stops
    assertEquals(
      Deno.readTextFileSync(path).trim(),
      other.key,
      "the running instance's credential was deleted",
    );
    // Its own file, still its own: removed as before.
    armLocalControl({ appId });
    disarmLocalControl(appId);
    let gone = false;
    try {
      Deno.statSync(path);
    } catch {
      gone = true; // aio-ok: absence is the assertion
    }
    assert(gone, "its own credential survived its shutdown");
  } finally {
    disarmLocalControl();
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(dir);
  }
});
