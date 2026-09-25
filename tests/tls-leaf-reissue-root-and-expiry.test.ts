// A cached leaf is reused only while it is VALID for the root on disk now:
// covering the machine's addresses is not enough. Before the fix a leaf was
// reused (1) after the machine root was rotated — the chain served the OLD
// root and a client pinning the new one failed the handshake — and (2) after
// it expired, forever.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  aioRootPaths,
  currentSans,
  loadOrCreateAioRoot,
  loadOrCreateCert,
} from "../src/server/tls.ts";
import { certNotAfter, issueLeaf } from "../src/server/x509.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { pinnedTest } from "../src/testing/env-pin.ts";

const SANDBOX = await tempDir("aio-tls-reissue-");
const test = pinnedTest({ AIO_APPS_DIR: join(SANDBOX, "apps") });
const firstPem = (s: string) =>
  s.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ??
    [];

test({
  name:
    "tls: after the machine root is rotated the cached leaf is re-issued under the new root",
  fn: async () => {
    {
      const dir = join(SANDBOX, "rot");
      const a = await loadOrCreateCert(dir, undefined, undefined, "rot");
      const { certPath, keyPath } = aioRootPaths();
      await Deno.remove(certPath);
      await Deno.remove(keyPath);
      const r2 = (await loadOrCreateAioRoot()).cert; // what `am trust` does
      const b = await loadOrCreateCert(dir, undefined, undefined, "rot");
      assert(a.cert !== b.cert, "the old leaf must not be served on");
      assertEquals(firstPem(b.cert).at(-1), firstPem(r2)[0]);
      // And the chain actually verifies against the pinned NEW root.
      const srv = Deno.serve(
        {
          port: 0,
          hostname: "127.0.0.1",
          cert: b.cert,
          key: b.key,
          onListen() {},
        },
        () => new Response("ok"),
      );
      const client = Deno.createHttpClient({ caCerts: [r2] });
      try {
        const r = await fetch(
          `https://localhost:${srv.addr.port}/`,
          {
            client,
          } as RequestInit & { client: Deno.HttpClient },
        );
        assertEquals(await r.text(), "ok");
      } finally {
        client.close();
        await srv.shutdown();
      }
    }
  },
});

test({
  name: "tls: a cached leaf that is about to expire is re-issued, not reused",
  fn: async () => {
    const dir = join(SANDBOX, "exp");
    const a = await loadOrCreateCert(dir, undefined, undefined, "exp");
    const sans = currentSans();
    const { certPath, keyPath } = aioRootPaths();
    const short = await issueLeaf({
      commonName: "exp",
      dns: sans.dns,
      ips: sans.ips,
      days: 5,
      caCertPem: await Deno.readTextFile(certPath),
      caKeyPem: await Deno.readTextFile(keyPath),
    });
    const root = await Deno.readTextFile(certPath);
    await Deno.writeTextFile(
      join(dir, "tls-cert.pem"),
      short.certPem.trimEnd() + "\n" + root.trimEnd() + "\n",
    );
    await Deno.writeTextFile(join(dir, "tls-key.pem"), short.keyPem);
    const b = await loadOrCreateCert(dir, undefined, undefined, "exp");
    const left = certNotAfter(b.cert).getTime() - Date.now();
    assert(
      left > 100 * 86_400_000,
      `the 5-day leaf was served again (expires in ${
        Math.round(left / 86_400_000)
      } days)`,
    );
    assert(a.cert !== b.cert);
  },
});

test({
  name:
    "tls: a certificate without its key is refused, never silently replaced by a generated one",
  fn: async () => {
    const dir = join(SANDBOX, "half");
    const pem = join(SANDBOX, "mine.pem");
    await Deno.writeTextFile(pem, "not read");
    let err: unknown;
    try {
      await loadOrCreateCert(dir, pem, undefined, "half");
    } catch (e) {
      err = e;
    }
    assert(err instanceof Error, "half a pair must throw");
    assert(/without its key/.test(err.message), err.message);
    let err2: unknown;
    try {
      await loadOrCreateCert(dir, undefined, pem, "half");
    } catch (e) {
      err2 = e;
    }
    assert(
      err2 instanceof Error && /without its certificate/.test(err2.message),
    );
  },
});
