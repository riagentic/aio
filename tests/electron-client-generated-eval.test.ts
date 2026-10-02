// aio-client's generated main script, RUN — not string-matched.
//
// `electronClientScript()` is a template literal that becomes main.cjs. A test
// that asserts the source text contains a line proves the line was typed, not
// that it does what it says once the template has cooked it:
//
//   • the discovery-port rule was written `/^\d+$/` inside the template, so
//     the file on disk said `/^d+$/` — a rule no port satisfies — and
//     `AIO_DISCOVERY_PORT` was ignored outright (always 8099);
//   • the "strict" certificate pin compared the WHOLE pinned text (leaf then
//     root, which is what a profile and a pairing reply carry) with the one
//     certificate Chromium presents, so it never matched a current server, and
//     a pin that did not match was silent.
//
// So this file evaluates the whole script against stand-ins for `electron`
// and drives the handlers it registers.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { createRequire } from "node:module";
import { electronClientScript } from "../src/electron/electron-client-script.ts";
import { generateRoot, issueLeaf } from "../src/server/x509.ts";
import { ROOT_PERMITTED_DNS, ROOT_PERMITTED_IPS } from "../src/server/tls.ts";

const nodeRequire = createRequire(import.meta.url);

type Win = {
  url: string;
  loaded: string[];
  injected: string[];
  listeners: Record<string, ((...a: unknown[]) => void)[]>;
};

type Client = {
  // deno-lint-ignore no-explicit-any
  api: any;
  handlers: Record<string, (...a: unknown[]) => void>;
  errors: string[];
  windows: Win[];
};

/** Runs the generated main with `electron` replaced by recorders. Everything
 *  else (`https`, `crypto`, `path`, `fs`) is the real Node module. */
function boot(
  opts: { env?: Record<string, string>; argv?: string[]; userData?: string } =
    {},
): Client {
  const handlers: Client["handlers"] = {};
  const errors: string[] = [];
  const windows: Win[] = [];
  class BrowserWindow {
    w: Win = { url: "", loaded: [], injected: [], listeners: {} };
    webContents = {
      getURL: () => this.w.url,
      executeJavaScript: (js: string) => {
        this.w.injected.push(js);
        return Promise.resolve();
      },
      once: (n: string, f: (...a: unknown[]) => void) =>
        (this.w.listeners[n] ??= []).push(f),
      on: (n: string, f: (...a: unknown[]) => void) =>
        (this.w.listeners[n] ??= []).push(f),
      session: {},
    };
    constructor() {
      windows.push(this.w);
    }
    static getAllWindows() {
      return windows.map((w) => ({
        webContents: {
          getURL: () => w.url,
          executeJavaScript: (js: string) => {
            w.injected.push(js);
            return Promise.resolve();
          },
        },
      }));
    }
    loadURL(u: string) {
      this.w.url = u;
      this.w.loaded.push(u);
    }
    on() {}
    setResizable() {}
    setSize() {}
    setPosition() {}
    center() {}
    setTitle() {}
    setIcon() {}
  }
  const electron = {
    app: {
      name: "",
      on: (n: string, f: (...a: unknown[]) => void) => {
        handlers[n] = f;
      },
      getPath: () => opts.userData ?? "/nonexistent-aio-client-test",
      quit() {},
    },
    BrowserWindow,
    Menu: { setApplicationMenu() {} },
    nativeImage: { createFromBuffer: () => ({}) },
    session: { defaultSession: {} },
  };
  const req = (name: string) => {
    if (name === "electron") return electron;
    // No LAN broadcast from a unit test: discoverApps answers [] when the
    // socket cannot be made.
    if (name === "dgram") {
      return {
        createSocket() {
          throw new Error("no dgram in this test");
        },
      };
    }
    return nodeRequire(name.startsWith("node:") ? name : "node:" + name);
  };
  const proc = {
    env: opts.env ?? {},
    argv: opts.argv ?? [],
    platform: "linux",
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    exit(code: number) {
      throw new Error("process.exit(" + code + ")");
    },
  };
  const con = {
    log() {},
    warn() {},
    error: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
  };
  const api = new Function(
    "require",
    "process",
    "console",
    "setInterval",
    electronClientScript(null) +
      "\nreturn { DISCOVERY_PORT, pinCert, _trustedHosts, fetchPage };",
  )(req, proc, con, () => 0);
  return { api, handlers, errors, windows };
}

