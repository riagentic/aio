// The aio root is MACHINE-wide, so a test that does not relocate it writes
// trust material into the developer's real home and then asserts against
// whatever their machine already had. `AIO_APPS_DIR` moves the whole data
// root, root CA included.
const _TLS_SANDBOX = await Deno.makeTempDir({ prefix: "aio-tls-test-" });
Deno.env.set("AIO_APPS_DIR", _TLS_SANDBOX);
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  certCommonName,
  DEFAULT_CERT_CN,
  loadOrCreateCert,
} from "../src/server/tls.ts";

const PEM_CERT_PREFIX = "-----BEGIN CERTIFICATE-----";
const PEM_KEY_PREFIX = "-----BEGIN";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("generates cert when none exists", async () => {
  await withTempDir(async (dir) => {
    const result = await loadOrCreateCert(dir);
    assertEquals(typeof result.cert, "string");
    assertEquals(typeof result.key, "string");
    assertEquals(result.cert.length > 0, true);
    assertEquals(result.key.length > 0, true);
  });
});

Deno.test("returns existing cert on second call (no regeneration)", async () => {
  await withTempDir(async (dir) => {
    const first = await loadOrCreateCert(dir);
    const second = await loadOrCreateCert(dir);
    assertEquals(first.cert, second.cert);
    assertEquals(first.key, second.key);
    assertEquals(first.certPath, second.certPath);
    assertEquals(first.keyPath, second.keyPath);
  });
});

Deno.test("custom cert/key paths reads those files instead", async () => {
  await withTempDir(async (dir) => {
    const certFile = `${dir}/custom-cert.pem`;
    const keyFile = `${dir}/custom-key.pem`;
    await Deno.writeTextFile(certFile, "FAKE-CERT");
    await Deno.writeTextFile(keyFile, "FAKE-KEY");

    const result = await loadOrCreateCert(dir, certFile, keyFile);
    assertEquals(result.cert, "FAKE-CERT");
    assertEquals(result.key, "FAKE-KEY");
    assertEquals(result.certPath, certFile);
    assertEquals(result.keyPath, keyFile);
  });
});

Deno.test("generated cert is valid PEM format", async () => {
  await withTempDir(async (dir) => {
    const result = await loadOrCreateCert(dir);
    assertEquals(result.cert.startsWith(PEM_CERT_PREFIX), true);
    assertEquals(
      result.cert.trimEnd().endsWith("-----END CERTIFICATE-----"),
      true,
    );
  });
});

Deno.test("generated key is valid PEM format", async () => {
  await withTempDir(async (dir) => {
    const result = await loadOrCreateCert(dir);
    assertEquals(result.key.startsWith(PEM_KEY_PREFIX), true);
    assertEquals(result.key.trimEnd().endsWith("-----"), true);
  });
});

Deno.test("certPath and keyPath point to real files", async () => {
  await withTempDir(async (dir) => {
    const result = await loadOrCreateCert(dir);
    const certStat = await Deno.stat(result.certPath);
    const keyStat = await Deno.stat(result.keyPath);
    assertEquals(certStat.isFile, true);
    assertEquals(keyStat.isFile, true);
  });
});

Deno.test("selfSigned is true for generated, false for custom", async () => {
  await withTempDir(async (dir) => {
    const generated = await loadOrCreateCert(dir);
    assertEquals(generated.selfSigned, true);

    const certFile = `${dir}/c.pem`;
    const keyFile = `${dir}/k.pem`;
    await Deno.writeTextFile(certFile, "cert");
    await Deno.writeTextFile(keyFile, "key");
    const custom = await loadOrCreateCert(dir, certFile, keyFile);
    assertEquals(custom.selfSigned, false);
  });
});

Deno.test("missing custom cert file throws", async () => {
  await withTempDir(async (dir) => {
    await assertRejects(
      () =>
        loadOrCreateCert(
          dir,
          `${dir}/nonexistent.pem`,
          `${dir}/also-missing.pem`,
        ),
    );
  });
});

// ── Cert IDENTITY (field report #2, root cause B) ──────────────────────
//
// Every aio app on earth used to issue `CN = aio-local`. A TLS client picks a
// trust anchor by matching the ISSUER DN, so a stale cert in a trust store —
// or the OTHER app's cert in a two-app repo — shadowed the right one and the
// handshake died with `BadSignature`, an error that names nothing about its
// cause. The DN must be per-app, and the leaf must be usable as its own
// pinned anchor.

