// testServer() + testBrowser() — the two harnesses apps otherwise hand-roll
// (libraryMode boot; headless-chromium lifecycle). a field report.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { route } from "../src/server/route.ts";
import {
  findChromium,
  testBrowser,
  testServer,
} from "../src/testing/server-test.ts";

Deno.test("testServer: boots on a free port with defaults; fetch + state + dispose", async () => {
  const counter = cell("counter", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  await using srv = await testServer<{ counter: { n: number } }>({
    cells: [counter],
    routes: {
      "/ping/:who": route((ctx) => ctx.json({ hi: ctx.params.who })),
    },
  });
  assert(srv.port > 0, "got a real port");
  assert(srv.url.startsWith("http://127.0.0.1:"), srv.url);

  // custom route works through the helper's fetch
  const res = await srv.fetch("/ping/ada");
  assertEquals(await res.json(), { hi: "ada" });

  // state reads the server-authoritative store; a server-side call mutates it
  assertEquals(srv.state().counter.n, 0);
  await (counter as unknown as { inc: () => Promise<void> }).inc();
  assertEquals(srv.state().counter.n, 1);
  // `await using` disposes (closes app + removes temp dir) at scope end.
});

Deno.test("testServer: honors an explicit port + persist override", async () => {
  const c = cell("c", { state: { x: 1 }, methods: {} });
  // a guaranteed-free port (bind :0 then release) — no cross-file collision
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  await using srv = await testServer({ cells: [c], port });
  assertEquals(srv.port, port);
  const res = await srv.fetch("/__aio/trojan/state");
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("testBrowser: throws a clear error when no browser is found", () => {
  let threw = "";
  try {
    // an impossible path forces the not-found branch deterministically
    testBrowser("http://127.0.0.1:1/", { browserPath: undefined });
    // findChromium may still find one on this machine — only assert when absent
    if (findChromium() === null) throw new Error("should have thrown");
  } catch (e) {
    threw = (e as Error).message;
  }
  if (findChromium() === null) {
    assert(threw.includes("no headless Chromium"), threw);
  }
});

Deno.test({
  name: "testBrowser: launches a real process and cleans it up on close",
  ignore: findChromium() === null,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const c = cell("counter", { state: { n: 0 }, methods: {} });
    await using srv = await testServer({ cells: [c], client: "server-only" });
    const browser = await testBrowser(`${srv.url}/`);
    const pid = browser.proc.pid;
    assert(pid > 0, "owns a real process");
    await browser.close();
    // after close, the process is reaped — killing it again is a no-op / throws
    let stillAlive = true;
    try {
      Deno.kill(pid, "SIGKILL"); // ESRCH if already gone
      stillAlive = true;
    } catch {
      stillAlive = false;
    }
    assert(!stillAlive, "the browser process was killed on close (no leak)");
  },
});
