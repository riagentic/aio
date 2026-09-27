// A log call must never throw into the code that made it. `_safeValue` claims
// to make any field value one safe line, and its `safeStringify` fallback
// exists precisely for values JSON.stringify refuses (BigInt, cycles) — but the
// fallback is `String(v)`, which itself throws for a null-prototype object,
// and a `toJSON` returning undefined makes `cap(undefined).length` throw. So
// `log.info("cat", "msg", { reg })` threw a TypeError at the call site —
// typically inside a catch block, where it replaces the error being logged.
import { assert, assertStrictEquals } from "@std/assert";
import { _safeValue, formatText } from "../src/diagnostics/logger-format.ts";
import { log } from "../src/diagnostics/logger-api.ts";

function nullProtoWithBigInt(): Record<string, unknown> {
  const o = Object.create(null) as Record<string, unknown>;
  o.id = 1n; // JSON.stringify refuses → String() fallback → throws
  return o;
}

function tryCall(f: () => unknown): unknown {
  try {
    f();
    return null;
  } catch (e) {
    return e;
  }
}

Deno.test("_safeValue: a null-prototype value JSON refuses renders, not throws", () => {
  const threw = tryCall(() => _safeValue(nullProtoWithBigInt()));
  assertStrictEquals(threw, null, `_safeValue threw: ${threw}`);
});

Deno.test("_safeValue: a toJSON returning undefined renders, not throws", () => {
  const threw = tryCall(() => _safeValue({ toJSON: () => undefined }));
  assertStrictEquals(threw, null, `_safeValue threw: ${threw}`);
});

Deno.test("formatText: an unstringifiable field does not lose the line", () => {
  let line = "";
  const threw = tryCall(() => {
    line = formatText({
      ts: "2026-09-26 00:00:00.000",
      lvl: "error",
      cat: "app",
      msg: "payment failed",
      data: { reg: nullProtoWithBigInt() },
    });
  });
  assertStrictEquals(threw, null, `formatText threw: ${threw}`);
  assert(line.includes("payment failed"));
});

Deno.test("log.info with an unstringifiable field does not throw at the call site", () => {
  const origInfo = console.info;
  console.info = () => {};
  try {
    const threw = tryCall(() =>
      log.info("app", "hello", { reg: nullProtoWithBigInt() })
    );
    assertStrictEquals(threw, null, `log.info threw: ${threw}`);
  } finally {
    console.info = origInfo;
  }
});