/** `openssl x509 -text` for a PEM on disk. */
async function certText(path: string): Promise<string> {
  const r = await new Deno.Command("openssl", {
    args: ["x509", "-in", path, "-text", "-noout"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(r.success, true, new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout);
}

Deno.test("certCommonName: per-app, sanitized, with a fallback", () => {
  assertEquals(certCommonName("notes"), "aio-notes");
  assertEquals(certCommonName(), DEFAULT_CERT_CN);
  assertEquals(certCommonName(""), DEFAULT_CERT_CN);
  // openssl config injection / DN metacharacters can never reach the config.
  assertEquals(certCommonName("a b/c=d\nCN"), "aio-a-b-c-d-CN");
  assertNotEquals(certCommonName("app-a"), certCommonName("app-b"));
});

Deno.test("generated cert carries the appId in its subject, CA:FALSE, and SANs", async () => {
  await withTempDir(async (dir) => {
    const appId = "notes-probe";
    const { certPath } = await loadOrCreateCert(
      dir,
      undefined,
      undefined,
      appId,
    );
    const text = await certText(certPath);
    // Identity: the app's own name, not the shared constant.
    assert(
      text.includes(`CN = aio-${appId}`) || text.includes(`CN=aio-${appId}`),
      `subject must name the app:\n${text}`,
    );
    assert(!text.includes("aio-local"), `still the shared DN:\n${text}`);
    // CA:FALSE is load-bearing: rustls rejects a self-signed leaf with
    // CA:TRUE as `CaUsedAsEndEntity`, so CA:TRUE would break the pinned-anchor
    // path this cert exists for.
    assert(text.includes("CA:FALSE"), `basicConstraints missing:\n${text}`);
    assert(
      !text.includes("CA:TRUE"),
      `CA:TRUE is unusable as a leaf:\n${text}`,
    );
    assert(
      /X509v3 Authority Key Identifier/.test(text),
      `authorityKeyIdentifier missing:\n${text}`,
    );
    // Hostname verification runs off the SANs — unchanged by the DN.
    assert(text.includes("DNS:localhost"), `SANs missing:\n${text}`);
    assert(text.includes("IP Address:127.0.0.1"), `SANs missing:\n${text}`);
  });
});

// This used to assert the OPPOSITE — that two apps get different ISSUER DNs —
// and it was right for the design it guarded. Back then every app's leaf was
// its own trust anchor, so a client holding several of them picked one by
// matching the issuer DN; when they all said `aio-local`, it picked the wrong
// anchor and rustls failed with `BadSignature`, which names nothing about the
// cause.
//
// That hazard is not moved, it is DISSOLVED: there is now exactly one anchor on
// the machine, so there is nothing to disambiguate. Sharing an issuer is the
// point — it is what lets a person trust one certificate and have every aio
// app work, including apps that do not exist yet.
//
// What must still hold is that the two apps remain TELLABLE APART, and that
// they really do hang off the same root rather than quietly minting their own.
Deno.test("two apps share ONE issuer and stay distinguishable", async () => {
  await withTempDir(async (a) => {
    await withTempDir(async (b) => {
      const one = await loadOrCreateCert(a, undefined, undefined, "app-one");
      const two = await loadOrCreateCert(b, undefined, undefined, "app-two");
      const line = (t: string, k: string) =>
        t.split("\n").find((l) => l.trim().startsWith(k))!.trim();
      const t1 = await certText(one.certPath);
      const t2 = await certText(two.certPath);

      // ① one anchor, shared — the whole reason `am trust` is a one-time act
      assertEquals(line(t1, "Issuer:"), line(t2, "Issuer:"));
      assertEquals(one.caPath, two.caPath);

      // ② still two different apps, named as themselves
      assertNotEquals(line(t1, "Subject:"), line(t2, "Subject:"));
      assert(line(t1, "Subject:").includes("app-one"), line(t1, "Subject:"));
      assert(line(t2, "Subject:").includes("app-two"), line(t2, "Subject:"));
    });
  });
});

Deno.test("compat: a cert already on disk is reused VERBATIM, old DN and all", async () => {
  await withTempDir(async (dir) => {
    // Simulate a pre-upgrade cert: generated under the legacy shared name.
    const legacy = await loadOrCreateCert(dir);
    assert(
      (await certText(legacy.certPath)).includes("aio-local"),
      "no-appId generation must keep the legacy DN",
    );
    // Same directory, now with an appId: an existing keypair is never
    // re-issued, so a client that pinned it keeps working.
    const after = await loadOrCreateCert(dir, undefined, undefined, "notes");
    assertEquals(after.cert, legacy.cert);
    assertEquals(after.key, legacy.key);
  });
});
