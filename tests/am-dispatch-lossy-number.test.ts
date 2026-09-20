// `am dispatch` auto-parses each value as JSON, and JSON.parse ROUNDS a number
// it cannot hold. A 19-digit id — a Discord/Twitter snowflake, a card or
// account number — arrived as a different number, and `1e400` as `Infinity`,
// which the wire then carries as `null`:
//
//   am dispatch bot:setChannel 1234567890123456789
//   → {"ok":true}, state.channel === 1234567890123456800
//
// A different id under `ok` is silent data loss, so it is refused at the
// keystroke, naming the literal and both spellings that ARE exact: a JSON
// string, or a number that fits.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { cmdDispatch, lossyNumberLiteral } from "../src/am/am-cmd-state.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const APP = "am-dispatch-lossy-app";
const CELL = "am-dispatch-lossy";

const store = cell(CELL, {
  state: { last: "", calls: 0 },
  methods: {
    set(s: { last: string; calls: number }, ...v: unknown[]) {
      s.last = JSON.stringify(v);
      s.calls++;
    },
  },
});

Deno.test("lossyNumberLiteral: names the literal JSON cannot hold exactly", () => {
  assertEquals(
    lossyNumberLiteral("1234567890123456789"),
    "1234567890123456789",
  );
  assertEquals(lossyNumberLiteral("-9007199254740993"), "-9007199254740993");
  assertEquals(lossyNumberLiteral("1e400"), "1e400");
  assertEquals(
    lossyNumberLiteral('[1, {"id": 99999999999999999}]'),
    "99999999999999999",
  );
  // Exact — never refused.
  for (
    const ok of [
      "9007199254740991",
      "-9007199254740991",
      "0.1",
      "1e21",
      "-0",
      '"1234567890123456789"',
      "[1,2]",
      "not json",
      "true",
    ]
  ) assertEquals(lossyNumberLiteral(ok), null, ok);
});

// The refusal is for a number that CHANGES, not for every integer past 2^53.
// Plenty of them are doubles exactly — 2^53 itself, every even number just
// above it, 10^20 — and those were refused with "it would reach the method as
// 9007199254740992, a different value", naming the very number typed.
//
// The reference: an integer literal is exact when the value JSON.parse gives
// back IS that integer (BigInt equality) AND prints back as that literal (what
// the wire, `am state` and every JSON consumer will show). Anything else is
// lossy; a non-finite value always is; a fraction or exponent spelling is
// never judged (0.1 is inexact by nature, and nobody expects otherwise).
function lossyReference(src: string): boolean {
  const v = JSON.parse(src) as number;
  if (!Number.isFinite(v)) return true;
  if (!/^-?\d+$/.test(src)) return false;
  if (v === 0) return false; // `-0` arrives as 0, the same number
  return !(String(v) === src && BigInt(v) === BigInt(src));
}

Deno.test("lossyNumberLiteral: agrees with the exactness reference — no false refusals, no misses", () => {
  const fixed = [
    "9007199254740992", // 2^53 — exact
    "-9007199254740992",
    "9007199254740994", // 2^53 + 2 — exact
    "18014398509481984", // 2^54 — exact
    "100000000000000000000", // 10^20 — exact
    "123456789012345680", // exact
    "9007199254740993", // rounds
    "99999999999999999", // rounds
    "1152921504606846976", // 2^60 — exact, but prints as …847000
    "1152921504606847000", // prints as typed, but IS 2^60
    "18446744073709551616",
    "1000000000000000000000",
    "123456789012345678901234567890",
    "1e400",
    "-1e400",
    "1.8e308",
    "1e-400",
    "1e308",
    "-0",
    "0",
    "5e0",
    "0.5",
  ];
  let seed = 0x5eed;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const drawn: string[] = [];
  for (let i = 0; i < 20000; i++) {
    let s: string;
    if (rnd(3) === 0) {
      // A power of two times a small odd factor: exact, and often not.
      s = String(2n ** BigInt(53 + rnd(20)) * BigInt(1 + 2 * rnd(8)));
    } else {
      s = String(1 + rnd(9));
      const len = 15 + rnd(8);
      for (let j = 1; j < len; j++) s += String(rnd(10));
    }
    drawn.push(rnd(4) === 0 ? `-${s}` : s);
  }
  for (const lit of [...fixed, ...drawn]) {
    const want = lossyReference(lit);
    assertEquals(
      lossyNumberLiteral(lit) !== null,
      want,
      `${lit} (parses to ${String(JSON.parse(lit))}) is ${
        want ? "lossy" : "exact"
      }`,
    );
    // Nested, the same verdict.
    assertEquals(
      lossyNumberLiteral(`{"a":[1,${lit}]}`),
      want ? lit : null,
      `nested ${lit}`,
    );
  }
});

