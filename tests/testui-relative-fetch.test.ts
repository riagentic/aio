// Under testUI a relative fetch has no server to reach. The call fails as it
// always did — but with a message that names the way out, not Deno's bare
// `Invalid URL`. A test's own fetch stub still answers relative URLs.
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { testUI } from "../src/cell-test.ts";
import { h } from "../src/air.ts";
import { join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const App = () => h("p", null, "hi");

Deno.test("testUI: a relative fetch fails with a message that names testServer", async () => {
  const before = globalThis.fetch;
  {
    await using _ui = await testUI(App);
    const e = await assertRejects(
      () => fetch("/media/hello.txt"),
      TypeError,
      'testUI: fetch("/media/hello.txt") is a relative URL',
    );
    assertEquals(e.message.includes("testServer()"), true);
    assertEquals((e.cause as Error).message.includes("Invalid URL"), true);
  }
  assertStrictEquals(globalThis.fetch, before, "fetch restored on dispose");
});

Deno.test("testUI: a fetch stub installed before the mount still answers relative URLs", async () => {
  const before = globalThis.fetch;
  const stub =
    ((input: string | URL | Request) =>
      Promise.resolve(new Response(`stub:${input}`))) as typeof fetch;
  globalThis.fetch = stub;
  try {
    {
      await using _ui = await testUI(App);
      assertEquals(await (await fetch("/api/x")).text(), "stub:/api/x");
    }
    assertStrictEquals(globalThis.fetch, stub, "the test's stub is kept");
  } finally {
    globalThis.fetch = before;
  }
});

// ── deno.json `assets` mounts: answered the way the app's server answers ──

/** A module in `appDir` that calls testUI — so testUI's caller (the "test
 *  file") lives in that app dir, exactly as an app's own test does. */
async function probeIn(appDir: string): Promise<
  (
    testUI: unknown,
    App: unknown,
    opts: Record<string, unknown>,
    paths: string[],
  ) => Promise<Record<string, string>>
> {
  await Deno.writeTextFile(
    join(appDir, "probe.ts"),
    `export async function probe(testUI, App, opts, paths) {
       const out = {};
       await using _ui = await testUI(App, opts);
       for (const p of paths) {
         try {
           const r = await fetch(p);
           out[p] = r.status + ":" + await r.text();
         } catch (e) {
           out[p] = "throw:" + (e.code ?? e.message);
         }
       }
       return out;
     }`,
  );
  return (await import(toFileUrl(join(appDir, "probe.ts")).href)).probe;
}

/** A project with `"assets": { "/geo": "./geo" }` and its app dir in `src/`
 *  (where testUI's caller lives). */
async function project(): Promise<{
  dir: string;
  run: (opts?: Record<string, unknown>) => Promise<Record<string, string>>;
}> {
  const dir = await tempDir("aio-testui-mount-");
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ assets: { "/geo": "./geo" } }),
  );
  await Deno.mkdir(join(dir, "geo", "sub"), { recursive: true });
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(join(dir, "geo", "a.geojson"), '{"type":"x"}');
  await Deno.writeTextFile(join(dir, "geo", "sub", "b.txt"), "bee");
  await Deno.writeTextFile(join(dir, "geo", ".env"), "SECRET=1");
  await Deno.writeTextFile(join(dir, "secret.txt"), "outside");
  if (Deno.build.os !== "windows") {
    await Deno.symlink(join(dir, "secret.txt"), join(dir, "geo", "link.txt"));
  }
  const probe = await probeIn(join(dir, "src"));
  const paths = [
    "/geo/a.geojson",
    "geo/sub/b.txt",
    "/geo/a.geojson?v=2",
    "/geo/missing.geojson",
    "/geo/.env",
    "/geo/%2e%2e/secret.txt",
    "/geo/link.txt",
    "/geo/sub/",
    "/elsewhere/a.geojson",
  ];
  return { dir, run: (opts = {}) => probe(testUI, App, opts, paths) };
}

Deno.test("testUI: a relative fetch under a deno.json assets mount is served from disk, by the server's rules", async () => {
  const p = await project();
  try {
    const out = await p.run();
    assertEquals(out["/geo/a.geojson"], '200:{"type":"x"}');
    assertEquals(out["geo/sub/b.txt"], "200:bee");
    assertEquals(out["/geo/a.geojson?v=2"], '200:{"type":"x"}');
    // A miss is what the server answers it: a route-shaped path gets the
    // app shell (the server's SPA fallback), never the mount's file.
    for (const p of ["/geo/missing.geojson", "/geo/sub/"]) {
      assertEquals(out[p]!.startsWith("200:<!DOCTYPE html>"), true, out[p]);
    }
    assertEquals(out["/geo/.env"], "404:Not found", "dotfiles never served");
    assertEquals(
      out["/geo/%2e%2e/secret.txt"],
      "throw:RELATIVE_FETCH",
      "a traversal leaves the mount — no server answers it under testUI",
    );
    if (Deno.build.os !== "windows") {
      assertEquals(out["/geo/link.txt"], "403:Forbidden", "symlink escape");
    }
    assertEquals(out["/elsewhere/a.geojson"], "throw:RELATIVE_FETCH");
  } finally {
    await dropTempDir(p.dir);
  }
});

