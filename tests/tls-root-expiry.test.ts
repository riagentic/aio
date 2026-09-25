// The machine root is valid for 10 years and was reused "verbatim, forever":
// from the day it ran out every chain it anchored failed, on every app at
// once, with no line saying why — and a cached leaf (825 days, issued late in
// the root's life) kept serving the dead root inside its chain. An expired or
// nearly expired root is now replaced, loudly, naming `am trust`.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  aioRootPaths,
  currentSans,
  loadOrCreateCert,
  ROOT_PERMITTED_DNS,
  ROOT_PERMITTED_IPS,
} from "../src/server/tls.ts";
import { certNotAfter, generateRoot, issueLeaf } from "../src/server/x509.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { pinnedTest } from "../src/testing/env-pin.ts";

const SANDBOX = await tempDir("aio-tls-root-expiry-");
const test = pinnedTest({ AIO_APPS_DIR: join(SANDBOX, "apps") });
const pems = (s: string) =>
  s.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ??
    [];
const DAY = 86_400_000;

for (
  const [label, days] of [["expired", -1], ["expires in 10 days", 10]] as const
) {
  test({
    name:
      `tls: a machine root that ${label} is replaced, the leaf re-issued, and am trust named`,
    fn: async () => {
      const dir = join(SANDBOX, `leaf-${days}`);
      // Plant a synthetic root with the given validity, and a leaf from it
      // that is itself still valid for years.
      const { certPath, keyPath } = aioRootPaths();
      await Deno.mkdir(join(certPath, ".."), { recursive: true });
      const old = await generateRoot({
        commonName: "aio local root (test)",
        org: "aio",
        days,
        permittedDns: ROOT_PERMITTED_DNS,
        permittedIpMasks: ROOT_PERMITTED_IPS,
      });
      await Deno.writeTextFile(certPath, old.certPem);
      await Deno.writeTextFile(keyPath, old.keyPem);
      const sans = currentSans();
      const leaf = await issueLeaf({
        commonName: "rx",
        dns: sans.dns,
        ips: sans.ips,
        days: 825,
        caCertPem: old.certPem,
        caKeyPem: old.keyPem,
      });
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        join(dir, "tls-cert.pem"),
        leaf.certPem.trimEnd() + "\n" + old.certPem.trimEnd() + "\n",
      );
      await Deno.writeTextFile(join(dir, "tls-key.pem"), leaf.keyPem);

      const warns: string[] = [];
      const prev = getLogger();
      setLogger({
        logDir: "",
        pub: (lvl: string, _cat: string, msg: string) => {
          if (lvl === "warn") warns.push(msg);
        },
        perf: () => {},
        flush: () => Promise.resolve(),
      } as unknown as LogSink);
      let got;
      try {
        got = await loadOrCreateCert(dir, undefined, undefined, "rx");
      } finally {
        setLogger(prev);
      }

      const root = await Deno.readTextFile(certPath);
      assert(root !== old.certPem, "the expiring root must be replaced");
      assert(
        certNotAfter(root).getTime() - Date.now() > 3000 * DAY,
        "the replacement root is a fresh 10-year root",
      );
      const chain = pems(got.cert);
      assertEquals(
        chain.at(-1),
        pems(root)[0],
        "the leaf chains to the NEW root",
      );
      assert(
        !got.cert.includes(pems(old.certPem)[0]!),
        "old root never served",
      );
      assert(
        warns.some((w) => w.includes(certPath) && w.includes("am trust")),
        `a warning names the root and \`am trust\`: ${JSON.stringify(warns)}`,
      );
    },
  });
}

test({
  name: "tls: a healthy machine root is reused verbatim",
  fn: async () => {
    const dir = join(SANDBOX, "healthy");
    const a = await loadOrCreateCert(dir, undefined, undefined, "ok");
    const { certPath } = aioRootPaths();
    const r1 = await Deno.readTextFile(certPath);
    const b = await loadOrCreateCert(dir, undefined, undefined, "ok");
    assertEquals(await Deno.readTextFile(certPath), r1);
    assertEquals(a.cert, b.cert);
  },
});
