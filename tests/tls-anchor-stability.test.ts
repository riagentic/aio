// Automatic TLS must never break an app that nobody touched.
//
// The rule it exists to enforce: turning TLS on may not introduce a failure the
// app would not have had without it. The way it used to break that rule was
// quiet and total — a certificate is generated once and cached forever, so its
// SAN list is a snapshot of whatever addresses the machine had that day. Move
// to another network, take a new DHCP lease, bring up a VPN, and the cached
// cert no longer names the address clients now use. The handshake fails, the
// code is unchanged, and nothing in the error says "your certificate is from a
// different network".
//
// The fix is an anchor that never has to move: the app issues its own CA, and
// the leaf — the only part that names addresses — is re-issued freely. Clients
// pin the CA. These tests pin BOTH halves of that: the leaf tracks the network,
// and the anchor does not.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  aioRootPaths,
  certSans,
  currentSans,
  loadOrCreateCert,
  sansCover,
} from "../src/server/tls.ts";

// The machine-wide root is MACHINE-wide, so a test that does not relocate it
// writes trust material into the developer's real home — and would then be
// asserting against whatever their actual machine already had. `AIO_APPS_DIR`
// is the one variable that moves the whole data root, root CA included; the
// suite sets it, and these tests set it too so they are isolated however they
// are run, not only under `deno task test`.
const SANDBOX = await Deno.makeTempDir({ prefix: "aio-tls-sandbox-" });
Deno.env.set("AIO_APPS_DIR", SANDBOX);

/** openssl is how certs are written here, so it is how they are read back.
 *  Without it these tests would be asserting on nothing. */
