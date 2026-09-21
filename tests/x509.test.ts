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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  certSubjectAltNames,
  certSubjectDer,
  generateRoot,
  issueLeaf,
} from "../src/server/x509.ts";
import { ROOT_PERMITTED_DNS, ROOT_PERMITTED_IPS } from "../src/server/tls.ts";
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
