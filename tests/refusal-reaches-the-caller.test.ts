// A refused write answers the caller the SAME way in process and over the wire.
//
// Measured, on one app, one cell, one method:
//
//   over the wire  →  ack { ok: false, code: "ACTION_REFUSED",
//                           error: "n must not be negative" }   → await REJECTS
//   in process     →  await RESOLVES undefined, state unchanged
//
// Same app code, two different answers about whether the write landed. The
// wire is right — `action-ack.ts` is the one decider for "did this action
// actually DO anything?" and every transport asks it — and the in-process path
// is the one that has never asked: `ownerRan` is true (the method DID run) and
// the refusal came after it, so the branch that would reject is skipped.
//
// The aligned behaviour cannot become the DEFAULT in 1.x: an app that does
// `await c.method(); if (c.x !== want) …` in process gets a rejection where it
// had a value, and an uncaught one takes out its handler. So it is opt-in
// (`refusalsReject: true`), the default is untouched, and dev SAYS the
// divergence out loud so it is discoverable rather than surprising.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";

function mk(id: string) {
  return cell(id, {
    state: { n: 0 },
    methods: {
      setNeg(s: { n: number }) {
        s.n = -1;
      },
      setOk(s: { n: number }) {
        s.n = 5;
      },
    },
    validate: (s: { n: number }) => s.n >= 0 || "n must not be negative",
  });
}

async function boot(c: unknown, extra: Record<string, unknown> = {}) {
  return await aio.run({
    cells: [c],
    appId: `refusal-${Deno.pid}-${Math.random().toString(36).slice(2, 7)}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port: 0,
    baseDir: await tempDir("aio-refusal-"),
    dbPath: ":memory:",
    ...extra,
  } as never);
}

Deno.test("refusal: the default still resolves — nobody's app changes", async () => {
  const c = mk("refdefault");
  const app = await boot(c);
  try {
    // deno-lint-ignore no-explicit-any
    const anyc = c as any;
    await anyc.setOk();
    assertEquals(await anyc.setNeg(), undefined, "today's answer, unchanged");
    assertEquals(anyc.n, 5, "and the refused write still did not land");
  } finally {
    await app.close();
  }
});

Deno.test("refusal: refusalsReject makes in-process agree with the wire", async () => {
  const c = mk("refopt");
  const app = await boot(c, { refusalsReject: true });
  try {
    // deno-lint-ignore no-explicit-any
    const anyc = c as any;
    await anyc.setOk();
    let msg = "";
    try {
      await anyc.setNeg();
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg !== "", "the refused write must reject the caller");
    assertStringIncludes(msg, "n must not be negative");
    assertEquals(anyc.n, 5, "state is the same either way");

    // A write that is NOT refused is unaffected by the flag.
    assertEquals(await anyc.setOk(), undefined);
  } finally {
    await app.close();
  }
});

Deno.test("refusal: dev says the divergence out loud", async () => {
  setDevModeOverride(true);
  const c = mk("refwarn");
  // BOOT FIRST, then capture: `aio.run()` installs the app's own logger, so a
  // sink set before it is replaced on the way up (this test asserted an empty
  // list for exactly that reason before the order was fixed).
  const app = await boot(c);
  const warns: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _c: string, m: string) => {
        if (lvl === "warn") warns.push(m);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    // deno-lint-ignore no-explicit-any
    await (c as any).setNeg();
    const hit = warns.find((w) => w.includes("refwarn:setNeg"));
    assert(
      hit,
      `dev must name the swallowed refusal: ${warns.join(" | ") || "(none)"}`,
    );
    assertStringIncludes(hit, "refusalsReject");
    assertStringIncludes(hit, "over the wire");
  } finally {
    setLogger(prev);
    setDevModeOverride(null);
    await app.close();
  }
});
