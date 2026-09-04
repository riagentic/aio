// The mirror of `wire-serves.test.ts`.
//
// That gate pins RECEIVERS: a kind in `FRAME_KINDS` that no router switches on
// is red. Nothing pinned the other direction — and `proto-err` was the proof
// that it matters: a fully declared, fully routed, catalog-recorded S→C frame
// kind (`envelope.ts`, `browser-shared.ts`, `cli-client.ts`) that NOTHING ever
// sent. Every protocol refusal went out as the legacy v1 string instead, so
// the structured refusal the client was ready to handle never arrived and the
// only reason it looked fine is that the client reached the same verdict on
// its own, from the server's hello.
//
// A declared kind with no sender is dead wiring that reads as a working
// feature. This makes that class unshippable.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { SERVES } from "../src/protocol/envelope.ts";

const SRC = new URL("../src/", import.meta.url).pathname;

/** Kinds sent by a call whose kind is a VARIABLE, not a literal — each with
 *  the site that sends it. A literal scan cannot see these; leaving them out
 *  would make the gate lie in the safe direction, which is how the receiver
 *  gate's own class of bug got in. */
const SENT_INDIRECTLY: Record<string, string> = {
  // `const signal = wasFullReload ? "reload" : "css"` → `enc(signal)`
  reload: "src/server/server-watcher.ts (enc(signal))",
  css: "src/server/server-watcher.ts (enc(signal))",
};

async function readAll(dir: string): Promise<string> {
  let out = "";
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) out += await readAll(p);
    else if (e.name.endsWith(".ts")) out += await Deno.readTextFile(p);
  }
  return out;
}

Deno.test("every frame kind a client ROUTES is a frame kind something SENDS", async () => {
  const src = await readAll(SRC);
  const sent = new Set(
    [...src.matchAll(/\benc(?:Raw)?\(\s*"([a-z-]+)"/g)].map((m) => m[1]!),
  );
  // The browser router is the S→C surface: everything it switches on must
  // have a sender on this side of the wire.
  const orphans = [...SERVES.browser]
    .filter((k) => !sent.has(k) && !(k in SENT_INDIRECTLY))
    .sort();
  assertEquals(
    orphans,
    [],
    "declared + routed frame kind(s) that nothing sends — dead wiring that " +
      "reads as a working feature. Send it, or drop it from the catalog.",
  );
  // …and no stale excuse: an entry here whose kind IS sent literally now is a
  // comment that has stopped being true.
  const staleExcuses = Object.keys(SENT_INDIRECTLY).filter((k) => sent.has(k));
  assertEquals(
    staleExcuses,
    [],
    "SENT_INDIRECTLY names a kind that is now sent literally — drop the entry",
  );
});
