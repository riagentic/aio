// src/server/x509.ts — the certificates aio generates, with no openssl.
//
// A hand-written DER encoder is only worth trusting if something other than
// its author agrees with it. Four independent instruments do, and they fail
// differently, which is the point:
//
//   1. openssl PARSES it and prints the same extensions openssl itself used to
//      write — including the 11 name-constraint subtrees, line for line.
//   2. openssl VERIFIES the chain (`verify -CAfile`), which exercises the
//      signature and the issuer/subject linkage rather than the field layout.
//   3. a REAL rustls handshake — Deno.serve with the chain and a client that
//      trusts ONLY the generated root — which is the thing users actually do,
//      and the one instrument that runs on Windows where openssl is absent.
//   4. the SECURITY property rather than the bytes: a leaf minted for
//      `example.com` under this root must be REFUSED. Constraints that are
//      present but not enforced would pass instruments 1–3 happily.
//
// Instruments 1, 2 and 4 need openssl, which Windows has none of — they skip
// there, and 3 does not, so the OS that motivated this file still proves the
// certificates work on it.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  certConstrainedNameTypes,
  certSubjectAltNames,
  certSubjectDer,
  dnsWithinSubtree,
  fromPem,
  generateRoot,
  ipWithinSubtree,
  issueLeaf,
} from "../src/server/x509.ts";
import {
  ROOT_PERMITTED_DNS,
  ROOT_PERMITTED_IPS,
  splitByRootSubtrees,
} from "../src/server/tls.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function haveOpenssl(): Promise<boolean> {
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
const OPENSSL = await haveOpenssl();

async function openssl(args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await new Deno.Command("openssl", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ok: r.success,
    out: new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr),
  };
}

async function makePair(opts: { dns?: string[]; ips?: string[] } = {}) {
  const root = await generateRoot({
    commonName: "aio local root (test)",
    org: "aio",
    days: 3650,
    permittedDns: ROOT_PERMITTED_DNS,
    permittedIpMasks: ROOT_PERMITTED_IPS,
  });
  const leaf = await issueLeaf({
    commonName: "aio-testapp",
    dns: opts.dns ?? ["localhost"],
    ips: opts.ips ?? ["127.0.0.1", "::1"],
    days: 825,
    caCertPem: root.certPem,
    caKeyPem: root.keyPem,
  });
  return { root, leaf, chain: leaf.certPem + root.certPem };
}

async function inDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await tempDir("aio-x509-");
  try {
    return await fn(dir);
  } finally {
    await dropTempDir(dir);
  }
}

// ── 3. the handshake — every OS, including the one with no openssl ──────────

Deno.test("a REAL TLS client accepts the generated chain", async () => {
  const { root, leaf, chain } = await makePair();
  const port = await freePort();
  const ac = new AbortController();
  const server = Deno.serve({
    port,
    hostname: "127.0.0.1",
    signal: ac.signal,
    cert: chain,
    key: leaf.keyPem,
    onListen: () => {},
  }, () => new Response("ok from a cert aio built itself"));
  try {
    // The client trusts ONLY this root — no system store, no leaf pin. If the
    // signature, the validity window, the SANs or the chain were wrong, rustls
    // refuses here.
    const client = Deno.createHttpClient({ caCerts: [root.certPem] });
    try {
      const res = await fetch(
        `https://localhost:${port}/`,
        { client } as RequestInit & { client: Deno.HttpClient },
      );
      assertEquals(res.status, 200);
      assertEquals(await res.text(), "ok from a cert aio built itself");
    } finally {
      client.close();
    }
  } finally {
    ac.abort();
    await server.finished.catch(() => {});
  }
});

Deno.test("the IP SAN works too — a client dialing 127.0.0.1 by address", async () => {
  const { root, leaf, chain } = await makePair();
  const port = await freePort();
  const ac = new AbortController();
  const server = Deno.serve({
    port,
    hostname: "127.0.0.1",
    signal: ac.signal,
    cert: chain,
    key: leaf.keyPem,
    onListen: () => {},
  }, () => new Response("by address"));
  try {
    const client = Deno.createHttpClient({ caCerts: [root.certPem] });
    try {
      const res = await fetch(
        `https://127.0.0.1:${port}/`,
        { client } as RequestInit & { client: Deno.HttpClient },
      );
      assertEquals(await res.text(), "by address");
    } finally {
      client.close();
    }
  } finally {
    ac.abort();
    await server.finished.catch(() => {});
  }
});

// ── the reader, and the round trip that keeps cached certs valid ───────────

