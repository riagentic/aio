// `AIO_APPS_DIR` is one directory however it is spelled.
//
// The raw value was used as typed: `AIO_APPS_DIR=demo/../apps` reported
// `appsRoot()` as `…/demo/../apps` (the containment root `am remove --data`
// checks), and a relative `apps` gave a RELATIVE app home — "relative to
// whichever cwd asked". Everything keyed on the string then disagreed about one
// directory, which is how `am` failed to find an app a `..` spelling started.
import { assert, assertEquals } from "@std/assert";
import { isAbsolute, join } from "@std/path";
import { appHome, appsDirEnv, appsRoot } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("AIO_APPS_DIR: absolute, `..` and cwd-relative spellings of one directory resolve identically", async () => {
  const dir = await tempDir("aio-appsdir-norm-");
  const prevEnv = Deno.env.get("AIO_APPS_DIR");
  const prevCwd = Deno.cwd();
  try {
    await Deno.mkdir(join(dir, "demo"));
    await Deno.mkdir(join(dir, "apps"));
    const want = join(Deno.realPathSync(dir), "apps");
    Deno.chdir(Deno.realPathSync(dir));
    const seen: Record<string, [string, string]> = {};
    for (
      const spelling of [want, `${dir}/demo/../apps`, "apps", "demo/../apps"]
    ) {
      Deno.env.set("AIO_APPS_DIR", spelling);
      seen[spelling] = [appsRoot(), appHome("wallet")];
    }
    const results = Object.entries(seen);
    assertEquals(results.length, 4, "four distinct spellings");
    for (const [spelling, [root, home]] of results) {
      assert(isAbsolute(root), `${spelling} → ${root}`);
      assertEquals(
        Deno.realPathSync(root),
        want,
        `appsRoot for ${spelling}`,
      );
      assertEquals(root, appsDirEnv(), "one reader for the value");
      assertEquals(home, join(root, "wallet"), `appHome for ${spelling}`);
      assert(!root.includes(".."), `${spelling} kept its '..': ${root}`);
    }
    Deno.env.delete("AIO_APPS_DIR");
    assertEquals(appsDirEnv(), undefined);
  } finally {
    Deno.chdir(prevCwd);
    if (prevEnv === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prevEnv);
    await dropTempDir(dir);
  }
});
