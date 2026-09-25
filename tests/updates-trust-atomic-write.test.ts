// The update trust file holds the PINNED release signing key, and `readTrust`
// refuses (throws) on a file it cannot parse — `startUpdates` reads it at
// boot, so an unparseable file stops the app from starting.
//
// It was rewritten in place (truncate, then write) on every routine "you are
// current" check (`etagCurrent`), i.e. every poll. A crash or power cut inside
// that write left a truncated file: the app then refused to boot over a cache
// field. The write is now temp file + fsync + rename, like the pending-update
// marker beside it, so an interrupted write leaves the previous file whole.
import { assertEquals, assertThrows } from "@std/assert";
import {
  pinKey,
  readTrust,
  trustPath,
  writeTrust,
} from "../src/server/updates-check.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const KEY: JsonWebKey = { kty: "OKP", crv: "Ed25519", x: "pinned-key-x" };

/** Simulate a crash inside a write: the bytes reach the target half-written,
 *  then the process "dies" (throws). */
function crashingWrites(): () => void {
  const realText = Deno.writeTextFileSync;
  const realBin = Deno.writeFileSync;
  const half = (path: string | URL, data: string) => {
    realText(path, data.slice(0, Math.floor(data.length / 2)));
    throw new Error("simulated power cut");
  };
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFileSync = (p: string | URL, d: string) => half(p, d);
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeFileSync = (p: string | URL, d: Uint8Array) =>
    half(p, new TextDecoder().decode(d));
  return () => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeTextFileSync = realText;
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeFileSync = realBin;
  };
}

Deno.test("updates trust: an interrupted etag write leaves the pinned key readable", async () => {
  const dir = await tempDir("aio-trust-atomic-");
  try {
    pinKey(dir, KEY, "https://releases.example/app");
    assertEquals(readTrust(dir).key, KEY);
    const restore = crashingWrites();
    try {
      writeTrust(dir, { etagCurrent: `"rel-2.0.0"` }); // best-effort: swallows
      assertThrows(() => pinKey(dir, KEY, "https://releases.example/app"));
    } finally {
      restore();
    }
    // The file the next boot reads is the previous one, whole.
    assertEquals(readTrust(dir).key, KEY);
    // …and no half-written temp file is left beside it.
    const names = [...Deno.readDirSync(dir)].map((e) => e.name);
    assertEquals(names, [trustPath(dir).split(/[\\/]/).pop()]);
  } finally {
    await dropTempDir(dir);
  }
});