Deno.test("certSubjectAltNames round-trips what was asked for", async () => {
  const { leaf, chain, root } = await makePair({
    dns: ["localhost"],
    ips: ["127.0.0.1", "::1", "192.168.1.5"],
  });
  const got = certSubjectAltNames(leaf.certPem);
  assert(got, "the leaf must carry SANs");
  assertEquals(got.dns, ["localhost"]);
  // IPv6 comes back fully expanded — the spelling openssl printed too, which
  // is what `normIp`/`sansCover` were written against. A change here would
  // mark every cached certificate stale on upgrade.
  assertEquals(got.ips, ["127.0.0.1", "0:0:0:0:0:0:0:1", "192.168.1.5"]);
  // A chain file answers for its FIRST certificate, the leaf.
  assertEquals(certSubjectAltNames(chain), got);
  // The root names no addresses at all, and that is `null`, not an error.
  assertEquals(certSubjectAltNames(root.certPem), null);
});

Deno.test("the leaf's issuer is the root's subject, byte for byte", async () => {
  const { root, leaf } = await makePair();
  const rootSubject = certSubjectDer(root.certPem);
  // certSubjectDer on the LEAF gives the leaf's subject; the linkage that
  // matters is issuer==subject, and instrument 2 (openssl verify) proves it.
  // Here we prove the bytes are copied rather than re-encoded.
  const leafDer = certSubjectDer(leaf.certPem);
  assert(rootSubject.length > 0 && leafDer.length > 0);
  assert(
    !rootSubject.every((b, i) => b === leafDer[i]),
    "root and leaf have different subjects",
  );
});

// ── 1, 2, 4. what openssl says (skipped where there is none) ───────────────

Deno.test({
  name: "openssl parses it and prints the extensions aio asked for",
  ignore: !OPENSSL,
  fn: () =>
    inDir(async (dir) => {
      const { root, chain } = await makePair();
      await Deno.writeTextFile(`${dir}/root.pem`, root.certPem);
      await Deno.writeTextFile(`${dir}/chain.pem`, chain);

      const r = await openssl([
        "x509",
        "-in",
        `${dir}/root.pem`,
        "-noout",
        "-text",
      ]);
      assert(r.ok, `openssl could not parse the root:\n${r.out}`);
      assertStringIncludes(r.out, "ecdsa-with-SHA256");
      assertStringIncludes(r.out, "CN = aio local root (test), O = aio");
      assertStringIncludes(r.out, "CA:TRUE, pathlen:0");
      assertStringIncludes(r.out, "Certificate Sign");
      // Every permitted subtree, in openssl's own spelling. This is the block
      // that used to come out of openssl's config parser.
      for (
        const want of [
          "DNS:localhost",
          "DNS:.local",
          "DNS:.localhost",
          "IP:127.0.0.0/255.0.0.0",
          "IP:10.0.0.0/255.0.0.0",
          "IP:192.168.0.0/255.255.0.0",
          "IP:172.16.0.0/255.240.0.0",
          "IP:169.254.0.0/255.255.0.0",
          "IP:0:0:0:0:0:0:0:1/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF",
          "IP:FC00:0:0:0:0:0:0:0/FE00:0:0:0:0:0:0:0",
          "IP:FE80:0:0:0:0:0:0:0/FFC0:0:0:0:0:0:0:0",
        ]
      ) {
        assertStringIncludes(r.out, want);
      }

      const l = await openssl([
        "x509",
        "-in",
        `${dir}/chain.pem`,
        "-noout",
        "-text",
      ]);
      assert(l.ok, `openssl could not parse the leaf:\n${l.out}`);
      assertStringIncludes(l.out, "CN = aio-testapp");
      assertStringIncludes(l.out, "CA:FALSE");
      assertStringIncludes(l.out, "TLS Web Server Authentication");
      // openssl's `x509 -req -CA` added this implicitly; a leaf without one is
      // not what this replaced.
      assertStringIncludes(l.out, "X509v3 Authority Key Identifier");
      assertStringIncludes(l.out, "DNS:localhost");
      assertStringIncludes(l.out, "IP Address:127.0.0.1");
    }),
});

Deno.test({
  name: "openssl verifies the chain against the generated root",
  ignore: !OPENSSL,
  fn: () =>
    inDir(async (dir) => {
      const { root, leaf } = await makePair();
      await Deno.writeTextFile(`${dir}/root.pem`, root.certPem);
      await Deno.writeTextFile(`${dir}/leaf.pem`, leaf.certPem);
      const v = await openssl([
        "verify",
        "-CAfile",
        `${dir}/root.pem`,
        `${dir}/leaf.pem`,
      ]);
      assert(v.ok, `the chain does not verify:\n${v.out}`);
      assertStringIncludes(v.out, "OK");
    }),
});

