// risoto #9 — `aio ship` core: a verifiable release manifest (SHA-256 +
// least-privilege capabilities + optional Ed25519 signature over the digest).
import { assert, assertEquals } from "@std/assert";
import {
  buildShipManifest,
  generateSigningKey,
  sha256Hex,
  shipApp,
  verifyShipManifest,
} from "../src/build/ship.ts";
import type { ShipManifest } from "../src/build/ship.ts";

const bin = (s: string) => new TextEncoder().encode(s);

Deno.test("sha256Hex: deterministic 64-hex digest", async () => {
  const h = await sha256Hex(bin("aio-binary"));
  assertEquals(h.length, 64);
  assertEquals(h, await sha256Hex(bin("aio-binary")));
  assert(h !== await sha256Hex(bin("different")));
});

Deno.test("ship manifest: capabilities + least-privilege run flags, no -A", async () => {
  const m = await buildShipManifest({
    name: "wallet",
    version: "1.0.0",
    binary: bin("BINARY"),
    sources: [{ content: `Deno.dlopen(p, {}); fetch("x");` }], // ffi + net
  });
  assertEquals(m.name, "wallet");
  assertEquals(m.size, 6);
  assertEquals(m.capabilities.ffi, true);
  assertEquals(m.capabilities.net, true);
  assertEquals(m.runFlags, ["--allow-net", "--allow-ffi"]);
  assert(!m.runFlags.includes("-A"));
});

Deno.test("ship manifest: unsigned verifies by SHA-256; a tampered binary fails", async () => {
  const binary = bin("v1.0.0-artifact");
  const m = await buildShipManifest({
    name: "app",
    version: "1",
    binary,
    sources: [],
  });
  assertEquals((await verifyShipManifest(binary, m)).ok, true);
  const tampered = bin("v1.0.0-artifact-EVIL");
  const bad = await verifyShipManifest(tampered, m);
  assertEquals(bad.ok, false);
  assert(bad.reason.includes("sha256"));
});

Deno.test("ship manifest: Ed25519 sign → verify round-trip", async () => {
  const binary = bin("signed-artifact");
  const keys = await generateSigningKey();
  const m = await buildShipManifest({
    name: "app",
    version: "1",
    binary,
    sources: [],
    sign: keys,
  });
  assert(m.signature, "signed");
  assert(m.publicKey, "carries the verifying public key");
  const v = await verifyShipManifest(binary, m);
  assertEquals(v.ok, true);
  assert(v.reason.includes("signature"));
});

Deno.test("ship manifest: a forged signature fails verification", async () => {
  const binary = bin("artifact");
  const keys = await generateSigningKey();
  const m = await buildShipManifest({
    name: "app",
    version: "1",
    binary,
    sources: [],
    sign: keys,
  });
  // Swap in a signature from a DIFFERENT key → must not verify.
  const other = await generateSigningKey();
  const forged = await buildShipManifest({
    name: "app",
    version: "1",
    binary: new TextEncoder().encode("artifact"),
    sources: [],
    sign: other,
  });
  m.signature = forged.signature; // forged sig under m's (original) public key
  const v = await verifyShipManifest(binary, m);
  assertEquals(v.ok, false);
  assertEquals(v.reason, "signature invalid");
});

Deno.test("shipApp: one command → binary + source → signed ship.json (batteries-included)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const binaryPath = dir + "/app.bin";
    await Deno.writeFile(binaryPath, bin("COMPILED-BINARY-BYTES"));
    await Deno.mkdir(dir + "/src", { recursive: true });
    await Deno.writeTextFile(
      dir + "/src/cell.ts",
      `Deno.dlopen(p, {}); fetch("x"); // ffi + net`,
    );
    const keyPath = dir + "/key.json";
    await Deno.writeTextFile(
      keyPath,
      JSON.stringify(await generateSigningKey()),
    );

    const m = await shipApp({
      binaryPath,
      sourceDir: dir + "/src",
      name: "wallet",
      version: "2.0.0",
      keyPath,
    });
    // Manifest reflects the real binary + scanned capabilities + signature.
    assertEquals(m.name, "wallet");
    assertEquals(m.version, "2.0.0");
    assertEquals(m.runFlags, ["--allow-net", "--allow-ffi"]);
    assert(m.signature, "signed with the provided key");

    // ship.json was written next to the binary and verifies against the binary.
    const written = JSON.parse(
      await Deno.readTextFile(binaryPath + ".ship.json"),
    ) as ShipManifest;
    const binary = await Deno.readFile(binaryPath);
    assertEquals((await verifyShipManifest(binary, written)).ok, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
