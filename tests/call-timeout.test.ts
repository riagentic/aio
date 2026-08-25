// `await cell.method()` used to give up after a hardcoded 30s and blame "the
// effect executor may have crashed or never resolved this call". Almost never
// true: the method was simply still running — and it stayed running, so its
// writes committed later, unannounced, on top of whatever the caller did next.
// A false cause plus a hidden true state, which is exactly what
// `.katana/errors.md` forbids, and it cost a production incident (an NFT queue
// starting new work on top of live work).
//
// Worse, it was a SECOND ceiling: `effectTimeoutMs` bounded the effect, this
// bounded the caller, both 30s, and raising the first left the second in place
// — a knob that looks like it worked. Now there is one ceiling.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  _getCallTimeouts,
  _resetCallTimeouts,
  _setCallTimeouts,
  callTimeoutFor,
  callTimeoutModeFor,
  registerCall,
  resolveCall,
} from "../src/state/cell-impl.ts";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";

Deno.test("call timeout: effectTimeoutMs raises the caller's ceiling too", () => {
  _resetCallTimeouts();
  assertEquals(callTimeoutFor("cell:m"), 30_000, "built-in default");
  _setCallTimeouts(120_000);
  assertEquals(
    callTimeoutFor("cell:m"),
    120_000,
    "raising effectTimeoutMs must raise THIS — the old bug was that it didn't",
  );
  _setCallTimeouts(120_000, { "cell:slow": 600_000 });
  assertEquals(callTimeoutFor("cell:slow"), 600_000, "per-method override");
  assertEquals(callTimeoutFor("cell:m"), 120_000, "others keep the default");
  _resetCallTimeouts();
});

Deno.test("call timeout: 0 waits indefinitely, and arms no timer", async () => {
  _resetCallTimeouts();
  _setCallTimeouts(0);
  assertEquals(callTimeoutFor(), 0);
  const p = registerCall("unbounded-1", "cell:m");
  // No pending timer to leak — Deno's op sanitizer would fail this test if the
  // "forever" path still armed a 30s setTimeout.
  resolveCall("unbounded-1", "done");
  assertEquals(await p, "done");
  _resetCallTimeouts();
});

Deno.test("call timeout: the message states what is true, not a guess", async () => {
  _resetCallTimeouts();
  _setCallTimeouts(20); // fast, deliberately
  const err = await assertRejects(
    () => registerCall("slow-1", "wallet:refresh"),
    Error,
  );
  const msg = String(err);
  assertStringIncludes(msg, "wallet:refresh");
  assertStringIncludes(msg, "stopped waiting after 20ms");
  // The two facts the old message got wrong: WHAT stopped, and what happens
  // to the work that didn't.
  assertStringIncludes(msg, "METHOD did not");
  assertStringIncludes(msg, "writes will still commit");
  // …and how to change it, naming both knobs.
  assertStringIncludes(msg, "effectTimeoutMs");
  assertStringIncludes(msg, 'perfBudget.methods["wallet:refresh"].timeout');
  // No invented cause.
  assertEquals(
    msg.includes("crashed"),
    false,
    `must not assert a crash it cannot know about: ${msg}`,
  );
  _resetCallTimeouts();
});

Deno.test("call timeout: a resolved call clears its timer (no late rejection)", async () => {
  _resetCallTimeouts();
  _setCallTimeouts(30);
  const p = registerCall("ok-1", "cell:m");
  resolveCall("ok-1", 42);
  assertEquals(await p, 42);
  await new Promise((r) => setTimeout(r, 50)); // past the ceiling
  _resetCallTimeouts();
});

// Through a REAL boot, because the failure mode this batch keeps meeting is a
// config key that is typed, documented and read by someone — and never
// carried from `aio.run({...})` to the code that acts on it. A unit test on
// `_setCallTimeouts` proves the mechanism, not the wiring.
Deno.test("call timeout: effectTimeoutMs from aio.run() reaches the caller's ceiling", async () => {
  const slow = cell("ct_boot", {
    state: { done: false },
    methods: {
      async work(s: { done: boolean }) {
        // Longer than the 30s default would ever allow if the ceiling were
        // still hardcoded — but this test does not wait 30s: the assertion is
        // on the RESOLVED ceiling the boot installed, plus a real call that
        // completes well inside it.
        await new Promise((r) => setTimeout(r, 20));
        s.done = true;
        return "finished";
      },
    },
  });
  await using srv = await testServer({
    cells: [slow],
    effectTimeoutMs: 90_000,
    perfBudget: { methods: { "ct_boot:work": { timeout: 300_000 } } },
  });
  assertEquals(
    callTimeoutFor("ct_boot:work"),
    300_000,
    "the per-method override survived the boot",
  );
  assertEquals(
    callTimeoutFor("ct_boot:other"),
    90_000,
    "…and so did effectTimeoutMs, which used to stop at the effect tracker",
  );
  assertEquals(
    await (slow as unknown as { work: () => Promise<string> }).work(),
    "finished",
  );
  void srv;
});

