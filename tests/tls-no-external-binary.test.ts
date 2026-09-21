// Automatic HTTPS must need NOTHING on PATH.
//
// It used to need `openssl`, four times over: generate the machine root, make
// a CSR, sign the leaf, read a cert's SANs. Linux and macOS ship one; WINDOWS
// DOES NOT — so `--expose` on a stock Windows machine died with
//
//     error: NotFound: Failed to spawn 'openssl': entity not found
//
// a whole supported target with no automatic HTTPS, found by running the suite
// on a real Windows 11 VM. The subtlest part was `certSans`, which CAUGHT that
// failure and returned `null` — indistinguishable from "this certificate names
// no addresses" — so the first thing that happened was the cached certificate
// being declared stale for the wrong reason, and only then the death above.
//
// `src/server/x509.ts` builds both certificates in Deno now. This pins the
// property that keeps it that way: the whole path runs with an EMPTY PATH and
// succeeds. A future change that shells out to anything at all turns this red
// on every OS, not only on the one that has no shell tools.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const TLS = new URL("../src/server/tls.ts", import.meta.url).href;

/** Run `code` in a child that can find NO external binary whatsoever. PATH is
 *  pointed at an empty directory rather than unset: unset is a different and
 *  less realistic condition, and on Windows it is not reliably empty. */