async function hasOpenssl(): Promise<boolean> {
  try {
    const r = await new Deno.Command("openssl", {
      args: ["version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return r.success;
  } catch {
    return false;
  }
}

const SKIP = !(await hasOpenssl());

Deno.test({
  name: "tls: the leaf covers every address this machine answers on",
  ignore: SKIP,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-tls-fresh-" });
    try {
      const t = await loadOrCreateCert(dir, undefined, undefined, "cov-app");
      const sans = await certSans(t.certPath);
      const want = currentSans();
      assert(
        sansCover(sans, want),
        `leaf is missing addresses it must serve: have ${
          JSON.stringify(sans)
        }, want ${JSON.stringify(want)}`,
      );
      // Loopback is the entry that is true on every machine forever — a cert
      // without it fails for the developer on their own laptop.
      assert(sans!.ips.includes("127.0.0.1"));
      assert(sans!.dns.includes("localhost"));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "tls: an unchanged network reuses the cert (pins stay valid)",
  ignore: SKIP,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-tls-reuse-" });
    try {
      const a = await loadOrCreateCert(dir, undefined, undefined, "reuse-app");
      const b = await loadOrCreateCert(dir, undefined, undefined, "reuse-app");
      assertEquals(
        a.cert,
        b.cert,
        "a cert that still covers this machine must be reused byte for byte — " +
          "re-issuing it for no reason invalidates every client's pin",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "tls: a cert from another network is re-issued, and the anchor holds",
  ignore: SKIP,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-tls-stale-" });
    try {
      const first = await loadOrCreateCert(
        dir,
        undefined,
        undefined,
        "net-app",
      );
      const caBefore = await Deno.readTextFile(first.caPath!);

      // Simulate "you are on a different network now" the only way that is
      // honest without a second machine: replace the leaf with one whose SANs
      // name an address this host does NOT have. That is exactly the state a
      // laptop is in after it changes networks.
      const foreign = join(dir, "foreign.cnf");
      await Deno.writeTextFile(
        foreign,
        [
          "[req]",
          "distinguished_name = dn",
          "x509_extensions = v3",
          "prompt = no",
          "[dn]",
          "CN = aio-net-app",
          "[v3]",
          "basicConstraints = critical,CA:FALSE",
          "subjectAltName = @sans",
          "[sans]",
          "DNS.1 = localhost",
          "IP.1 = 203.0.113.7", // TEST-NET-3: never a real local address
        ].join("\n"),
      );
      const r = await new Deno.Command("openssl", {
        args: [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-keyout",
          join(dir, "tls-key.pem"),
          "-out",
          join(dir, "tls-cert.pem"),
          "-days",
          "30",
          "-nodes",
          "-config",
          foreign,
        ],
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(r.success, new TextDecoder().decode(r.stderr));

      const stale = await certSans(join(dir, "tls-cert.pem"));
      assert(
        !sansCover(stale, currentSans()),
        "the fixture is inert — it must NOT cover this machine",
      );

      const second = await loadOrCreateCert(
        dir,
        undefined,
        undefined,
        "net-app",
      );

      // ① the leaf was re-issued and now serves this machine
      assert(
        sansCover(await certSans(second.certPath), currentSans()),
        "a stale cert must be re-issued for the addresses in use NOW — " +
          "reusing it is the silent handshake failure this all exists to stop",
      );

      // ② and the anchor did NOT move, which is the whole point: a client that
      //    paired on the old network is still paired on the new one.
      assertEquals(
        await Deno.readTextFile(second.caPath!),
        caBefore,
        "the CA must survive a leaf re-issue — an anchor that changes when " +
          "the network changes is the bug wearing a different hat",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "tls: the CA private key is owner-only",
  ignore: SKIP || Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-tls-perm-" });
    try {
      const t = await loadOrCreateCert(dir, undefined, undefined, "perm-app");
      // This key can mint a trusted certificate for EVERY aio app on this
      // machine, for the next ten years, and a person is being asked to put
      // its public half in their browser. It is the most sensitive file the
      // framework writes.
      const caKey = aioRootPaths().keyPath;
      assertEquals((await Deno.stat(caKey)).mode! & 0o777, 0o600);
      assertEquals((await Deno.stat(t.keyPath)).mode! & 0o777, 0o600);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("tls: sansCover is exact, not approximate", () => {
  const want = { dns: ["localhost"], ips: ["127.0.0.1", "192.168.1.5"] };
  assert(
    sansCover({ dns: ["localhost"], ips: ["127.0.0.1", "192.168.1.5"] }, want),
  );
  // A superset is fine — extra addresses cost nothing.
  assert(
    sansCover({
      dns: ["localhost", "x"],
      ips: ["127.0.0.1", "192.168.1.5", "::1"],
    }, want),
  );
  // A missing address is NOT fine: that is precisely the one a client fails on.
  assert(!sansCover({ dns: ["localhost"], ips: ["127.0.0.1"] }, want));
  assert(!sansCover({ dns: [], ips: ["127.0.0.1", "192.168.1.5"] }, want));
  assert(!sansCover(null, want));
});

// ── The machine-wide root ───────────────────────────────────────────────────

Deno.test({
  name: "tls: one root serves every app on the machine",
  ignore: SKIP,
  fn: async () => {
    const a = await Deno.makeTempDir({ prefix: "aio-tls-app-a-" });
    const b = await Deno.makeTempDir({ prefix: "aio-tls-app-b-" });
    try {
      const ca = await loadOrCreateCert(a, undefined, undefined, "app-a");
      const cb = await loadOrCreateCert(b, undefined, undefined, "app-b");
      // The point of the whole design: trust it once, and the app you write
      // next month is already trusted. A per-app root would mean a new
      // browser dialog per app forever.
      assertEquals(ca.caPath, cb.caPath);
      assertEquals(
        await Deno.readTextFile(ca.caPath!),
        await Deno.readTextFile(cb.caPath!),
      );
      // …and their leaves are genuinely different certificates.
      assert(ca.cert !== cb.cert);
    } finally {
      await Deno.remove(a, { recursive: true });
      await Deno.remove(b, { recursive: true });
    }
  },
});

// This is what makes asking someone to install it defensible. An unconstrained
// CA in a trust store can vouch for ANY site on the internet — that is what
// made Superfish and eDellRoot catastrophic. This one is cryptographically
// incapable of speaking for the public web, and that must stay true by test,
// not by intention: the constraints are one edit away from being dropped, and
// nothing else in the system would notice.
Deno.test({
  name: "tls: the root CANNOT vouch for the public internet",
  ignore: SKIP,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-tls-nc-" });
    try {
      await loadOrCreateCert(dir, undefined, undefined, "nc-app");
      const { certPath: rootPath, keyPath: rootKey } = aioRootPaths();

      const sign = async (san: string) => {
        const cfg = join(dir, "probe.cnf");
        await Deno.writeTextFile(
          cfg,
          [
            "[req]",
            "distinguished_name = dn",
            "req_extensions = v3",
            "prompt = no",
            "[dn]",
            "CN = probe",
            "[v3]",
            "basicConstraints = critical,CA:FALSE",
            "extendedKeyUsage = serverAuth",
            `subjectAltName = ${san}`,
          ].join("\n"),
        );
        const csr = join(dir, "probe.csr");
        const leaf = join(dir, "probe.pem");
        await new Deno.Command("openssl", {
          args: [
            "req",
            "-new",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-keyout",
            join(dir, "probe-key.pem"),
            "-out",
            csr,
            "-nodes",
            "-config",
            cfg,
          ],
          stdout: "null",
          stderr: "null",
        }).output();
        await new Deno.Command("openssl", {
          args: [
            "x509",
            "-req",
            "-in",
            csr,
            "-CA",
            rootPath,
            "-CAkey",
            rootKey,
            "-CAcreateserial",
            "-out",
            leaf,
            "-days",
            "5",
            "-extfile",
            cfg,
            "-extensions",
            "v3",
          ],
          stdout: "null",
          stderr: "null",
        }).output();
        const v = await new Deno.Command("openssl", {
          args: ["verify", "-CAfile", rootPath, leaf],
          stdout: "null",
          stderr: "null",
        }).output();
        return v.success;
      };

      // Where an aio app actually lives — must work, or the feature is useless.
      assert(await sign("DNS:localhost"), "localhost must verify");
      assert(await sign("IP:127.0.0.1"), "loopback must verify");
      assert(await sign("IP:192.168.1.5"), "a LAN address must verify");
      assert(await sign("IP:10.1.2.3"), "a LAN address must verify");

      // The public internet — must NOT, even holding the private key.
      assert(
        !(await sign("DNS:example.com")),
        "the root signed a public DNS name — the name constraints are gone, " +
          "and installing this root would expose the whole web to anyone who " +
          "steals it",
      );
      assert(
        !(await sign("IP:8.8.8.8")),
        "the root signed a public IP — name constraints are not holding",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// The on-disk certificate file must be usable AS A TRUST ANCHOR by itself.
//
// Everything that hands out "the certificate to trust" points at this one path:
// `am profile` exports it, `DENO_CERT` names it, the aio client takes it as
// `--cert=`. While the leaf was self-signed it anchored itself. The moment it
// became CA-issued, a client pinning the leaf alone had an anchor it could not
// build a chain to — and the failure was not an error but a HANG, because a
// handshake that cannot complete just sits there. tests/e2e-lan-client.test.ts
// caught it by timing out after eight minutes; this catches it in a
// millisecond.
Deno.test({
  name: "tls: the cert file on disk carries its own anchor",
  ignore: SKIP,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-tls-chain-" });
    try {
      const t = await loadOrCreateCert(dir, undefined, undefined, "chain-app");
      const onDisk = await Deno.readTextFile(t.certPath);
      const count = [...onDisk.matchAll(/BEGIN CERTIFICATE/g)].length;
      assertEquals(
        count,
        2,
        "the file a client pins must hold the leaf AND the root that signed " +
          "it — one certificate alone is an anchor nothing chains to",
      );
      // What the server serves and what a client pins are the same bytes.
      assertEquals(t.cert, onDisk);
      // And the SAN read still sees the LEAF, not the root (openssl reads the
      // first cert) — otherwise staleness would be judged against a cert that
      // deliberately names no address, and never re-issue.
      const sans = await certSans(t.certPath);
      assert(sansCover(sans, currentSans()));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
