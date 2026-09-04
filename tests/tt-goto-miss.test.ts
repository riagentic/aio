// `am timetravel goto <N>` must not answer ok:true for an entry that is not
// there — and the number it takes must be the one the surface names.
//
// Two defects, stacked, both measured against a running app:
//
//  1. Every word of the surface says INDEX — `am help` ("Jump to index"),
//     `docs/clients/app-manager.md` ("jump to index"), and the CLI's own
//     out-of-range message ("indices are whole numbers from 0"). `travelTo`
//     matches by entry ID (`entries.findIndex((e) => e.id === id)`). Those
//     agree only while ids happen to equal positions — a fresh history that
//     has never been trimmed. `resume` truncates entries after the current
//     one and the window rolls at 2000, so after any real session the two
//     diverge and the same number means a different entry.
//  2. A miss is SILENT: `travelTo` returns the state unchanged ("invalid id —
//     no-op"), `handleTTCommand` returns early when nothing changed, and the
//     route had already answered `{ok:true}`. Measured: `am tt goto 2` against
//     a history of ids [0,4,5] answered ok and moved nothing.
//
// The file this route lives in states the rule it was breaking, ten lines
// above, about a different command: "ok:true must mean EXECUTED".
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const post = (port: number, route: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/__aio/trojan/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify(body),
  });

Deno.test("tt goto: an id no entry carries is refused, not acked", async () => {
  const c = cell("ttgoto", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-ttgoto-");
  const app = await aio.run({
    cells: [c],
    appId: `ttgoto-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
  } as never);
  try {
    for (let i = 0; i < 3; i++) {
      const r = await post(port, "dispatch", { type: "ttgoto:inc" });
      await r.body?.cancel();
    }
    const h = await fetch(`http://127.0.0.1:${port}/__aio/trojan/history`);
    const hist = await h.json() as {
      entries: { id: number }[];
      index: number;
    };
    const ids = hist.entries.map((e) => e.id);
    assert(ids.length > 1, `need a history to travel in: ${ids}`);

    // A real id moves — the ordinary case still works.
    const okr = await post(port, "tt", { cmd: "goto", arg: ids[0] });
    assertEquals(okr.status, 200, await okr.clone().text());
    await okr.body?.cancel();

    // …and one that names no entry is REFUSED, naming what it could have been.
    const miss = Math.max(...ids) + 100;
    const bad = await post(port, "tt", { cmd: "goto", arg: miss });
    const text = await bad.text();
    assertEquals(
      bad.status >= 400,
      true,
      `goto ${miss} over ids [${ids}] answered ${bad.status}: ${text}`,
    );
    assert(
      text.includes(String(miss)),
      `the refusal must name the id it could not find: ${text}`,
    );
  } finally {
    await app.close();
  }
});