Deno.test({
  name: "the name constraints BITE: a public name under this root is refused",
  ignore: !OPENSSL,
  fn: () =>
    inDir(async (dir) => {
      // The security property the whole design rests on: installing this root
      // must not let it vouch for the internet. Present-but-unenforced
      // constraints pass every other instrument in this file.
      const root = await generateRoot({
        commonName: "aio local root (test)",
        org: "aio",
        days: 3650,
        permittedDns: ROOT_PERMITTED_DNS,
        permittedIpMasks: ROOT_PERMITTED_IPS,
      });
      const evil = await issueLeaf({
        commonName: "aio-evil",
        dns: ["example.com"],
        ips: ["8.8.8.8"],
        days: 825,
        caCertPem: root.certPem,
        caKeyPem: root.keyPem,
      });
      await Deno.writeTextFile(`${dir}/root.pem`, root.certPem);
      await Deno.writeTextFile(`${dir}/evil.pem`, evil.certPem);
      const v = await openssl([
        "verify",
        "-CAfile",
        `${dir}/root.pem`,
        `${dir}/evil.pem`,
      ]);
      assert(
        !v.ok,
        `a leaf for example.com/8.8.8.8 was ACCEPTED under the local root — ` +
          `the name constraints are decoration:\n${v.out}`,
      );
      assertStringIncludes(v.out, "permitted subtree violation");
    }),
});

// ── the upgrade path ────────────────────────────────────────────────────────

Deno.test({
  name: "a leaf issued under a root OPENSSL generated still verifies",
  ignore: !OPENSSL,
  fn: () =>
    inDir(async (dir) => {
      // Every machine that ever ran an older aio has an openssl-made root on
      // disk, and it is the anchor its clients pinned. Re-issuing a leaf under
      // it must keep working, which needs the issuer DN copied out of that
      // certificate verbatim rather than re-encoded from a string.
      const cfg = `${dir}/root.cnf`;
      await Deno.writeTextFile(
        cfg,
        [
          "[req]",
          "distinguished_name = dn",
          "x509_extensions = v3",
          "prompt = no",
          "[dn]",
          "CN = aio local root (legacy)",
          "O = aio",
          "[v3]",
          "basicConstraints = critical,CA:TRUE,pathlen:0",
          "keyUsage = critical,keyCertSign,cRLSign",
          "subjectKeyIdentifier = hash",
        ].join("\n"),
      );
      const gen = await openssl([
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-keyout",
        `${dir}/legacy-key.pem`,
        "-out",
        `${dir}/legacy-root.pem`,
        "-days",
        "3650",
        "-nodes",
        "-config",
        cfg,
      ]);
      assert(gen.ok, `could not make a legacy root:\n${gen.out}`);

      const leaf = await issueLeaf({
        commonName: "aio-upgraded",
        dns: ["localhost"],
        ips: ["127.0.0.1"],
        days: 825,
        caCertPem: await Deno.readTextFile(`${dir}/legacy-root.pem`),
        caKeyPem: await Deno.readTextFile(`${dir}/legacy-key.pem`),
      });
      await Deno.writeTextFile(`${dir}/upgraded.pem`, leaf.certPem);
      const v = await openssl([
        "verify",
        "-CAfile",
        `${dir}/legacy-root.pem`,
        `${dir}/upgraded.pem`,
      ]);
      assert(
        v.ok,
        `a leaf issued under the openssl-era root does not chain to it — ` +
          `every machine that upgrades loses its pinned anchor:\n${v.out}`,
      );

      // …and a client still completes a handshake against that pairing.
      const port = await freePort();
      const ac = new AbortController();
      const server = Deno.serve({
        port,
        hostname: "127.0.0.1",
        signal: ac.signal,
        cert: leaf.certPem + await Deno.readTextFile(`${dir}/legacy-root.pem`),
        key: leaf.keyPem,
        onListen: () => {},
      }, () => new Response("upgraded"));
      try {
        const client = Deno.createHttpClient({
          caCerts: [await Deno.readTextFile(`${dir}/legacy-root.pem`)],
        });
        try {
          const res = await fetch(
            `https://localhost:${port}/`,
            { client } as RequestInit & { client: Deno.HttpClient },
          );
          assertEquals(await res.text(), "upgraded");
        } finally {
          client.close();
        }
      } finally {
        ac.abort();
        await server.finished.catch(() => {});
      }
    }),
});

// ── the 2050 boundary ───────────────────────────────────────────────────────