// ── The BROWSER side (alpha40 review): the ack wait must come from the same
// bridged numbers, not its own constant — a hardcoded 15s used to fire first
// and blame "server overloaded or disconnected" for a method that was simply
// still running (< every server ceiling, so the honest server error could
// never reach a browser caller).

Deno.test("browser ack: the ceiling comes from __aioConfig.callTimeouts", async () => {
  const { _registerAck, _rejectAllPending, _setAckGraceMs } = await import(
    "../src/browser/browser-ack.ts"
  );
  const w = globalThis as { __aioConfig?: unknown };
  const prev = w.__aioConfig;
  _setAckGraceMs(5);
  try {
    // Per-method 1ms — the timer fires with the honest message.
    w.__aioConfig = { callTimeouts: { default: 0, methods: { "a:slow": 1 } } };
    const start = _registerAck("cid-slow", { methodKey: "a:slow" });
    const err = await start.then(() => null, (e: Error) => e);
    assertStringIncludes(String(err), "never confirmed the call");
    assertStringIncludes(String(err), "may still be running");
    assertStringIncludes(String(err), 'perfBudget.methods["a:slow"]');

    // default 0 ⇒ wait indefinitely: no timer, still pending after a beat.
    const never = _registerAck("cid-forever", { methodKey: "a:other" });
    let settled = false;
    never.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(settled, false, "0 = wait indefinitely on the browser too");
  } finally {
    _rejectAllPending(new Error("test teardown"));
    _setAckGraceMs(5_000);
    w.__aioConfig = prev;
  }
});

Deno.test("browser ack: a deferred (queued) call starts its clock at SEND, not at queue time", async () => {
  const { _registerAck, _armAckTimer, _rejectAllPending, _setAckGraceMs } =
    await import("../src/browser/browser-ack.ts");
  const w = globalThis as { __aioConfig?: unknown };
  const prev = w.__aioConfig;
  _setAckGraceMs(5);
  try {
    w.__aioConfig = { callTimeouts: { methods: { "a:m": 1 } } };
    const p = _registerAck("cid-queued", {
      methodKey: "a:m",
      deferTimer: true,
    });
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));
    // "Offline" for longer than the ceiling — must NOT reject while queued.
    await new Promise((r) => setTimeout(r, 25));
    assertEquals(settled, false, "no timeout while the call sits in a queue");
    // The transport writes the frame → the clock starts now.
    _armAckTimer("cid-queued");
    const err = await p.then(() => null, (e: Error) => e);
    assertStringIncludes(String(err), "never confirmed the call");
  } finally {
    _rejectAllPending(new Error("test teardown"));
    _setAckGraceMs(5_000);
    w.__aioConfig = prev;
  }
});

Deno.test("browser ack: the page shell bridges the resolved ceilings", async () => {
  const { generateHTML } = await import("../src/server/server-html-gen.ts");
  const html = generateHTML({
    title: "t",
    prod: true,
    hasCSS: false,
    importMap: "{}",
    callTimeouts: { default: 45_000, methods: { "wallet:refresh": 120_000 } },
  });
  assertStringIncludes(html, '"callTimeouts":{"default":45000');
  assertStringIncludes(html, '"wallet:refresh":120000');
});

// ── field report §3.2: the rejection names the fix in ONE line, and `timeout: "warn"`
// makes the ceiling a report that keeps awaiting instead of a rejection that
// misreports live work.

Deno.test('call timeout: the rejection names long:, timeout: "warn" and the serialize mutex', async () => {
  _resetCallTimeouts();
  _setCallTimeouts(20);
  const err = await assertRejects(
    () => registerCall("slow-2", "wallet:refresh"),
    Error,
  );
  const msg = String(err);
  assertStringIncludes(msg, 'long: ["refresh"] on cell("wallet")');
  assertStringIncludes(
    msg,
    'perfBudget.methods["wallet:refresh"].timeout: "warn"',
  );
  assertStringIncludes(msg, "transaction: { serialize: true }");
  assertStringIncludes(msg, "HOLDS the cell's mutex");
  assertStringIncludes(msg, "commit with a sync reducer");
  _resetCallTimeouts();
});

