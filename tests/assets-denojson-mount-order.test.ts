// WHO answers a path, in order: `routes` → `aio.run({ assets })` →
// `serveDirs` → `share` → the app dir → a mount deno.json ALONE declares.
//
// A deno.json-only mount is served since 1.0.20 (it answered 404). It FILLS
// IN: it answers a path only when it holds that file and nothing that
// answered before does — so every path a 1.0.19 app served is the same bytes,
// and the one change an upgrade can show is 404 → 200. Claiming its prefix
// the way an `aio.run` mount does broke that: `"assets": { "/": "./public" }`
// (the web build's "put these at the root") took every path, so the dev page
// could not load one of its own modules, and `{ "/lib": "./data" }` hid the
// app's `src/lib/`. An `aio.run` mount claims its prefix, miss included — as
// it always did.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  createStaticHandler,
  type StaticDeps,
} from "../src/server/server-static.ts";
import { _mountsDenoJsonOnly, _servedAssets } from "../src/server/server.ts";
import { stopEsbuild } from "../src/server/server-transpile.ts";

function deps(over: Partial<StaticDeps>): StaticDeps {
  return {
    prod: false,
    debug: () => {},
    title: "T",
    absBaseDir: "/tmp",
    absDistDir: null,
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    getVitalsExtra: () => ({ payloadStats: new Map(), clientBackpressure: {} }),
    getTrojanDeps: () => ({}),
    ...over,
  };
}

/** A project: the app in `src/`, data in `public/` and `data/`. */
async function project(assets: Record<string, string>): Promise<string> {
  const root = await tempDir("aio-mount-order-");
  for (const d of ["src/lib", "public/lib", "data", "shared"]) {
    await Deno.mkdir(join(root, d), { recursive: true });
  }
  await Deno.writeTextFile(
    join(root, "src/lib/mod.js"),
    "export const a='APP'",
  );
  await Deno.writeTextFile(join(root, "src/own.txt"), "APP");
  await Deno.writeTextFile(join(root, "public/lib/mod.js"), "MOUNT");
  await Deno.writeTextFile(join(root, "public/own.txt"), "MOUNT");
  await Deno.writeTextFile(join(root, "public/robots.txt"), "MOUNT");
  await Deno.writeTextFile(join(root, "public/lib/only.txt"), "MOUNT");
  await Deno.writeTextFile(join(root, "data/only.txt"), "DATA");
  await Deno.writeTextFile(join(root, "shared/only.txt"), "SERVEDIR");
  await Deno.writeTextFile(join(root, "deno.json"), JSON.stringify({ assets }));
  return root;
}

async function body(
  h: ReturnType<typeof createStaticHandler>,
  path: string,
): Promise<string> {
  const r = await h.serveStatic(path);
  const text = await r.text();
  return r.status === 200 ? text : String(r.status);
}

for (const prod of [false, true]) {
  const mode = prod ? "prod" : "dev";

  Deno.test(`assets order (${mode}): a deno.json-only mount fills in — the app's own file at that path is still the app's, and "/" takes nothing over`, async () => {
    const root = await project({ "/": "./public", "/lib": "./data" });
    try {
      const base = join(root, "src");
      const served = _servedAssets(undefined, base);
      const h = createStaticHandler(deps({
        prod,
        absBaseDir: base,
        assets: served,
        assetsFill: _mountsDenoJsonOnly(undefined, served),
      }));
      // What 1.0.19 served is the same bytes.
      assertEquals(await body(h, "/lib/mod.js"), "export const a='APP'");
      assertEquals(await body(h, "/own.txt"), "APP");
      // What it answered 404 is now the mount's.
      assertEquals(await body(h, "/robots.txt"), "MOUNT");
      // The first mount that HOLDS the file answers: "/" is declared first
      // and holds /lib/only.txt; "/lib" → ./data holds only.txt too, later.
      assertEquals(await body(h, "/lib/only.txt"), "MOUNT");
      // Held by no one: the answer an app without the mount gives.
      const bare = createStaticHandler(deps({ prod, absBaseDir: base }));
      assertEquals(
        await body(h, "/lib/nope.bin"),
        await body(bare, "/lib/nope.bin"),
      );
    } finally {
      await dropTempDir(root);
      await stopEsbuild();
    }
  });

  Deno.test(`assets order (${mode}): an aio.run mount claims its prefix, miss included — and stands before a deno.json-only one`, async () => {
    const root = await project({ "/lib": "./public/lib", "/d": "./data" });
    try {
      const base = join(root, "src");
      const run = { "/lib": join(root, "data") };
      const served = _servedAssets(run, base);
      const fill = _mountsDenoJsonOnly(run, served);
      assertEquals(fill, ["/d"]);
      const h = createStaticHandler(deps({
        prod,
        absBaseDir: base,
        assets: served,
        assetsFill: fill,
      }));
      assertEquals(await body(h, "/lib/only.txt"), "DATA");
      // The app's own src/lib/mod.js is behind the claimed prefix, as before.
      assertEquals(await body(h, "/lib/mod.js"), "404");
      assertEquals(await body(h, "/d/only.txt"), "DATA");
    } finally {
      await dropTempDir(root);
      await stopEsbuild();
    }
  });
}

Deno.test("assets order (dev): serveDirs answers its prefix before a deno.json-only mount of the same prefix", async () => {
  const root = await project({ "/s": "./data" });
  try {
    const base = join(root, "src");
    const served = _servedAssets(undefined, base);
    const h = createStaticHandler(deps({
      absBaseDir: base,
      serveDirs: { "/s": join(root, "shared") },
      assets: served,
      assetsFill: _mountsDenoJsonOnly(undefined, served),
    }));
    assertEquals(await body(h, "/s/only.txt"), "SERVEDIR");
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("assets order: aio.run's mounts keep the order aio.run gave them — deno.json's own follow", async () => {
  const root = await project({ "/a": "./data", "/z": "./data", "/a/b": "./x" });
  try {
    const run = { "/a/b": "/one", "/a": "/two" };
    const served = _servedAssets(run, join(root, "src"))!;
    assertEquals(Object.keys(served), ["/a/b", "/a", "/z"]);
    assertEquals(served["/a"], "/two");
    assertEquals(_mountsDenoJsonOnly(run, served), ["/z"]);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("assets order: a real server — a route answers before a deno.json-only mount, the app's file before it, the mount where both were 404", async () => {
  const { aio, cell } = await import("../mod.ts");
  const root = await project({ "/": "./public" });
  const port = freePort();
  const app = await aio.run({
    cells: [cell("c_mount_order", { state: { n: 0 } })],
    appId: `test-mount-order-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    appDir: join(root, "home"),
    baseDir: join(root, "src"),
    watch: false,
    routes: { "/lib/only.txt": () => new Response("ROUTE") },
  });
  try {
    const get = async (p: string) =>
      await (await fetch(`http://127.0.0.1:${port}${p}`)).text();
    assertEquals(await get("/lib/only.txt"), "ROUTE");
    assertEquals(await get("/own.txt"), "APP");
    assertEquals(await get("/robots.txt"), "MOUNT");
    assert((await get("/lib/mod.js")).includes("APP"));
  } finally {
    await app.close();
    await dropTempDir(root);
    await stopEsbuild();
  }
});
