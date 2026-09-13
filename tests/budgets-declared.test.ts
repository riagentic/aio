// `aio.run({ budgets })` — the limits an APP declares, in human units.
//
// A field report asked for it and said why it beats aio picking a number
// (report 2 §9.3): a dashboard pushing a 4 MB table once a minute and a game loop
// pushing 200 bytes at 60 Hz are both healthy, and no single threshold calls
// them both correctly.
//
// NOT A SECOND MECHANISM. Every limit here already existed and was reachable —
// a hard-coded 1 MiB inside the broadcaster, and `vitals.pressure`'s
// rate/payload thresholds. This is one obvious door onto them, which is the
// round's own meta-finding again: aio's features are better than aio's
// discoverability.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  parseRate,
  parseSize,
  resetBudgets,
  resolveBudgets,
  setBudgets,
} from "../src/state/budgets.ts";

Deno.test("sizes parse in the units a person writes", () => {
  assertEquals(parseSize("1MB", "x"), 1024 * 1024);
  assertEquals(parseSize("512KB", "x"), 512 * 1024);
  assertEquals(parseSize("1.5mb", "x"), Math.floor(1.5 * 1024 * 1024));
  assertEquals(parseSize("2048", "x"), 2048);
  assertEquals(parseSize(4096, "x"), 4096, "a number is bytes");
});

Deno.test("rates parse the same way", () => {
  assertEquals(parseRate("20/s", "x"), 20);
  assertEquals(parseRate("20 / sec", "x"), 20);
  assertEquals(parseRate("20 per second", "x"), 20);
  assertEquals(parseRate("60", "x"), 60);
  assertEquals(parseRate(30, "x"), 30);
});

Deno.test("an unreadable budget THROWS, naming the key", () => {
  // Never a fallback. A budget that silently became aio's own default is a
  // limit nobody declared and nobody can see — worse than having none, because
  // the app believes it has one.
  for (const bad of ["lots", "1 gigabyte", "", "-5", "0", "1MBB"]) {
    const e = assertThrows(() => parseSize(bad, "cellState"));
    assert(
      String(e).includes("cellState"),
      `the message must name the key: ${e}`,
    );
  }
  for (const bad of ["fast", "20/minute", "0", "-1"]) {
    assertThrows(() => parseRate(bad, "broadcastRate"));
  }
  // Zero is refused with its own reason: it would refuse everything, including
  // an empty cell and the very first broadcast.
  assert(
    String(assertThrows(() => parseSize("0", "cellState"))).includes("zero"),
  );
  assert(
    String(assertThrows(() => parseRate("0", "broadcastRate"))).includes(
      "zero",
    ),
  );
});

Deno.test("resolveBudgets carries only what was declared", () => {
  assertEquals(resolveBudgets(undefined), {});
  assertEquals(resolveBudgets({}), {});
  assertEquals(
    resolveBudgets({ cellState: "1MB", broadcastRate: "20/s" }),
    { cellState: 1024 * 1024, broadcastRate: 20 },
  );
  // An undeclared key stays ABSENT, not zero — absent means "aio's own number
  // applies", and zero would mean "refuse everything".
  assertEquals(resolveBudgets({ payload: "1KB" }).cellState, undefined);
});

Deno.test("a breach is recorded once, keeping the WORST reading", () => {
  try {
    const l = setBudgets(resolveBudgets({ cellState: "1KB" }));
    l.record("cellState", 2048, 'cell "big"');
    l.record("cellState", 8192, 'cell "bigger"');
    l.record("cellState", 3000, 'cell "middling"');
    const r = l.report()!;
    assertEquals(r.ok, false);
    assertEquals(r.breaches.length, 1, "one budget, one row");
    assertEquals(
      r.breaches[0]!.worst,
      8192,
      "a later healthy sample must not erase it",
    );
    assertEquals(r.breaches[0]!.limit, 1024);
    assertEquals(r.breaches[0]!.detail, 'cell "bigger"');
  } finally {
    resetBudgets();
  }
});

Deno.test("a reading UNDER the limit is not a breach", () => {
  try {
    const l = setBudgets(resolveBudgets({ cellState: "1KB" }));
    l.record("cellState", 1024, "exactly at it");
    l.record("cellState", 1, "well under");
    assertEquals(l.report(), { ok: true, breaches: [] });
  } finally {
    resetBudgets();
  }
});

