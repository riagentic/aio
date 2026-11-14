// Two scaffolds that were born unable to do what they were made for, both
// fixed in `adjustScaffoldConfig` (am-cmd-create.ts):
//
// 1. `am create x --aio-version=<older tag>` wrote THIS am's templates against
//    the pin's framework. Pinned to v1.0.20-beta, deno.json carried
//    `build.electronRuntime`, which that aiol rejects — the brand-new app's
//    `deno task lint` failed on a file nobody had touched. The keys the pin
//    does not know are now left out, and said.
// 2. `am create 3d-viewer --client=android` derived `app.aio.3dviewer`, which
//    Android rejects (a segment must start with a letter), so the scaffold's
//    own build and `dev:android` refused after the long server build. A valid
//    `android.applicationId` is now written, and said.
import "./store-sandbox.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  adjustScaffoldConfig,
  cmdCreate,
  scaffold,
} from "../src/am/am-cmd-create.ts";
import { androidApplicationId, apkLabel } from "../src/build/build-android.ts";
import { slugify } from "../src/build/build-helpers.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url)).replace(/[\\/]$/, "");

/** A framework tree whose config.ts knows only `keys` — an older release. */
async function olderTree(dir: string, keys: string[]): Promise<string> {
  await Deno.mkdir(join(dir, "src", "server"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "src", "server", "config.ts"),
    `export const VALID_BUILD_KEYS = new Set<string>([\n${
      keys.map((k) => `  "${k}",`).join("\n")
    }\n]);\n`,
  );
  return dir;
}

Deno.test("adjustScaffoldConfig: build.* keys the pinned framework does not know are left out, and said", async () => {
  const dir = await tempDir("aio-create-oldpin-");
  try {
    const fw = await olderTree(dir, [
      "targets",
      "platforms",
      "out",
      "strictPin",
    ]);
    const files = scaffold("oldpin", "counter", true, "browser");
    assert("electronRuntime" in JSON.parse(files["deno.json"]!).build);
    const notes = await adjustScaffoldConfig(
      files,
      "oldpin",
      "browser",
      fw,
      "v1.0.20-beta",
    );
    const build = JSON.parse(files["deno.json"]!).build;
    assertEquals(Object.keys(build).sort(), [
      "out",
      "platforms",
      "strictPin",
      "targets",
    ]);
    assertEquals(notes.length, 1, notes.join("\n"));
    assertStringIncludes(notes[0]!, "build.electronRuntime");
    assertStringIncludes(notes[0]!, "v1.0.20-beta");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("adjustScaffoldConfig: this checkout knows every key its own templates write", async () => {
  for (const t of ["counter", "cli"] as const) {
    const files = scaffold("cur", t, true, "browser");
    const before = files["deno.json"];
    assertEquals(
      await adjustScaffoldConfig(files, "cur", "browser", ROOT, "path:x"),
      [],
    );
    assertEquals(files["deno.json"], before, "an untouched file is untouched");
  }
});

Deno.test("adjustScaffoldConfig: a digit-leading android app gets an applicationId its build accepts", async () => {
  const files = scaffold("3d-viewer", "counter", true, "android");
  const notes = await adjustScaffoldConfig(
    files,
    "3d-viewer",
    "android",
    ROOT,
    "path:x",
  );
  const cfg = JSON.parse(files["deno.json"]!);
  assertEquals(cfg.android.applicationId, "app.aio.a3dviewer");
  assertEquals(cfg.android.colorScheme, "system", "the rest of android{} kept");
  assertEquals(notes.length, 1);
  assertStringIncludes(notes[0]!, "app.aio.a3dviewer");
  // Every label the build derives from this title accepts it.
  for (const doRemote of [false, true]) {
    const label = apkLabel({ binaryName: slugify(cfg.title), doRemote });
    assert(androidApplicationId(label, cfg.android.applicationId) !== null);
  }
  // A letter-leading android app, and a digit-leading browser app: untouched.
  for (
    const [n, t] of [["viewer", "android"], ["3d-viewer", "browser"]] as const
  ) {
    const f = scaffold(n, "counter", true, t);
    assertEquals(await adjustScaffoldConfig(f, n, t, ROOT, "path:x"), []);
    assertEquals(JSON.parse(f["deno.json"]!).android?.applicationId, undefined);
  }
});

Deno.test("am create 3d-viewer --client=android: the scaffold's deno.json can name its APK", async () => {
  const cwd = await tempDir("aio-create-andr-");
  const apps = await tempDir("aio-create-andr-apps-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  const orig = Deno.cwd();
  const lines: string[] = [];
  const real = console.log;
  try {
    Deno.env.set("AIO_APPS_DIR", apps);
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    Deno.chdir(cwd);
    await cmdCreate(
      ["3d-viewer", "--client=android", `--mirror=${ROOT}`],
      { json: true } as GlobalFlags,
    );
    console.log = real;
    const report = JSON.parse(lines.at(-1)!) as { adjusted: string[] };
    assertStringIncludes(report.adjusted.join("\n"), "android.applicationId");
    const cfg = JSON.parse(
      await Deno.readTextFile(join(cwd, "3d-viewer", "deno.json")),
    );
    const label = apkLabel({ binaryName: slugify(cfg.title), doRemote: false });
    assertEquals(
      androidApplicationId(label, cfg.android?.applicationId),
      "app.aio.a3dviewer",
    );
  } finally {
    console.log = real;
    Deno.chdir(orig);
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(cwd);
    await dropTempDir(apps);
  }
});
