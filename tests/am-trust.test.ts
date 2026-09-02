// `am trust` and the promise it makes.
//
// This is the one command that asks a person to install a root CA into their
// system trust store, and it argues for itself in the terminal: "It is
// name-constrained: it can only ever vouch for localhost, .local and private
// LAN addresses. It is cryptographically incapable of vouching for a public
// website, even for whoever holds the key."
//
// Nothing held that. `src/am/am-cmd-trust.ts` had NO test (2% covered), and no
// test anywhere read the generated certificate's Name Constraints. The sentence
// that makes installing a root reasonable rather than reckless — the difference
// between this and Superfish — was prose.
//
// So these assert the ARTIFACT, not the source string: generate a real root into
// a temp home and read it back with openssl.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aioRootPaths, loadOrCreateAioRoot } from "../src/server/tls.ts";
import { cmdTrust } from "../src/am/am-cmd-trust.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/** Run `fn` with a private AIO_APPS_DIR, console captured, and Deno.exit
 *  converted to a throw — `fail()` exits, and a test must survive it.
 *
 *  `tty` decides which of the two renderings runs. `detectMode` answers "json"
 *  whenever stdout is not a terminal — "a pipe IS json mode", which is every CI
 *  log and every coding agent — so a test reaches the HUMAN branch only by
 *  saying it is one. That branch carries the whole argument for installing a
 *  root CA, and without this it is unreachable from a test suite. */
async function run(
  fn: () => Promise<void>,
  home: string,
  opts: { tty?: boolean } = {},
): Promise<{ logs: string[]; errors: string[]; code: number | null }> {
  const prevHome = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", home);
  const logs: string[] = [], errors: string[] = [];
  const l = console.log, e = console.error, realExit = Deno.exit;
  const realIsTerminal = Deno.stdout.isTerminal;
  if (opts.tty) Deno.stdout.isTerminal = () => true;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  let code: number | null = null;
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    code = err.code;
  } finally {
    console.log = l;
    console.error = e;
    Deno.exit = realExit;
    Deno.stdout.isTerminal = realIsTerminal;
    if (prevHome === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prevHome);
  }
  return { logs, errors, code };
}

const FLAGS = (
  json = false,
): GlobalFlags => ({ json } as unknown as GlobalFlags);

async function tempHome(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "am-trust-" });
}

async function opensslText(certPath: string): Promise<string> {
  const { code, stdout } = await new Deno.Command("openssl", {
    args: ["x509", "-in", certPath, "-noout", "-text"],
    stdout: "piped",
    stderr: "null",
  }).output();
  assertEquals(code, 0, "openssl could not read the generated root");
  return new TextDecoder().decode(stdout);
}

// ── the promise ──────────────────────────────────────────────

