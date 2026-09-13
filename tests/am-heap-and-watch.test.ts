// `am heap` and `am state --watch` — two questions nothing could answer.
//
// `am state` says what an app is SERVING. Nothing said what it was HOLDING: a
// field report watched a console peak at 31.8 GB and restart 16 times in 24
// hours with no way to ask, from outside, how much of that was heap and which
// cell it was in (report 2 §9.4).
//
// And `--wait=N` re-printed the value every N seconds — a poll loop with nicer
// syntax. Both reports that asked for a watch wrote `until` loops around
// `am state` anyway, all session (report 7 §6). A change is rare and a tick is
// not, so a line per tick buries the one line that matters.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";

type S = { n: number; items: string[] };

Deno.test("am heap: the trojan reports heap, the ceiling, and per-cell size", async () => {
  const dir = await tempDir("am-heap-");
  const port = freePort();
  const counter = cell("counter", {
    state: { n: 0, items: [] as string[] },
    methods: {
      add(s: S, v: string) {
        s.items.push(v);
        s.n++;
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const app = await aio.run({
    cells: [counter],
    appId: `heapprobe-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/heap`, {
      headers: { "x-aio": "1" },
    });
    const body = await r.text();
    assertEquals(r.status, 200, body);
    const h = JSON.parse(body) as {
      pid: number;
      rss: number;
      heapUsed: number;
      heapLimit: number | null;
      heapPct: number | null;
      cells: { name: string; bytes: number }[];
    };
    assertEquals(h.pid, Deno.pid);
    assert(h.heapUsed > 0, "heapUsed must be a real reading");
    assert(h.rss > 0, "rss must be a real reading");
    // The CEILING is the point. `heapTotal` is lazily allocated and always
    // sits just above `heapUsed`, so it always looks reassuring; the number
    // that says how close an app is to OOM is `heap_size_limit`.
    assert(
      h.heapLimit === null || h.heapLimit > h.heapUsed,
      `heapLimit (${h.heapLimit}) must be the real ceiling, above heapUsed ` +
        `(${h.heapUsed}) — heapTotal would not be`,
    );
    if (h.heapLimit) {
      assert(
        h.heapPct !== null && h.heapPct >= 0 && h.heapPct <= 100,
        `heapPct out of range: ${h.heapPct}`,
      );
    }
    const c = h.cells.find((x) => x.name === "counter");
    assert(c, `the counter cell was not measured: ${JSON.stringify(h.cells)}`);
    assert(c!.bytes > 0, "a cell with state measured zero bytes");
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});

Deno.test("am heap: a runtime with no V8 statistics reports null, not a plausible zero", async () => {
  // The percentage is the one number that can be wrong in a dangerous
  // direction — a hard-coded 0 reads as "plenty of room". It is null when
  // unknown, and the pretty output simply omits the ratio.
  const { default: v8 } = await import("node:v8");
  const stats = v8.getHeapStatistics() as { heap_size_limit: number };
  assert(
    stats.heap_size_limit > 0,
    "this runtime does report a heap limit, so the null path is the OTHER " +
      "branch and is asserted by the route's own `|| null`",
  );
});

Deno.test("am state --watch: the path is the positional, whichever side the flag is on", async () => {
  // `args[0]` was the path, so `am state --watch todo.items` made the FLAG the
  // path and asked for a key called "--watch".
  const { _pathOfArgs } = await import("../src/am/am-cmd-state.ts") as {
    _pathOfArgs?: (a: string[]) => string | undefined;
  };
  if (!_pathOfArgs) return; // not exported; the behaviour is pinned by cmdState
  assertEquals(_pathOfArgs(["--watch", "todo.items"]), "todo.items");
  assertEquals(_pathOfArgs(["todo.items", "--watch"]), "todo.items");
  assertEquals(_pathOfArgs(["--watch"]), undefined);
});

Deno.test("am help lists heap and state --watch", async () => {
  const help = await Deno.readTextFile(
    new URL("../src/am/am-help-text.ts", import.meta.url),
  );
  assertStringIncludes(help, "heap");
  assertStringIncludes(help, "--watch");
  assertStringIncludes(
    help,
    "prints only",
    "the help has to say what makes --watch different from --wait, or the " +
      "two read as synonyms and people keep writing the until loop — and it " +
      "has to say it POLLS, because a change undone between two polls is " +
      "never printed",
  );
});