// testUI kept a second copy of mount serving that skipped the server's rule
// "the app dir first; a deno.json-only mount only fills in": `/own.txt` was
// the APP's file on the server and the MOUNT's under testUI, and `/lib/x.txt`
// (a `/lib` mount beside the app's own `lib/`) was 200 there and 404 here.
// testUI now asks the server's own static handler.
Deno.test("testUI: a relative fetch is answered by the server's own static handler — the app dir first, a deno.json mount filling in", async () => {
  const dir = await tempDir("aio-testui-mount-fill-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ assets: { "/": "./public", "/lib": "./data" } }),
    );
    for (const d of ["src/lib", "public/lib", "data"]) {
      await Deno.mkdir(join(dir, d), { recursive: true });
    }
    await Deno.writeTextFile(join(dir, "src", "own.txt"), "APP");
    await Deno.writeTextFile(join(dir, "src", "lib", "mod.txt"), "APPLIB");
    await Deno.writeTextFile(join(dir, "public", "own.txt"), "MOUNT");
    await Deno.writeTextFile(join(dir, "public", "pub.txt"), "PUB");
    await Deno.writeTextFile(join(dir, "data", "x.txt"), "DATA");
    const probe = await probeIn(join(dir, "src"));
    const out = await probe(testUI, App, {}, [
      "/own.txt",
      "/lib/x.txt",
      "/lib/mod.txt",
      "/pub.txt",
    ]);
    assertEquals(out, {
      "/own.txt": "200:APP",
      "/lib/x.txt": "200:DATA",
      "/lib/mod.txt": "200:APPLIB",
      "/pub.txt": "200:PUB",
    });
  } finally {
    await dropTempDir(dir);
  }
});

// The test lives in tests/, the app in src/: the server serves src/ (the
// entry's folder), so testUI must too — it answered from tests/ (the test's
// own folder), handing back tests/x.txt and even the test's source.
Deno.test("testUI: a test in tests/ is answered from the app's dir (the entry's folder), never its own", async () => {
  const dir = await tempDir("aio-testui-mount-appdir-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ assets: { "/": "./public" } }),
    );
    for (const d of ["src", "public", "tests"]) {
      await Deno.mkdir(join(dir, d));
    }
    await Deno.writeTextFile(join(dir, "src", "x.txt"), "APP");
    await Deno.writeTextFile(join(dir, "public", "y.txt"), "PUB");
    await Deno.writeTextFile(join(dir, "tests", "x.txt"), "TESTS");
    await Deno.writeTextFile(join(dir, "tests", "z.txt"), "TESTS");
    const probe = await probeIn(join(dir, "tests"));
    const out = await probe(testUI, App, {}, ["/x.txt", "/y.txt", "/z.txt"]);
    assertEquals(out["/x.txt"], "200:APP");
    assertEquals(out["/y.txt"], "200:PUB");
    assertEquals(out["/z.txt"]!.includes("TESTS"), false, out["/z.txt"]);
  } finally {
    await dropTempDir(dir);
  }
});

// No `entry`, no src/app.ts: an app run as `deno run -A main.ts` is served
// from main.ts's folder (the project root), as its server serves it.
Deno.test("testUI: an app run as main.ts (no entry, no src/app.ts) is answered from main.ts's folder", async () => {
  for (
    const tasks of [
      { dev: "deno run -A --watch main.ts" },
      // a helper task listed first runs another module: not the app's dir
      { gen: "deno run -A tools/gen.ts", dev: "deno run -A --watch main.ts" },
      undefined,
    ]
  ) {
    const dir = await tempDir("aio-testui-mount-main-");
    try {
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ assets: { "/": "./public" }, tasks }),
      );
      await Deno.mkdir(join(dir, "tests"));
      await Deno.mkdir(join(dir, "public"));
      await Deno.writeTextFile(join(dir, "main.ts"), "// the app");
      await Deno.writeTextFile(join(dir, "x.txt"), "ROOT");
      if (tasks && "gen" in tasks) {
        await Deno.mkdir(join(dir, "tools"));
        await Deno.writeTextFile(join(dir, "tools", "gen.ts"), "// a helper");
        await Deno.writeTextFile(join(dir, "tools", "x.txt"), "TOOLS");
      }
      if (tasks) {
        // A src/ of components beside it is not the app dir.
        await Deno.mkdir(join(dir, "src"));
        await Deno.writeTextFile(join(dir, "src", "x.txt"), "SRC");
      }
      const probe = await probeIn(join(dir, "tests"));
      const out = await probe(testUI, App, {}, ["/x.txt"]);
      assertEquals(out["/x.txt"], "200:ROOT", JSON.stringify(tasks));
    } finally {
      await dropTempDir(dir);
    }
  }
});

Deno.test("testUI: opts.fetch still answers a path under an assets mount", async () => {
  const p = await project();
  try {
    const out = await p.run({
      fetch: (input: string | URL | Request) => new Response(`stub:${input}`),
    });
    assertEquals(out["/geo/a.geojson"], "200:stub:/geo/a.geojson");
  } finally {
    await dropTempDir(p.dir);
  }
});
