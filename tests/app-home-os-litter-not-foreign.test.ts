// A fresh app home holding only what a desktop drops into every folder it
// opens is still a fresh home, not another program's directory.
//
// `foreignAppHomeError` refuses a derived home that exists, is non-empty and
// holds none of aio's own entries. `mkdir ~/apps/notes`, one look at it in
// Finder, and the folder held `.DS_Store` — so the app's first boot was
// refused as "not an aio app's: it holds .DS_Store". Explorer (`Thumbs.db`,
// `desktop.ini`) and Dolphin (`.directory`) do the same.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { foreignAppHomeError } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("foreignAppHomeError: OS folder litter alone does not make a home foreign, and is not named beside real files", async () => {
  const dir = await tempDir("aio-home-litter-");
  try {
    const litter = [
      ".DS_Store",
      "._.DS_Store",
      ".localized",
      "Thumbs.db",
      "desktop.ini",
      "DESKTOP.INI",
      ".directory",
    ];
    for (const name of litter) {
      const home = join(dir, `one-${name.replace(/\W/g, "_")}`);
      await Deno.mkdir(home);
      await Deno.writeTextFile(join(home, name), "");
      assertEquals(foreignAppHomeError("notes", home), null, name);
    }
    const all = join(dir, "all");
    await Deno.mkdir(all);
    for (const name of litter.slice(0, 5)) {
      await Deno.writeTextFile(join(all, name), "");
    }
    assertEquals(foreignAppHomeError("notes", all), null, "all of it at once");

    // Still refused when a real file sits beside it — and the refusal names
    // the real file, not the litter.
    await Deno.writeTextFile(join(all, "authorized_keys"), "ssh-ed25519 AAAA");
    const refusal = foreignAppHomeError("notes", all);
    assert(refusal?.includes("it holds authorized_keys,"), refusal!);
    assert(!refusal!.includes(".DS_Store"), refusal!);
  } finally {
    await dropTempDir(dir);
  }
});
