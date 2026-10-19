// A main-isolate cell that `listensTo` a `worker: true` cell's method.
//
// Found by a main-vs-worker differential: the listener ran in-isolate (every
// harness) and NEVER in a real worker — the worker's calls are routed straight
// to its thread and never enter the main reduce, where the fan-out runs.
// Silent: no boot line, no runtime line, `heard` simply stayed 0. Refusing it
// would stop apps that boot today, so it is said — at a real boot and by every
// harness, in the same words.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { captureConsoleAsync } from "./console-capture.ts";
import { wlisSrc, wlisTarget } from "./fixtures/worker-listened-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-listened-app.ts");
const SRC = wlisSrc as unknown as { inc(): Promise<number> };
const said = (lines: string[]) =>
  lines.some((l) =>
    l.includes(`"wlisTarget" listens to "wlisSrc", a worker: true cell`)
  );

Deno.test("listensTo a worker cell: the gap is real — the listener never runs in a real worker", async () => {
  await using srv = await testServer({
    cells: [wlisSrc, wlisTarget],
    workers: "real",
    workerEntry: ENTRY,
  });
  await SRC.inc();
  await new Promise((r) => setTimeout(r, 50));
  const st = srv.state() as {
    wlisSrc: { n: number };
    wlisTarget: { heard: number };
  };
  assertEquals(st.wlisSrc.n, 1);
  assertEquals(st.wlisTarget.heard, 0);
});

Deno.test("listensTo a worker cell: a real boot says so", async () => {
  const lines = await captureConsoleAsync(async () => {
    await using _srv = await testServer({
      cells: [wlisSrc, wlisTarget],
      workers: "real",
      workerEntry: ENTRY,
    });
  });
  assert(said(lines), lines.join("\n"));
});

Deno.test("listensTo a worker cell: an in-isolate harness says the same", async () => {
  const lines = await captureConsoleAsync(async () => {
    await using _app = await bootCells([wlisSrc, wlisTarget]);
  });
  assert(said(lines), lines.join("\n"));
});
