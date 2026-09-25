// An AbortSignal that is ALREADY aborted when spawn() is called must kill the
// child at once — an `abort` listener added after the fact never fires. The
// Windows branch had only the listener (measured on Windows 11: a pre-aborted
// spawn of `Start-Sleep 20` was still running 8 s later; fixed, killed in
// ~100 ms). Asserted from any OS: the decider directly, and that BOTH
// platform branches route through it.

import { assert, assertEquals } from "@std/assert";
import { _wireAbort } from "../src/server/spawn.ts";

function fakeHandle() {
  let kills = 0;
  return {
    get kills() {
      return kills;
    },
    kill: () => {
      kills++;
      return Promise.resolve({ code: 1, signal: null, success: false });
    },
  };
}

Deno.test("spawn abort: an already-aborted signal kills at once", () => {
  const ac = new AbortController();
  ac.abort();
  const h = fakeHandle();
  _wireAbort(ac.signal, h, "x");
  assertEquals(h.kills, 1);
});

Deno.test("spawn abort: a later abort kills exactly once; no signal never kills", () => {
  const ac = new AbortController();
  const h = fakeHandle();
  _wireAbort(ac.signal, h, "x");
  assertEquals(h.kills, 0);
  ac.abort();
  ac.abort();
  assertEquals(h.kills, 1);
  const none = fakeHandle();
  _wireAbort(undefined, none, "x");
  assertEquals(none.kills, 0);
});

Deno.test("spawn abort: the Windows branch routes its signal through _wireAbort", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/spawn.ts", import.meta.url),
  );
  const start = src.indexOf("function _spawnWindows(");
  assert(start >= 0, "_spawnWindows exists");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  assert(
    body.includes("_wireAbort(opts.signal, handle, cmd)"),
    "_spawnWindows must wire opts.signal via _wireAbort (pre-aborted case)",
  );
  assert(
    !body.includes('addEventListener("abort"'),
    "no hand-rolled listener that misses an already-aborted signal",
  );
});
