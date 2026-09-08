// console-intercept — forwards browser console.* + uncaught errors to the
// dev server. When it silently breaks, dev diagnostics vanish and (by
// definition) nobody notices. Pin serialize/forward/install/uninstall.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _serialize,
  installConsoleIntercept,
  uninstallConsoleIntercept,
} from "../src/browser/console-intercept.ts";
import { dec } from "../src/protocol/envelope.ts";

Deno.test("_serialize: strings pass through, objects JSON, errors readable, circular safe", () => {
  assertEquals(_serialize(["hello", 42]), "hello 42");
  assertStringIncludes(_serialize([{ a: 1 }]), '"a":1');
  assertStringIncludes(_serialize([new Error("boom")]), "boom");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  // Must not throw on a circular reference.
  assert(typeof _serialize([circular]) === "string");
});

Deno.test("console intercept: forwards console.* and restores on uninstall", () => {
  const sent: string[] = [];
  try {
    installConsoleIntercept((msg) => sent.push(msg));
    console.log("via", "intercept");
    console.error("bad");
    assertEquals(sent.length, 2);
    // Frames are the v2 "log" envelope; decode the first.
    const frame = dec(sent[0]!) as {
      t: string;
      d: { level: string; msg: string };
    };
    assertEquals(frame.t, "log");
    assertEquals(frame.d.level, "info");
    assertStringIncludes(frame.d.msg, "via intercept");
    const errFrame = dec(sent[1]!) as { d: { level: string } };
    assertEquals(errFrame.d.level, "error");
  } finally {
    uninstallConsoleIntercept();
  }
  // After uninstall, nothing more is captured (functional restore — the
  // rebound original is not reference-identical, so assert behavior).
  const before = sent.length;
  console.log("post-uninstall");
  assertEquals(sent.length, before, "no capture after uninstall");
});

Deno.test("console intercept: forwards uncaught error events", () => {
  const sent: string[] = [];
  try {
    installConsoleIntercept((msg) => sent.push(msg));
    const evt = new ErrorEvent("error", {
      error: new Error("uncaught-boom"),
      message: "uncaught-boom",
    });
    evt.preventDefault?.();
    globalThis.dispatchEvent(evt);
    const logFrame = sent
      .map((s) => dec(s) as { d: { level: string; msg: string } })
      .find((f) => f.d.msg.includes("uncaught"));
    assert(logFrame, "an uncaught error was forwarded");
    assertEquals(logFrame!.d.level, "error");
  } finally {
    uninstallConsoleIntercept();
  }
});

// The line has to say WHERE it was written.
//
// Every forwarded line used to arrive attributed to the interceptor:
//
//   [gate] start, mouth led by 0ms   (aio://app/__aio/browser/console-intercept.ts:73)
//   [capture] camera off — captions … (aio://app/__aio/browser/console-intercept.ts:73)
//
// Always the same location, whatever emitted it. Plain devtools, Vite, Next and
// every Node logger report the CALLER's file and line. The interception itself
// is a genuine feature — a field report calls renderer logs reaching the server
// log the best thing in the framework — and it traded away the one piece of
// metadata that makes a log line actionable. That report ended up prefixing
// every message by hand (`[gate]`, `[capture]`, `[decode]`) to recover what the
// runtime already knew and threw away.
Deno.test("console intercept: the forwarded entry carries the CALLER's location", () => {
  const sent: string[] = [];
  try {
    installConsoleIntercept((msg) => sent.push(msg));
    console.warn("[gate] start");
  } finally {
    uninstallConsoleIntercept();
  }
  const entries = sent
    .map((m) => dec(m))
    .filter((f) => f !== null && f.t === "log")
    .map((f) => f!.d as { source?: string; msg: string });
  assertEquals(entries.length, 1, JSON.stringify(sent));
  const src = entries[0]!.source;
  // Best-effort by construction — `Error.stack` is not standardised, so an
  // engine that formats it differently yields nothing and the line is exactly
  // what it was before. What must NEVER happen is naming the interceptor.
  if (src !== undefined) {
    assert(
      !src.includes("console-intercept"),
      `the interceptor named ITSELF — that is the bug: ${src}`,
    );
    assert(
      src.includes("console-intercept.test"),
      `it must name the caller's file: ${src}`,
    );
  }
});
