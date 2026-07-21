// perfect-aio B4b (D7) — the wire-frame catalog is THE source of truth.
// These tests pin src/protocol/envelope.ts against the live transports:
// every catalogued prefix must exist in real code (no stale entries), and
// every `__`-prefixed frame the code speaks must be catalogued (no
// undocumented frames).
import { assert, assertEquals } from "@std/assert";
import { unsupportedOnUds, WIRE } from "../src/protocol/envelope.ts";
import { parseAck } from "../src/protocol/transport-shared.ts";

async function readSrc(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.name.endsWith(".ts") && !p.endsWith("protocol/envelope.ts")) {
        out.push({ path: p, text: await Deno.readTextFile(p) });
      }
    }
  };
  await walk("src");
  return out;
}

Deno.test("envelope: every catalogued wire prefix exists in live code", async () => {
  const files = await readSrc();
  for (const [name, prefix] of Object.entries(WIRE)) {
    const hit = files.some((f) =>
      f.text.includes(`"${prefix}"`) ||
      f.text.includes(`"${prefix}` /* prefix + concat */) ||
      f.text.includes(`'${prefix}`)
    );
    assert(
      hit,
      `WIRE.${name} ("${prefix}") not found in src/ — stale catalog entry?`,
    );
  }
});

Deno.test("envelope: every wire prefix the code speaks is catalogued", async () => {
  const files = await readSrc();
  // `__`-strings that are NOT wire frames (globals, action-type infix, keys).
  const NOT_WIRE = [
    "__aio", // internal namespace/globals (__aio, __aioDev, __aioTest…)
    "__proto__", // banned-key filters
    "__error", // action-type suffix, not a frame
    "__op", // JSON discriminator keys (typed in envelope.ts, not prefixes)
    "__sync",
    "__sfn",
    "__sfnr",
    "__op_rejected",
    "__sync_error",
    "__schedule", // effect objects, network-rejected
    "__own",
    "__set", // internal action fragments
    "__exec",
    "__flow",
    "__batch",
    "__init",
    "__esModule", // CJS interop marker (esbuild plugin)
    "__effects", // internal draft-meta key
  ];
  const catalogued = Object.values(WIRE) as string[];
  const speaks =
    /(?:startsWith\(|===\s*)["'](__[a-zA-Z:-]+:?)["']|["'](__[a-zA-Z:-]+:)["']\s*\+/g;
  const misses: string[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(speaks)) {
      const lit = (m[1] ?? m[2])!;
      if (NOT_WIRE.some((n) => lit.startsWith(n))) continue;
      const known = catalogued.some((p) =>
        lit === p || p.startsWith(lit) || lit.startsWith(p)
      );
      if (!known) misses.push(`${f.path}: ${lit}`);
    }
  }
  assertEquals(
    misses,
    [],
    `undocumented wire frames — add them to src/protocol/envelope.ts:\n${
      misses.join("\n")
    }`,
  );
});

Deno.test("envelope: parseAck is the ONE ack parse — survives cids containing ':'", () => {
  assertEquals(parseAck("__ack:abc:1"), { cid: "abc", ok: true });
  assertEquals(parseAck("__ack:a:b:c:0"), { cid: "a:b:c", ok: false });
  assertEquals(parseAck("__notack:x:1"), null);
  assertEquals(parseAck("__ack::1"), null);
});

Deno.test("envelope: UDS rejects WS-only frames loudly (no silent drop)", () => {
  assertEquals(unsupportedOnUds({ __op: { id: "1" } }), "CRDT sync");
  assertEquals(unsupportedOnUds({ __sync: {} }), "CRDT sync");
  assertEquals(unsupportedOnUds({ __sfn: {} }), "serverFns");
  assertEquals(unsupportedOnUds({ type: "counter:inc" }), null);
});
