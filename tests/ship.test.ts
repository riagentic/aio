// `aio ship` core: a verifiable release manifest (SHA-256 +
// least-privilege capabilities + optional Ed25519 signature over the digest).
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  artifactFormat,
  buildShipManifest,
  declaredTargetKinds,
  generateSigningKey,
  keyFingerprint,
  manifestCore,
  manifestFileName,
  parseSigningKey,
  SAFE_TOKEN,
  safeTokenReason,
  sha256Hex,
  shipApp,
  UPDATE_TARGETS,
  verifyManifestClaims,
  verifyShipManifest,
} from "../src/build/ship.ts";
import { notRunnableExit } from "../src/testing/internal.ts";
import type { DataContract, ShipManifest } from "../src/build/ship.ts";
import { manifestUrl } from "../src/server/updates-core.ts";

const bin = (s: string) => new TextEncoder().encode(s);

/** A stand-in for a COMPILED artifact: `s`, behind ELF magic.
 *
 *  `shipApp` reads the artifact's first bytes and refuses a file that is not an
 *  executable or an archive for any platform — the gate that stops `--no-data`
 *  publishing `printf 'NOT A BINARY' > dist/app`. A fixture that is bare ASCII
 *  is exactly that file, so every fixture standing in for a real artifact
 *  carries a real header. (`bin()` stays for the byte-level tests — hashing,
 *  manifest canonicalisation — which never go through that gate.) */
const elf = (s: string) =>
  new Uint8Array([0x7f, 0x45, 0x4c, 0x46, ...new TextEncoder().encode(s)]);

