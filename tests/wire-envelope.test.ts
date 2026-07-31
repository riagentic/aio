// perfect-aio B4b (D7) — the wire-frame catalog is THE source of truth.
// These tests pin src/protocol/envelope.ts against the live transports in
// both directions: every kind the code speaks (enc/encRaw) must be in
// FRAME_KINDS, and no code outside the one deliberate shim may speak a v1
// `__prefix:` string.
import { assert, assertEquals } from "@std/assert";
import {
  dec,
  enc,
  encRaw,
  FRAME_KINDS,
  unsupportedOnUds,
  v1PeerReason,
  WIRE,
} from "../src/protocol/envelope.ts";

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

Deno.test("envelope: catalog has no duplicate kinds", () => {
  assertEquals(new Set(FRAME_KINDS).size, FRAME_KINDS.length);
});

Deno.test("envelope: every kind round-trips through enc/dec", () => {
  for (const t of FRAME_KINDS) {
    assertEquals(dec(enc(t)), { v: 2, t });
    assertEquals(dec(enc(t, { x: 1 })), { v: 2, t, d: { x: 1 } });
  }
});

Deno.test("envelope: encRaw agrees with enc for pre-serialized payloads", () => {
  const d = { a: [1, 2], b: "s" };
  assertEquals(encRaw("state", JSON.stringify(d)), enc("state", d));
});

Deno.test("envelope: dec rejects everything that is not a v2 frame", () => {
  assertEquals(dec(""), null);
  assertEquals(dec("__reload"), null); // v1 string frame
  assertEquals(dec("__proto:{}"), null); // v1 hello
  assertEquals(dec("not json"), null);
  assertEquals(dec('{"type":"counter:inc"}'), null); // bare action
  assertEquals(dec('{"$patches":[]}'), null); // bare-JSON state hazard — gone
  assertEquals(dec('{"v":1,"t":"state"}'), null); // wrong version
  assertEquals(dec('{"v":2,"t":"nope"}'), null); // unknown kind
  assertEquals(dec('{"v":2}'), null); // missing kind
});

Deno.test("envelope: every kind the code speaks is catalogued", async () => {
  const files = await readSrc();
  const kinds = new Set<string>(FRAME_KINDS);
  const speaks = /\benc(?:Raw)?\(\s*["']([a-z-]+)["']/g;
  const misses: string[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(speaks)) {
      const k = m[1]!;
      if (!kinds.has(k)) misses.push(`${f.path}: ${k}`);
    }
  }
  assertEquals(
    misses,
    [],
    `undocumented wire kinds — add them to src/protocol/envelope.ts:\n${
      misses.join("\n")
    }`,
  );
});

Deno.test("envelope: no v1 wire prefixes outside the one proto shim", async () => {
  const files = await readSrc();
  // `__`-strings that are NOT wire frames (globals, action-type infix, keys).
  const NOT_WIRE = [
    "__aio", // internal namespace/globals (__aio, __aioDev, __aioTest…)
    "__proto__", // banned-key filters
    "__error", // action-type suffix, not a frame
    "__schedule", // effect objects, network-rejected
    "__own",
    "__set", // internal action fragments
    "__exec",
    "__flow",
    "__batch",
    "__init",
    "__snapshot",
    "__esModule", // CJS interop marker (esbuild plugin)
    "__effects", // internal draft-meta key
  ];
  const shim = Object.values(WIRE) as string[]; // __proto: / __proto-err:
  const speaks = /["'](__[a-zA-Z:_-]+:?)["']/g;
  const misses: string[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(speaks)) {
      const lit = m[1]!;
      if (NOT_WIRE.some((n) => lit.startsWith(n))) continue;
      if (shim.some((p) => lit === p || p.startsWith(lit))) continue;
      misses.push(`${f.path}: ${lit}`);
    }
  }
  assertEquals(
    misses,
    [],
    `v1 wire prefixes must not survive B4b — convert to the envelope:\n${
      misses.join("\n")
    }`,
  );
});

Deno.test("envelope: v1 peers get a readable refusal (the one shim)", () => {
  assertEquals(v1PeerReason("__proto-err:too old"), "too old");
  assert(v1PeerReason('__proto:{"v":1,"min":1}')?.includes("v1"));
  assertEquals(v1PeerReason('{"v":2,"t":"ping"}'), null);
  assertEquals(v1PeerReason("garbage"), null);
});

Deno.test("envelope: UDS serves sync + serverFns + time travel, rejects vitals", () => {
  assertEquals(unsupportedOnUds("vitals-ping"), true);
  assertEquals(unsupportedOnUds("vitals-pong"), true);
  // Time travel flows over UDS now — the Electron panel needs tt-state in and
  // tt-cmd out (tests/tt-uds.test.ts covers the real socket round-trip).
  assertEquals(unsupportedOnUds("tt-cmd"), false);
  assertEquals(unsupportedOnUds("tt-state"), false);
  assertEquals(unsupportedOnUds("op"), false);
  assertEquals(unsupportedOnUds("sync-req"), false);
  assertEquals(unsupportedOnUds("sfn"), false);
  assertEquals(unsupportedOnUds("action"), false);
});
