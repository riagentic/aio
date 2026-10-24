// With the default `"out": "dist"` the fleet empties dist/ into the release,
// and the bundle went with it: every `deno task build` re-ran esbuild, because
// the next build's freshness check found no dist/app.js. The fleet now keeps
// the staged bundle and its input record in .aio/bundle-cache/ between builds
// (one pair, moved by rename so the mtimes the check compares are the real
// ones) and puts them back into dist/ right before the first target that
// bundles.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  BUNDLE_CACHE,
  BUNDLE_INPUTS,
  restoreBundle,
  stashBundle,
} from "../src/build/dist-staging.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const BUILD_ALL = fromFileUrl(new URL("../src/build-all.ts", import.meta.url));

/** A per-target builder (the fleet's `--build-spec` seam): reuses a staged
 *  dist/app.js + record as the real bundle step does (says CACHED), else
 *  writes both; then sweeps dist/ to the staged files and emits a binary. */
const STUB = `
const has = async (p) => { try { await Deno.stat(p); return true; } catch { return false; } };
if (Deno.args.includes("--headless")) {
  // A headless target bundles nothing and embeds whatever dist/ holds.
  console.log("HEADLESS sees bundle=" + await has("dist/app.js"));
} else if (await has("dist/app.js") && await has(".aio/bundle-inputs.json")) {
  const m = (await Deno.stat("dist/app.js")).mtime.getTime();
  console.log("CACHED " + await Deno.readTextFile("dist/app.js") + " " + m);
} else {
  await Deno.mkdir("dist", { recursive: true });
  await Deno.mkdir(".aio", { recursive: true });
  await Deno.writeTextFile("dist/app.js", "bundle-" + crypto.randomUUID());
  await Deno.writeTextFile("dist/electron.json", "{}");
  await Deno.writeTextFile(".aio/bundle-inputs.json", "{}");
  console.log("BUNDLED");
}
const bin = Deno.cwd() + "/cacheapp";
await Deno.writeTextFile(bin, "#!/bin/sh\\necho 'cacheapp 0.1.0 (aio 1.0.0-beta)'\\n");
await Deno.chmod(bin, 0o755);
`;

async function fleet(dir: string, targets = "browser"): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      BUILD_ALL,
      `--build-spec=${join(dir, "stub-build.ts")}`,
      `--targets=${targets}`,
    ],
    cwd: dir,
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  const said = dec.decode(out.stdout) + dec.decode(out.stderr);
  assertEquals(out.code, 0, said);
  return said;
}

Deno.test("default out: the second fleet build reuses the first one's bundle; the release holds no bundle", async () => {
  const dir = await tempDir("aio-dist-cache-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "cacheapp",
        build: { targets: ["browser"], out: "dist" },
      }),
    );
    await Deno.writeTextFile(join(dir, "stub-build.ts"), STUB);
    const first = await fleet(dir);
    assertStringIncludes(first, "BUNDLED");
    const names: string[] = [];
    for await (const e of Deno.readDir(join(dir, "dist"))) names.push(e.name);
    assert(names.includes("manifest.json"), names.join());
    assert(!names.includes("app.js"), names.join());
    const cached = await Deno.readTextFile(join(dir, BUNDLE_CACHE, "app.js"));
    const mtime = (await Deno.stat(join(dir, BUNDLE_CACHE, "app.js"))).mtime!
      .getTime();

    const second = await fleet(dir);
    assertStringIncludes(second, `CACHED ${cached} ${mtime}`);
    assert(!second.includes("BUNDLED"), second);
  } finally {
    await dropTempDir(dir);
  }
});

// The cache may make a build faster, never different: a headless target
// embeds whatever bundle dist/ holds, so a cached one must not reach a
// headless-only build (a fresh clone or CI builds it headless).
Deno.test("default out: [server] after [browser,server] is headless, as on a fresh clone", async () => {
  const dir = await tempDir("aio-dist-cache-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "cacheapp", build: { out: "dist" } }),
    );
    await Deno.writeTextFile(join(dir, "stub-build.ts"), STUB);
    const both = await fleet(dir, "browser,server");
    assertStringIncludes(both, "HEADLESS sees bundle=true"); // same run: by design
    assert(await Deno.stat(join(dir, BUNDLE_CACHE, "app.js")));
    await assertGone(join(dir, BUNDLE_CACHE, "electron.json"));
    const alone = await fleet(dir, "server");
    assertStringIncludes(alone, "HEADLESS sees bundle=false");
    // …and the cache waits for the next target that bundles.
    assertStringIncludes(await fleet(dir, "browser"), "CACHED ");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("stash/restore: one pair, mtime kept; never a bundle without its record", async () => {
  const dir = await tempDir("aio-dist-cache-");
  const dist = join(dir, "dist");
  const record = join(dir, BUNDLE_INPUTS);
  try {
    await Deno.mkdir(dist);
    await Deno.mkdir(join(dir, ".aio"));
    await Deno.writeTextFile(join(dist, "app.js"), "js");
    await Deno.writeTextFile(join(dist, "style.css"), "css");
    await Deno.writeTextFile(join(dist, "manifest.json"), "{}");
    await Deno.writeTextFile(record, "rec");
    const old = new Date(Date.now() - 60_000);
    await Deno.utime(join(dist, "app.js"), old, old);

    assertEquals((await stashBundle(dir, dist)).sort(), [
      "app.js",
      "style.css",
    ]);
    assert(await Deno.stat(join(dist, "manifest.json")));
    // A record written since describes some other dist/app.js: dropped.
    await Deno.writeTextFile(record, "other");
    assert(await restoreBundle(dir, dist));
    assertEquals(await Deno.readTextFile(record), "rec");
    assertEquals(
      (await Deno.stat(join(dist, "app.js"))).mtime!.getTime(),
      old.getTime(),
    );

    // No record → nothing cached, so nothing restored, and a stray record goes.
    await Deno.remove(record);
    assertEquals(await stashBundle(dir, dist), []);
    await Deno.writeTextFile(record, "stray");
    assert(!await restoreBundle(dir, dist));
    await assertGone(record);
  } finally {
    await dropTempDir(dir);
  }
});

async function assertGone(p: string): Promise<void> {
  try {
    await Deno.stat(p);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return;
    throw e;
  }
  throw new Error(`${p} still there`);
}
