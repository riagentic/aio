// a `--headless` build skips the browser bundle but the prod server
// still served the UI shell, which then 404'd on /app.js and rendered blank.
// Now the prod root handler detects the missing bundle and serves a clear
// "headless build — no browser UI" diagnostic (503) instead of a broken page.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
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

Deno.test("headless serve: dev mode never shows the headless diagnostic", async () => {
  // dev transpiles /app.js live, so a missing dist is irrelevant.
  const { serveStatic } = createStaticHandler(
    deps({ prod: false, absDistDir: null }),
  );
  const res = await serveStatic("/");
  assertEquals(res.status, 200);
  assert(!(await res.text()).includes("Headless build"));
});
