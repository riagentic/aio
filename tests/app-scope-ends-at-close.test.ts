// app-scope-ends-at-close.test.ts — a closed app's scope never outlives it.
//
// Every `aio.run()` runs AS its app (an AsyncLocalStorage scope), and code
// outside any app has none — which is what decides where its log lines,
// diagnostics, `degraded()` failures, spawned children, serverFns and budgets
// go. A `Deno.test` that ran after one which booted and closed an app used to
// START inside that dead app's scope, so "outside any app" was charged to an
// app that no longer existed. Tests in one file, in order: the order is the
// proof.
//
// Two ways in: aio's own boot evaluated `npm:esbuild` inside the app scope,
// and Deno pins the ambient context to wherever an npm module is FIRST
// evaluated (fixed: framework loads run outside any app — `outside-app.ts`).
// An APP can do the same from a method (`await import("npm:…")`), which aio
// cannot intercept — so a closed app's scope reads as no app at all.
import { assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { _diagScopeNow } from "../src/diagnostics/diagnostic-bus.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("app scope: an app boots, is called, and closes", async () => {
  await bootCallClose(async () => {}, async () => {
    // A handler nobody wrapped runs in Deno's AMBIENT context — while the app
    // is still up, that must not be the app's (its boot's own npm load).
    const probe = Deno.serve(
      { port: 0, onListen() {} },
      () => new Response(String(_diagScopeNow() !== undefined)),
    );
    try {
      const r = await fetch(`http://127.0.0.1:${probe.addr.port}/`);
      assertEquals(
        await r.text(),
        "false",
        "the app's boot pinned the ambient",
      );
    } finally {
      await probe.shutdown();
    }
  });
});

async function bootCallClose(
  inMethod: () => Promise<unknown>,
  whileUp: () => Promise<void> = async () => {},
) {
  const dir = await tempDir("aio-scope-end-");
  const c = cell("c", {
    state: { n: 0 },
    methods: {
      async inc(s: { n: number }) {
        await inMethod();
        s.n++;
      },
    },
  });
  const app = await aio.run({
    cells: [c],
    appId: `scope-end-${crypto.randomUUID().slice(0, 8)}`,
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port: freePort(),
  } as never) as unknown as { close(): Promise<void> };
  try {
    await (c as unknown as { inc(): Promise<void> }).inc();
    await whileUp();
  } finally {
    await app.close();
  }
  assertEquals(_diagScopeNow(), undefined, "the test body is outside any app");
  await dropTempDir(dir);
}

Deno.test("app scope: the next test starts outside any app", () => {
  assertEquals(
    _diagScopeNow(),
    undefined,
    "a closed app's scope leaked into the next test",
  );
});

Deno.test("app scope: an app's method loads an npm module, then the app closes", async () => {
  // First evaluation of `react` in this process — inside the app's scope.
  await bootCallClose(() => import("react"));
  // Self-contained, so `--filter` of this one test still proves it: that
  // import pinned Deno's AMBIENT context to the app, and a handler nobody
  // wrapped runs in it — after close() it must read as no app at all.
  assertEquals(
    await ambientScopeSeen(),
    "false",
    "a closed app's scope outlived its close through an npm import",
  );
});

/** What a `Deno.serve` handler nobody wrapped sees: Deno's ambient context. */
async function ambientScopeSeen(): Promise<string> {
  const probe = Deno.serve(
    { port: 0, onListen() {} },
    () => new Response(String(_diagScopeNow() !== undefined)),
  );
  try {
    const r = await fetch(`http://127.0.0.1:${probe.addr.port}/`);
    return await r.text();
  } finally {
    await probe.shutdown();
  }
}

Deno.test("app scope: after that close, the next test is outside any app", () => {
  assertEquals(
    _diagScopeNow(),
    undefined,
    "a closed app's scope outlived its close through an npm import",
  );
});