Deno.test("an app that declared NOTHING gets null, never a green tick", () => {
  const l = setBudgets(resolveBudgets(undefined));
  // A breach against an undeclared budget is not a breach — aio's own numbers
  // are hints, not commitments, and reporting them would make /health degraded
  // on every app that never opted in.
  l.record("cellState", 999_999_999, "huge");
  resetBudgets();
  assertEquals(
    l.report(),
    null,
    "a green field for a promise nobody made reads as assurance",
  );
});

Deno.test("the registry is per-app: each setBudgets is its own ledger", () => {
  try {
    const a = setBudgets(resolveBudgets({ cellState: "1MB" }));
    const b = setBudgets(resolveBudgets({ broadcastRate: "5/s" }));
    assertEquals(b.declared().cellState, undefined);
    assertEquals(b.declared().broadcastRate, 5);
    // …and the first app keeps ITS limits and its own breaches.
    assertEquals(a.declared().cellState, 1024 * 1024);
    a.record("cellState", 2 * 1024 * 1024, 'cell "a"');
    assertEquals(a.report()?.ok, false);
    assertEquals(b.report(), { ok: true, breaches: [] });
  } finally {
    resetBudgets();
  }
});

Deno.test("the explicit vitals.pressure spelling still WINS", async () => {
  // The more specific instruction. Silently overriding it would make the
  // narrower spelling the weaker one, which is how two config keys for one
  // fact become a bug.
  const src = await Deno.readTextFile(
    new URL("../src/vitals/mod.ts", import.meta.url),
  );
  const block = src.slice(src.indexOf("const pressureMonitor ="));
  const body = block.slice(0, block.indexOf("onDiagnostic"));
  for (const k of ["payloadThreshold", "rateThreshold"]) {
    const at = body.indexOf(k);
    assert(at > 0, `${k} is no longer wired`);
    const line = body.slice(
      at,
      body.indexOf("\n", body.indexOf("declared", at)),
    );
    assert(
      line.includes("??"),
      `${k} must fall BACK to the budget, not override the explicit value: ${line}`,
    );
  }
});

Deno.test("the declared cellState limit replaces aio's hard-coded one", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/server-broadcast.ts", import.meta.url),
  );
  assert(
    /const limit = budgets\.declared\(\)\.cellState \?\? BROADCAST_FULL_WARN_BYTES/
      .test(src),
    "the broadcaster must prefer the declared budget over its own constant",
  );
  assert(
    !/n > BROADCAST_FULL_WARN_BYTES/.test(src),
    "a second comparison against the constant would ignore the declared budget",
  );
});

Deno.test("end to end: a declared budget reaches /health and turns it degraded", async () => {
  // The unit tests above drive the ledger directly. This one boots a real app,
  // because a correctly-written ledger wired to nothing passes every one of
  // them.
  const { aio, cell } = await import("../mod.ts");
  const { dropTempDir, tempDir } = await import("../src/testing/temp-dir.ts");
  const { freePort } = await import("../src/testing/server-test.ts");
  const dir = await tempDir("budgets-e2e-");
  const port = freePort();
  const big = cell("bigcell", {
    state: { blob: "" },
    methods: {
      fill(s: { blob: string }, n: number) {
        s.blob = "x".repeat(n);
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const app = await aio.run({
    cells: [big],
    appId: `budgets-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    // A tiny limit, so one ordinary write crosses it.
    budgets: { cellState: "2KB" },
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    const read = async () => {
      const r = await fetch(`http://127.0.0.1:${port}/__aio/health`);
      return await r.json() as {
        status: string;
        budgets?: {
          ok: boolean;
          breaches: { budget: string; worst: number }[];
        };
      };
    };
    const before = await read();
    assertEquals(
      before.budgets,
      { ok: true, breaches: [] },
      "a declared budget must APPEAR before it is broken, or nobody can see it",
    );
    assertEquals(before.status, "healthy");

    // deno-lint-ignore no-explicit-any
    await (big as any).fill(20_000);
    await new Promise((r) => setTimeout(r, 150));

    const after = await read();
    assert(
      after.budgets && after.budgets.ok === false,
      `the breach never reached /health: ${JSON.stringify(after.budgets)}`,
    );
    assertEquals(after.budgets!.breaches[0]!.budget, "cellState");
    assert(after.budgets!.breaches[0]!.worst > 2048);
    assertEquals(
      after.status,
      "degraded",
      "a limit that only warns cannot fail a CI step — which is what the " +
        "report asked for",
    );
  } finally {
    await app.close();
    await dropTempDir(dir);
    resetBudgets();
  }
});