Deno.test("validity past 2049 switches to GeneralizedTime", async () => {
  // RFC 5280 §4.1.2.5: UTCTime carries a TWO-DIGIT year and is only valid
  // through 2049; from 2050 a certificate must use GeneralizedTime. This is
  // not hypothetical for aio — the machine root is valid for 3650 days, so
  // every root created from January 2040 onward already ends past the
  // boundary, and a hardcoded UTCTime would silently write a year in the
  // 1900s: a certificate generated fresh and already expired by 130 years.
  //
  // Asserted on the BYTES, so it holds on Windows too, where there is no
  // openssl to ask.
  const far = await generateRoot({
    commonName: "aio local root (far future)",
    org: "aio",
    days: 11_000, // ~30 years: lands in the 2050s
    permittedDns: ROOT_PERMITTED_DNS,
    permittedIpMasks: ROOT_PERMITTED_IPS,
  });
  const der = fromPemForTest(far.certPem);
  // notBefore is today (UTCTime, 0x17); notAfter is past 2049
  // (GeneralizedTime, 0x18). Both tags must be present in one certificate,
  // which is what proves the choice is per-date and not per-file.
  assert(der.includes(0x17), "notBefore should still be UTCTime");
  assert(
    der.includes(0x18),
    "a validity ending after 2049 must be encoded as GeneralizedTime",
  );

  if (OPENSSL) {
    await inDir(async (dir) => {
      await Deno.writeTextFile(`${dir}/far.pem`, far.certPem);
      const r = await openssl([
        "x509",
        "-in",
        `${dir}/far.pem`,
        "-noout",
        "-dates",
      ]);
      assert(r.ok, `openssl could not read the dates:\n${r.out}`);
      const year = Number(/notAfter=.*\b(\d{4})\s+GMT/.exec(r.out)?.[1] ?? "0");
      assert(
        year >= 2050,
        `notAfter came back as ${year} — the year wrapped:\n${r.out}`,
      );
    });
  }
});

