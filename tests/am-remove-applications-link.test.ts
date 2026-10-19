// macOS: `run.sh` with AIO_APPLICATIONS_LINK=1 links the installed bundle
// into ~/Applications, where Launchpad lists it. `am remove` takes that link
// with the install — found by what it points at, never by its name, and
// listed FIRST, so no link is left to an install that is gone.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { installedFootprint } from "../src/am/am-cmd-remove.ts";
import { installedAppPaths } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// The footprint is computed for "darwin" on every host, so the links are made
// on every host — and Windows needs a link's type when its target is absent.
const DIR = { type: "dir" } as const;

Deno.test("am remove on macOS: the ~/Applications link into the install is part of it, first — a link elsewhere and a real bundle are not", async () => {
  const home = await tempDir("am-remove-applink-");
  try {
    const apps = join(home, "Applications");
    await Deno.mkdir(join(apps, "Mine.app"), { recursive: true });
    const ours = join(apps, "Demo App.app");
    await Deno.symlink(
      join(installedAppPaths("demo-applink").dir, "Demo App.app"),
      ours,
      DIR,
    );
    await Deno.symlink(
      join(home, "elsewhere.app"),
      join(apps, "Other.app"),
      DIR,
    );
    const env = (n: string) => n === "HOME" ? home : undefined;
    const darwin = await installedFootprint("demo-applink", "darwin", env);
    assertEquals(darwin[0], {
      path: ours,
      kind: "Applications link",
      parent: apps,
      present: true,
    });
    assertEquals(
      darwin.filter((f) => f.kind === "Applications link").length,
      1,
    );
    const linux = await installedFootprint("demo-applink", "linux", env);
    assert(!linux.some((f) => f.kind === "Applications link"));
    // The delete `am remove` runs takes the LINK, never what it points at.
    const target = join(home, "target.app");
    await Deno.mkdir(target);
    await Deno.writeTextFile(join(target, "kept"), "");
    await Deno.symlink(target, join(apps, "T.app"), DIR);
    await Deno.remove(join(apps, "T.app"), { recursive: true });
    assert(Deno.statSync(join(target, "kept")).isFile);
  } finally {
    await dropTempDir(home);
  }
});
