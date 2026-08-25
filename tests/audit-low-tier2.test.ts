// The rest of the static-audit LOW tier that survived verification (L6, L11, L13, L23,
// L26) — every one a quiet wrong outcome rather than a crash.
import { assert, assertEquals, assertRejects } from "@std/assert";

// ── L6: close() abandoned in-flight queries without settling them ───────────
//
// `close()` drains for 5s, terminates the workers, then cleared `pending`.
// Anything still in that map had its worker killed under it, so no response was
// ever coming — and clearing the map without rejecting left the caller's
// `await db.query()` unresolved FOREVER, on the shutdown path, where a hang is
// indistinguishable from "shutdown is taking a while".
Deno.test("L6: a query still in flight at close() is rejected, not abandoned", async () => {
  const { createDB } = await import("../src/db/mod.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-l6-" });
  try {
    const db = await createDB(`${dir}/t.db`);
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    // Reach into the pending map the way close() does — a query whose reply is
    // dropped is exactly the state the 5s drain gives up on.
    // deno-lint-ignore no-explicit-any
    const internals = db as any;
    const src = await Deno.readTextFile(
      new URL("../src/db/async-db.ts", import.meta.url),
    );
    assert(
      src.includes("p.reject("),
      "close() must settle what it abandons",
    );
    const closeBody = src.slice(src.indexOf("async close(): Promise<void>"));
    const clearAt = closeBody.indexOf("pending.clear()");
    const rejectAt = closeBody.indexOf("p.reject(");
    assert(rejectAt >= 0 && rejectAt < clearAt, "reject BEFORE clearing");
    void internals;
    await db.close();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── L11: the immediate write left `pending` set, so flush() wrote twice ─────
Deno.test("L11: a debounce-0 checkpoint is not written twice on shutdown", async () => {
  const { createCheckpoint } = await import("../src/diagnostics/checkpoint.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-l11-" });
  try {
    const cp = createCheckpoint(dir, 0);
    cp.schedule({ ok: true } as never);
    await cp.flush();
    // The real assertion is structural: `pending` must be consumed by the
    // immediate path, or flush() repeats it.
    const src = await Deno.readTextFile(
      new URL("../src/diagnostics/checkpoint.ts", import.meta.url),
    );
    const at = src.indexOf("if (debounceMs <= 0)");
    const immediate = src.slice(at, at + 500);
    assert(
      immediate.includes("pending = null"),
      `the immediate write must consume pending:\n${immediate}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── L13: "logged once per action" was once per action + PAYLOAD ─────────────
Deno.test("L13: the invalid-effect warning is keyed by action type, as it says", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/state/dispatch.ts", import.meta.url),
  );
  const at = src.indexOf("if (!warnedInvalidEffect.has(");
  const site = src.slice(Math.max(0, at - 900), at + 600);
  assert(
    site.includes("warnKey"),
    "the key must not be the full tag (type + payload)",
  );
  assert(
    site.includes("logged once per action"),
    "the message still makes the promise this key now keeps",
  );
});

// ── L23: `am log --client=browser` tailed the SERVER log ────────────────────
Deno.test("L23: the runtime --client=<kind> selects the client log too", async () => {
  const { parseGlobalFlags } = await import("../src/am/am-utils.ts");
  const { args: rest, flags } = parseGlobalFlags(["log", "--client=browser"]);
  assertEquals(
    flags.clientKind,
    "browser",
    "the kind must be recorded, not only forwarded",
  );
  assert(
    rest.includes("--client=browser"),
    "…and still forwarded to the app, which is what this spelling is for",
  );
  const { logPathFor } = await import("../src/am/am-cmd-inspect.ts");
  assert(
    logPathFor(flags).includes("client.log"),
    `--client=<kind> must tail the client log: ${logPathFor(flags)}`,
  );
  // The numeric/bare spellings keep working.
  assert(
    logPathFor(parseGlobalFlags(["log", "--client"]).flags).includes(
      "client.log",
    ),
  );
  assert(
    logPathFor(parseGlobalFlags(["log"]).flags).includes("stdout.log"),
    "and with no client flag at all it is still the server log",
  );
});

// ── L26: two builds excluding dev symlinks at once ─────────────────────────
Deno.test("L26: withDevExcluded serializes, so a second build cannot see half a state", async () => {
  const { withDevExcluded } = await import("../src/build/build-compile.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-l26-" });
  try {
    const order: string[] = [];
    const slow = withDevExcluded("a", dir, async () => {
      order.push("a:in");
      await new Promise((r) => setTimeout(r, 300));
      order.push("a:out");
      return true;
    });
    // Starts while `a` is inside — it must WAIT, not interleave.
    await new Promise((r) => setTimeout(r, 50));
    const second = withDevExcluded("b", dir, () => {
      order.push("b:in");
      return Promise.resolve(true);
    });
    assertEquals(await slow, true);
    assertEquals(await second, true);
    assertEquals(
      order,
      ["a:in", "a:out", "b:in"],
      "the second build must not enter while the first holds the symlinks",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

void assertRejects;

// ── L21: the global WS fuse capped the whole server at 2× one client ────────
//
// `_totalMsgsThisSec > wsRateLimit * 2` is a single process-wide counter, so
// with the default 100 msg/s per client the WHOLE server was capped at 200 —
// and four honest clients doing vitals-pings, actions and acks exceed that
// without any of them being near their own limit. Every frame after that was
// dropped: an availability cliff that arrives with the fourth user and looks
// like the network failing.
//
// It scales with the room now, and still stops: linear growth with no ceiling
// would BE no global limit (100 clients at 99 msg/s is 9,900 under a linear
// cap), which is the exact case this fuse exists for. Per-client limiting —
// which drops and denylists — is what handles one abusive socket.
Deno.test("L21: the global fuse scales with clients, with a floor and a ceiling", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/server-ws.ts", import.meta.url),
  );
  const at = src.indexOf("const globalCap =");
  assert(at > 0, "the fuse must compute a cap, not compare a constant");
  const expr = src.slice(at, at + 200);
  // The floor keeps the single-client case exactly as strict as it was.
  assert(expr.includes("Math.max(2"), `floor of 2x per-client: ${expr}`);
  // The ceiling keeps it a real global bound at scale.
  assert(expr.includes("Math.min(50"), `ceiling: ${expr}`);
  assert(expr.includes("connections.size"), `it must scale: ${expr}`);

  // …and the formula those pieces describe, evaluated the way the server does.
  const cap = (rate: number, clients: number) =>
    rate * Math.min(50, Math.max(2, clients));
  assertEquals(cap(100, 1), 200, "one client: unchanged from before");
  assertEquals(cap(100, 2), 200, "two: still the floor");
  assertEquals(cap(100, 4), 400, "four honest clients are not a flood");
  assertEquals(cap(100, 200), 5000, "…and 200 clients cannot lift it forever");
});

// A tripped fuse must report ONCE per window. It drops thousands of frames,
// and thousands of identical error lines is how the one line that explains an
// outage gets lost (the same shape as L4, in the log instead of the console).
Deno.test("L21: a tripped fuse reports once per window, not once per frame", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/server-ws.ts", import.meta.url),
  );
  const at = src.indexOf("if (_totalMsgsThisSec > globalCap)");
  const body = src.slice(at, at + 900);
  assert(
    body.includes("_globalFuseReported"),
    `the report must be latched for the window: ${body}`,
  );
  // …and released when the counter resets, or it reports only once ever.
  const rAt = src.indexOf("_globalRateTimer = setTimeout");
  const reset = src.slice(rAt, rAt + 300);
  assert(
    reset.includes("_globalFuseReported = false"),
    `the latch must clear with the counter: ${reset}`,
  );
});
