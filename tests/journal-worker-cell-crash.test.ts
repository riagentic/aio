// `journal: true` must protect a `worker: true` cell's acked writes, and the
// timeline must show them.
//
// A worker cell's method runs in its own isolate and never reaches the main
// dispatch; the patches it commits come home as `__aioWorkerPatch`, with the
// cell in the payload. The journal/timeline hook decides by the `cell:` prefix
// of the type, found none, and dropped the batch as framework noise. So a
// worker cell reached NO sink: the r3 chaos hunt's `journal: true` app never
// even created its journal file, and a SIGKILL 800 ms into a burst lost 5 of
// 66 acked writes (the same app without `worker: true`: 0). `am timeline`
// listed nothing for the cell.
//
// Real worker (the child's entry hosts it), real SIGKILL, real disk.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

// Inside the worker `aio.run()` never resolves, so the phase code below it
// runs on the main isolate only.
const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
export const wk = cell("wk", {
  worker: true,
  state: { items: [] },
  methods: { add(s, id) { s.items.push(id); } },
});
await aio.run({
  cells: [wk],
  appId: "worker-journal-probe",
  client: "server-only",
  journal: true,
  // Far past the burst: without the journal, nothing of it is on disk.
  persistDebounceMs: 5000,
  port: PORT,
  appDir: DIR,
});
const url = (r) => "http://127.0.0.1:" + PORT + "/__aio/trojan/" + r;
if (PHASE === "crash") {
  for (let i = 1; i <= 25; i++) {
    const res = await fetch(url("dispatch"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ type: "wk:add", payload: { args: [i] } }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(res.status + " " + text);
  }
  // Every call is acked; let the last patch batch cross home.
  for (let t = 0; t < 100 && wk.items.length < 25; t++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const tl = await (await fetch(url("timeline"))).json();
  Deno.writeTextFileSync(DIR + "/timeline.json", JSON.stringify(tl.entries));
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(wk.items));
  Deno.kill(Deno.pid, "SIGKILL");
} else {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(wk.items));
  Deno.exit(0);
}
`;

async function runChild(dir: string, phase: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase === "read" && !out.success) {
    throw new Error(`read child failed:\n${text}`);
  }
  return text;
}

Deno.test("worker cell + journal: SIGKILL keeps every acked write, and the timeline shows them", async () => {
  const dir = await tempDir("aio-worker-journal-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const crashLog = await runChild(dir, "crash");
    const expected = JSON.parse(
      await Deno.readTextFile(join(dir, "expected.json")).catch(() => {
        throw new Error(`crash child never reached its kill:\n${crashLog}`);
      }),
    ) as number[];
    assertEquals(expected.length, 25, "the live app acked 25 writes");

    const bootLog = await runChild(dir, "read");
    const recovered = JSON.parse(
      await Deno.readTextFile(join(dir, "recovered.json")),
    ) as number[];
    assertEquals(
      recovered,
      expected,
      `every acked write must survive a SIGKILL under journal: true — ` +
        `restored ${recovered.length} of ${expected.length}.\n${bootLog}`,
    );

    const timeline = JSON.parse(
      await Deno.readTextFile(join(dir, "timeline.json")),
    ) as { type: string; origin?: string; diff: unknown[] }[];
    const batches = timeline.filter((e) => e.origin === "wk:__worker");
    assert(
      batches.length > 0 && batches.every((e) => e.diff.length > 0),
      `the worker cell's commits must reach the timeline, attributed to the ` +
        `cell: ${JSON.stringify(timeline.map((e) => [e.type, e.origin]))}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});
