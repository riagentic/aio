// An untagged `log.x("msg")` is tagged by WHERE it was called from: the
// framework's own src/ → `aio`, anything else (an app, a test) → `app`.
// Explicit tags are untouched.
import { assertEquals } from "@std/assert";
import {
  frameIsFramework,
  getLogger,
  inferTag,
  log,
  setLogger,
} from "../src/diagnostics/logger-api.ts";
import type { LogLevel, LogSink } from "../src/diagnostics/logger-types.ts";
import { parseCli } from "../src/server/aio-cli.ts";

function capture(): { sink: LogSink; cats: string[] } {
  const cats: string[] = [];
  const sink = {
    logDir: "/tmp",
    pub(_l: LogLevel, cat: string) {
      cats.push(cat);
    },
  } as unknown as LogSink;
  return { sink, cats };
}

Deno.test("logger tag: a call from a test file is `app`; explicit tag unchanged", () => {
  const prev = getLogger();
  const { sink, cats } = capture();
  setLogger(sink);
  try {
    log.info("bridge: hello");
    log.error("bridge: boom", { k: 1 });
    log.warn("net", "explicit");
    assertEquals(cats, ["app", "app", "net"]);
  } finally {
    setLogger(prev);
  }
});

Deno.test("logger tag: a call from src/server is `aio`", () => {
  const prev = getLogger();
  const { sink, cats } = capture();
  setLogger(sink);
  try {
    parseCli(["--port=abc"]); // src/server/aio-cli.ts warns, untagged
    assertEquals(cats, ["aio"]);
  } finally {
    setLogger(prev);
  }
});

Deno.test("inferTag: pure on an injected stack; framework src/ and dep/aio + jsr shapes", () => {
  const here = new URL("../src/", import.meta.url).href;
  const fw = `Error\n    at x (${here}server/aio.ts:1:1)`;
  const app = `Error\n    at y (file:///home/u/app/src/app.ts:1:1)`;
  const viaLogger =
    `Error\n    at emit (${here}diagnostics/logger-api.ts:9:9)\n    at z (file:///home/u/app/cell.ts:2:2)`;
  assertEquals(inferTag(fw), "aio");
  assertEquals(inferTag(app), "app");
  assertEquals(inferTag(viaLogger), "app");
  assertEquals(inferTag("Error"), "aio"); // no frame → the old default
  assertEquals(
    frameIsFramework(`    at q (${here}state/dispatch.ts:3:3)`),
    true,
  );
  assertEquals(
    frameIsFramework("    at q (file:///x/tests/a.test.ts:3:3)"),
    false,
  );
});
