// Android/Conscrypt — same three-way the macOS and Windows rows answered.
//
// WHY. RFC 5280 §6.1 starts path validation AFTER the trust anchor, so a
// self-signed root's name constraints and EKU are advisory to a verifier that
// follows the letter. Stock Java's CertPathValidator ignores both (measured).
// Android's HttpsURLConnection talks through Conscrypt's TrustManagerImpl, not
// that stock path, and until this file nothing had asked Conscrypt the same
// three questions macOS and Windows got:
//
//   1. forged `login.acmebank.com` under the constrained aio root
//   2. same name under an unconstrained control root          (instrument)
//   3. legitimate `localhost` under the constrained root      (instrument)
//   + forged name under an INTERMEDIATE that carries the NC   (blindness)
//   + clientAuth leaf under the serverAuth-only aio root      (anchor EKU)
//   + clientAuth leaf under a no-EKU control root             (EKU control)
//
// MEASURED (Conscrypt 2.5.2 openjdk-uber / OpenJDK 21, 2026-09-22):
//   anchor name constraints  IGNORES  (forged-aio ACCEPT; forged-inter REFUSE)
//   anchor EKU               IGNORES  (client-aio ACCEPT; client-plain ACCEPT)
// So Conscrypt joins the Java row, not the Windows one. The intermediate still
// closes it; nothing here changes the "no intermediate for now" verdict.
//
// HOW TO RUN on a machine that has a JDK but not the jar yet:
//   curl -fsSL -o tests/x509-conscrypt/conscrypt-openjdk-uber.jar \
//     https://repo1.maven.org/maven2/org/conscrypt/conscrypt-openjdk-uber/2.5.2/conscrypt-openjdk-uber-2.5.2.jar
//   deno test -A tests/x509-conscrypt.test.ts
// Or point CONSCRYPT_JAR at any 2.5.x uber jar. Without java or the jar this
// file skips — same shape as the openssl instruments in x509.test.ts.
//
// Do NOT read checkServerTrusted(emailProtection) as an anchor-EKU answer:
// Conscrypt refuses that leaf for lacking serverAuth before any anchor check.
// otherName (Windows UPN) is deliberately not constrained — park, do not fix.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { generateRoot, issueLeaf } from "../src/server/x509.ts";
import { ROOT_PERMITTED_DNS, ROOT_PERMITTED_IPS } from "../src/server/tls.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const PROBE_DIR = join(ROOT, "tests/x509-conscrypt");
const PROBE_SRC = join(PROBE_DIR, "Probe.java");
const PINNED_JAR_VERSION = "2.5.2";
const JAR_URL =
  `https://repo1.maven.org/maven2/org/conscrypt/conscrypt-openjdk-uber/` +
  `${PINNED_JAR_VERSION}/conscrypt-openjdk-uber-${PINNED_JAR_VERSION}.jar`;

async function haveJava(): Promise<boolean> {
  try {
    const r = await new Deno.Command("java", {
      args: ["-version"],
      stdout: "null",
      stderr: "null",
    }).output();
    const c = await new Deno.Command("javac", {
      args: ["-version"],
      stdout: "null",
      stderr: "null",
    }).output();
    // `-version` writes to stderr and still exits 0 on a real JDK.
    return (r.success || r.code === 0) && (c.success || c.code === 0);
  } catch {
    return false;
  }
}

function resolveJar(): string | null {
  const fromEnv = Deno.env.get("CONSCRYPT_JAR");
  if (fromEnv) return fromEnv;
  const local = join(PROBE_DIR, "conscrypt-openjdk-uber.jar");
  try {
    Deno.statSync(local);
    return local;
  } catch {
    return null;
  }
}

const JAVA = await haveJava();
const JAR = resolveJar();
const CONSCRYPT = JAVA && JAR !== null;

async function openssl(args: string[]): Promise<void> {
  const r = await new Deno.Command("openssl", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!r.success) {
    throw new Error(
      `openssl failed:\n` +
        new TextDecoder().decode(r.stdout) +
        new TextDecoder().decode(r.stderr),
    );
  }
}