async function withEmptyPath(
  code: string,
): Promise<{ out: string; err: string; code: number }> {
  const empty = await tempDir("aio-empty-path-");
  const apps = await tempDir("aio-empty-path-apps-");
  // The CHILD's scratch lives INSIDE `apps`, which this function sweeps. A
  // `Deno.makeTempDir()` over there would be made by a process that has no
  // registry and exits without cleaning up — an orphan per run, in the one
  // place the parent cannot see.
  const scratch = `${apps}/scratch`;
  await Deno.mkdir(scratch, { recursive: true });
  try {
    const p = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { certSans, loadOrCreateAioRoot, loadOrCreateCert } from "${TLS}";
${code}`,
      ],
      env: {
        PATH: empty,
        Path: empty, // Windows spells it this way
        AIO_APPS_DIR: apps,
        AIO_TEST_SCRATCH: scratch,
        NO_COLOR: "1",
        DENO_NO_UPDATE_CHECK: "1",
      },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
      code: p.code,
    };
  } finally {
    await dropTempDir(empty);
    await dropTempDir(apps);
  }
}

Deno.test("the machine root is generated with an empty PATH", async () => {
  const r = await withEmptyPath(`
    const root = await loadOrCreateAioRoot();
    console.log("CREATED=" + root.created);
    console.log("PEM=" + root.cert.startsWith("-----BEGIN CERTIFICATE-----"));
    // …and a second call reuses it rather than minting a new anchor.
    const again = await loadOrCreateAioRoot();
    console.log("REUSED=" + (again.created === false && again.cert === root.cert));
  `);
  assertStringIncludes(r.out, "CREATED=true", `${r.out}${r.err}`);
  assertStringIncludes(r.out, "PEM=true", `${r.out}${r.err}`);
  assertStringIncludes(r.out, "REUSED=true", `${r.out}${r.err}`);
  assertEquals(r.code, 0, r.err);
});

Deno.test("a full auto-TLS boot succeeds with an empty PATH", async () => {
  // `loadOrCreateCert` is what `aio.run()` calls under `--expose`. This is the
  // exact path that used to die on Windows.
  const r = await withEmptyPath(`
    const dir = Deno.env.get("AIO_TEST_SCRATCH") + "/boot";
    await Deno.mkdir(dir, { recursive: true });
    const t = await loadOrCreateCert(dir, undefined, undefined, "demo");
    console.log("SELF=" + t.selfSigned);
    console.log("ANCHOR=" + (typeof t.caPath === "string"));
    // The file on disk is the CHAIN: leaf then root, which is what every
    // pinning caller (am profile, DENO_CERT, --cert=) reads.
    const onDisk = await Deno.readTextFile(t.certPath);
    console.log("CHAIN=" + (onDisk.match(/BEGIN CERTIFICATE/g) ?? []).length);
    console.log("SAME=" + (onDisk === t.cert));
    // …and the SANs read back without a subprocess.
    const sans = await certSans(t.certPath);
    console.log("SANS=" + JSON.stringify(sans));
    // A second boot must REUSE it — a fresh cert every time would break every
    // client's pin daily.
    const again = await loadOrCreateCert(dir, undefined, undefined, "demo");
    console.log("STABLE=" + (again.cert === t.cert));
  `);
  assertEquals(r.code, 0, `${r.out}${r.err}`);
  assertStringIncludes(r.out, "SELF=true");
  assertStringIncludes(r.out, "ANCHOR=true");
  assertStringIncludes(r.out, "CHAIN=2", "the chain must be leaf + root");
  assertStringIncludes(r.out, "SAME=true");
  assertStringIncludes(r.out, `"dns":["localhost"]`);
  assertStringIncludes(r.out, `"127.0.0.1"`);
  assertStringIncludes(
    r.out,
    "STABLE=true",
    "a cached certificate that still covers this machine must be reused",
  );
});

Deno.test("no external binary is spawned on the auto-TLS path at all", async () => {
  // The property directly: Deno.Command is replaced with one that throws, so
  // ANY subprocess — not just openssl — fails the test. A future change that
  // shells out to something else entirely is caught by this on every OS.
  const r = await withEmptyPath(`
    const RealCommand = Deno.Command;
    let spawned = [];
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = class {
      constructor(cmd, opts) {
        spawned.push(cmd);
        throw new Error("a subprocess was spawned: " + cmd);
      }
    };
    try {
      const dir = Deno.env.get("AIO_TEST_SCRATCH") + "/nospawn";
      await Deno.mkdir(dir, { recursive: true });
      await loadOrCreateCert(dir, undefined, undefined, "demo");
      console.log("SPAWNED=" + JSON.stringify(spawned));
    } finally {
      // deno-lint-ignore no-explicit-any
      (Deno as any).Command = RealCommand;
    }
  `);
  assertEquals(r.code, 0, `${r.out}${r.err}`);
  assertStringIncludes(
    r.out,
    "SPAWNED=[]",
    "automatic HTTPS must not depend on anything being installed",
  );
});

Deno.test("a user-supplied certificate is still passed through untouched", async () => {
  const r = await withEmptyPath(`
    const dir = Deno.env.get("AIO_TEST_SCRATCH") + "/supplied";
    await Deno.mkdir(dir, { recursive: true });
    const cert = dir + "/mine-cert.pem", key = dir + "/mine-key.pem";
    await Deno.writeTextFile(cert, "CERT-BYTES");
    await Deno.writeTextFile(key, "KEY-BYTES");
    const t = await loadOrCreateCert(dir, cert, key, "demo");
    console.log("CERT=" + t.cert + " KEY=" + t.key + " SELF=" + t.selfSigned);
  `);
  assertStringIncludes(
    r.out,
    "CERT=CERT-BYTES KEY=KEY-BYTES SELF=false",
    `${r.out}${r.err}`,
  );
});

Deno.test("certSans on a file that is not a certificate is an error, never a quiet null", async () => {
  // `null` means ONE thing — this certificate names no addresses. It must not
  // also mean "I could not read it", which is what the openssl-era catch-all
  // returned and what sent every Windows boot down the re-issue path.
  const r = await withEmptyPath(`
    const f = Deno.env.get("AIO_TEST_SCRATCH") + "/notacert.pem";
    await Deno.writeTextFile(f, "this is not a certificate");
    try {
      console.log("RETURNED=" + JSON.stringify(await certSans(f)));
    } catch (e) {
      console.log("THREW=" + e.message);
    }
  `);
  assert(
    !r.out.includes("RETURNED="),
    `an unreadable file answered like a certificate with no SANs: ${r.out}`,
  );
  assertStringIncludes(r.out, "THREW=");
});
