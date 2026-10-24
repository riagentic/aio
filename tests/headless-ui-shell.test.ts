// a `--headless` build skips the browser bundle but the prod server
// still served the UI shell, which then 404'd on /app.js and rendered blank.
// Now the prod root handler detects the missing bundle and serves a clear
// "headless build — no browser UI" diagnostic (503) instead of a broken page.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import {
  createStaticHandler,
  type StaticDeps,
} from "../src/server/server-static.ts";

function deps(over: Partial<StaticDeps>): StaticDeps {
  return {
    prod: true,
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

Deno.test("headless serve: prod dist without app.js → 503 headless diagnostic", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // dist dir exists but has NO app.js (a --headless build)
    const { serveStatic } = createStaticHandler(deps({ absDistDir: dir }));
    const res = await serveStatic("/");
    assertEquals(res.status, 503);
    const body = await res.text();
    assert(body.includes("Headless build"), `got: ${body.slice(0, 120)}`);
    assert(body.includes("--headless"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("headless serve: prod dist WITH app.js → serves the normal shell", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "app.js"), "// bundle");
    const { serveStatic } = createStaticHandler(deps({ absDistDir: dir }));
    const res = await serveStatic("/");
    assertEquals(res.status, 200);
    const body = await res.text();
    assert(
      !body.includes("Headless build"),
      "healthy prod shell, not the diagnostic",
    );
    assert(body.includes("app.js"), "the shell references the bundle");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("headless serve: prod picks up a bundle written after boot", async () => {
  const dir = await tempDir("aio-headless-late-");
  try {
    const { serveStatic } = createStaticHandler(deps({ absDistDir: dir }));
    const before = await serveStatic("/");
    assertEquals(before.status, 503);
    await before.body?.cancel();
    await Deno.writeTextFile(join(dir, "app.js"), "// bundle");
    const after = await serveStatic("/");
    assertEquals(after.status, 200, "the boot-time 503 must not stick");
    await after.body?.cancel();
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("headless serve: dev WITH the UI entry → serves the normal shell", async () => {
  const dir = await tempDir("aio-headless-dev-");
  try {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default () => null;",
    );
    const { serveStatic } = createStaticHandler(
      deps({ prod: false, absBaseDir: dir }),
    );
    for (const path of ["/", "/deep/link"]) {
      const res = await serveStatic(path);
      assertEquals(res.status, 200, path);
      assert(!(await res.text()).includes("headless"), path);
    }
  } finally {
    await dropTempDir(dir);
  }
});

// Dev answered every page path of a UI-less app (no App.tsx: a
// `client: "server-only"` app) 200 with a shell whose own import 404s — a blank
// page — where prod answers the honest 503. Dev must never be more lenient
// than prod: the same 503, with a dev-worded explanation.
Deno.test("headless serve: dev WITHOUT the UI entry → the same 503 prod answers", async () => {
  const dir = await tempDir("aio-headless-dev-");
  try {
    const { serveStatic } = createStaticHandler(
      deps({ prod: false, absBaseDir: dir, headless503: true }),
    );
    for (const path of ["/", "/deep/link"]) {
      const res = await serveStatic(path);
      assertEquals(res.status, 503, path);
      const body = await res.text();
      assert(body.includes("No UI"), `${path}: ${body.slice(0, 160)}`);
      assert(body.includes("App.tsx"), "names the missing entry");
      assert(!body.includes("--headless"), "dev was not built --headless");
    }
    // A configured entry is the one named — and creating it needs no restart.
    const custom = createStaticHandler(
      deps({
        prod: false,
        absBaseDir: dir,
        uiEntry: "ui/Main.tsx",
        headless503: true,
      }),
    );
    const miss = await custom.serveStatic("/");
    assertEquals(miss.status, 503);
    assert((await miss.text()).includes("ui/Main.tsx"));
    await Deno.mkdir(join(dir, "ui"));
    await Deno.writeTextFile(
      join(dir, "ui/Main.tsx"),
      "export default () => null;",
    );
    const hit = await custom.serveStatic("/");
    assertEquals(hit.status, 200, "picked up without a restart");
    await hit.body?.cancel();
  } finally {
    await dropTempDir(dir);
  }
});

// Compat: a programmatic server (libraryMode — every user's own test,
// `testServer`, a direct `createServer`) keeps the 1.0.24 answer, the shell
// with 200, and says ONCE that prod answers 503 there. The dev server a human
// runs answers 503 (`headless503`, set by aio.run outside libraryMode — proven
// end to end by tests/port-zero-is-reachable.test.ts's real child app).
Deno.test("headless serve: libraryMode keeps the shell and warns once", async () => {
  const dir = await tempDir("aio-headless-lib-");
  const warns: string[] = [];
  setLogger(
    {
      pub: (lvl: string, _c: string, msg: string) => {
        if (lvl === "warn") warns.push(msg);
      },
    } as unknown as LogSink,
  );
  try {
    const c = cell(`hl_${crypto.randomUUID().slice(0, 6)}`, {
      state: { n: 0 },
      methods: {},
    });
    const app = await aio.run({
      cells: [c],
      appId: `test-hl-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      port: freePort(),
      baseDir: dir,
    });
    try {
      const url = `http://127.0.0.1:${app.port}`;
      for (const path of ["/", "/deep/link", "/"]) {
        const res = await fetch(url + path);
        assertEquals(res.status, 200, path);
        assert((await res.text()).includes("<!DOCTYPE html>"), path);
      }
    } finally {
      await app.close();
    }
    await using srv = await testServer({ cells: [c] });
    const res = await srv.fetch("/");
    assertEquals(res.status, 200, "testServer: unchanged");
    await res.body?.cancel();
  } finally {
    setLogger(null);
    await dropTempDir(dir);
  }
  const said = warns.filter((w) =>
    w.includes("prod answers 503 'Headless build'")
  );
  assertEquals(said.length, 2, `once per server: ${JSON.stringify(warns)}`);
  assert(said[0]!.includes("no UI entry"));
});