async function compileProbe(outDir: string, jar: string): Promise<string> {
  const r = await new Deno.Command("javac", {
    args: ["-cp", jar, "-d", outDir, PROBE_SRC],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!r.success) {
    throw new Error(
      `javac Probe.java failed:\n` +
        new TextDecoder().decode(r.stdout) +
        new TextDecoder().decode(r.stderr),
    );
  }
  return outDir;
}

async function runProbe(
  jar: string,
  classes: string,
  name: string,
  mode: "server" | "client",
  trustPem: string,
  leafPem: string,
  ...extras: string[]
): Promise<{ accept: boolean; detail: string; provider: string }> {
  const r = await new Deno.Command("java", {
    args: [
      "-cp",
      `${jar}:${classes}`,
      "Probe",
      name,
      mode,
      trustPem,
      leafPem,
      ...extras,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  assert(r.success, `Probe ${name} exited ${r.code}:\n${out}\n${err}`);
  const line = out.split("\n").pop()!;
  assert(
    line.startsWith(name + " "),
    `Probe ${name} spoke oddly:\n${out}\n${err}`,
  );
  const rest = line.slice(name.length + 1);
  return {
    accept: rest === "ACCEPT",
    detail: rest,
    provider: err,
  };
}

async function mintLeaf(
  dir: string,
  name: string,
  caPem: string,
  caKey: string,
  san: string,
  eku: string,
): Promise<string> {
  const cnf = join(dir, `${name}.cnf`);
  await Deno.writeTextFile(
    cnf,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "[dn]",
      `CN = ${name}`,
      "[v3]",
      "basicConstraints = critical,CA:FALSE",
      "keyUsage = critical,digitalSignature,keyEncipherment",
      `extendedKeyUsage = ${eku}`,
      `subjectAltName = ${san}`,
    ].join("\n"),
  );
  await openssl([
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    join(dir, `${name}-key.pem`),
    "-out",
    join(dir, `${name}.csr`),
    "-config",
    cnf,
  ]);
  const pem = join(dir, `${name}.pem`);
  await openssl([
    "x509",
    "-req",
    "-in",
    join(dir, `${name}.csr`),
    "-CA",
    caPem,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    pem,
    "-days",
    "30",
    "-extfile",
    cnf,
    "-extensions",
    "v3",
  ]);
  return pem;
}

async function mintCa(
  dir: string,
  name: string,
  extensions: string[],
): Promise<{ pem: string; key: string }> {
  const cnf = join(dir, `${name}.cnf`);
  await Deno.writeTextFile(
    cnf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3",
      "prompt = no",
      "[dn]",
      `CN = ${name}`,
      "[v3]",
      ...extensions,
    ].join("\n"),
  );
  const pem = join(dir, `${name}.pem`);
  const key = join(dir, `${name}-key.pem`);
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    key,
    "-out",
    pem,
    "-days",
    "30",
    "-config",
    cnf,
  ]);
  return { pem, key };
}