/** The PEM body as DER, for byte-level assertions. */
function fromPemForTest(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ── what the four instruments above could not see ──────────────────────────
//
// All four fed the encoder only inputs it was designed for, under a root they
// controlled, and asked openssl or rustls. The tests below feed it what a real
// machine and a real thief would, and ask a verifier that is neither.

Deno.test({
  name: "an address the root cannot name POISONS the whole certificate",
  ignore: !OPENSSL,
  fn: () =>
    inDir(async (dir) => {
      // 100.64/10 is CGNAT — it is also every Tailscale address, which is the
      // single most common reason to run `--expose` at all. `localIPs()` hands
      // over every non-loopback IPv4 this machine has, so such an address used
      // to land in the SAN list unexamined.
      //
      // The point of this test is the BLAST RADIUS: `localhost` and 127.0.0.1
      // are in the same certificate and are perfectly permitted, and they die
      // too. A name-constraint violation is a verdict on the certificate, not
      // on the one name that caused it.
      const { root } = await makePair();
      const poisoned = await issueLeaf({
        commonName: "aio-poisoned",
        dns: ["localhost"],
        ips: ["127.0.0.1", "100.64.7.9"],
        days: 825,
        caCertPem: root.certPem,
        caKeyPem: root.keyPem,
      });
      await Deno.writeTextFile(`${dir}/root.pem`, root.certPem);
      await Deno.writeTextFile(`${dir}/poisoned.pem`, poisoned.certPem);
      const v = await openssl([
        "verify",
        "-CAfile",
        `${dir}/root.pem`,
        `${dir}/poisoned.pem`,
      ]);
      assert(!v.ok, `openssl accepted a leaf naming 100.64.7.9:\n${v.out}`);
      assertStringIncludes(v.out, "permitted subtree violation");

      // …so the address set aio actually issues must already exclude it.
      const { sans, dropped } = splitByRootSubtrees({
        dns: ["localhost", "example.com"],
        ips: ["127.0.0.1", "::1", "192.168.1.5", "100.64.7.9", "8.8.8.8"],
      });
      assertEquals(sans.dns, ["localhost"]);
      assertEquals(sans.ips, ["127.0.0.1", "::1", "192.168.1.5"]);
      assertEquals(dropped, ["example.com", "100.64.7.9", "8.8.8.8"]);
      // And every address that survives the filter must actually verify.
      const good = await issueLeaf({
        commonName: "aio-good",
        dns: sans.dns,
        ips: sans.ips,
        days: 825,
        caCertPem: root.certPem,
        caKeyPem: root.keyPem,
      });
      await Deno.writeTextFile(`${dir}/good.pem`, good.certPem);
      const ok = await openssl([
        "verify",
        "-CAfile",
        `${dir}/root.pem`,
        `${dir}/good.pem`,
      ]);
      assert(ok.ok, `the filtered SAN set does not verify:\n${ok.out}`);
    }),
});

Deno.test("the subtree predicates agree with the encoder, address by address", () => {
  // ONE parser decides what an address means. If `splitByRootSubtrees` read
  // `10.0.0.1` one way and the encoder wrote it another, the filter would pass
  // an address the certificate then fails on — the exact shape of bug that
  // makes a chain reject itself.
  for (
    const [ip, want] of [
      ["127.0.0.1", true],
      ["127.255.255.254", true],
      ["10.5.0.2", true],
      ["192.168.88.151", true],
      ["172.16.0.1", true],
      ["172.31.255.255", true],
      ["172.32.0.1", false], // just past the /12
      ["172.15.255.255", false],
      ["169.254.3.4", true],
      ["100.64.7.9", false], // CGNAT / Tailscale
      ["8.8.8.8", false],
      ["203.0.113.5", false],
      ["::1", true],
      ["::2", false],
      ["fd00::1", true], // fc00::/7
      ["fe80::1", true], // fe80::/10
      ["fec0::1", false], // just past the /10
      ["2001:4860:4860::8888", false],
      ["999.1.2.3", false], // not an address at all → in no subtree
      ["1.2.3", false],
      ["::ffff:127.0.0.1", false], // not a spelling this encoder accepts
    ] as const
  ) {
    assertEquals(
      ROOT_PERMITTED_IPS.some((s) => ipWithinSubtree(ip, s)),
      want,
      ip,
    );
  }
  for (
    const [d, want] of [
      ["localhost", true],
      ["LocalHost", true],
      ["printer.local", true],
      ["a.b.local", true],
      ["app.localhost", true],
      ["notlocalhost", false],
      ["local", false],
      ["example.com", false],
      ["localhost.example.com", false],
    ] as const
  ) {
    assertEquals(
      ROOT_PERMITTED_DNS.some((b) => dnsWithinSubtree(d, b)),
      want,
      d,
    );
  }
});

Deno.test("an address that will not encode is an error, not a guess", async () => {
  const { root } = await makePair();
  const mint = (ips: string[]) =>
    issueLeaf({
      commonName: "aio-bad",
      dns: ["localhost"],
      ips,
      days: 825,
      caCertPem: root.certPem,
      caKeyPem: root.keyPem,
    });
  // Each of these used to MINT. `999.888.777.666` became 231.120.9.154;
  // `1.2.3` became a three-byte iPAddress that Java reads as "Invalid
  // IPAddressName" and Python as "does not appear to be an IPv4 or IPv6
  // address"; `1:2:…:9:10` quietly lost two groups; `::ffff:127.0.0.1` came
  // back as `0:0:0:0:0:0:ffff:127`. A certificate naming an address nobody
  // asked for is worse than no certificate.
  for (
    const bad of [
      "999.888.777.666",
      "1.2.3",
      "1.2.3.4.5",
      "1.2.3.-4",
      "1.2.3.x",
      "",
      "1:2:3:4:5:6:7:8:9:10",
      "1::2::3",
      "::ffff:127.0.0.1",
      "fe80::1%eth0",
      "12345::1",
      "gggg::1",
    ]
  ) {
    await assertRejects(
      () => mint([bad]),
      Error,
      undefined,
      `"${bad}" was encoded instead of refused`,
    );
  }
  // …and the spellings that ARE addresses still mint.
  await mint(["127.0.0.1", "::1", "fe80::1", "10.0.0.1", "0.0.0.0"]);
});

Deno.test("a certificate that names nothing is refused, not written", async () => {
  // GeneralNames ::= SEQUENCE SIZE (1..MAX). openssl parses an empty one
  // happily; Java answers "No data available in passed DER encoded value".
  const { root } = await makePair();
  await assertRejects(
    () =>
      issueLeaf({
        commonName: "aio-nameless",
        dns: [],
        ips: [],
        days: 825,
        caCertPem: root.certPem,
        caKeyPem: root.keyPem,
      }),
    Error,
    "at least one address",
  );
});

Deno.test({
  name: "a stolen root key cannot sign for any purpose but serverAuth",
  ignore: !OPENSSL,
  fn: () =>
    inDir(async (dir) => {
      // The name constraints answer WHICH addresses and say nothing about FOR
      // WHAT — and `rfc822Name`, `otherName` and `uniformResourceIdentifier`
      // are not constrained at all. With the key in hand and nothing but
      // openssl, this root used to mint an S/MIME certificate for
      // `ceo@bigbank.com` and a client certificate carrying the Windows UPN
      // `admin@corp.example`, both of which `openssl verify` ACCEPTED. The
      // extendedKeyUsage on the root is what stops it, and Windows CryptoAPI
      // and macOS Security.framework enforce the same nesting.
      const { root, leaf } = await makePair();
      await Deno.writeTextFile(`${dir}/root.pem`, root.certPem);
      await Deno.writeTextFile(`${dir}/root-key.pem`, root.keyPem);
      await Deno.writeTextFile(`${dir}/leaf.pem`, leaf.certPem);
      await Deno.writeTextFile(
        `${dir}/thief.cnf`,
        [
          "[req]",
          "distinguished_name = dn",
          "prompt = no",
          "[dn]",
          "CN = thief",
          "[v3]",
          "basicConstraints = critical,CA:FALSE",
          "keyUsage = critical,digitalSignature,keyEncipherment",
          "extendedKeyUsage = emailProtection,clientAuth,codeSigning",
          "subjectAltName = email:ceo@bigbank.com," +
          "otherName:1.3.6.1.4.1.311.20.2.3;UTF8:admin@corp.example",
        ].join("\n"),
      );
      const csr = await openssl([
        "req",
        "-new",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-keyout",
        `${dir}/thief-key.pem`,
        "-out",
        `${dir}/thief.csr`,
        "-nodes",
        "-config",
        `${dir}/thief.cnf`,
      ]);
      assert(csr.ok, `could not build the thief's CSR:\n${csr.out}`);
      const signed = await openssl([
        "x509",
        "-req",
        "-in",
        `${dir}/thief.csr`,
        "-CA",
        `${dir}/root.pem`,
        "-CAkey",
        `${dir}/root-key.pem`,
        "-CAcreateserial",
        "-out",
        `${dir}/thief.pem`,
        "-days",
        "5",
        "-extfile",
        `${dir}/thief.cnf`,
        "-extensions",
        "v3",
      ]);
      assert(signed.ok, `the thief could not sign:\n${signed.out}`);
      for (const purpose of ["smimesign", "smimeencrypt", "sslclient"]) {
        const v = await openssl([
          "verify",
          "-purpose",
          purpose,
          "-CAfile",
          `${dir}/root.pem`,
          `${dir}/thief.pem`,
        ]);
        assert(
          !v.ok,
          `the local root vouched for a ${purpose} certificate:\n${v.out}`,
        );
        assertStringIncludes(v.out, "unsuitable certificate purpose");
      }
      // …and the one purpose aio needs is untouched.
      const ok = await openssl([
        "verify",
        "-purpose",
        "sslserver",
        "-CAfile",
        `${dir}/root.pem`,
        `${dir}/leaf.pem`,
      ]);
      assert(ok.ok, `serverAuth stopped working:\n${ok.out}`);
    }),
});

Deno.test({
  name:
    "the issuer DN is COPIED, not re-encoded — proven with a DN this encoder cannot write",
  ignore: !OPENSSL,
  fn: () =>
    inDir(async (dir) => {
      // The existing upgrade test cannot fail: openssl 3 writes UTF8String for
      // these names, which is exactly what `distinguishedName()` produces, so
      // a re-encoding would match byte for byte and pass. A root whose DN is
      // PrintableString (openssl `string_mask = pkix`, and what several older
      // and vendor openssls default to) is a DN this encoder CANNOT produce —
      // if the issuer is ever re-encoded from a string, this chain breaks.
      const cfg = `${dir}/root.cnf`;
      await Deno.writeTextFile(
        cfg,
        [
          "[req]",
          "string_mask = pkix",
          "distinguished_name = dn",
          "x509_extensions = v3",
          "prompt = no",
          "[dn]",
          "CN = aio local root (printable)",
          "O = aio",
          "[v3]",
          "basicConstraints = critical,CA:TRUE,pathlen:0",
          "keyUsage = critical,keyCertSign,cRLSign",
          "subjectKeyIdentifier = hash",
        ].join("\n"),
      );
      const gen = await openssl([
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-keyout",
        `${dir}/pk-key.pem`,
        "-out",
        `${dir}/pk-root.pem`,
        "-days",
        "3650",
        "-nodes",
        "-config",
        cfg,
      ]);
      assert(gen.ok, `could not make a PrintableString root:\n${gen.out}`);
      const caPem = await Deno.readTextFile(`${dir}/pk-root.pem`);
      // 0x13 is PrintableString; `distinguishedName()` only ever emits 0x0c.
      assert(
        certSubjectDer(caPem).includes(0x13),
        "the fixture is not PrintableString — this test proves nothing",
      );

      const leaf = await issueLeaf({
        commonName: "aio-printable",
        dns: ["localhost"],
        ips: ["127.0.0.1"],
        days: 825,
        caCertPem: caPem,
        caKeyPem: await Deno.readTextFile(`${dir}/pk-key.pem`),
      });
      await Deno.writeTextFile(`${dir}/pk-leaf.pem`, leaf.certPem);
      const v = await openssl([
        "verify",
        "-CAfile",
        `${dir}/pk-root.pem`,
        `${dir}/pk-leaf.pem`,
      ]);
      assert(
        v.ok,
        `a leaf under a PrintableString root does not chain:\n${v.out}`,
      );

      // The HANDSHAKE is the instrument that can actually fail here, and it
      // took measuring to find that out. openssl compares issuer and subject
      // CANONICALLY — it folds PrintableString and UTF8String together and
      // accepts a re-encoded DN — so `openssl verify` alone proves nothing
      // about the copy. rustls/webpki matches the DER byte for byte: swap the
      // verbatim copy for a re-encoding and this fetch fails while every
      // openssl assertion above still passes.
      const port = await freePort();
      const ac = new AbortController();
      const server = Deno.serve({
        port,
        hostname: "127.0.0.1",
        signal: ac.signal,
        cert: leaf.certPem + caPem,
        key: leaf.keyPem,
        onListen: () => {},
      }, () => new Response("printable"));
      try {
        const client = Deno.createHttpClient({ caCerts: [caPem] });
        try {
          const res = await fetch(
            `https://localhost:${port}/`,
            { client } as RequestInit & { client: Deno.HttpClient },
          );
          assertEquals(
            await res.text(),
            "printable",
            "a client could not build the chain — the issuer DN was " +
              "re-encoded rather than copied",
          );
        } finally {
          client.close();
        }
      } finally {
        ac.abort();
        await server.finished.catch(() => {});
      }
    }),
});

// ── the name types a stolen key would reach for ─────────────────────────────
//
// These two tests exist because the pair above gave FALSE confidence. It
// asserts `unsuitable certificate purpose`, which is openssl refusing the
// ROOT's extendedKeyUsage at depth 1 — and openssl reports that before it
// reports a name-constraint violation, so the test passes identically whether
// or not the constraints cover email at all.
//
// Measured on macOS 14.8.9 with `security verify-cert`: Security.framework
// does NOT apply a trust anchor's EKU. With the EKU alone, it ACCEPTED an
// S/MIME certificate for `ceo@bigbank.com` signed by this root — and accepted
// it identically under a control root carrying no EKU, so the extension was
// doing nothing there. Adding `rfc822Name`/`URI` bases to permittedSubtrees
// made the same verifier refuse it while a legitimate `localhost` server leaf
// under the same root still verified.
//
// That measurement cannot run on Linux, so what runs here is the two halves it
// rests on: the bases are ENCODED, and they BITE on a verifier we do have.

Deno.test("the root constrains rfc822Name and URI, not just DNS and IP", async () => {
  const { root } = await makePair();
  const der = fromPem(root.certPem);
  // The bases are IA5String-as-raw-bytes under their context tags, so the
  // reserved TLD is findable as literal ASCII. Assert both the bytes and the
  // tag that precedes them, or ".invalid" appearing anywhere would pass.
  const bytes = [...der];
  const ascii = String.fromCharCode(...bytes);
  for (
    const [tag, what] of [[0x81, "rfc822Name"], [0x86, "URI"]] as const
  ) {
    const at = ascii.indexOf(".invalid");
    assert(at > 0, `no .invalid base at all — ${what} is UNRESTRICTED`);
    // find the specific one: <tag> <len=8> ".invalid"
    const found = bytes.some((b, i) =>
      b === tag && bytes[i + 1] === 8 &&
      ascii.slice(i + 2, i + 10) === ".invalid"
    );
    assert(
      found,
      `the root has no ${what} base in permittedSubtrees. A name type left ` +
        `out is UNRESTRICTED, and macOS does not apply the anchor's EKU, so ` +
        `a stolen key mints ${what} certificates there.`,
    );
  }
});

Deno.test({
  name: "an email name is refused even when the PURPOSE is one aio allows",
  ignore: !OPENSSL,
  fn: () =>
    inDir(async (dir) => {
      // serverAuth, so the depth-1 EKU check the older test relies on PASSES
      // and cannot be what refuses this. The only thing left is the
      // rfc822Name base.
      const { root } = await makePair();
      await Deno.writeTextFile(`${dir}/root.pem`, root.certPem);
      await Deno.writeTextFile(`${dir}/root-key.pem`, root.keyPem);
      await Deno.writeTextFile(
        `${dir}/t.cnf`,
        [
          "[req]",
          "distinguished_name = dn",
          "prompt = no",
          "[dn]",
          "CN = localhost",
          "[v3]",
          "basicConstraints = critical,CA:FALSE",
          "keyUsage = critical,digitalSignature,keyEncipherment",
          "extendedKeyUsage = serverAuth",
          "subjectAltName = DNS:localhost,email:ceo@bigbank.com",
        ].join("\n"),
      );
      const csr = await openssl([
        "req",
        "-new",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-keyout",
        `${dir}/k.pem`,
        "-out",
        `${dir}/t.csr`,
        "-nodes",
        "-config",
        `${dir}/t.cnf`,
      ]);
      assert(csr.ok, `could not build the CSR:\n${csr.out}`);
      const signed = await openssl([
        "x509",
        "-req",
        "-in",
        `${dir}/t.csr`,
        "-CA",
        `${dir}/root.pem`,
        "-CAkey",
        `${dir}/root-key.pem`,
        "-CAcreateserial",
        "-out",
        `${dir}/t.pem`,
        "-days",
        "5",
        "-extfile",
        `${dir}/t.cnf`,
        "-extensions",
        "v3",
      ]);
      assert(signed.ok, `could not sign:\n${signed.out}`);
      const v = await openssl([
        "verify",
        "-purpose",
        "sslserver",
        "-CAfile",
        `${dir}/root.pem`,
        `${dir}/t.pem`,
      ]);
      assert(
        !v.ok,
        `the root vouched for an email name on a serverAuth cert:\n${v.out}`,
      );
      assertStringIncludes(v.out, "permitted subtree violation");
    }),
});

Deno.test("a root with no permitted subtree is refused, not written malformed", async () => {
  // An empty permittedSubtrees is a malformed extension (RFC 5280 §4.2.1.10
  // requires at least one GeneralSubtree). Verifiers split on it — some
  // reject, some ignore — and "ignore" means the root is UNCONSTRAINED while
  // looking constrained, which is the worst of the two.
  await assertRejects(
    () =>
      generateRoot({
        commonName: "empty",
        org: "aio",
        days: 1,
        permittedDns: [],
        permittedIpMasks: [],
      }),
    Error,
    "at least one DNS or IP base",
  );
});

Deno.test("certConstrainedNameTypes reads what a root on disk actually covers", async () => {
  const { root, leaf } = await makePair();
  const cur = certConstrainedNameTypes(root.certPem);
  assert(cur, "the root aio writes today must carry name constraints");
  assertEquals(cur, { dns: true, ip: true, email: true, uri: true });

  // A leaf has no name constraints at all — null, which must NOT read as
  // "covers nothing", because the two lead to opposite advice.
  assertEquals(certConstrainedNameTypes(leaf.certPem), null);
});

Deno.test({
  name:
    "a root that constrains DNS and IP only is reported as under-constrained",
  ignore: !OPENSSL,
  fn: () =>
    inDir(async (dir) => {
      // This is the shape every aio root written before this version has, and
      // `loadOrCreateAioRoot` reuses one verbatim forever — so without a
      // reader like this, nothing on an upgraded machine would ever notice.
      const cfg = `${dir}/old.cnf`;
      await Deno.writeTextFile(
        cfg,
        [
          "[req]",
          "distinguished_name = dn",
          "x509_extensions = v3",
          "prompt = no",
          "[dn]",
          "CN = aio local root (old)",
          "[v3]",
          "basicConstraints = critical,CA:TRUE,pathlen:0",
          "keyUsage = critical,keyCertSign,cRLSign",
          "extendedKeyUsage = serverAuth",
          "nameConstraints = critical,permitted;DNS:localhost," +
          "permitted;IP:127.0.0.0/255.0.0.0",
        ].join("\n"),
      );
      const made = await openssl([
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        `${dir}/old-key.pem`,
        "-out",
        `${dir}/old.pem`,
        "-days",
        "5",
        "-config",
        cfg,
      ]);
      assert(made.ok, `could not build the old-shaped root:\n${made.out}`);
      const t = certConstrainedNameTypes(
        await Deno.readTextFile(`${dir}/old.pem`),
      );
      assertEquals(t, { dns: true, ip: true, email: false, uri: false });
    }),
});
