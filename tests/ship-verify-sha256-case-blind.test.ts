// `verifyShipManifest` (aio/ship) compared the binary's digest to the
// manifest's EXACTLY, while the updater's manifest validator accepts an
// UPPERCASE digest (`/^[0-9a-f]{64}$/i` — PowerShell's `Get-FileHash` prints
// it that way) and the updater's own compares are case-blind. A correctly
// signed manifest for the right bytes was "sha256 mismatch" to the public
// verifier and fine to the updater: two verifiers of one manifest, opposite
// verdicts.
import { assert, assertEquals } from "@std/assert";
import {
  buildShipManifest,
  generateSigningKey,
  manifestCore,
  verifyShipManifest,
} from "../src/build/ship.ts";

const ED = { name: "Ed25519" };

async function signCore(text: string, jwk: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", jwk, ED, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    ED,
    key,
    new TextEncoder().encode(text) as BufferSource,
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

Deno.test("ship verify: a signed manifest with an UPPERCASE digest verifies the same bytes", async () => {
  const binary = new TextEncoder().encode("APP 3.0.0 ".repeat(500));
  const keys = await generateSigningKey();
  const m = await buildShipManifest({
    name: "app",
    version: "3.0.0",
    binary,
    sources: [],
  });
  m.sha256 = m.sha256.toUpperCase();
  m.signature = await signCore(manifestCore(m), keys.privateKey);
  m.publicKey = keys.publicKey;

  const ok = await verifyShipManifest(binary, m, {
    key: keys.publicKey,
  });
  assert(ok.ok, `same bytes, same digest in another case: ${ok.reason}`);

  // …and a different binary is still refused.
  const other = new TextEncoder().encode("APP 3.0.1");
  const bad = await verifyShipManifest(other, m, {
    key: keys.publicKey,
  });
  assertEquals(bad.ok, false);
});
