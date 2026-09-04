// testServer() + testBrowser() — the two harnesses apps otherwise hand-roll
// (libraryMode boot; headless-chromium lifecycle). a field report.
import { assert, assertEquals, assertThrows } from "@std/assert";
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
  // `""` is a FALSY path, so `opts.browserPath ?? findChromium()` keeps it and
  // the not-found branch runs on every machine.
  //
  // The previous form passed `browserPath: undefined`, which falls through to
  // `findChromium()` — so on any machine that HAS a browser (this one, CI, the
  // machine the e2e chromium tests need) it LAUNCHED one against
  // http://127.0.0.1:1/, never awaited the promise, never closed it: a leaked
  // child process and a leaked profile directory on every suite run, surfacing
  // as a sanitizer failure in whichever test happened to run next. And both of
  // its assertions were guarded by `findChromium() === null`, so on those same
  // machines it asserted NOTHING. A test that only checks something where it
  // cannot run is the vacuous half of the same bug.
  assertThrows(
    () => void testBrowser("http://127.0.0.1:1/", { browserPath: "" }),
    Error,
    "no headless Chromium",
  );
});

Deno.test({
  name: "testBrowser: launches a real process and cleans it up on close",
  ignore: findChromium() === null,
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
