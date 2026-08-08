// `aio ship` core: a verifiable release manifest (SHA-256 +
// least-privilege capabilities + optional Ed25519 signature over the digest).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
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

Deno.test("ship manifest: unsigned is REFUSED unless explicitly allowed", async () => {
  const binary = bin("v1.0.0-artifact");
  const m = await buildShipManifest({
    name: "app",
    version: "1",
    binary,
    sources: [],
  });
  // An unsigned manifest authenticates nothing, so it is not a quiet "ok".
  const refused = await verifyShipManifest(binary, m);
  assertEquals(refused.ok, false);
  assert(refused.reason.includes("unsigned"));

  const allowed = await verifyShipManifest(binary, m, { allowUnsigned: true });
  assertEquals(allowed.ok, true);
  assert(allowed.reason.includes("UNSIGNED"));

  const tampered = bin("v1.0.0-artifact-EVIL");
  const bad = await verifyShipManifest(tampered, m, { allowUnsigned: true });
  assertEquals(bad.ok, false);
  assert(bad.reason.includes("sha256"));
});

Deno.test("ship manifest: unsigned is refused outright once a key is pinned", async () => {
  const binary = bin("stripped-signature");
  const keys = await generateSigningKey();
  const m = await buildShipManifest({
    name: "app",
    version: "1",
    binary,
    sources: [],
  });
  // Stripping a signature must never downgrade an app that trusts a key —
  // otherwise every signature is optional to an attacker in the middle.
  const r = await verifyShipManifest(binary, m, {
    key: keys.publicKey,
    allowUnsigned: true,
  });
  assertEquals(r.ok, false);
  assert(r.reason.includes("pinned"));
});

Deno.test("ship manifest: a self-signed manifest fails against a pinned key", async () => {
  const binary = bin("forged-release");
  const mine = await generateSigningKey();
  const theirs = await generateSigningKey();
  // The forger signs their own manifest and ships their own public key with
  // it — internally consistent, and worthless. Verification must compare the
  // key against the one the app already trusts.
  const forged = await buildShipManifest({
    name: "app",
    version: "9.9.9",
    binary,
    sources: [],
    sign: theirs,
  });
  assertEquals((await verifyShipManifest(binary, forged)).ok, true);
  const r = await verifyShipManifest(binary, forged, { key: mine.publicKey });
  assertEquals(r.ok, false);
  assert(r.reason.includes("untrusted key"));
});

Deno.test("ship manifest: channel/target/platform are inside the signature", async () => {
  const binary = bin("channel-bound");
  const keys = await generateSigningKey();
  const m = await buildShipManifest({
    name: "app",
    version: "1.2.0",
    binary,
    sources: [],
    sign: keys,
    channel: "test",
    target: "appimage",
    platform: { os: "linux", arch: "x86_64" },
  });

  // The client asked for prod and got a test build — the realistic failure.
  const wrongChannel = await verifyShipManifest(binary, m, {
    key: keys.publicKey,
    channel: "prod",
  });
  assertEquals(wrongChannel.ok, false);
  assert(wrongChannel.reason.includes("channel mismatch"));

  const wrongPlatform = await verifyShipManifest(binary, m, {
    key: keys.publicKey,
    channel: "test",
    platform: { os: "darwin", arch: "aarch64" },
  });
  assertEquals(wrongPlatform.ok, false);
  assert(wrongPlatform.reason.includes("platform mismatch"));

  // Editing the channel in transit breaks the signature rather than the check.
  const relabelled = { ...m, channel: "prod" };
  const tamperedChannel = await verifyShipManifest(binary, relabelled, {
    key: keys.publicKey,
    channel: "prod",
  });
  assertEquals(tamperedChannel.ok, false);
  assert(tamperedChannel.reason.includes("signature invalid"));

  const good = await verifyShipManifest(binary, m, {
    key: keys.publicKey,
    channel: "test",
    target: "appimage",
    platform: { os: "linux", arch: "x86_64" },
  });
  assertEquals(good.ok, true);
});