Deno.test('call timeout: timeout: "warn" warns once at the ceiling and KEEPS awaiting', async () => {
  _resetCallTimeouts();
  _setCallTimeouts(20, { "wallet:refresh": "warn", "wallet:other": 500 });
  assertEquals(callTimeoutModeFor("wallet:refresh"), "warn");
  assertEquals(callTimeoutModeFor("wallet:other"), "reject");
  assertEquals(
    callTimeoutFor("wallet:refresh"),
    20,
    "warn fires at the default ceiling",
  );
  assertEquals(callTimeoutFor("wallet:other"), 500, "a number still wins");
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  try {
    const p = registerCall("warn-1", "wallet:refresh");
    await new Promise((r) => setTimeout(r, 60)); // 3× past the ceiling
    const mine = warnings.filter((w) => w.includes("wallet:refresh"));
    assertEquals(mine.length, 1, `exactly one warning: ${warnings}`);
    assertStringIncludes(mine[0]!, "still running after");
    assertStringIncludes(mine[0]!, 'timeout: "warn"');
    assertStringIncludes(mine[0]!, "keeps waiting");
    resolveCall("warn-1", "late but here");
    assertEquals(await p, "late but here", "the caller still gets the value");
  } finally {
    console.warn = orig;
    _resetCallTimeouts();
  }
});

Deno.test('call timeout: timeout: "warn" from aio.run() reaches the caller side', async () => {
  const slow = cell("ct_warn", {
    state: { done: false },
    methods: {
      async work(s: { done: boolean }) {
        await new Promise((r) => setTimeout(r, 5));
        s.done = true;
        return "finished";
      },
    },
  });
  await using srv = await testServer({
    cells: [slow],
    perfBudget: { methods: { "ct_warn:work": { timeout: "warn" } } },
  });
  assertEquals(callTimeoutModeFor("ct_warn:work"), "warn");
  assertEquals(
    await (slow as unknown as { work: () => Promise<string> }).work(),
    "finished",
  );
  void srv;
});

// ── The BROWSER half of `timeout: "warn"` (CLAUDE.md: a per-method flag the
// browser branches on must reach the browser). "warn" rides the cfg frame /
// page shell as-is, and browser-ack keeps awaiting — never rejects.

Deno.test('call timeout: _getCallTimeouts() carries "warn" to the cfg frame', () => {
  _resetCallTimeouts();
  _setCallTimeouts(90_000, { "wallet:refresh": "warn", "wallet:slow": 5 });
  assertEquals(_getCallTimeouts(), {
    default: 90_000,
    methods: { "wallet:slow": 5, "wallet:refresh": "warn" },
  });
  _resetCallTimeouts();
});

Deno.test('browser ack: a "warn" method warns once at the ceiling and KEEPS awaiting', async () => {
  const { _registerAck, _resolveAck, _rejectAllPending, _setAckGraceMs } =
    await import("../src/browser/browser-ack.ts");
  const w = globalThis as { __aioConfig?: unknown };
  const prev = w.__aioConfig;
  _setAckGraceMs(1);
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  try {
    w.__aioConfig = {
      callTimeouts: { default: 5, methods: { "wallet:refresh": "warn" } },
    };
    const p = _registerAck("cid-warn", { methodKey: "wallet:refresh" });
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 40)); // 6× past default+grace
    assertEquals(settled, false, "warn mode must never reject");
    const mine = warnings.filter((x) => x.includes("wallet:refresh"));
    assertEquals(mine.length, 1, `exactly one warning: ${warnings}`);
    assertStringIncludes(mine[0]!, 'timeout: "warn"');
    assertStringIncludes(mine[0]!, "keeps waiting");
    _resolveAck("cid-warn", "late");
    assertEquals(await p, "late", "the browser caller still gets the value");
  } finally {
    console.warn = orig;
    _rejectAllPending(new Error("test teardown"));
    _setAckGraceMs(5_000);
    w.__aioConfig = prev;
  }
});

Deno.test('browser ack: the page shell bridges "warn" unchanged', async () => {
  const { generateHTML } = await import("../src/server/server-html-gen.ts");
  const html = generateHTML({
    title: "t",
    prod: true,
    hasCSS: false,
    importMap: "{}",
    callTimeouts: { default: 45_000, methods: { "wallet:refresh": "warn" } },
  });
  assertStringIncludes(html, '"wallet:refresh":"warn"');
});
