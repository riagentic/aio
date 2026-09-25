// `/__aio/health` lists ITS app's cells — not the last app booted in the
// process.
//
// Its `cells` (and the vitals probe's circuit-breaker list) were read off
// `globalThis.__aioCells`, which every boot overwrote. With two apps in one
// process — an embedding host, two `testServer`s — app A's health endpoint
// reported app B's cells, errors and enabled flags, and kept doing so after B
// closed.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

type N = { n: number };
const alpha = cell("healthAlpha", {
  state: { n: 0 },
  methods: {
    inc(s: N) {
      s.n++;
    },
  },
});
const beta = cell("healthBeta", {
  state: { n: 0 },
  methods: {
    inc(s: N) {
      s.n++;
    },
  },
});

Deno.test("health: each app's /__aio/health lists its own cells", async () => {
  await using a = await testServer({ cells: [alpha] });
  await (alpha as unknown as { inc(): Promise<void> }).inc();
  await using b = await testServer({ cells: [beta] });
  const cellsOf = async (url: string) =>
    Object.keys((await (await fetch(`${url}/__aio/health`)).json()).cells);
  assertEquals(await cellsOf(a.url), ["healthAlpha"]);
  assertEquals(await cellsOf(b.url), ["healthBeta"]);
});