// KNOWN vectors, not a self-comparison. The old test hashed a string and
// compared it to itself hashed again, which passes for any function at all —
// including one that returns a constant.
Deno.test("sha256Hex: matches the published SHA-256 vectors", async () => {
  assertEquals(
    await sha256Hex(bin("")),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    await sha256Hex(bin("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(
    await sha256Hex(
      bin("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assertEquals((await sha256Hex(bin("aio"))).length, 64);
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
  const legacy = { ...m, manifestVersion: 1 as unknown as 3 };
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
    await Deno.writeFile(binaryPath, elf("COMPILED-BINARY-BYTES"));
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
      // A stub file is not an executable — there is no contract to probe, and
      // saying so explicitly is now the only way past it (see the --no-data
      // regression test below).
      noData: true,
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
    await Deno.writeFile(binaryPath, elf("COMPILED"));
    Deno.chdir(dir);

    const m = await shipApp({ binaryPath, noData: true });
    // Capabilities actually measured, from where the app's sources live.
    assertEquals(m.capabilities.ffi, true);
    assertEquals(m.capabilities.net, true);
    assertEquals(m.runFlags, ["--allow-net", "--allow-ffi"]);
    // …and the artifact carries the app's real version, not a confident 0.0.0.
    assertEquals(m.version, "2.3.4");

    // With nothing to scan, refuse rather than sign an empty claim.
    await Deno.remove(join(dir, "apps", "web", "main.ts"));
    const err = await assertRejects(
      () => shipApp({ binaryPath, noData: true }),
      Error,
      "never measured",
    );
    assert(err.message.includes("apps/web"), `names the dir: ${err.message}`);

    // An explicitly named source dir that does not exist is loud too — it used
    // to be swallowed into "no capabilities".
    await assertRejects(
      () => shipApp({ binaryPath, sourceDir: join(dir, "nope"), noData: true }),
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
  // The manifest name is produced by `aio ship --channel-dir`, never re-spelled
  // here: a second spelling of <os>-<arch>.json is the exact defect this
  // workflow used to carry.
  assert(yml.includes("--channel-dir=out"));
  assert(
    !yml.includes("Deno.build.os"),
    "the workflow must not re-derive the manifest file name",
  );
  // Reachable for a consuming app, not just inside this repo.
  assert(yml.includes("jsr:@riagentic/aio/ship"));
  // Signing key comes from a secret, never the repo.
  assert(yml.includes("secrets.AIO_SIGNING_KEY"));
  // Pages, because a GitHub Release asset list is FLAT and can never answer
  // <base>/<channel>/<os>-<arch>.json.
  assert(yml.includes("actions/deploy-pages"));
  assert(yml.includes("pages: write") && yml.includes("id-token: write"));
  assert(
    yml.includes("https://OWNER.github.io/REPO"),
    "recommends a base URL that actually serves directories",
  );
  assert(
    !yml.includes('releases/latest/download"'),
    "never recommends a release download URL as the update base",
  );
  // A draft release has no public download path — the attached binaries are
  // for humans, so they still must not be a draft.
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

// The recommendation printed by ship.ts and the classifier the app boots with
// must agree. `classifySource` THROWS on a forge `releases/*/download` URL, so
// a workflow that recommends one recommends a config that cannot boot.
Deno.test("ship github: the recommended update base classifies as a manifest source", async () => {
  const { classifySource } = await import("../src/server/updates-core.ts");
  assertEquals(
    classifySource("https://OWNER.github.io/REPO"),
    "manifest",
  );
  // …and the URL the old workflow recommended is still refused, loudly.
  assertThrows(
    () =>
      classifySource(
        "https://github.com/OWNER/REPO/releases/latest/download",
      ),
    Error,
  );
});

// ── manifest v3 ─────────────────────────────────────────────────────────────

Deno.test("manifest v3: name, notes and releasedAt are inside the signature", async () => {
  const binary = bin("v3-artifact");
  const keys = await generateSigningKey();
  const m = await buildShipManifest({
    name: "app",
    version: "1.0.0",
    binary,
    sources: [],
    sign: keys,
    notes: "routine bug fixes",
    releasedAt: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(m.manifestVersion, 3);
  assertEquals(
    (await verifyShipManifest(binary, m, { key: keys.publicKey })).ok,
    true,
  );

  // Rewriting the sentence a human agrees to must break the signature.
  for (
    const edit of [
      { notes: "routine SECURITY fix — install now" },
      { releasedAt: "2026-06-01T00:00:00.000Z" },
      { name: "other-app" },
    ]
  ) {
    const tampered = { ...m, ...edit } as ShipManifest;
    const r = await verifyShipManifest(binary, tampered, {
      key: keys.publicKey,
    });
    assertEquals(r.ok, false, `rewriting ${Object.keys(edit)[0]} must fail`);
    assertEquals(r.reason, "signature invalid");
  }
});

Deno.test("manifest v3: the signature covers the DATA contract", async () => {
  const binary = bin("data-bound");
  const keys = await generateSigningKey();
  const data: DataContract = {
    schema: 4,
    cells: { todos: { version: 3, migratesFrom: 1 } },
  };
  const m = await buildShipManifest({
    name: "app",
    version: "1.0.0",
    binary,
    sources: [],
    sign: keys,
    data,
  });
  assertEquals(
    (await verifyShipManifest(binary, m, { key: keys.publicKey })).ok,
    true,
  );

  // "yes, I can migrate your data" is a data-destruction primitive when forged.
  const forged = {
    ...m,
    data: { schema: 4, cells: { todos: { version: 9, migratesFrom: 1 } } },
  } as ShipManifest;
  const r = await verifyShipManifest(binary, forged, { key: keys.publicKey });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "signature invalid");

  const widened = {
    ...m,
    data: { schema: 4, cells: { todos: { version: 3, migratesFrom: 0 } } },
  } as ShipManifest;
  assertEquals(
    (await verifyShipManifest(binary, widened, { key: keys.publicKey })).reason,
    "signature invalid",
  );
});

Deno.test("manifest v3: a v2 manifest is refused, not downgraded to", async () => {
  const binary = bin("v2-legacy");
  const keys = await generateSigningKey();
  const m = await buildShipManifest({
    name: "app",
    version: "1.0.0",
    binary,
    sources: [],
    sign: keys,
  });
  const v2 = { ...m, manifestVersion: 2 as unknown as 3 };
  const r = await verifyShipManifest(binary, v2, { key: keys.publicKey });
  assertEquals(r.ok, false);
  assert(r.reason.includes("predates release-text binding"), r.reason);
  assert(r.reason.includes("aio ship"), "names the fix");
});

Deno.test("manifestCore: cell insertion order cannot change the signed core", () => {
  const base = {
    manifestVersion: 3,
    name: "app",
    version: "1.0.0",
    sha256: "00",
    size: 1,
    capabilities: {} as never,
    runFlags: [],
    channel: "prod",
    target: "binary",
    platform: { os: "linux", arch: "x86_64" },
    releasedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ShipManifest;
  const forwards: DataContract = {
    schema: 2,
    cells: {
      alpha: { version: 1, migratesFrom: 1 },
      beta: { version: 2, migratesFrom: 1 },
      gamma: { version: 3, migratesFrom: 2 },
    },
  };
  const backwards: DataContract = { schema: 2, cells: {} };
  backwards.cells.gamma = { version: 3, migratesFrom: 2 };
  backwards.cells.beta = { version: 2, migratesFrom: 1 };
  backwards.cells.alpha = { version: 1, migratesFrom: 1 };
  assertEquals(
    manifestCore({ ...base, data: forwards }),
    manifestCore({ ...base, data: backwards }),
  );
  // …and the core is stable across calls (no Date.now / no Map iteration luck).
  assertEquals(manifestCore(base), manifestCore(base));
});

// ── the app-name binding ────────────────────────────────────────────────────

Deno.test("manifest: a release for ANOTHER app is refused before the signature", async () => {
  const binary = bin("other-app");
  const keys = await generateSigningKey();
  const m = await buildShipManifest({
    name: "other-app",
    version: "1.0.0",
    binary,
    sources: [],
    sign: keys,
  });
  // Perfectly signed by the trusted key — and still not this app's release.
  const r = await verifyManifestClaims(m, {
    name: "wallet",
    key: keys.publicKey,
  });
  assertEquals(r.ok, false);
  assert(r.reason.includes("wallet"), r.reason);
  assert(r.reason.includes("other-app"), r.reason);
  assert(r.reason.includes("another app"), r.reason);

  assertEquals(
    (await verifyManifestClaims(m, { name: "other-app", key: keys.publicKey }))
      .ok,
    true,
  );
});

// ── SAFE_TOKEN: the ONE decider for values that become paths and argv ───────

Deno.test("SAFE_TOKEN: accepts real identifiers, refuses everything that escapes", () => {
  for (
    const good of [
      "app",
      "wallet-desktop",
      "1.2.3",
      "1.2.3-rc.1",
      "1.2.3+build.7",
      "prod",
      "a".repeat(64),
    ]
  ) assert(SAFE_TOKEN.test(good), `${good} must be accepted`);

  for (
    const bad of [
      "",
      "../../etc/passwd",
      "a/b",
      "a\\b",
      "a b",
      "a;rm -rf /",
      "a$(id)",
      "a`id`",
      "a|b",
      "a\nb",
      "--upload-pack=touch",
      ".hidden",
      "a".repeat(65),
      "é",
    ]
  ) assert(!SAFE_TOKEN.test(bad), `${bad} must be refused`);
});

Deno.test("safeTokenReason: names the field, the value and the fix", () => {
  assertEquals(safeTokenReason("channel", "prod"), null);
  const r = safeTokenReason("channel", "prod;rm -rf /")!;
  assert(r.includes("channel"), r);
  assert(r.includes("rm -rf"), "echoes the offending value");
  assert(r.includes("aio ship --channel="), "names the fix");
  // Long values are truncated rather than pasted whole into a log line.
  const long = safeTokenReason("version", "x/".repeat(200))!;
  assert(long.includes("…"), long.slice(0, 120));
  assert(long.length < 500, `truncated: ${long.length}`);
  assert(safeTokenReason("name", undefined)!.includes("missing"));
});

Deno.test("verifyManifestClaims: an unsafe name/version/channel is refused FIRST", async () => {
  const binary = bin("unsafe");
  const keys = await generateSigningKey();
  const base = await buildShipManifest({
    name: "app",
    version: "1.0.0",
    binary,
    sources: [],
    sign: keys,
  });
  for (
    const [field, value] of [
      ["name", "../../../etc/cron.d/x"],
      ["version", "1.0.0; rm -rf ~"],
      ["channel", "--upload-pack=touch /tmp/pwn"],
    ] as const
  ) {
    // Signed correctly for the tampered content, so nothing downstream would
    // have caught it — the charset is the only thing standing there.
    const m = await buildShipManifest({
      name: field === "name" ? value : "app",
      version: field === "version" ? value : "1.0.0",
      channel: field === "channel" ? value : "prod",
      binary,
      sources: [],
      sign: keys,
    });
    const r = await verifyManifestClaims(m, { key: keys.publicKey });
    assertEquals(r.ok, false, `${field} ${value} must be refused`);
    assert(r.reason.includes(field), r.reason);
  }
  // A well-formed manifest still passes — the guard is not a wall.
  assertEquals(
    (await verifyManifestClaims(base, { key: keys.publicKey })).ok,
    true,
  );
});

// ── key fingerprint ─────────────────────────────────────────────────────────

Deno.test("keyFingerprint: short, stable, and blind to JWK metadata", async () => {
  const { publicKey } = await generateSigningKey();
  const fp = keyFingerprint(publicKey);
  assertEquals(fp.length, 12);
  assert(/^[0-9a-f]{12}$/.test(fp), fp);
  assertEquals(fp, keyFingerprint(publicKey));
  // Re-exported by another runtime: same key, different optional metadata.
  assertEquals(
    fp,
    keyFingerprint({
      kty: publicKey.kty,
      crv: publicKey.crv,
      x: publicKey.x,
      alg: "EdDSA",
      ext: true,
      key_ops: ["verify"],
    }),
  );
  const other = await generateSigningKey();
  assert(fp !== keyFingerprint(other.publicKey), "different keys differ");
  // Known vector: the fingerprint is a function of {kty,crv,x} only, so it is
  // reproducible outside this process (a human comparing two screens).
  assertEquals(
    keyFingerprint({ kty: "OKP", crv: "Ed25519", x: "AAAA" }),
    keyFingerprint({ x: "AAAA", crv: "Ed25519", kty: "OKP" }),
  );
});

// ── key rotation: a roster, so one lost key is not the end of the app ───────

Deno.test("keys roster: any rostered key verifies, so signing keys can rotate", async () => {
  const binary = bin("rotating");
  const oldKey = await generateSigningKey();
  const newKey = await generateSigningKey();
  const signedByNew = await buildShipManifest({
    name: "app",
    version: "2.0.0",
    binary,
    sources: [],
    sign: newKey,
  });

  // An install that only ever saw the old key refuses — correctly.
  const refused = await verifyShipManifest(binary, signedByNew, {
    key: oldKey.publicKey,
  });
  assertEquals(refused.ok, false);
  assert(refused.reason.includes("untrusted key"));
  assert(refused.reason.includes("rotate"), "names the procedure");
  assert(
    refused.reason.includes(keyFingerprint(newKey.publicKey)),
    "names WHICH key signed it",
  );

  // The release before it shipped `keys: [old, new]`, so this install accepts
  // both — that is the whole rotation, and it needs no out-of-band step.
  const rotated = await verifyShipManifest(binary, signedByNew, {
    key: oldKey.publicKey,
    keys: [newKey.publicKey],
  });
  assertEquals(rotated.ok, true);

  // The old key keeps working during the overlap.
  const signedByOld = await buildShipManifest({
    name: "app",
    version: "2.0.0",
    binary,
    sources: [],
    sign: oldKey,
  });
  assertEquals(
    (await verifyShipManifest(binary, signedByOld, {
      keys: [oldKey.publicKey, newKey.publicKey],
    })).ok,
    true,
  );
  // A roster still refuses a key that is not on it.
  const stranger = await generateSigningKey();
  const forged = await buildShipManifest({
    name: "app",
    version: "3.0.0",
    binary,
    sources: [],
    sign: stranger,
  });
  assertEquals(
    (await verifyShipManifest(binary, forged, {
      keys: [oldKey.publicKey, newKey.publicKey],
    })).ok,
    false,
  );
  // …and a roster counts as "pinned": an unsigned manifest cannot slip past it.
  const unsigned = await buildShipManifest({
    name: "app",
    version: "3.0.0",
    binary,
    sources: [],
  });
  const u = await verifyShipManifest(binary, unsigned, {
    keys: [newKey.publicKey],
    allowUnsigned: true,
  });
  assertEquals(u.ok, false);
  assert(u.reason.includes("pinned"));
});

// ── truthful errors ─────────────────────────────────────────────────────────

Deno.test("unsigned refusal names a fix that exists", async () => {
  const binary = bin("unsigned-advice");
  const m = await buildShipManifest({
    name: "app",
    version: "1.0.0",
    binary,
    sources: [],
  });
  const r = await verifyShipManifest(binary, m);
  assertEquals(r.ok, false);
  // `--allow-unsigned` was advertised for releases and never existed.
  assert(!r.reason.includes("--allow-unsigned"), r.reason);
  assert(r.reason.includes("allowUnsigned: true"), r.reason);
  assert(r.reason.includes("aio ship --key="), r.reason);
});

Deno.test("shipApp: an unknown --target is refused, not cast into the manifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ship-target-" });
  try {
    const binaryPath = join(dir, "app.bin");
    await Deno.writeFile(binaryPath, elf("BIN"));
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src", "a.ts"), `fetch("x");`);
    const err = await assertRejects(
      () =>
        shipApp({
          binaryPath,
          sourceDir: join(dir, "src"),
          name: "app",
          version: "1.0.0",
          target: "binry" as never,
          noData: true,
        }),
      Error,
      "unknown target",
    );
    for (const t of UPDATE_TARGETS) assert(err.message.includes(t), t);
    // A real target still ships.
    const m = await shipApp({
      binaryPath,
      sourceDir: join(dir, "src"),
      name: "app",
      version: "1.0.0",
      target: "appimage",
      noData: true,
    });
    assertEquals(m.target, "appimage");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("shipApp: refuses an unsafe channel at the PUBLISHER, not at every user", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ship-channel-" });
  try {
    const binaryPath = join(dir, "app.bin");
    await Deno.writeFile(binaryPath, elf("BIN"));
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src", "a.ts"), `fetch("x");`);
    await assertRejects(
      () =>
        shipApp({
          binaryPath,
          sourceDir: join(dir, "src"),
          name: "app",
          version: "1.0.0",
          channel: "prod/../dev",
        }),
      Error,
      "not a safe identifier",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the publish rename trap ─────────────────────────────────────────────────

Deno.test("manifestFileName: one spelling, shared with the URL the client requests", () => {
  const platform = { os: "linux", arch: "x86_64" };
  assertEquals(manifestFileName(platform), "linux-x86_64.json");
  // THE guard: two spellings of this path is what made "copy both files"
  // produce a permanent, silent "no updates available".
  assertEquals(
    manifestUrl("https://example.com/rel", "prod", platform),
    `https://example.com/rel/prod/${manifestFileName(platform)}`,
  );
});

Deno.test("shipApp: writes the manifest under the name the CLIENT fetches", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ship-names-" });
  try {
    const binaryPath = join(dir, "app.bin");
    await Deno.writeFile(binaryPath, elf("COMPILED"));
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src", "a.ts"), `fetch("x");`);
    const m = await shipApp({
      binaryPath,
      sourceDir: join(dir, "src"),
      name: "app",
      version: "1.0.0",
      channel: "prod",
      channelDir: join(dir, "out"),
      noData: true,
    });
    const fetched = manifestFileName(m.platform);
    const human = await Deno.readTextFile(binaryPath + ".ship.json");
    const client = await Deno.readTextFile(join(dir, fetched));
    // Both names, one content — a publisher who copies either is not broken.
    assertEquals(human, client);
    // …and --channel-dir assembles the exact path the client requests.
    const staged = await Deno.readTextFile(
      join(dir, "out", "prod", fetched),
    );
    assertEquals(staged, client);
    assertEquals(
      (JSON.parse(client) as ShipManifest).sha256,
      m.sha256,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publishInstructions: the copy lines name the file the client asks for", async () => {
  const { publishInstructions } = await import("../src/testing/internal.ts");
  const m = await buildShipManifest({
    name: "app",
    version: "1.0.0",
    binary: bin("x"),
    sources: [],
    channel: "test",
    platform: { os: "linux", arch: "x86_64" },
  });
  const text = publishInstructions(m, "app.bin");
  assert(text.includes("test/"), text);
  assert(text.includes("linux-x86_64.json"), text);
  assert(text.includes("cp app.bin out/test/"), text);
  // The trap itself, stated: a release asset list cannot serve this layout.
  assert(text.includes("FLAT"), text);
});

// ── the data contract: the update feature's headline guarantee ───────────────
//
// `<binary> --aio-data-contract` is MACHINE-READ (by `aio ship`, by
// `updates-rebuild`). It used to print the contract through the logger — four
// INFO lines first, and a timestamp preamble glued to the JSON's opening
// brace — so nothing could parse it, `ship` warned and published every release
// with `data: undefined`, and every install that HAD data refused that release
// forever. These pin BOTH halves: only JSON on stdout, and a `ship` that
// refuses to publish a contract-less release by accident.

/** A real aio app, booted for real, answering `--aio-data-contract`. */
async function contractFixture(): Promise<
  { dir: string; script: string; entry: string }
> {
  const dir = await Deno.makeTempDir({ prefix: "aio-contract-" });
  const repo = new URL("../", import.meta.url).pathname;
  const entry = join(dir, "app.ts");
  await Deno.writeTextFile(
    entry,
    `import { aio, cell } from "${repo}mod.ts";\n` +
      `export const notes = cell("notes", {\n` +
      `  version: 3,\n` +
      `  state: { items: [] as string[] },\n` +
      `  onMigrate: (s: Record<string, unknown>) => s,\n` +
      `  methods: {},\n` +
      `});\n` +
      `await aio.run({ cells: [notes], libraryMode: true, baseDir: "${dir}" });\n`,
  );
  // A file `probeDataContract` can spawn — the shape a compiled binary has.
  const script = join(dir, "app.bin");
  await Deno.writeTextFile(
    script,
    `#!/bin/sh\nexec "${Deno.execPath()}" run -A --config "${repo}deno.json" ` +
      `"${entry}" "$@"\n`,
  );
  await Deno.chmod(script, 0o755);
  return { dir, script, entry };
}

Deno.test({
  name: "--aio-data-contract: stdout is the JSON and NOTHING else",
  fn: async () => {
    const { dir, entry } = await contractFixture();
    try {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          new URL("../deno.json", import.meta.url).pathname,
          entry,
          "--aio-data-contract",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(out.stdout);
      const stderr = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, stderr);
      // THE regression: a bare JSON.parse, exactly as `ship` does it.
      const parsed = JSON.parse(stdout) as DataContract;
      assertEquals(parsed.cells.notes, { version: 3, migratesFrom: 1 });
      assert(
        !/INFO|WARN|\d{4}-\d\d-\d\d/.test(stdout),
        `stdout carried log lines:\n${stdout}`,
      );
      // Nothing is DROPPED — the boot report is still there, on stderr.
      assert(
        stderr.includes("cells: notes"),
        `boot lines must survive on stderr:\n${stderr}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "shipApp: probes a real binary and publishes what it promises",
  fn: async () => {
    const { dir, script } = await contractFixture();
    try {
      await Deno.mkdir(join(dir, "src"), { recursive: true });
      await Deno.writeTextFile(join(dir, "src", "a.ts"), `fetch("x");`);
      const m = await shipApp({
        binaryPath: script,
        sourceDir: join(dir, "src"),
        name: "notes",
        version: "1.0.0",
      });
      assertEquals(m.data?.cells.notes, { version: 3, migratesFrom: 1 });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("shipApp: an unreadable data contract FAILS the publish", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ship-nodata-" });
  try {
    const binaryPath = join(dir, "app.bin");
    // A program that RUNS and fails on its own terms — which is the case this
    // message and its two hatches were written for. (The fixture used to be
    // bare text, i.e. a file that cannot execute at all; that is a BROKEN
    // BUILD and now gets its own refusal, with no `--no-data` in it. See "the
    // not-runnable refusal does NOT offer --no-data".)
    await Deno.writeTextFile(
      binaryPath,
      "#!/bin/sh\necho 'nope' >&2\nexit 3\n",
    );
    await Deno.chmod(binaryPath, 0o755);
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src", "a.ts"), `fetch("x");`);
    const err = await assertRejects(
      () =>
        shipApp({
          binaryPath,
          sourceDir: join(dir, "src"),
          name: "app",
          version: "1.0.0",
        }),
      Error,
    );
    // Cause AND both ways out, named.
    assert(err.message.includes("--data="), err.message);
    assert(err.message.includes("--no-data"), err.message);
    // …and the deliberate escape still works, unlike a warning nobody read.
    const m = await shipApp({
      binaryPath,
      sourceDir: join(dir, "src"),
      name: "app",
      version: "1.0.0",
      noData: true,
    });
    assertEquals(m.data, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("shipApp: --data with log lines in it names the file, not a stack", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ship-dataflag-" });
  try {
    const binaryPath = join(dir, "app.bin");
    await Deno.writeFile(binaryPath, elf("COMPILED"));
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src", "a.ts"), `fetch("x");`);
    const dataPath = join(dir, "contract.json");
    // Exactly what the old `--aio-data-contract` wrote into a redirect.
    await Deno.writeTextFile(
      dataPath,
      `2026-08-25 10:00:00.000  INFO   aio         cells: notes\n` +
        `2026-08-25 10:00:00.001  INFO   aio         {\n  "schema": 1\n}\n`,
    );
    const err = await assertRejects(
      () =>
        shipApp({
          binaryPath,
          sourceDir: join(dir, "src"),
          name: "app",
          version: "1.0.0",
          dataPath,
        }),
      Error,
    );
    assert(err.message.startsWith("[ship]"), err.message);
    assert(err.message.includes(dataPath), err.message);
    assert(err.message.includes("--aio-data-contract"), err.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// The publisher half of the app-name binding. `verifyManifestClaims` refuses a
// manifest whose signed `name` is not the booting app's `appId` — so the name
// `shipApp` writes MUST be that same id, read through the same decider. A file
// name ("notes-cli", "notes.AppImage") would refuse its own updates.
Deno.test("shipApp: the release name is the app's appId, not the file name", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ship-name-" });
  const cwd = Deno.cwd();
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ appId: "Note Book", version: "1.2.0" }),
    );
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src", "a.ts"), `fetch("x");`);
    const binaryPath = join(dir, "notes-cli");
    await Deno.writeFile(binaryPath, elf("COMPILED"));
    Deno.chdir(dir);
    const m = await shipApp({ binaryPath, noData: true });
    // The SAME string `aio.run` resolves for this project — same chain, same
    // slugify — not `notes-cli`.
    const { resolveAppId } = await import(
      "../src/server/single-instance-lock.ts"
    );
    assertEquals(m.name, resolveAppId("Note Book"));
    assertEquals(m.name, "note-book");
    // …and a manifest carrying it is accepted by the client-side check that
    // compares against the booting app's appId.
    const claims = await verifyManifestClaims(m, {
      name: resolveAppId("Note Book"),
      allowUnsigned: true,
    });
    assert(claims.ok, claims.reason);
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the signing key must not land in the repository ──────────────────────────
//
// `ship keygen > release-key.json` (what the docs taught) wrote an Ed25519
// PRIVATE key into the repo root, where nothing ignored it: a routine
// `git add -A` committed it and it travelled into every clone. Whoever holds
// it can publish a signed update that every install of the app accepts.
async function runShip(
  args: string[],
  opts: { cwd: string; home: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      new URL("../deno.json", import.meta.url).pathname,
      new URL("../src/build/ship.ts", import.meta.url).pathname,
      ...args,
    ],
    cwd: opts.cwd,
    env: { ...Deno.env.toObject(), HOME: opts.home },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

Deno.test({
  name: "ship keygen: never writes a private key inside a git work tree",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-keygen-" });
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    try {
      await Deno.mkdir(join(repo, ".git"), { recursive: true }); // a work tree
      // 1. The old flow, spelled as a path: refused, with the risk and the fix.
      const refused = await runShip(
        ["keygen", "--out=./release-key.json"],
        { cwd: repo, home },
      );
      assertEquals(refused.code, 1, refused.stderr);
      assert(refused.stderr.includes("git work tree"), refused.stderr);
      assert(refused.stderr.includes("--out="), refused.stderr);
      await assertRejects(() => Deno.stat(join(repo, "release-key.json")));

      // 2. The default: written OUTSIDE the tree, 0600, and stdout carries the
      //    PUBLIC half only — a pipe cannot leak the private key by accident.
      const ok = await runShip(["keygen"], { cwd: repo, home });
      assertEquals(ok.code, 0, ok.stderr);
      const doc = JSON.parse(ok.stdout) as {
        keyPath: string;
        publicKey: JsonWebKey;
      };
      assert(!doc.keyPath.startsWith(repo), `outside the repo: ${doc.keyPath}`);
      assert(doc.keyPath.startsWith(home), doc.keyPath);
      assert(!ok.stdout.includes('"d"'), "no private scalar on stdout");
      assertEquals(doc.publicKey.key_ops, ["verify"]);
      const st = await Deno.stat(doc.keyPath);
      if (st.mode !== null) assertEquals(st.mode & 0o777, 0o600);
      const pair = JSON.parse(await Deno.readTextFile(doc.keyPath)) as {
        privateKey: JsonWebKey;
      };
      assert(pair.privateKey.d, "the file holds the real private key");

      // 3. …and it never silently replaces the key users already pinned.
      const second = await runShip(["keygen"], { cwd: repo, home });
      assertEquals(second.code, 1, second.stdout);
      assert(second.stderr.includes("already exists"), second.stderr);
      assertEquals(
        (JSON.parse(await Deno.readTextFile(doc.keyPath)) as {
          privateKey: { d?: string };
        }).privateKey.d,
        pair.privateKey.d,
        "the existing key is untouched",
      );

      // 4. The explicit CI path still prints the pair — and says so.
      const piped = await runShip(["keygen", "--stdout"], { cwd: repo, home });
      assertEquals(piped.code, 0, piped.stderr);
      assert((JSON.parse(piped.stdout) as { privateKey: unknown }).privateKey);
      assert(piped.stderr.includes("PRIVATE"), piped.stderr);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("gitWorkTreeOf: finds the tree from a nested path, .git file or dir", async () => {
  const { gitWorkTreeOf } = await import("../src/testing/internal.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-worktree-" });
  try {
    const repo = join(dir, "repo");
    const deep = join(repo, "a", "b");
    await Deno.mkdir(deep, { recursive: true });
    assertEquals(gitWorkTreeOf(deep), null, "no .git yet");
    // A worktree/submodule has a .git FILE, not a directory — both count.
    await Deno.writeTextFile(join(repo, ".git"), "gitdir: /elsewhere\n");
    assertEquals(gitWorkTreeOf(deep), repo);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the signing key file: a wrong one must say so, not reach WebCrypto ──────
//
// `--key=` used to be `JSON.parse(...) as {privateKey, publicKey}` — a bare
// parse and a bare cast — sitting twenty lines below `parseDataContract`,
// whose comment explains exactly why that shape is unacceptable. A wrong file
// therefore surfaced as
//   TypeError: Cannot import key: 'keyData' is not a JsonWebKey
// naming neither the file, nor the key, nor the fix.
//
// And it is reachable by FOLLOWING THE DOCS. `aio ship keygen` writes the pair
// to disk and prints a SUMMARY on stdout — `{"keyPath": "…", "publicKey": {…}}`
// — so the redirect the docs taught (`ship keygen > release-key.json`) captures
// the summary: valid JSON, a real public key, no private half, and identical at
// a glance to a key file.

Deno.test("ship: a captured keygen SUMMARY is refused, and points at the real key", () => {
  const summary = JSON.stringify({
    keyPath: "/home/dev/.aio/keys/probe-release-key.json",
    publicKey: { kty: "OKP", crv: "Ed25519", x: "AAAA" },
  });
  const e = assertThrows(
    () => parseSigningKey(summary, "release-key.json"),
    Error,
  );
  const msg = (e as Error).message;
  // The path it was handed…
  assertStringIncludes(msg, "release-key.json");
  // …what is actually in it…
  assertStringIncludes(msg, "privateKey");
  // …why it looks like a key (so the reader recognises what they did)…
  assertStringIncludes(msg, "keygen");
  // …and the fix, which here is a specific file, not general advice.
  assertStringIncludes(msg, "/home/dev/.aio/keys/probe-release-key.json");
  assertStringIncludes(msg, "--key=");
});

Deno.test("ship: every wrong-key shape names the file and a way forward", () => {
  const cases: [string, string, string][] = [
    // not JSON at all — the boot-log-in-the-file case parseDataContract has.
    ["2026-01-01 INFO boot\n{}", "not JSON", "text that is not JSON"],
    // JSON, but nothing like a key.
    ['{"token":"abc"}', "privateKey", "an unrelated object"],
    // Both halves present, neither a JWK.
    [
      '{"privateKey":"AAAA","publicKey":"BBBB"}',
      "JSON Web Key",
      "base64 strings instead of JWKs",
    ],
    // One half a JWK, the other not.
    [
      '{"privateKey":{"kty":"OKP"},"publicKey":"BBBB"}',
      "publicKey",
      "a half-JWK pair",
    ],
  ];
  for (const [text, needle, what] of cases) {
    const e = assertThrows(
      () => parseSigningKey(text, "/tmp/k.json"),
      Error,
      undefined,
      `${what} must be refused`,
    );
    const msg = (e as Error).message;
    assertStringIncludes(msg, "/tmp/k.json");
    assertStringIncludes(msg, needle);
    assertStringIncludes(
      msg,
      "ship keygen",
      `${what}: the refusal must name the way to get a real key`,
    );
  }
});

Deno.test("ship: a real keypair still loads unchanged", async () => {
  const pair = await generateSigningKey();
  const parsed = parseSigningKey(JSON.stringify(pair), "k.json");
  assertEquals(parsed.publicKey.kty, pair.publicKey.kty);
  assertEquals(parsed.privateKey.crv, pair.privateKey.crv);
});

Deno.test("ship: the CLI refuses a bad key BEFORE it hashes or signs anything", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ship-key-" });
  try {
    // Exactly what the docs' `ship keygen > release-key.json` produced.
    await Deno.writeTextFile(
      join(dir, "release-key.json"),
      JSON.stringify({
        keyPath: join(dir, "real-key.json"),
        publicKey: { kty: "OKP", crv: "Ed25519", x: "AAAA" },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ appId: "shipkey", version: "1.0.0" }),
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      "export const x = 1;\n",
    );
    await Deno.writeTextFile(join(dir, "artifact"), "#!/bin/sh\nexit 0\n");
    await Deno.chmod(join(dir, "artifact"), 0o755);

    const ship = join(
      import.meta.dirname ?? ".",
      "..",
      "src",
      "build",
      "ship.ts",
    );
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        ship,
        "./artifact",
        "--key=release-key.json",
        "--no-data",
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 1, `expected a refusal, got:\n${out}`);
    assertStringIncludes(out, "release-key.json");
    assertStringIncludes(out, "keygen");
    assert(
      !out.includes("Cannot import key"),
      `the raw WebCrypto error must never reach the user:\n${out}`,
    );
    // Nothing was written — a refused ship leaves no half-manifest behind.
    assert(
      ![...Deno.readDirSync(dir)].some((e) => e.name === "ship.json"),
      "a refused ship must not write a manifest",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ship: the install strategy reads BOTH spellings of build.targets", () => {
  // The array form — what `am create` writes and what every existing project
  // has.
  assert(
    declaredTargetKinds({ targets: ["browser", "electron"] }).has(
      "electron",
    ),
  );
  // The OBJECT form, which is the documented layout for a repo holding two
  // apps. `Array.isArray(targets) && includes("electron")` was the whole
  // check, so such a project published its Electron AppImage as a plain
  // `appimage` — a SIGNED manifest naming the wrong install strategy.
  assert(
    declaredTargetKinds({ targets: { electron: { entry: "src/app.ts" } } })
      .has("electron"),
    "a label that IS a target name needs no `kind`",
  );
  assert(
    declaredTargetKinds({
      targets: {
        desk: { kind: "electron", entry: "src/desk/app.ts" },
        relay: { kind: "server", entry: "src/relay/app.ts" },
      },
    }).has("electron"),
    "a labelled target declares its kind explicitly",
  );
  // …and it must not over-claim.
  assertEquals(
    declaredTargetKinds({ targets: { relay: { kind: "server" } } }).has(
      "electron",
    ),
    false,
  );
  assertEquals(declaredTargetKinds({}).size, 0);
  assertEquals(declaredTargetKinds({ targets: "electron" }).size, 0);
});

// ── a broken artifact is a broken BUILD, never a missing data contract ──────
//
// `probeDataContract` runs the artifact to ask what it does with persisted
// data. When the artifact is not a program at all, that failure was reported
// with the DATA-CONTRACT wording — and that message offers `--no-data`, which
// signs and publishes the thing. Repro that reached a real publish:
//
//     printf 'NOT A BINARY\n' > dist/myapp && chmod +x dist/myapp
//     am publish --no-build --key=…
//
// → "…exited 127: NOT: not found, so this release cannot say what it does with
//    existing data … or pass --no-data to publish without a contract".
//
// Every install would then fetch a binary that cannot run, fail its pre-swap
// smoke test and roll back. The one machine positioned to catch it cheaply —
// the publisher's — was handed the flag that ships it.
//
// `--no-data` remains the right hatch for the case it was written for: a
// CROSS-COMPILED artifact this machine cannot execute (`am publish` passes
// `noData: !p.host` for exactly that). It is the wrong hatch for a build that
// is broken everywhere, which is why the two now say different things.

Deno.test("ship: 'did not run' and 'ran, no contract' are different failures", () => {
  // A shell answers a file it cannot execute with 126/127 AND says so.
  assert(notRunnableExit(127, "./app: 1: NOT: not found"));
  assert(notRunnableExit(126, "bash: ./app: cannot execute binary file"));
  assert(notRunnableExit(127, "Exec format error"));
  assert(notRunnableExit(126, "./app: Permission denied"));
  // A program that RAN and failed keeps the data-contract treatment, even when
  // its own exit code happens to be 127 — the code alone never decides.
  assertEquals(
    notRunnableExit(127, "config error: no cells registered"),
    false,
  );
  assertEquals(notRunnableExit(1, "boom"), false);
  assertEquals(notRunnableExit(0, ""), false);
});

Deno.test("ship: the not-runnable refusal does NOT offer --no-data", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ship-broken-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      '{"appId":"brk","version":"1.0.0"}',
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      "export const x = 1;\n",
    );
    // Executable, valid shebang (so the FORMAT gate passes) — and an
    // interpreter that does not exist, so the spawn fails.
    await Deno.writeTextFile(join(dir, "app"), "#!/nonexistent/interp\n");
    await Deno.chmod(join(dir, "app"), 0o755);

    const ship = join(
      import.meta.dirname ?? ".",
      "..",
      "src",
      "build",
      "ship.ts",
    );
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", ship, "./app"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 1, `expected a refusal, got:\n${out}`);
    assertStringIncludes(out, "not a runnable program");
    assertStringIncludes(out, "BROKEN BUILD");
    assertStringIncludes(out, "rebuild");
    // THE point of the split: the hatch that would have shipped it is not
    // offered for a build that is broken everywhere.
    assert(
      !out.includes("--no-data") || out.includes("--no-data is not one"),
      `a not-runnable artifact must not be offered --no-data:\n${out}`,
    );
    assert(
      !out.includes("cannot say what it does with existing data"),
      `this is not a data-contract failure and must not be framed as one:\n${out}`,
    );
    // A refusal writes nothing.
    assert(
      ![...Deno.readDirSync(dir)].some((e) => e.name.endsWith(".ship.json")),
      "a refused ship must not write a manifest",
    );
    // Clean output: a message with a fix in it, not a framework stack.
    assert(
      !out.includes("Uncaught (in promise)"),
      `the CLI must print its own refusal, not an unhandled rejection:\n${out}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ship: a program that RAN and failed keeps --data= and --no-data", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ship-ranfail-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      '{"appId":"ranfail","version":"1.0.0"}',
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      "export const x = 1;\n",
    );
    await Deno.writeTextFile(
      join(dir, "app"),
      "#!/bin/sh\necho 'boom' >&2\nexit 3\n",
    );
    await Deno.chmod(join(dir, "app"), 0o755);

    const ship = join(
      import.meta.dirname ?? ".",
      "..",
      "src",
      "build",
      "ship.ts",
    );
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", ship, "./app"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 1, `expected a refusal, got:\n${out}`);
    assertStringIncludes(out, "cannot say what it does with existing data");
    assertStringIncludes(out, "--data=contract.json");
    assertStringIncludes(out, "--no-data");
    // …and the hatch now names WHEN it is the right one.
    assertStringIncludes(out, "CROSS-COMPILED");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── the format gate: --no-data must not be a door for a non-artifact ────────

Deno.test("ship: artifactFormat recognises every shape aio publishes, and nothing else", () => {
  const f = (...b: number[]) =>
    artifactFormat(new Uint8Array([...b, 0, 0, 0, 0]));
  assertEquals(f(0x7f, 0x45, 0x4c, 0x46), "ELF"); // binary + AppImage
  assertEquals(f(0x4d, 0x5a), "PE"); // windows .exe
  assertEquals(f(0x50, 0x4b, 0x03, 0x04), "ZIP"); // electron-zip + .apk
  assertEquals(f(0x23, 0x21), "script"); // shebang launcher
  for (
    const m of [
      [0xfe, 0xed, 0xfa, 0xce],
      [0xce, 0xfa, 0xed, 0xfe],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
    ]
  ) assertEquals(f(...m), "Mach-O");
  // Everything else — a source file, a manifest, a placeholder, an empty file.
  assertEquals(
    artifactFormat(new TextEncoder().encode("NOT A BINARY\n")),
    null,
  );
  assertEquals(artifactFormat(new TextEncoder().encode('{"a":1}')), null);
  assertEquals(artifactFormat(new Uint8Array(0)), null);
});

Deno.test("ship: --no-data cannot publish a file that is not an artifact", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ship-fmt-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      '{"appId":"fmt","version":"1.0.0"}',
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      "export const x = 1;\n",
    );
    // The exact repro: executable, and not a program.
    await Deno.writeTextFile(join(dir, "app"), "NOT A BINARY\n");
    await Deno.chmod(join(dir, "app"), 0o755);

    const ship = join(
      import.meta.dirname ?? ".",
      "..",
      "src",
      "build",
      "ship.ts",
    );
    // --no-data is what skips the only step that would have EXECUTED it, so
    // this is the path that used to publish.
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", ship, "./app", "--no-data"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assertEquals(
      r.code,
      1,
      `--no-data must not publish a non-artifact:\n${out}`,
    );
    assertStringIncludes(out, "not a publishable artifact");
    assertStringIncludes(out, "--no-data does not make it one");
    assert(
      ![...Deno.readDirSync(dir)].some((e) =>
        e.name.endsWith(".json") && e.name !== "deno.json"
      ),
      "nothing may be written for a file that is not an artifact",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