Deno.test("am trust: the root it asks you to install cannot vouch for the public internet", async () => {
  const home = await tempHome();
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", home);
  try {
    const root = await loadOrCreateAioRoot();
    assert(root.created, "a fresh home should have produced a new root");
    const text = await opensslText(root.certPath);

    // CRITICAL, or a client is free to ignore it — which would make the
    // constraint decorative and the command's argument false.
    assertStringIncludes(text, "X509v3 Name Constraints: critical");

    const permitted = text
      .slice(text.indexOf("X509v3 Name Constraints"))
      .split("Signature Algorithm")[0]!;

    // Exactly the reach the command claims, and both name types a server
    // certificate can carry (a DNS-only constraint leaves IP SANs unbounded).
    for (
      const name of [
        "DNS:localhost",
        "DNS:.local",
        "DNS:.localhost",
        "IP:127.0.0.0/255.0.0.0",
        "IP:10.0.0.0/255.0.0.0",
        "IP:192.168.0.0/255.255.0.0",
        "IP:172.16.0.0/255.240.0.0",
        "IP:169.254.0.0/255.255.0.0",
      ]
    ) {
      assertStringIncludes(permitted, name);
    }
    // IPv6 loopback and the private ranges, case-insensitively (openssl prints
    // the mask uppercase).
    const upper = permitted.toUpperCase();
    assertStringIncludes(upper, "IP:0:0:0:0:0:0:0:1/");
    assertStringIncludes(upper, "IP:FC00:");
    assertStringIncludes(upper, "IP:FE80:");

    // And NOTHING that reaches a public name. A bare `DNS:` (the empty prefix)
    // permits every domain that exists; `.com`, `.org` and a naked TLD are the
    // shapes a careless widening would take.
    for (const forbidden of ["DNS:.com", "DNS:.org", "DNS:.net", "DNS:\n"]) {
      assert(
        !permitted.includes(forbidden),
        `the root permits ${
          JSON.stringify(forbidden)
        } — it can vouch for a public site`,
      );
    }
    // It is a CA, and it is the only thing in here that is.
    assertStringIncludes(text, "CA:TRUE");
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am trust: the terminal claim and the certificate agree", async () => {
  const home = await tempHome();
  try {
    const { logs } = await run(() => cmdTrust([], FLAGS()), home, {
      tty: true,
    });
    const said = logs.join("\n");

    // The argument the user is asked to accept.
    assertStringIncludes(said, "name-constrained");
    assertStringIncludes(said, "cryptographically incapable");
    // …and the names it says it is limited to are the ones in the cert.
    const prev = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", home);
    let text: string;
    try {
      text = await opensslText(aioRootPaths().certPath);
    } finally {
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
    }
    for (const claimed of ["localhost", ".local"]) {
      assertStringIncludes(said, claimed);
      assertStringIncludes(text, `DNS:${claimed}`);
    }
    // It never tells you to trust it without saying how to untrust it.
    assertStringIncludes(said, "To undo");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am trust: it explains, and never installs anything itself", async () => {
  const home = await tempHome();
  try {
    const { logs } = await run(() => cmdTrust(["show"], FLAGS()), home, {
      tty: true,
    });
    const said = logs.join("\n");
    // The steps are PRINTED for the person to run: they need elevation, and a
    // tool that sudo's on your behalf is not being helpful.
    const host = Deno.build.os;
    if (host === "linux") {
      assertStringIncludes(said, "sudo cp");
      assertStringIncludes(said, "update-ca-certificates");
      assertStringIncludes(said, "certutil"); // Firefox/Chrome keep their own
    } else if (host === "darwin") {
      assertStringIncludes(said, "security add-trusted-cert");
    } else if (host === "windows") {
      assertStringIncludes(said, "Import-Certificate");
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

// ── the plumbing ─────────────────────────────────────────────

Deno.test("am trust path: the one line a script wants, in both modes", async () => {
  const home = await tempHome();
  try {
    const text = await run(() => cmdTrust(["path"], FLAGS()), home, {
      tty: true,
    });
    assertEquals(text.logs.length, 1);
    assertStringIncludes(text.logs[0]!, "aio-root.pem");
    // `path` must not CREATE a root — it answers where one would live.
    let created = true;
    try {
      await Deno.stat(`${home}/.aio-ca/aio-root.pem`);
    } catch {
      created = false;
    }
    assertEquals(
      created,
      false,
      "`am trust path` generated a root as a side effect",
    );

    const json = await run(() => cmdTrust(["path"], FLAGS(true)), home);
    const parsed = JSON.parse(json.logs.join("\n")) as { path: string };
    assertStringIncludes(parsed.path, "aio-root.pem");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am trust --json: the machine-readable form carries the steps", async () => {
  const home = await tempHome();
  try {
    const { logs } = await run(() => cmdTrust([], FLAGS(true)), home);
    const j = JSON.parse(logs.join("\n")) as {
      path: string;
      created: boolean;
      os: string;
      steps: string[];
    };
    assertStringIncludes(j.path, "aio-root.pem");
    assertEquals(j.created, true);
    assert(j.steps.length > 0, "no install steps in the JSON form");
    // Blank spacer lines are for humans; a consumer gets none.
    assert(
      j.steps.every((s) => s.trim().length > 0),
      `JSON steps carry layout blanks: ${JSON.stringify(j.steps)}`,
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("am trust: an unknown subcommand names the two that exist", async () => {
  const home = await tempHome();
  try {
    // Human: the refusal goes to stderr, where `2>` can separate it.
    const human = await run(() => cmdTrust(["instal"], FLAGS()), home, {
      tty: true,
    });
    assertEquals(human.code, 1);
    const said = human.errors.join("\n");
    assertStringIncludes(said, "instal");
    assertStringIncludes(said, "am trust path");

    // Piped: the SAME refusal, as data a caller can address.
    const piped = await run(() => cmdTrust(["instal"], FLAGS()), home);
    assertEquals(piped.code, 1);
    const j = JSON.parse(piped.logs.join("\n")) as { error: string };
    assertStringIncludes(j.error, "instal");
    assertStringIncludes(j.error, "am trust path");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