// ── K1: AIO_DISCOVERY_PORT ───────────────────────────────────────────────

Deno.test("aio-client: AIO_DISCOVERY_PORT is honoured by the generated script", () => {
  const port = (v?: string) =>
    boot({ env: v === undefined ? {} : { AIO_DISCOVERY_PORT: v } }).api
      .DISCOVERY_PORT;
  assertEquals(port("9123"), 9123, "a plain decimal port was ignored");
  assertEquals(port(" 8100 "), 8100);
  assertEquals(port(undefined), 8099);
  assertEquals(port(""), 8099);
  // The server's rule (discoveryPortOf): decimal digits only, 1..65535.
  for (const bad of ["0", "70000", "0x2000", "1e3", "+80", "80.0", "d"]) {
    assertEquals(port(bad), 8099, `"${bad}" must fall back`);
  }
});

// ── K5: the certificate pin ──────────────────────────────────────────────

async function pki() {
  const root = (cn: string) =>
    generateRoot({
      commonName: cn,
      org: "myapp",
      days: 30,
      permittedDns: ROOT_PERMITTED_DNS,
      permittedIpMasks: ROOT_PERMITTED_IPS,
    });
  const leaf = (ca: { certPem: string; keyPem: string }) =>
    issueLeaf({
      commonName: "myapp",
      dns: ["localhost"],
      ips: ["127.0.0.1"],
      days: 30,
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
    });
  const rootA = await root("root A"), rootB = await root("root B");
  return {
    rootA,
    a1: await leaf(rootA),
    a2: await leaf(rootA),
    b1: await leaf(rootB),
  };
}

/** Fires 'certificate-error' the way Electron does; returns the verdict. */
function present(c: Client, url: string, pem: string): boolean | undefined {
  let verdict: boolean | undefined;
  c.handlers["certificate-error"]!(
    { preventDefault() {} },
    null,
    url,
    "net::ERR_CERT_AUTHORITY_INVALID",
    { data: pem },
    (ok: boolean) => {
      verdict = ok;
    },
  );
  return verdict;
}

const HOST = "https://10.0.0.5:8443/?token=k";
const pinWarnings = (c: Client) =>
  c.errors.filter((e) => /certificate pinned for 10\.0\.0\.5:8443/.test(e));

Deno.test("aio-client: a pin is met by the pinned leaf and by a leaf re-issued under the pinned root", async () => {
  const { rootA, a1, a2 } = await pki();
  const c = boot();
  // What a profile / a pairing reply carries: the served file, leaf then root.
  c.api.pinCert(new URL(HOST).host, a1.certPem + rootA.certPem);
  // NOT in the looser host list: only the pin can say yes here.
  assertEquals(present(c, HOST, a1.certPem), true, "the pinned leaf itself");
  assertEquals(
    present(c, HOST, a2.certPem),
    true,
    "a leaf re-issued by the pinned root (the machine's addresses changed)",
  );
  assertEquals(pinWarnings(c), [], "a satisfied pin must not warn");
});

Deno.test("aio-client: a pinned host presenting ANOTHER certificate is said out loud", async () => {
  const { rootA, a1, b1 } = await pki();
  const c = boot();
  c.windows.push({
    url: "data:text/html;charset=utf-8,connect",
    loaded: [],
    injected: [],
    listeners: {},
  });
  c.windows.push({
    url: "https://10.0.0.5:8443/",
    loaded: [],
    injected: [],
    listeners: {},
  });
  c.api.pinCert(new URL(HOST).host, a1.certPem + rootA.certPem);

  assertEquals(present(c, HOST, b1.certPem), false, "no pin, no host list");
  assertEquals(pinWarnings(c).length, 1, "the mismatch was silent");
  assertMatch(pinWarnings(c)[0]!, /has CHANGED/);
  // The connect page is told; an APP page is never scripted.
  assertMatch(c.windows[0]!.injected.join("\n"), /has CHANGED/);
  assertEquals(c.windows[1]!.injected, []);

  // The compatible half: a server that regenerated its certificate stays
  // reachable once the address was fetched + validated (connectTo) — and the
  // change is still said.
  c.api._trustedHosts.add(new URL(HOST).host);
  assertEquals(present(c, HOST, b1.certPem), true);
  assertEquals(pinWarnings(c).length, 2, "accepted through the host list");

  // An unpinned host on the list is the ordinary manual connect: no warning.
  c.api._trustedHosts.add("10.0.0.9:8443");
  assertEquals(present(c, "https://10.0.0.9:8443/", b1.certPem), true);
  assertEquals(pinWarnings(c).length, 2);
});