/** Run cmdDispatch, turning its `Deno.exit(1)` into a return value. */
async function run(
  args: string[],
  flags: Partial<GlobalFlags>,
  port: number,
): Promise<{ exited: number | null; err: string }> {
  const realExit = Deno.exit;
  const realLog = console.log;
  const realErr = console.error;
  let err = "";
  // `--json` output: a refusal is `{"error": …}` on stdout.
  console.log = console.error = (...a: unknown[]) => {
    err += a.join(" ") + "\n";
  };
  const EXIT = Symbol("exit");
  let code: number | null = null;
  (Deno as { exit: (c?: number) => never }).exit = (c?: number) => {
    code = c ?? 0;
    throw EXIT;
  };
  try {
    await cmdDispatch(args, {
      app: APP,
      port,
      json: true,
      ...flags,
    } as GlobalFlags);
  } catch (e) {
    if (e !== EXIT) throw e;
  } finally {
    Deno.exit = realExit;
    console.log = realLog;
    console.error = realErr;
  }
  return { exited: code, err };
}

Deno.test({
  name: "am dispatch: a number JSON would round is refused, never sent rounded",
  async fn() {
    _resetInstanceVerify();
    await using srv = await testServer<
      Record<string, { last: string; calls: number }>
    >({ cells: [store], appId: APP });
    const calls = () => srv.state()[CELL]!.calls;

    // Control: an exact number and a quoted id go through verbatim.
    let r = await run(
      [`${CELL}:set`, "42", '"1234567890123456789"'],
      {},
      srv.port,
    );
    assertEquals(r.exited, null, r.err);
    assertEquals(srv.state()[CELL]!.last, '[42,"1234567890123456789"]');
    // Past 2^53 but a double EXACTLY, printing back as typed: sent as is.
    r = await run([`${CELL}:set`, "9007199254740992"], {}, srv.port);
    assertEquals(r.exited, null, r.err);
    assertEquals(srv.state()[CELL]!.last, "[9007199254740992]");
    // Prints back as typed, yet IS 2^60: refused, naming the exact value.
    r = await run([`${CELL}:set`, "1152921504606847000"], {}, srv.port);
    assertEquals(r.exited, 1, r.err);
    assertStringIncludes(r.err, "1152921504606846976");

    for (
      const [args, flags] of [
        [[`${CELL}:set`, "1234567890123456789"], {}],
        [[`${CELL}:set`, "1e400"], {}],
        [[`${CELL}:set`, "id=1234567890123456789"], {}],
        [[`${CELL}:set`], { jsonArgs: "[1234567890123456789]" }],
        [[`${CELL}:set`], { jsonBody: '{"id":1234567890123456789}' }],
      ] as [string[], Partial<GlobalFlags>][]
    ) {
      const before = calls();
      r = await run(args, flags, srv.port);
      const what = JSON.stringify([args, flags]);
      assertEquals(r.exited, 1, `must be refused: ${what}`);
      assertEquals(calls(), before, `must not reach the method: ${what}`);
      assertStringIncludes(r.err, "cannot hold", what);
    }
  },
});
