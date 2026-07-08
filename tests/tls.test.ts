import { assertEquals, assertRejects } from "@std/assert";
import { loadOrCreateCert } from "../src/server/tls.ts";

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