Deno.test("aio-client: a leaf from ANOTHER root with the pinned root's name does not meet the pin", async () => {
  // The pin is met by a SIGNATURE of the pinned root, never by its name: a
  // root anyone can generate carries whatever common name they type.
  const { rootA, a1 } = await pki();
  const twin = await generateRoot({
    commonName: "root A",
    org: "myapp",
    days: 30,
    permittedDns: ROOT_PERMITTED_DNS,
    permittedIpMasks: ROOT_PERMITTED_IPS,
  });
  const forged = await issueLeaf({
    commonName: "myapp",
    dns: ["localhost"],
    ips: ["127.0.0.1"],
    days: 30,
    caCertPem: twin.certPem,
    caKeyPem: twin.keyPem,
  });
  const X509 = nodeRequire("node:crypto").X509Certificate;
  assertEquals(
    new X509(forged.certPem).issuer,
    new X509(rootA.certPem).subject,
    "the forged leaf must name the pinned root, or this proves nothing",
  );
  // Pinned every way a pin is carried: leaf then root, and the root alone.
  for (const pin of [a1.certPem + rootA.certPem, rootA.certPem]) {
    const c = boot();
    c.api.pinCert(new URL(HOST).host, pin);
    assertEquals(present(c, HOST, a1.certPem), true, "control: the real leaf");
    assertEquals(pinWarnings(c), []);
    assertEquals(present(c, HOST, forged.certPem), false, "same-name root");
    assertEquals(present(c, HOST, twin.certPem), false, "the twin root itself");
    assertEquals(pinWarnings(c).length, 2, "each was said as a changed pin");
    assertMatch(pinWarnings(c)[0]!, /has CHANGED/);
  }
});

Deno.test("aio-client: fetchPage says a changed pin on the connection that carries the token", async () => {
  const { rootA, a1, b1 } = await pki();
  const https = nodeRequire("node:https");
  let requests = 0;
  // The server presents B's leaf.
  const server = https.createServer(
    { cert: b1.certPem, key: b1.keyPem },
    (_req: unknown, res: { end(s: string): void }) => {
      requests++;
      res.end('<title>myapp</title><div id="root"></div>');
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = `https://127.0.0.1:${port}/?token=k`;
  try {
    const c = boot();
    const seenAtWarning: number[] = [];
    const push = c.errors.push.bind(c.errors);
    c.errors.push = (...a: string[]) => {
      seenAtWarning.push(requests);
      return push(...a);
    };
    // Pinned to A; the host answers with B.
    c.api.pinCert(new URL(url).host, a1.certPem + rootA.certPem);
    const html = await c.api.fetchPage(url);
    assertMatch(html, /myapp/, "the fetch itself is not refused");
    const warned = c.errors.filter((e) => /has CHANGED/.test(e));
    assertEquals(warned.length, 1, "fetchPage sent the token without a word");
    assertEquals(seenAtWarning[0], 0, "warned only after the request landed");

    // Control: the pin that matches is quiet.
    const ok = boot();
    ok.api.pinCert(new URL(url).host, b1.certPem);
    await ok.api.fetchPage(url);
    assertEquals(ok.errors.filter((e) => /has CHANGED/.test(e)), []);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ── a .aioapp whose host no URL accepts ──────────────────────────────────

Deno.test("aio-client: a .aioapp with a URL-invalid host lands on the connect page with the reason", async () => {
  const dir = await tempDir("aio-client-profile-");
  try {
    const file = dir + "/myapp.aioapp";
    // Passes loadProfileFile's character rule, is not a URL authority.
    await Deno.writeTextFile(
      file,
      JSON.stringify({ aio: 1, name: "myapp", host: "a:b", port: 8443 }),
    );
    const c = boot({ argv: ["aio-client", file], userData: dir });
    c.handlers["ready"]!(); // threw "Invalid URL" out of the handler
    const win = c.windows[0]!;
    assert(
      win.loaded[0]?.startsWith("data:text/html"),
      "the connect page was not shown",
    );
    for (const f of win.listeners["did-finish-load"] ?? []) f();
    assertMatch(win.injected.join("\n"), /not a usable address/);
    assertMatch(c.errors.join("\n"), /not a usable address/);
  } finally {
    await dropTempDir(dir);
  }
});
