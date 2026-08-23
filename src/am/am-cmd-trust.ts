/**
 * @module
 * `am trust` — teach this machine's browsers about this machine's aio root, so
 * an aio app served over HTTPS stops being a security dialog.
 *
 * The problem it solves is narrow and specific. aio serves everything that
 * leaves the machine over TLS, and it issues its own certificates, because
 * there is no public CA on earth that will sign for `192.168.1.42` (the
 * CA/Browser Forum banned issuance for private addresses in 2016). A browser
 * meeting a certificate it does not recognise shows an interstitial — not
 * because the traffic is unencrypted (it is fully encrypted either way) but
 * because the browser cannot tell WHO it is talking to.
 *
 * So: install the root once, and every aio app on this machine is recognised
 * forever, including apps that do not exist yet.
 *
 * What this deliberately does NOT do is install anything without being asked.
 * A root in a trust store is a serious object, the user is the only one who can
 * consent to it, and a framework that quietly added one would be doing what
 * Superfish did. This command explains, then acts.
 */

import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, out } from "./am-output.ts";
import { aioRootPaths, loadOrCreateAioRoot } from "../server/tls.ts";

/** Where each platform keeps the trust store, and the one command that adds to
 *  it. Printed rather than guessed at: these commands need elevation, and a
 *  tool that silently sudo's on your behalf is not being helpful. */
function installHint(certPath: string): { os: string; steps: string[] } {
  switch (Deno.build.os) {
    case "linux":
      return {
        os: "Linux",
        steps: [
          `sudo cp ${certPath} /usr/local/share/ca-certificates/aio-root.crt`,
          `sudo update-ca-certificates`,
          ``,
          `Firefox and Chrome keep their OWN store (NSS) — for those:`,
          `  certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "aio local root" -i ${certPath}`,
          `  (install certutil with: apt install libnss3-tools)`,
        ],
      };
    case "darwin":
      return {
        os: "macOS",
        steps: [
          `sudo security add-trusted-cert -d -r trustRoot \\`,
          `  -k /Library/Keychains/System.keychain ${certPath}`,
          ``,
          `Firefox keeps its own store — import via`,
          `  Settings › Privacy & Security › Certificates › View Certificates › Import`,
        ],
      };
    case "windows":
      return {
        os: "Windows",
        steps: [
          `Run in an ADMIN PowerShell:`,
          `  Import-Certificate -FilePath "${certPath}" \\`,
          `    -CertStoreLocation Cert:\\LocalMachine\\Root`,
          ``,
          `Firefox keeps its own store — import via`,
          `  Settings › Privacy & Security › Certificates › View Certificates › Import`,
        ],
      };
    default:
      return {
        os: Deno.build.os,
        steps: [`Import ${certPath} into your system's trust store.`],
      };
  }
}

export async function cmdTrust(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const sub = args[0];

  if (sub === "path") {
    // The one-liner a script wants: where is the thing to trust.
    out(
      mode === "json"
        ? { path: aioRootPaths().certPath }
        : aioRootPaths().certPath,
      mode,
    );
    return;
  }

  if (sub !== undefined && sub !== "show") {
    fail(
      `unknown subcommand "${sub}" — usage: am trust | am trust path`,
      mode,
    );
  }

  let root;
  try {
    root = await loadOrCreateAioRoot();
  } catch (e) {
    fail(
      `could not read or create this machine's aio root: ${e}. TLS issuance ` +
        `needs openssl on PATH.`,
      mode,
    );
    return;
  }

  const hint = installHint(root.certPath);

  if (mode === "json") {
    out({
      path: root.certPath,
      created: root.created,
      os: hint.os,
      steps: hint.steps.filter(Boolean),
    }, mode);
    return;
  }

  const L = (s = "") => console.log(s);
  L();
  L(`  aio local root${root.created ? "  (created just now)" : ""}`);
  L(`  ${root.certPath}`);
  L();
  L(`  Trust it once and every aio app on this machine is recognised by your`);
  L(`  browser — including apps you have not written yet. It is generated on`);
  L(`  THIS machine and its private key never leaves it.`);
  L();
  // The reason a person can say yes to this without it being a bad idea. Said
  // out loud, because "install a root CA" is otherwise sound advice to refuse.
  L(`  It is name-constrained: it can only ever vouch for localhost, .local`);
  L(`  and private LAN addresses. It is cryptographically incapable of`);
  L(`  vouching for a public website, even for whoever holds the key.`);
  L();
  L(`  ${hint.os}:`);
  for (const s of hint.steps) L(s ? `    ${s}` : "");
  L();
  L(`  To undo: remove "aio local root" from the same store.`);
  L();
}