Deno.test("ship manifest: a v1 (digest-only) manifest is refused, not downgraded to", async () => {
  const binary = bin("legacy");
  const keys = await generateSigningKey();
  const m = await buildShipManifest({
    name: "app",
    version: "1",
    binary,
    sources: [],
    sign: keys,
  });
  const legacy = { ...m, manifestVersion: 1 as unknown as 2 };
  const r = await verifyShipManifest(binary, legacy, { key: keys.publicKey });
  assertEquals(r.ok, false);
  assert(r.reason.includes("predates channel binding"));
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

// A ship manifest is a CLAIM: "this binary needs exactly these permissions".
// The source dir it scanned was hardcoded to "src", and a missing dir was
// swallowed into an empty scan — so on any layout that isn't the scaffold's
// (sources in `apps/web/`), `ship` signed a least-privilege claim it never
// measured: every capability false, `run: (no perms)`, `version 0.0.0`.
Deno.test("shipApp: scans THE app dir (from the entry) and refuses an unmeasured claim", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ship-nested-" });
  const cwd = Deno.cwd();
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "Nested",
        version: "2.3.4",
        entry: "apps/web/main.ts",
      }),
    );
    await Deno.mkdir(join(dir, "apps", "web"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "apps", "web", "main.ts"),
      `Deno.dlopen(p, {}); fetch("x"); // ffi + net`,
    );
    const binaryPath = join(dir, "nested.bin");
    await Deno.writeFile(binaryPath, bin("COMPILED"));
    Deno.chdir(dir);

    const m = await shipApp({ binaryPath });
    // Capabilities actually measured, from where the app's sources live.
    assertEquals(m.capabilities.ffi, true);
    assertEquals(m.capabilities.net, true);
    assertEquals(m.runFlags, ["--allow-net", "--allow-ffi"]);
    // …and the artifact carries the app's real version, not a confident 0.0.0.
    assertEquals(m.version, "2.3.4");

    // With nothing to scan, refuse rather than sign an empty claim.
    await Deno.remove(join(dir, "apps", "web", "main.ts"));
    const err = await assertRejects(
      () => shipApp({ binaryPath }),
      Error,
      "never measured",
    );
    assert(err.message.includes("apps/web"), `names the dir: ${err.message}`);

    // An explicitly named source dir that does not exist is loud too — it used
    // to be swallowed into "no capabilities".
    await assertRejects(
      () => shipApp({ binaryPath, sourceDir: join(dir, "nope") }),
      Error,
      "cannot read the source tree",
    );
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ship github: the workflow publishes into the layout the updater reads", async () => {
  const { githubWorkflow } = await import("../src/build/ship.ts");
  const yml = githubWorkflow({ name: "wallet", channel: "prod" });

  // Valid YAML with both halves of the pipeline — a workflow that does not
  // parse is a release process that fails on the day you need it.
  const { parse } = await import("@std/yaml");
  const doc = parse(yml) as { jobs: Record<string, unknown>; on: unknown };
  assertEquals(Object.keys(doc.jobs), ["build", "publish"]);

  // The layout is the part aio owns; it must match what the client fetches.
  assert(yml.includes("out/prod"), "publishes under the channel directory");
  assert(
    yml.includes("$(deno eval 'console.log(Deno.build.os"),
    "names the manifest <os>-<arch>.json, which is what a client asks for",
  );
  // Reachable for a consuming app, not just inside this repo.
  assert(yml.includes("jsr:@riagentic/aio/ship"));
  // Signing key comes from a secret, never the repo.
  assert(yml.includes("secrets.AIO_SIGNING_KEY"));
  // A draft release has no public download path — the app would only ever see
  // "no updates available".
  assert(yml.includes("draft: false"));
  // Three platforms, and one failing must not hide the others.
  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert(yml.includes(os), `builds on ${os}`);
  }
  assert(yml.includes("fail-fast: false"));

  assert(
    githubWorkflow({ name: "w" }).includes("out/prod"),
    "defaults to prod",
  );
  assert(githubWorkflow({ name: "w", channel: "test" }).includes("out/test"));
});