Deno.test({
  name:
    "Android/Conscrypt three-way: anchor NC + anchor EKU (skips without JDK/jar)",
  ignore: !CONSCRYPT,
  fn: async () => {
    assert(JAR, "jar resolved");
    // openssl builds the control roots and forged leaves; without it the
    // fixtures cannot be made. Skip rather than fail a Conscrypt-capable box
    // that happens to lack openssl (rare on the Linux hosts this runs on).
    let haveOpenssl = false;
    try {
      const r = await new Deno.Command("openssl", {
        args: ["version"],
        stdout: "null",
        stderr: "null",
      }).output();
      haveOpenssl = r.success;
    } catch { /* absent */ }
    if (!haveOpenssl) {
      console.log(
        "x509-conscrypt: openssl missing — cannot mint control roots; skip body",
      );
      return;
    }

    const dir = await tempDir("aio-conscrypt-");
    try {
      const classes = join(dir, "classes");
      await Deno.mkdir(classes);
      await compileProbe(classes, JAR);

      // Constrained aio root — the one am trust installs.
      const aio = await generateRoot({
        commonName: "aio local root (conscrypt probe)",
        org: "aio",
        days: 30,
        permittedDns: ROOT_PERMITTED_DNS,
        permittedIpMasks: ROOT_PERMITTED_IPS,
      });
      const aioPem = join(dir, "aio-root.pem");
      const aioKey = join(dir, "aio-root-key.pem");
      await Deno.writeTextFile(aioPem, aio.certPem);
      await Deno.writeTextFile(aioKey, aio.keyPem);

      const localhost = await issueLeaf({
        commonName: "aio-localhost",
        dns: ["localhost"],
        ips: ["127.0.0.1"],
        days: 30,
        caCertPem: aio.certPem,
        caKeyPem: aio.keyPem,
      });
      const localhostPem = join(dir, "localhost.pem");
      await Deno.writeTextFile(localhostPem, localhost.certPem);

      // Unconstrained control — no NC, no EKU.
      const uncon = await mintCa(dir, "uncon", [
        "basicConstraints = critical,CA:TRUE,pathlen:1",
        "keyUsage = critical,keyCertSign,cRLSign",
        "subjectKeyIdentifier = hash",
      ]);
      // pathlen:1 so it can sign the constrained intermediate below.

      // No-EKU, DNS-only NC — email unrestricted, so a clientAuth leaf is a
      // pure EKU-control (nothing but a missing anchor EKU could refuse it,
      // and this root has none).
      const plain = await mintCa(dir, "plain", [
        "basicConstraints = critical,CA:TRUE,pathlen:0",
        "keyUsage = critical,keyCertSign,cRLSign",
        "subjectKeyIdentifier = hash",
        "nameConstraints = critical,permitted;DNS:localhost," +
        "permitted;IP:127.0.0.0/255.0.0.0",
      ]);

      const forgedAio = await mintLeaf(
        dir,
        "forged-aio",
        aioPem,
        aioKey,
        "DNS:login.acmebank.com",
        "serverAuth",
      );
      const forgedUncon = await mintLeaf(
        dir,
        "forged-uncon",
        uncon.pem,
        uncon.key,
        "DNS:login.acmebank.com",
        "serverAuth",
      );

      // Intermediate carrying the NC the anchor also has — the blindness
      // check. If forged-aio ACCEPTS and this REFUSES, the instrument sees
      // name constraints and the anchor is what it is skipping.
      const interCnf = join(dir, "inter.cnf");
      await Deno.writeTextFile(
        interCnf,
        [
          "[req]",
          "distinguished_name = dn",
          "prompt = no",
          "[dn]",
          "CN = constrained intermediate",
          "[v3]",
          "basicConstraints = critical,CA:TRUE,pathlen:0",
          "keyUsage = critical,keyCertSign,cRLSign",
          "subjectKeyIdentifier = hash",
          "nameConstraints = critical,permitted;DNS:localhost," +
          "permitted;IP:127.0.0.0/255.0.0.0",
        ].join("\n"),
      );
      await openssl([
        "req",
        "-new",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        join(dir, "inter-key.pem"),
        "-out",
        join(dir, "inter.csr"),
        "-config",
        interCnf,
      ]);
      const interPem = join(dir, "inter.pem");
      await openssl([
        "x509",
        "-req",
        "-in",
        join(dir, "inter.csr"),
        "-CA",
        uncon.pem,
        "-CAkey",
        uncon.key,
        "-CAcreateserial",
        "-out",
        interPem,
        "-days",
        "30",
        "-extfile",
        interCnf,
        "-extensions",
        "v3",
      ]);
      const forgedInter = await mintLeaf(
        dir,
        "forged-inter",
        interPem,
        join(dir, "inter-key.pem"),
        "DNS:login.acmebank.com",
        "serverAuth",
      );

      const clientAio = await mintLeaf(
        dir,
        "client-aio",
        aioPem,
        aioKey,
        "DNS:localhost",
        "clientAuth",
      );
      const clientPlain = await mintLeaf(
        dir,
        "client-plain",
        plain.pem,
        plain.key,
        "DNS:localhost",
        "clientAuth",
      );

      const probe = (
        name: string,
        mode: "server" | "client",
        trust: string,
        leaf: string,
        ...extras: string[]
      ) => runProbe(JAR, classes, name, mode, trust, leaf, ...extras);

      // ── the three-way + blindness + EKU ─────────────────────────────────
      const legit = await probe("localhost", "server", aioPem, localhostPem);
      const forged = await probe("forged-aio", "server", aioPem, forgedAio);
      const control = await probe(
        "forged-uncon",
        "server",
        uncon.pem,
        forgedUncon,
      );
      const inter = await probe(
        "forged-inter",
        "server",
        uncon.pem,
        forgedInter,
        interPem,
      );
      const ekuAio = await probe("client-aio", "client", aioPem, clientAio);
      const ekuCtrl = await probe(
        "client-plain",
        "client",
        plain.pem,
        clientPlain,
      );

      // Instrument must not be blind (the Windows ExtraStore lesson).
      assertEquals(
        control.accept,
        true,
        `unconstrained control refused the forgery — instrument is broken:\n` +
          `${control.detail}\n${control.provider}`,
      );
      assertEquals(
        legit.accept,
        true,
        `localhost under the aio root was refused — chain/dates broken:\n` +
          `${legit.detail}\n${legit.provider}`,
      );
      assertEquals(
        inter.accept,
        false,
        `intermediate NC did not bite — instrument cannot see name ` +
          `constraints at all, so an ACCEPT on forged-aio would be meaningless:\n` +
          `${inter.detail}\n${inter.provider}`,
      );
      assert(
        inter.detail.toLowerCase().includes("name constraint") ||
          inter.detail.toLowerCase().includes("chain validation"),
        `intermediate refusal was not a name-constraint signal: ${inter.detail}`,
      );
      assertEquals(
        ekuCtrl.accept,
        true,
        `no-EKU control refused clientAuth — EKU instrument is broken:\n` +
          `${ekuCtrl.detail}\n${ekuCtrl.provider}`,
      );

      // Measured answers (Conscrypt 2.5.2). Pin them so a silent flip is a
      // failed test rather than a forgotten row in todo.md.
      assertEquals(
        forged.accept,
        true,
        `Conscrypt started ENFORCING anchor name constraints (was IGNORES). ` +
          `Update todo.md / the verifier table — this is good news, not a ` +
          `regression to silence:\n${forged.detail}\n${forged.provider}`,
      );
      assertEquals(
        ekuAio.accept,
        true,
        `Conscrypt started ENFORCING anchor EKU (was IGNORES). Update ` +
          `todo.md — clientAuth under a serverAuth-only root was accepted:\n` +
          `${ekuAio.detail}\n${ekuAio.provider}`,
      );

      console.log(
        `x509-conscrypt MEASURED (${PINNED_JAR_VERSION}): ` +
          `anchor NC=IGNORES anchor EKU=IGNORES ` +
          `(intermediate NC=enforces; ${legit.provider.split("\n")[0]})`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "x509-conscrypt probe source and fetch instructions are present",
  fn: async () => {
    // Always runs — so a machine without Conscrypt still knows exactly what
    // to measure and how. The jar is gitignored; the .java is not.
    const src = await Deno.readTextFile(PROBE_SRC);
    assert(
      src.includes("checkServerTrusted") && src.includes("checkClientTrusted"),
      "Probe.java must exercise both TrustManager entry points",
    );
    assert(
      src.includes("setCertificateEntry"),
      "Probe.java must install the root in a real trust store " +
        "(ExtraStore-style blindness)",
    );
    // The how-to lives in THIS file's header; keep the URL accurate.
    const self = await Deno.readTextFile(fromFileUrl(import.meta.url));
    assert(
      self.includes(JAR_URL),
      "fetch URL for the pinned Conscrypt uber jar drifted",
    );
  },
});
