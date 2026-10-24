// `aio.run({ assets: { "media": "./media" } })` — the spelling deno.json's
// `assets` has always accepted as `/media` — never matched a pathname here (a
// pathname starts with "/"), so the mount served nothing and said nothing.
// A non-string dir crashed the boot inside `resolve` naming neither key nor
// prefix (now refused, naming both); `""` resolved to the process CWD and
// served it — it booted on 1.0.24, so it is now warned and that mount skipped.
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { _runMounts, createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("an assets / serveDirs prefix without its leading slash is served", async () => {
  const dir = await tempDir("aio-run-mounts-");
  const media = join(dir, "media-src");
  await Deno.mkdir(media);
  await Deno.writeTextFile(join(media, "a.txt"), "hi");
  const port = freePort();
  const server = createServer({
    port,
    title: "mounts",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    distDir: join(dir, "dist"),
    assets: { "media": media },
    serveDirs: { "dev": media },
  });
  try {
    for (const path of ["/media/a.txt", "/dev/a.txt"]) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      assertEquals([path, r.status, await r.text()], [path, 200, "hi"]);
    }
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});

Deno.test("a non-string mount dir is refused, naming key and prefix", () => {
  for (const dir of [5, null, {}]) {
    const e = assertThrows(() =>
      _runMounts("assets", { "/x": dir as unknown as string })
    );
    assertEquals(
      (e as Error).message.startsWith('[aio] assets["/x"] is'),
      true,
    );
  }
  assertEquals(_runMounts("serveDirs", { "/a": "d", b: "e" }), {
    "/a": "d",
    "/b": "e",
  });
  assertEquals(_runMounts("assets", undefined), undefined);
});

Deno.test("a blank mount dir is warned and skipped — never the CWD, never a refusal", async () => {
  const said: string[] = [];
  assertEquals(
    _runMounts(
      "assets",
      { "/x": "", "/y": "  ", "/z": "d" },
      (m) => said.push(m),
    ),
    { "/z": "d" },
  );
  assertEquals(said.length, 2);
  assertEquals(said[0]!.includes('assets["/x"]'), true, said[0]);
  // A real server: the blank mount answers nothing from the CWD.
  const dir = await tempDir("aio-run-mounts-");
  const port = freePort();
  const server = createServer({
    port,
    title: "mounts",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    distDir: join(dir, "dist"),
    assets: { "/cwd": "" },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/cwd/deno.json`);
    await r.body?.cancel();
    assertEquals(r.status, 404, "the CWD must not be served");
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});

// aio-server.ts counts mounts and writes the "deno.json alone" note from the
// SAME normalizer: `"media"` in aio.run beside deno.json's `"media"` is one
// mount, owned by aio.run.
Deno.test("the boot reader and the server read aio.run mounts through one normalizer", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/aio-server.ts", import.meta.url),
  );
  assertEquals(/_servedAssets\(\s*config\.assets/.test(src), false);
  assertEquals(/_denoJsonMountsNote\(\s*config\.assets/.test(src), false);
  assertEquals(/_runMounts\(\s*"assets",\s*config\.assets/.test(src), true);
});

Deno.test("an aio.run mount spelled without '/' is not counted as deno.json's alone", async () => {
  const { _mountsDenoJsonOnly, _servedAssets } = await import(
    "../src/server/server.ts"
  );
  const dir = await tempDir("aio-run-mounts-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ assets: { "media": "./m" } }),
    );
    const run = _runMounts("assets", { "media": join(dir, "m2") });
    const served = _servedAssets(run, dir, () => {}) ?? {};
    assertEquals(Object.keys(served), ["/media"]);
    assertEquals(served["/media"], join(dir, "m2"), "aio.run's wins");
    assertEquals(_mountsDenoJsonOnly(run, served), []);
  } finally {
    await dropTempDir(dir);
  }
});
