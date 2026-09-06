// The trojan's rate limit is the one an OPERATOR meets, through `am`.
//
// It answered a bare `{"error":"rate limit exceeded"}`: no cap, no count, no
// hint that it clears by itself a second later — which from `am state` reads as
// a broken tool rather than a limiter doing its job. Both sibling limiters in
// this codebase name their numbers (client-log: `>${MAX_RATE} msg/s`; the WS
// fuse: the rate, the client count and the cap), and they are the two nobody
// sees. MEASURED: 700 dispatches in a loop, then `am state counter` answered
// the bare string with nothing to act on.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { tooLargeMessage } from "../src/server/server-trojan.ts";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

Deno.test("trojan: the rate limit says its cap, its count, and that it self-clears", async () => {
  const c = cell("trl", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-trl-");
  const app = await aio.run({
    cells: [c],
    appId: `trl-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
  } as never);
  try {
    // Past the 100/sec cap, in one second, on purpose.
    let limited: { error?: string } | null = null;
    for (let i = 0; i < 140 && !limited; i++) {
      const res = await fetch(
        `http://127.0.0.1:${port}/__aio/trojan/dispatch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-AIO": "1" },
          body: JSON.stringify({ type: "trl:bump" }),
        },
      );
      const body = await res.json() as { error?: string };
      if (res.status === 429) limited = body;
    }
    assert(limited, "140 requests in a second must trip the 100/sec cap");
    const msg = limited.error ?? "";
    // the cap itself — the number an operator needs to space their calls by
    assertStringIncludes(msg, "100 requests/sec");
    // …that it is not a wedged tool
    assertStringIncludes(msg, "clears on its own");
    // …and what usually causes it
    assertStringIncludes(msg, "tight loop");
  } finally {
    await app.close();
  }
});

// The same gap, four more times, in the same file: every bounded control-plane
// body answered "<x> body too large" — a limit with no number. The operator
// meets these through `am` too. The request's true size is deliberately not
// known (the read aborts AT the cap), but the cap is, and that is the half
// that can be acted on.
Deno.test("trojan: a too-large body names the cap and says nothing ran", async () => {
  const c = cell("trbig", {
    state: { n: 0 },
    methods: {
      // deno-lint-ignore no-explicit-any
      take(s: { n: number }, _blob: any) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-trbig-");
  const app = await aio.run({
    cells: [c],
    appId: `trbig-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
  } as never);
  try {
    // 2 MB of payload against a 1 MB cap
    const res = await fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({
        type: "trbig:take",
        payload: { args: ["x".repeat(2 * 1024 * 1024)] },
      }),
    });
    assertEquals(res.status, 413);
    const body = await res.json() as { error?: string };
    const msg = body.error ?? "";
    assertStringIncludes(msg, "1 MB cap");
    assertStringIncludes(msg, "NOTHING was executed");

    // …and the refusal really did refuse: the method never ran.
    const st = await fetch(`http://127.0.0.1:${port}/__aio/trojan/state`);
    const state = await st.json() as { trbig: { n: number } };
    assertEquals(state.trbig.n, 0, "a refused body must not have been applied");
  } finally {
    await app.close();
  }
});

// One sentence, four callers — each names its own route so an operator knows
// which call was refused.
Deno.test("trojan: every bounded route shares one message, named per route", () => {
  for (const what of ["action", "trigger", "time-travel", "query"]) {
    const m = tooLargeMessage(what);
    assertStringIncludes(m, what);
    assertStringIncludes(m, "1 MB cap");
  }
});
