// A call that supplies FEWER arguments than the method declares says so.
//
// Measured on a running app before this landed:
//
//   POST /__aio/trojan/dispatch {"type":"ar:addTwo","payload":{"args":["one"]}}
//   → {"ok":true}   and the row written was {"a":"one"}
//
// `addTwo(s, a, b)` — the declared field `b` simply absent from the row, on
// every client's screen, with the persist guard naming the damage one window
// later. TypeScript catches this for an in-process call; nothing did for a call
// that arrives as DATA (`am dispatch`, the trojan route, a stale client after a
// signature change). The audited shapes (no `args` at all) were already
// refused; a SHORT but present list was not.
//
// A warning, not a refusal, and the reason is exact: `fn.length` stops at the
// first parameter with a default, so a method that defaults in its BODY
// (`reset(s, to) { to ??= 0 }`) reports as requiring an argument it does not,
// and refusing on the count would break a call that works today. So the warning
// also names the spelling that makes optionality visible — `(s, to = 0)` —
// which fixes the ambiguity permanently rather than silencing it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { _resetShortCallWarnings } from "../src/state/cell-methods-internals.ts";

const c = cell("shortcall", {
  state: { rows: [] as unknown[] },
  methods: {
    addTwo(s: { rows: unknown[] }, a: string, b: string) {
      s.rows.push({ a, b });
    },
    resetDefault(s: { rows: unknown[] }, to = 0) {
      s.rows.length = to;
    },
    none(s: { rows: unknown[] }) {
      s.rows.length = 0;
    },
  },
});

const post = (port: number, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify(body),
  });

Deno.test("a short call is named, a complete one is silent", async () => {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  const app = await aio.run({
    cells: [c],
    appId: `shortcall-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: await tempDir("aio-shortcall-"),
    dbPath: ":memory:",
  } as never);
  // Capture AFTER boot: `aio.run()` installs the app's own logger.
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
  _resetShortCallWarnings();
  try {
    // 1 of 2 — the measured case.
    const r = await post(port, {
      type: "shortcall:addTwo",
      payload: { args: ["one"] },
    });
    await r.body?.cancel();
    const hit = warns.find((w) => w.includes("shortcall:addTwo"));
    assert(
      hit,
      `the short call must be named: ${warns.join(" | ") || "(none)"}`,
    );
    assertStringIncludes(hit, "declares 2 arguments and this call passed 1");
    assertStringIncludes(hit, "= 0"); // the signature-default fix

    // …said ONCE for that method and count — a stale client repeats it forever.
    warns.length = 0;
    const again = await post(port, {
      type: "shortcall:addTwo",
      payload: { args: ["two"] },
    });
    await again.body?.cancel();
    assertEquals(warns, [], "once per method and count");

    // A method whose optionality is IN THE SIGNATURE is silent — this is the
    // false positive the refusal could not avoid and the warning must.
    warns.length = 0;
    for (const type of ["shortcall:resetDefault", "shortcall:none"]) {
      const ok = await post(port, { type, payload: { args: [] } });
      await ok.body?.cancel();
    }
    assertEquals(
      warns.filter((w) => w.includes("declares")),
      [],
      "a signature default (or no parameters) is not a short call",
    );
  } finally {
    setLogger(prev);
    await app.close();
  }
});
