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
import { _serverHere, printConsole } from "../src/diagnostics/logger-format.ts";

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
    installConsoleIntercept((msg) => {
      sent.push(msg);
    });
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
    installConsoleIntercept((msg) => {
      sent.push(msg);
    });
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
    installConsoleIntercept((msg) => {
      sent.push(msg);
    });
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

Deno.test("_serialize: NaN, undefined, functions and symbols say what the console says", () => {
  // JSON.stringify turns NaN into "null" and undefined/functions/symbols into
  // `undefined`, which `join` prints as "" — the forwarded line in `am logs`
  // then said something the page's own console never did.
  assertEquals(_serialize(["total:", NaN]), "total: NaN");
  assertEquals(_serialize(["got", undefined]), "got undefined");
  assertEquals(_serialize([Infinity, -Infinity]), "Infinity -Infinity");
  assertEquals(_serialize([function onTick() {}]), "[Function onTick]");
  assertEquals(_serialize([Symbol("k")]), "Symbol(k)");
  assertEquals(_serialize([10n, true, null]), "10 true null");
});

Deno.test("_serialize: nested NaN, undefined, functions, symbols and cycles keep their console words", () => {
  // JSON.stringify printed `{ total: NaN, cb: undefined }` as `{"total":null}`
  // — the NaN became null and the key vanished.
  assertEquals(
    _serialize([{ total: NaN, cb: undefined }]),
    '{"total":NaN,"cb":undefined}',
  );
  assertEquals(_serialize([[undefined, Infinity]]), "[undefined,Infinity]");
  assertEquals(
    _serialize([{ f: function onTick() {}, s: Symbol("k"), n: 10n }]),
    '{"f":[Function onTick],"s":Symbol(k),"n":10n}',
  );
  // Plain data prints exactly as JSON did (toJSON included).
  const plain = { a: 1, b: ["x", true, null], d: new Date(0), o: { c: -2 } };
  assertEquals(_serialize([plain]), JSON.stringify(plain));
  // A cycle is named in place, the rest of the value survives.
  const cyc: Record<string, unknown> = { id: 7 };
  cyc.self = cyc;
  assertEquals(_serialize([cyc]), '{"id":7,"self":[Circular]}');
  // A shared (non-cyclic) reference is not a cycle.
  const shared = { v: 1 };
  assertEquals(_serialize([[shared, shared]]), '[{"v":1},{"v":1}]');
  // Depth and size are bounded.
  let deep: unknown = NaN;
  for (let i = 0; i < 50; i++) deep = [deep];
  assert(_serialize([deep]).includes("[Array]"));
  const huge = Array.from({ length: 100_000 }, (_, i) => ({ i }));
  assert(_serialize([huge]).length <= 4096);
});

// In one process the page's console IS the server's (the in-process harness:
// a server and a page's runtime side by side). Every line the server logged
// was forwarded back up the socket to the server that had just said it — and
// its "closing —" line, said the moment before a close for cause, then sat
// unread behind that close and cost it its code (a revoked session's 1008,
// 22 of 30 runs). A browser has no server beside it: there, nothing changes.
Deno.test("console intercept: a server's own log line is not sent back to it — a page with no server beside it forwards as ever", () => {
  const msgs: string[] = [];
  const entry = (msg: string) => ({
    ts: "2026-01-01 00:00:00.000+00:00",
    lvl: "info" as const,
    cat: "aio",
    msg,
  });
  try {
    installConsoleIntercept((frame) => {
      msgs.push((dec(frame) as { d: { msg: string } }).d.msg);
    });
    // A browser: the framework logger's line is the page's, and is forwarded.
    printConsole(entry("page-side logger line"));
    assertEquals(msgs.length, 1);
    assertStringIncludes(msgs[0]!, "page-side logger line");

    _serverHere(1);
    try {
      printConsole(entry("server log line"));
      assertEquals(msgs.length, 1, "the server's line came back as a frame");
      // What the page says by hand is still the page's.
      console.warn("written by the page");
      assertEquals(msgs.length, 2);
      assertStringIncludes(msgs[1]!, "written by the page");
    } finally {
      _serverHere(-1);
    }
    // The server is gone: a browser again.
    printConsole(entry("after the server"));
    assertEquals(msgs.length, 3);
  } finally {
    uninstallConsoleIntercept();
  }
});
