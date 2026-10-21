// jot §8: `print()` from aio/air — the desktop window's main process prints
// (window.print() is a silent no-op in an Electron window on Linux), a
// browser uses window.print(), and a place with no page says so.
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { print } from "../src/browser/desktop-print.ts";
import * as air from "../src/air.ts";
import * as browserAir from "../src/browser-air.ts";
import * as standaloneAir from "../src/standalone-air.ts";

const g = globalThis as Record<string, unknown>;

function withGlobals(set: Record<string, unknown>, fn: () => void) {
  const old = Object.fromEntries(Object.keys(set).map((k) => [k, g[k]]));
  Object.assign(g, set);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
}

Deno.test("print(): an aio desktop window prints through its main process, not window.print()", () => {
  const did: string[] = [];
  withGlobals({
    __aioIPC: { print: () => did.push("ipc") },
    print: () => did.push("window"),
  }, () => print());
  assertEquals(did, ["ipc"]);
});

Deno.test("print(): a browser page uses window.print()", () => {
  const did: string[] = [];
  withGlobals({ print: () => did.push("window") }, () => print());
  assertEquals(did, ["window"]);
});

Deno.test("print(): no page to print throws — never a silent no-op", () => {
  withGlobals({ __aioIPC: undefined, print: undefined }, () => {
    assertThrows(() => print(), Error, "no page to print");
  });
});

Deno.test("print() is the same function on every aio/air surface", () => {
  assertStrictEquals(air.print, print);
  assertStrictEquals(browserAir.print, print);
  assertStrictEquals(standaloneAir.print, print);
});
