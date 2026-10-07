// A machine root whose private key cannot be LOADED is replaced, loudly.
//
// aio before 1.0.7 made the root with the system `openssl`. On macOS that is
// LibreSSL, which wrote the P-256 curve as explicit parameters rather than
// the named OID; WebCrypto reads only the named form. So on an upgraded Mac
// every leaf issue threw `DataError: malformed parameters`, naming nothing —
// TLS was dead on that machine — and the root could never have anchored a
// chain a rustls client accepts (its own public key is spelled the same way).
// Measured on a real Apple-silicon Mac. The explicit form is made here with
// `ecparam -param_enc explicit`, which OpenSSL and LibreSSL both honour, so
// Linux proves the same thing the Mac does.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  aioRootPaths,
  loadOrCreateAioRoot,
  loadOrCreateCert,
} from "../src/server/tls.ts";
import { importPrivateKeyPem } from "../src/server/x509.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { pinnedTest } from "../src/testing/env-pin.ts";
import { captureConsoleAsync } from "./console-capture.ts";

const SANDBOX = await tempDir("aio-tls-unusable-");
const test = pinnedTest({ AIO_APPS_DIR: join(SANDBOX, "apps") });

async function openssl(args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await new Deno.Command("openssl", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    return { ok: r.success, out: d.decode(r.stdout) + d.decode(r.stderr) };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
}
const HAVE_OPENSSL = (await openssl(["version"])).ok;

test({
  name:
    "tls: a root whose key is in explicit-parameter form is replaced and said so; a readable root is kept",
  ignore: !HAVE_OPENSSL,
  fn: async () => {
    // A healthy root first: loading it again changes nothing.
    const good = await loadOrCreateAioRoot();
    assertEquals(good.created, true);
    const again = await loadOrCreateAioRoot();
    assertEquals(again.created, false);
    assertEquals(again.cert, good.cert);

    // The legacy shape, written over it.
    const { certPath, keyPath } = aioRootPaths();
    const ec = join(SANDBOX, "ec.pem");
    const run = async (args: string[]) => {
      const r = await openssl(args);
      assert(r.ok, `openssl ${args.join(" ")}:\n${r.out}`);
    };
    // deno-fmt-ignore
    await run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-param_enc", "explicit", "-out", ec]);
    await run(["pkcs8", "-topk8", "-nocrypt", "-in", ec, "-out", keyPath]);
    // deno-fmt-ignore
    await run(["req", "-x509", "-new", "-key", keyPath, "-out", certPath, "-days", "3650", "-subj", "/CN=aio local root (legacy)/O=aio"]);
    const legacy = await Deno.readTextFile(certPath);
    // The fixture really is the unusable shape — else this proves nothing.
    await assertRejects(
      async () => await importPrivateKeyPem(await Deno.readTextFile(keyPath)),
    );

    let next!: Awaited<ReturnType<typeof loadOrCreateAioRoot>>;
    const warned = await captureConsoleAsync(async () => {
      next = await loadOrCreateAioRoot();
    });
    assertEquals(next.created, true);
    assert(next.cert !== legacy, "the unusable root was kept");
    const said = warned.join("\n");
    assert(
      said.includes(certPath) && said.includes("am trust") &&
        said.includes("cannot be used"),
      `the replacement must name the root and the re-trust:\n${said}`,
    );
    // The new one signs: a leaf under it is issued and its key loads.
    await importPrivateKeyPem(await Deno.readTextFile(keyPath));
    const leaf = await loadOrCreateCert(
      join(SANDBOX, "leaf"),
      undefined,
      undefined,
      "unusable",
    );
    assert(leaf.cert.includes("BEGIN CERTIFICATE"));

    // An UNREADABLE key is some other fault and never replaces a root.
    const kept = await Deno.readTextFile(certPath);
    await Deno.remove(keyPath);
    await Deno.mkdir(keyPath); // present (stat passes), unreadable as a file
    try {
      const same = await loadOrCreateAioRoot();
      assertEquals(same.created, false);
      assertEquals(same.cert, kept);
    } finally {
      await Deno.remove(keyPath);
    }
  },
});
