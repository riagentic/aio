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
import { CONNECT_HTML } from "../src/electron/electron-shared.ts";
import { generateRoot, issueLeaf } from "../src/server/x509.ts";
import { ROOT_PERMITTED_DNS, ROOT_PERMITTED_IPS } from "../src/server/tls.ts";
import { answerPinProof } from "../src/server/pin-proof.ts";

const nodeRequire = createRequire(import.meta.url);

type Win = {
  url: string;
  loaded: string[];
  injected: string[];
  listeners: Record<string, ((...a: unknown[]) => void)[]>;
  /** The cookie jar's names, as each `loadURL` found it. */
  jarAtLoad?: string[][];
};

type Cookie = { name: string; domain: string; path: string; secure: boolean };

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
  opts: {
    env?: Record<string, string>;
    argv?: string[];
    userData?: string;
    /** A stand-in for `require('dgram')`; without one no socket can be made. */
    dgram?: unknown;
    platform?: string;
    /** `electronClientScript(_, { strictPin })` — the baked switch. */
    strictPin?: boolean;
    /** The session's cookie jar (shared by every window, as in Electron). */
    jar?: Cookie[];
  } = {},
): Client {
  const handlers: Client["handlers"] = {};
  const errors: string[] = [];
  const windows: Win[] = [];
  const jar = opts.jar ?? [];
  class BrowserWindow {
    w: Win = {
      url: "",
      loaded: [],
      injected: [],
      listeners: {},
      jarAtLoad: [],
    };
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
      session: {
        cookies: {
          get: () => Promise.resolve([...jar]),
          remove: (url: string, name: string) => {
            const u = new URL(url);
            const i = jar.findIndex((c) =>
              c.name === name && c.domain === u.hostname &&
              c.path === u.pathname && c.secure === (u.protocol === "https:")
            );
            if (i >= 0) jar.splice(i, 1);
            return Promise.resolve();
          },
        },
      },
      setWindowOpenHandler() {}, // pinned by electron-web-isolation.test.ts
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
      this.w.jarAtLoad!.push(jar.map((c) => `${c.name}@${c.domain}`));
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
      // Asked for only on darwin (the dock); never ready in a unit test.
      whenReady: () => new Promise(() => {}),
    },
    BrowserWindow,
    Menu: { setApplicationMenu() {} },
    nativeImage: { createFromBuffer: () => ({}) },
    session: {
      defaultSession: {
        setCertificateVerifyProc(f: (...a: unknown[]) => void) {
          handlers["verify-proc"] = f;
        },
      },
    },
  };
  const req = (name: string) => {
    if (name === "electron") return electron;
    // No LAN broadcast from a unit test: discoverApps answers [] when the
    // socket cannot be made.
    if (name === "dgram") {
      return opts.dgram ?? {
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
    platform: opts.platform ?? "linux",
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
    electronClientScript(null, { strictPin: opts.strictPin }) +
      "\nreturn { DISCOVERY_PORT, pinCert, _trustedHosts, fetchPage, " +
      "fetchBuffer, discoverApps, _pinDecided, _pinKeyless, forPage };",
  )(req, proc, con, () => 0);
  return { api, handlers, errors, windows };
}

// ── a discovery probe that could not be sent ─────────────────────────────

Deno.test("aio-client: a discovery probe that could not be sent is said once, with no address", async () => {
  // Node hands a send failure to the callback (macOS without the Local
  // Network permission: EHOSTUNREACH), or throws it; both were `catch {}`.
  const socket = (fail: "callback" | "throw") => ({
    createSocket: () => ({
      on() {},
      bind: (f: () => void) => f(),
      setBroadcast() {},
      close() {},
      send(_p: unknown, _port: number, _to: string, cb: (e: unknown) => void) {
        const e = Object.assign(new Error("send EHOSTUNREACH"), {
          code: "EHOSTUNREACH",
        });
        if (fail === "throw") throw e;
        cb(e);
      },
    }),
  });
  for (const fail of ["callback", "throw"] as const) {
    for (const platform of ["darwin", "linux"]) {
      const c = boot({ dgram: socket(fail), platform });
      const sweep = () =>
        new Promise<unknown[]>((res) => c.api.discoverApps(5, res));
      assertEquals(await sweep(), []);
      assertEquals(await sweep(), [], "the sweep still answers");
      const said = c.errors.filter((l) => l.includes("discovery"));
      assertEquals(said.length, 1, `${fail}/${platform}: ${c.errors}`);
      assertMatch(said[0]!, /could not be sent \(EHOSTUNREACH\)/);
      assertEquals(
        said[0]!.includes("Local Network"),
        platform === "darwin",
        said[0],
      );
      assert(!/255\.255|:\/\//.test(said[0]!), `an address: ${said[0]}`);
    }
  }
  // A probe that WAS sent says nothing.
  const ok = boot({
    dgram: {
      createSocket: () => ({
        on() {},
        bind: (f: () => void) => f(),
        setBroadcast() {},
        close() {},
        send: (_p: unknown, _n: number, _t: string, cb: (e: unknown) => void) =>
          cb(null),
      }),
    },
  });
  await new Promise((res) => ok.api.discoverApps(5, res));
  assertEquals(ok.errors, []);
});

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
    rootB,
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

/** The same, for a verdict that follows an answer from the server. */
function presented(c: Client, url: string, pem: string): Promise<boolean> {
  return new Promise((res) =>
    c.handlers["certificate-error"]!(
      { preventDefault() {} },
      null,
      url,
      "net::ERR_CERT_AUTHORITY_INVALID",
      { data: pem },
      res,
    )
  );
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

  // Not strict, the verdict follows a question to the server (provePin) —
  // nobody is paired at this address, so nobody is asked.
  assertEquals(
    await presented(c, HOST, b1.certPem),
    false,
    "no pin, no host list",
  );
  assertEquals(pinWarnings(c).length, 1, "the mismatch was silent");
  assertMatch(pinWarnings(c)[0]!, /has CHANGED/);
  // The connect page is told; an APP page is never scripted.
  assertMatch(c.windows[0]!.injected.join("\n"), /has CHANGED/);
  assertEquals(c.windows[1]!.injected, []);

  // The validated-host list alone admits no certificate the pin does not
  // cover: the page URL carries the key, and nobody decided about THIS one.
  // (It used to — which let a second certificate at the address ride in on
  // the first one's validation.)
  c.api._trustedHosts.add(new URL(HOST).host);
  assertEquals(await presented(c, HOST, b1.certPem), false);
  assertEquals(pinWarnings(c).length, 2, "refused without a word");
  // The compatible half: a server that regenerated its certificate stays
  // reachable — for the certificate connectTo decided about (decidePin).
  const der = (pem: string) =>
    pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  c.api._pinDecided.set(new URL(HOST).host, der(b1.certPem));
  assertEquals(present(c, HOST, b1.certPem), true);
  assertEquals(pinWarnings(c).length, 2, "said when it was decided, not again");

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
    assertEquals(
      await presented(c, HOST, forged.certPem),
      false,
      "same-name root",
    );
    assertEquals(
      await presented(c, HOST, twin.certPem),
      false,
      "the twin root itself",
    );
    assertEquals(pinWarnings(c).length, 2, "each was said as a changed pin");
    assertMatch(pinWarnings(c)[0]!, /has CHANGED/);
  }
});

// ── a changed certificate, not strict: proof before the key ───────────────
// The default used to warn and send the saved key to whatever presented
// another certificate at the paired address. Now nothing is sent until that
// is decided: the server is asked to prove it holds the key
// (src/server/pin-proof.ts answers here, as in the real server).

/** An HTTPS stand-in for an aio server; `proof` = it has `/__aio/pin-proof`
 *  for `key`, answering for certificate file `certFile`. Records every
 *  request line. */
async function standIn(
  leaf: { certPem: string; keyPem: string },
  /** `drop`: the question gets no answer — the connection is cut. */
  proof?: { key: string; certFile: string; drop?: boolean },
  /** As a keyed aio server: the page without `token=k` is a 401. */
  gated = false,
) {
  const https = nodeRequire("node:https");
  const seen: string[] = [];
  // deno-lint-ignore no-explicit-any
  const server = https.createServer(
    { cert: leaf.certPem, key: leaf.keyPem },
    // deno-lint-ignore no-explicit-any
    (req: any, res: any) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url.startsWith("/__aio/pin-proof")) {
        if (proof?.drop) return req.socket.destroy();
        let body = "";
        req.on("data", (c: unknown) => body += String(c));
        req.on("end", async () => {
          const a = proof
            ? await answerPinProof(JSON.parse(body), proof.key, proof.certFile)
            : null;
          res.statusCode = a?.ok ? 200 : 401;
          res.end(a?.ok ? JSON.stringify(a) : "Unauthorized");
        });
        return;
      }
      if (req.url.startsWith("/__aio/icon")) {
        res.statusCode = 404;
        return res.end();
      }
      if (gated && !req.url.includes("token=k")) {
        res.statusCode = 401;
        return res.end("Unauthorized");
      }
      res.end('<title>myapp</title><div id="root"></div>');
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port as number;
  return {
    seen,
    port,
    url: `https://127.0.0.1:${port}/?token=k`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** A client launched straight at `url`, with one paired recent on disk. */
async function connect(
  dir: string,
  url: string,
  recent: { cert: string; proves?: boolean },
  key = "k",
  flags: string[] = [],
) {
  const recents = dir + "/recents.json";
  await Deno.writeTextFile(
    recents,
    JSON.stringify([{ url, name: "myapp", key, ...recent }]),
  );
  const c = boot({ argv: [`--server-url=${url}`, ...flags], userData: dir });
  c.handlers["ready"]!();
  const win = c.windows[0]!;
  const deadline = Date.now() + 10_000;
  while (
    win.loaded.length === 0 && win.injected.length === 0 &&
    Date.now() < deadline
  ) await new Promise((r) => setTimeout(r, 10));
  // The icon fetch and the learn request follow the page fetch.
  return {
    c,
    win,
    recents: () =>
      JSON.parse(Deno.readTextFileSync(recents)) as {
        url: string;
        cert: string;
        proves?: boolean;
        changed?: string;
      }[],
  };
}
const withKey = (seen: string[]) => seen.filter((l) => l.includes("token=k"));

Deno.test("aio-client: a changed certificate gets NO request with the key before it is decided", async () => {
  const { rootA, a1, b1 } = await pki();
  const s = await standIn(b1);
  try {
    const c = boot();
    c.api.pinCert(new URL(s.url).host, a1.certPem + rootA.certPem);
    const err = await c.api.fetchPage(s.url).then(() => null, (e: Error) => e);
    assert(err, "the page fetch went through to another certificate");
    assert((err as { pinUndecided?: unknown }).pinUndecided, err.message);
    assertEquals(await c.api.fetchBuffer(s.url), null, "the icon fetch too");
    assertEquals(s.seen, [], "a request (and its token) was sent");
    // Control: the pin that matches is quiet, and served.
    const ok = boot();
    ok.api.pinCert(new URL(s.url).host, b1.certPem);
    assertMatch(await ok.api.fetchPage(s.url), /myapp/);
    assertEquals(ok.errors.filter((e) => /CHANGED/.test(e)), []);
  } finally {
    await s.close();
  }
});

Deno.test("aio-client: a server that regenerated its certificate and PROVES it holds the key is connected to, and re-pinned — no warning, no prompt", async () => {
  const { rootA, rootB, a1, b1 } = await pki();
  const fileB = b1.certPem + rootB.certPem;
  const s = await standIn(b1, { key: "k", certFile: fileB });
  const dir = await tempDir("aio-client-proof-");
  try {
    const { c, win, recents } = await connect(dir, s.url, {
      cert: a1.certPem + rootA.certPem,
    });
    assertEquals(win.loaded, [s.url], c.errors.join("\n"));
    // Asked first, WITHOUT the key; the key only after the proof.
    assertMatch(s.seen[0]!, /^POST \/__aio\/pin-proof$/);
    assertEquals(withKey(s.seen.slice(0, 1)), []);
    assertMatch(s.seen[1]!, /^GET \/\?token=k$/);
    assertEquals(c.errors.filter((e) => /CHANGED/.test(e)), []);
    assertMatch(c.errors.join("\n"), /proved it holds this app's key/);
    // The new certificate is the pin, on disk; the pairing is known to prove.
    assertEquals(recents()[0]!.cert, fileB);
    assertEquals(recents()[0]!.proves, true);
    assertEquals(present(c, s.url, b1.certPem), true);
  } finally {
    await s.close();
    await dropTempDir(dir);
  }
});

Deno.test("aio-client: a server older than the proof, with a changed certificate, is warned about and reached as before", async () => {
  const { rootA, a1, b1 } = await pki();
  const s = await standIn(b1); // no /__aio/pin-proof: answers 401, as its key gate does
  const dir = await tempDir("aio-client-proof-");
  try {
    const { c, win, recents } = await connect(dir, s.url, {
      cert: a1.certPem + rootA.certPem,
    });
    assertEquals(win.loaded, [s.url], c.errors.join("\n"));
    assertEquals(c.errors.filter((e) => /has CHANGED/.test(e)).length, 1);
    assertMatch(s.seen[0]!, /^POST \/__aio\/pin-proof$/);
    assert(
      withKey(s.seen).length > 0,
      "the compatible half: it still connects",
    );
    // The pin is NOT moved by an unproved connect.
    assertEquals(recents()[0]!.cert, a1.certPem + rootA.certPem);
    assertEquals(recents()[0]!.proves, undefined);
    assertEquals(present(c, s.url, b1.certPem), true, "the page load");
  } finally {
    await s.close();
    await dropTempDir(dir);
  }
});

Deno.test("aio-client: a pairing that HAS proved gives its key to nothing that cannot — not a silent server, not a relay of the real one's proof", async () => {
  const { rootA, a1, b1 } = await pki();
  const fileA = a1.certPem + rootA.certPem;
  for (
    const [how, proof] of [
      ["no proof endpoint", undefined],
      // What sits in the middle forwards the real server's answer: valid for
      // the REAL certificate, which is not the one being presented.
      ["a relayed proof", { key: "k", certFile: fileA }],
      ["another key", { key: "not-k", certFile: b1.certPem }],
    ] as const
  ) {
    const s = await standIn(b1, proof);
    const dir = await tempDir("aio-client-proof-");
    try {
      const { c, win, recents } = await connect(dir, s.url, {
        cert: fileA,
        proves: true,
      });
      const bare = s.url.replace("?token=k", "");
      assertEquals(win.loaded, [bare], `${how}: ${c.errors.join("\n")}`);
      assertEquals(withKey(s.seen), [], `${how}: the key was sent`);
      assertMatch(c.errors.join("\n"), /the key was NOT sent/, how);
      // Nothing about the pairing changed, and the keyless visit is no recent.
      assertEquals(recents().length, 1, how);
      assertEquals(recents()[0]!.cert, fileA, how);
      assertEquals(recents()[0]!.url, s.url, how);
    } finally {
      await s.close();
      await dropTempDir(dir);
    }
  }
});

Deno.test("aio-client: a connect that meets its pin learns, once, that the server can prove — and an older server is asked with the key it already gets", async () => {
  const { rootA, a1 } = await pki();
  const fileA = a1.certPem + rootA.certPem;
  const settle = async (done: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!done() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(done(), "the learn request never finished");
  };
  // A server with the proof: the pairing is marked.
  {
    const s = await standIn(a1, { key: "k", certFile: fileA });
    const dir = await tempDir("aio-client-proof-");
    try {
      const { win, recents } = await connect(dir, s.url, { cert: fileA });
      assertEquals(win.loaded, [s.url]);
      await settle(() => recents()[0]?.proves === true);
      assertMatch(s.seen[0]!, /^GET \/\?token=k$/, "the page first, as ever");
    } finally {
      await s.close();
      await dropTempDir(dir);
    }
  }
  // A server without it: asked WITH the key (its gate lets that through —
  // an anonymous request would count against the client's address), and the
  // pairing stays unmarked.
  {
    const s = await standIn(a1);
    const dir = await tempDir("aio-client-proof-");
    try {
      const { win, recents } = await connect(dir, s.url, { cert: fileA });
      assertEquals(win.loaded, [s.url]);
      await settle(() => s.seen.some((l) => l.includes("pin-proof")));
      assertMatch(
        s.seen.find((l) => l.includes("pin-proof"))!,
        /^POST \/__aio\/pin-proof\?token=k$/,
      );
      assertEquals(recents()[0]!.proves, undefined);
    } finally {
      await s.close();
      await dropTempDir(dir);
    }
  }
});

Deno.test("aio-client: no line a changed certificate prints carries the key — proved, withheld, warned, refused", async () => {
  const { rootA, rootB, a1, b1 } = await pki();
  const KEY = "s3cr3t-KEY-9f2a";
  const fileA = a1.certPem + rootA.certPem;
  for (
    const [how, said, proof, proves, flags] of [
      [
        "proved",
        /proved it holds/,
        {
          key: KEY,
          certFile: b1.certPem + rootB.certPem,
        },
        false,
        [],
      ],
      ["withheld", /the key was NOT sent/, undefined, true, []],
      ["warned", /has CHANGED/, undefined, false, []],
      ["refused", /REFUSED: /, undefined, false, ["--strict-pin"]],
    ] as const
  ) {
    const s = await standIn(b1, proof);
    const dir = await tempDir("aio-client-proof-");
    try {
      const url = s.url.replace("token=k", "token=" + KEY);
      const { c, win } = await connect(
        dir,
        url,
        { cert: fileA, ...(proves ? { proves } : {}) },
        KEY,
        [...flags],
      );
      const printed = c.errors.join("\n");
      assertMatch(printed, said, how);
      assert(!printed.includes(KEY), `${how}: a log line has the key`);
      assertMatch(printed, new RegExp(`127\\.0\\.0\\.1:${s.port}`), how);
      assert(
        !win.injected.join("\n").includes(KEY),
        `${how}: the page was told the key`,
      );
    } finally {
      await s.close();
      await dropTempDir(dir);
    }
  }
});

Deno.test("aio-client: a key that was withheld is withheld from the NEXT connect too — it asks again, and connects once the server proves", async () => {
  // The recent clicked a second time in the same run: the certificate had
  // been "decided", so the guard let the request — key and all — through to
  // what had just failed to prove. The same path is a proof that only timed
  // out: asked again, a server that answers now is connected to.
  const { rootA, rootB, a1, b1 } = await pki();
  const fileA = a1.certPem + rootA.certPem;
  const fileB = b1.certPem + rootB.certPem;
  const proof = { key: "not-k", certFile: fileB };
  const s = await standIn(b1, proof, true);
  const dir = await tempDir("aio-client-proof-");
  const until = async (what: string, done: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!done() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(done(), what);
  };
  try {
    const { c, win, recents } = await connect(dir, s.url, {
      cert: fileA,
      proves: true,
    });
    // Withheld; the keyless page is a 401, so the connect page says why.
    assertMatch(win.loaded[0]!, /^data:text\/html/, c.errors.join("\n"));
    assertEquals(withKey(s.seen), []);
    assertMatch(recents()[0]!.changed ?? "", /^\d{4}-\d\d-\d\dT/);
    const b1Der = b1.certPem.replace(/-----[A-Z ]+-----/g, "").replace(
      /\s+/g,
      "",
    );
    assertEquals(c.api._pinDecided.get(new URL(s.url).host), undefined);
    assertEquals(c.api._pinKeyless.get(new URL(s.url).host), b1Der);
    // The window's own load: the keyless address only.
    const bare = s.url.replace("?token=k", "");
    c.api._trustedHosts.add(new URL(s.url).host);
    assertEquals(present(c, bare, b1.certPem), true, "the keyless page");
    const click = () =>
      win.listeners["will-navigate"]!.at(-1)!({ preventDefault() {} }, s.url);
    const asked = () => s.seen.filter((l) => l.includes("pin-proof")).length;
    click();
    await until("the second connect never asked", () => asked() === 2);
    await until(
      "the second connect never answered",
      () => win.injected.some((j) => j.includes("the key was NOT sent")),
    );
    assertEquals(withKey(s.seen), [], "the second connect sent the key");
    assertEquals(win.loaded.length, 1);
    // What answers there now holds the key: asked a third time, connected.
    proof.key = "k";
    click();
    await until("never connected", () => win.loaded.at(-1) === s.url);
    assertEquals(asked(), 3);
    assertEquals(recents()[0]!.cert, fileB);
    assertEquals(recents()[0]!.proves, true);
    assertEquals(recents()[0]!.changed, undefined, "the mark outlived the pin");
  } finally {
    await s.close();
    await dropTempDir(dir);
  }
});

Deno.test("aio-client: an address opened WITHOUT the key is not sent it by the window's cookie jar either", async () => {
  // This run connected with the key (the connect page, a recent): the server
  // handed the window `aio_key_<app>` for its follow-up requests. Then the
  // certificate changes, what answers cannot prove, and the address is opened
  // keyless — by a window that sent the cookie along. Two ways in: the
  // address carried the key (it is withheld), or it carried none ("nothing to
  // withhold" — the jar had it).
  const { rootA, rootB, a1, b1 } = await pki();
  const fileA = a1.certPem + rootA.certPem;
  const fileB = b1.certPem + rootB.certPem;
  for (const how of ["key withheld", "no key in the address"] as const) {
    // Not the app's server: it serves a page to anyone, and cannot prove.
    const s = await standIn(b1, { key: "not-k", certFile: fileB });
    const dir = await tempDir("aio-client-jar-");
    try {
      await Deno.writeTextFile(
        dir + "/recents.json",
        JSON.stringify([{
          url: s.url,
          name: "myapp",
          key: "k",
          cert: fileA,
          proves: true,
        }]),
      );
      const cookie = (name: string, domain: string, secure = true): Cookie => ({
        name,
        domain,
        path: "/",
        secure,
      });
      const jar = [
        cookie("aio_key_myapp", "127.0.0.1"),
        cookie("aio_key_other", "127.0.0.1", false), // cookies ignore the port
        cookie("aio_key_myapp", "192.168.1.9"), // another machine's app
        cookie("theme", "127.0.0.1"), // not a key
      ];
      const bare = s.url.replace("?token=k", "");
      const url = how === "key withheld" ? s.url : bare;
      const c = boot({ argv: [`--server-url=${url}`], userData: dir, jar });
      c.handlers["ready"]!();
      const win = c.windows[0]!;
      const deadline = Date.now() + 10_000;
      while (win.loaded.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(win.loaded, [bare], `${how}: ${c.errors.join("\n")}`);
      assertEquals(withKey(s.seen), [], how);
      // Gone BEFORE the page was loaded; nothing else was touched.
      assertEquals(win.jarAtLoad, [[
        "aio_key_myapp@192.168.1.9",
        "theme@127.0.0.1",
      ]], how);
    } finally {
      await s.close();
      await dropTempDir(dir);
    }
  }
});

Deno.test("aio-client: a connect that carries the key, or meets its pin, leaves the cookie jar alone", async () => {
  const { rootA, a1 } = await pki();
  const s = await standIn(a1);
  const dir = await tempDir("aio-client-jar-");
  try {
    const jar = [{
      name: "aio_key_myapp",
      domain: "127.0.0.1",
      path: "/",
      secure: true,
    }];
    for (const url of [s.url, s.url.replace("?token=k", "")]) {
      await Deno.writeTextFile(
        dir + "/recents.json",
        JSON.stringify([{
          url: s.url,
          name: "myapp",
          key: "k",
          cert: a1.certPem + rootA.certPem,
        }]),
      );
      const c = boot({ argv: [`--server-url=${url}`], userData: dir, jar });
      c.handlers["ready"]!();
      const win = c.windows[0]!;
      const deadline = Date.now() + 10_000;
      while (win.loaded.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(win.loaded, [url], c.errors.join("\n"));
      assertEquals(win.jarAtLoad, [["aio_key_myapp@127.0.0.1"]]);
    }
  } finally {
    await s.close();
    await dropTempDir(dir);
  }
});

Deno.test("aio-client: a certificate that changes while the window is open is accepted once the server proves — and only then", async () => {
  // No connect is there to decide (see decidePin): the window's own request
  // met the new certificate, was refused, and stayed refused until the client
  // was restarted — a server that regenerated its certificate locked every
  // OPEN client out.
  const { rootA, rootB, a1, b1 } = await pki();
  const fileA = a1.certPem + rootA.certPem;
  const fileB = b1.certPem + rootB.certPem;
  const open = async (
    proof: { key: string; certFile: string } | undefined,
    flags: string[] = [],
  ) => {
    const s = await standIn(b1, proof);
    const dir = await tempDir("aio-client-proof-");
    const file = dir + "/recents.json";
    await Deno.writeTextFile(
      file,
      JSON.stringify([{ url: s.url, name: "myapp", key: "k", cert: fileA }]),
    );
    const c = boot({ argv: flags, userData: dir });
    c.handlers["ready"]!(); // pins what the recents carry
    return {
      s,
      c,
      recent: () => JSON.parse(Deno.readTextFileSync(file))[0],
      close: async () => {
        await s.close();
        await dropTempDir(dir);
      },
    };
  };
  const proofs = (seen: string[]) => seen.filter((l) => l.includes("proof"));
  // The app's own server, with a new root: it proves, on that certificate.
  {
    const t = await open({ key: "k", certFile: fileB });
    try {
      const wss = t.s.url.replace("https:", "wss:").replace("/?", "/ws?");
      assertEquals(await presented(t.c, wss, b1.certPem), true);
      assertEquals(t.s.seen, ["POST /__aio/pin-proof"], "asked with the key");
      assertEquals(t.recent().cert, fileB);
      assertEquals(t.recent().proves, true);
      assertMatch(t.c.errors.join("\n"), /proved it holds/);
      // The pin now: the next request is not a question.
      assertEquals(present(t.c, t.s.url, b1.certPem), true);
      assertEquals(t.s.seen.length, 1);
    } finally {
      await t.close();
    }
  }
  // Nothing that cannot prove — and it is asked once, not per request.
  for (
    const [how, proof] of [
      ["no proof endpoint", undefined],
      ["a relayed proof", { key: "k", certFile: fileA }],
      ["another key", { key: "not-k", certFile: fileB }],
    ] as const
  ) {
    const t = await open(proof);
    try {
      assertEquals(await presented(t.c, t.s.url, b1.certPem), false, how);
      assertEquals(await presented(t.c, t.s.url, b1.certPem), false, how);
      assertEquals(proofs(t.s.seen).length, 1, how);
      assertEquals(t.s.seen.length, 1, `${how}: ${t.s.seen}`);
      assertEquals(t.recent().cert, fileA, how);
      assertMatch(t.c.errors.join("\n"), /has CHANGED/, how);
    } finally {
      await t.close();
    }
  }
  // A question that got NO answer (the server was still starting: the
  // connection broke, or its 8 s ran out) is not "cannot prove": the next
  // request asks again, and a server that answers now is back — it stayed
  // refused until the client was restarted.
  {
    const proof = { key: "k", certFile: fileB, drop: true };
    const t = await open(proof);
    try {
      assertEquals(await presented(t.c, t.s.url, b1.certPem), false);
      assertEquals(proofs(t.s.seen).length, 1);
      assertEquals(await presented(t.c, t.s.url, b1.certPem), false);
      assertEquals(proofs(t.s.seen).length, 2, "not asked again");
      assertEquals(t.recent().cert, fileA);
      proof.drop = false;
      assertEquals(await presented(t.c, t.s.url, b1.certPem), true);
      assertEquals(t.recent().cert, fileB);
      assertEquals(withKey(t.s.seen), [], "the key went along with a question");
    } finally {
      await t.close();
    }
  }
  // Strict asks nothing: refused there and then.
  {
    const t = await open({ key: "k", certFile: fileB }, ["--strict-pin"]);
    try {
      assertEquals(present(t.c, t.s.url, b1.certPem), false);
      assertEquals(t.s.seen, []);
    } finally {
      await t.close();
    }
  }
});

Deno.test("aio-client: a changed certificate that did not prove is kept with the pairing, and the connect page shows it on that recent", async () => {
  // The warning went to the log, and to a connect page that the app's page
  // replaced a moment later.
  const { rootA, a1, b1 } = await pki();
  const s = await standIn(b1);
  const dir = await tempDir("aio-client-proof-");
  try {
    const { c, win, recents } = await connect(dir, s.url, {
      cert: a1.certPem + rootA.certPem,
    });
    assertEquals(win.loaded, [s.url], "warned about, and reached as before");
    // …and the connect's own save of the recent keeps it.
    assertMatch(recents()[0]!.changed ?? "", /^\d{4}-\d\d-\d\dT/);
    const appRow = new Function(
      "esc",
      CONNECT_HTML.match(/function appRow[\s\S]*?\n    }\n/)![0] +
        "return appRow;",
    )((x: unknown) => String(x)) as (a: unknown, extra?: string) => string;
    assertMatch(appRow(recents()[0]), /certificate changed/);
    assert(
      !appRow({ ...recents()[0], changed: undefined }).includes("changed"),
    );
    // What the page prints under the name is the address WITHOUT the key —
    // it printed '…/?token=k'. What a click opens, and what "forget" names,
    // is still the stored address.
    const [row] = c.api.forPage(recents()) as { url: string; shown: string }[];
    assertEquals(row!.url, s.url);
    const html = appRow(row, `<span data-del="${row!.url}"></span>`);
    const meta = /<div class="meta">([^<]*)<\/div>/.exec(html)![1]!;
    assertEquals(meta, s.url.replace("token=k", "token=…"));
    assert(html.includes(`data-url="${s.url}"`), html);
    assert(html.includes(`data-del="${s.url}"`), html);
    // An entry that was handed over without `shown` prints no address with a
    // key either: host and port.
    assert(
      !/<div class="meta">[^<]*token=k/.test(
        appRow({ ...recents()[0], host: "h", port: 1 }),
      ),
    );
  } finally {
    await s.close();
    await dropTempDir(dir);
  }
});

// ── the strict pin (`electron: { strictPin }`, `build.strictPin`, --strict-pin) ──

Deno.test("aio-client strict pin: a pinned host with ANOTHER certificate gets no request — not the page fetch, not the icon fetch", async () => {
  const { rootA, a1, a2, b1 } = await pki();
  const https = nodeRequire("node:https");
  const seen: string[] = [];
  const serve = async (leaf: { certPem: string; keyPem: string }) => {
    const server = https.createServer(
      { cert: leaf.certPem, key: leaf.keyPem },
      (req: { url: string }, res: { end(s: string): void }) => {
        seen.push(req.url);
        res.end('<title>myapp</title><div id="root"></div>');
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return server;
  };
  // What answers in the app's place presents B's leaf.
  const other = await serve(b1), same = await serve(a2);
  const url = (srv: typeof other) =>
    `https://127.0.0.1:${srv.address().port}/?token=k`;
  try {
    for (
      const [how, c] of [
        ["baked", boot({ strictPin: true })],
        ["--strict-pin", boot({ argv: ["--strict-pin"] })],
      ] as const
    ) {
      c.api.pinCert(new URL(url(other)).host, a1.certPem + rootA.certPem);
      const err = await c.api.fetchPage(url(other)).then(
        () => null,
        (e: Error) => e,
      );
      assert(err, `${how}: the fetch went through`);
      assertMatch(err.message, /has CHANGED\. REFUSED \(strict pin\)/);
      assertMatch(err.message, /pair again/);
      assertEquals(await c.api.fetchBuffer(url(other)), null, how);
      assertEquals(seen, [], `${how}: a request (and its token) was sent`);
      assertEquals(c.errors.filter((e) => /REFUSED: /.test(e)).length, 2);
      // A leaf re-issued under the PINNED root still meets the pin.
      c.api.pinCert(new URL(url(same)).host, a1.certPem + rootA.certPem);
      assertMatch(await c.api.fetchPage(url(same)), /myapp/);
      assert((await c.api.fetchBuffer(url(same))).length > 0);
      assertEquals(seen.splice(0).length, 2);
      // A host with NO pin is the ordinary manual connect, strict or not.
      const free = boot({ strictPin: true });
      assertMatch(await free.api.fetchPage(url(other)), /myapp/);
      seen.length = 0;
    }
  } finally {
    for (const server of [other, same]) {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});

Deno.test("aio-client strict pin: the page load is refused even for a host on the validated list, and for a certificate Chromium itself would accept", async () => {
  const { rootA, a1, a2, b1 } = await pki();
  const c = boot({ strictPin: true, userData: "/nonexistent-aio-client-test" });
  c.api.pinCert(new URL(HOST).host, a1.certPem + rootA.certPem);
  // The door the default leaves open: connectTo validated the address.
  c.api._trustedHosts.add(new URL(HOST).host);
  assertEquals(present(c, HOST, b1.certPem), false, "accepted via host list");
  assertEquals(present(c, HOST, a2.certPem), true, "re-issued by the root");
  assertMatch(pinWarnings(c)[0]!, /REFUSED: /);

  // Off (the default): the same sequence is ACCEPTED for the certificate
  // that was decided about (see the proof tests below).
  const off = boot();
  off.api.pinCert(new URL(HOST).host, a1.certPem + rootA.certPem);
  off.api._trustedHosts.add(new URL(HOST).host);
  off.api._pinDecided.set(
    new URL(HOST).host,
    b1.certPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""),
  );
  assertEquals(present(off, HOST, b1.certPem), true);
  off.handlers["ready"]!();
  assertEquals(off.handlers["verify-proc"], undefined, "installed by default");

  // Chromium's own verdict is not asked for a pinned name: a certificate the
  // trust store accepts never reaches 'certificate-error'.
  c.handlers["ready"]!();
  const verify = (hostname: string, pem: string) => {
    let v: number | undefined;
    c.handlers["verify-proc"]!(
      { hostname, certificate: { data: pem } },
      (n: number) => (v = n),
    );
    return v;
  };
  assertEquals(verify("10.0.0.5", b1.certPem), -2, "another certificate");
  assertEquals(verify("10.0.0.5", a2.certPem), -3, "meets the pin");
  assertEquals(verify("example.com", b1.certPem), -3, "no pin for this name");
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

// ── a strict refusal on a launch that went straight to an address ─────────
// Measured in a real Electron (tests/electron-client-strict-pin-e2e.test.ts):
// `--server-url` at a host whose pin no longer holds was refused — in the
// log — and the window stayed blank. The way back is to pair again, and the
// connect page is where that happens.

Deno.test("aio-client strict pin: a refused --server-url launch opens the connect page with the reason; a server that is merely down does not", async () => {
  const { rootA, a1, b1 } = await pki();
  const https = nodeRequire("node:https");
  const seen: string[] = [];
  const server = https.createServer(
    { cert: b1.certPem, key: b1.keyPem },
    (req: { url: string }, res: { end(s: string): void }) => {
      seen.push(req.url);
      res.end('<title>myapp</title><div id="root"></div>');
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = `https://127.0.0.1:${port}/?token=k`;
  const settled = async (c: Client, done: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!done() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(done(), `never settled: ${c.errors.join("\n")}`);
  };
  try {
    const c = boot({ strictPin: true, argv: [`--server-url=${url}`] });
    c.api.pinCert(`127.0.0.1:${port}`, a1.certPem + rootA.certPem);
    c.handlers["ready"]!();
    const win = c.windows[0]!;
    await settled(c, () => win.loaded.length > 0);
    assertEquals(seen, [], "a request (and its token) was sent");
    assertEquals(win.loaded.length, 1);
    assert(win.loaded[0]!.startsWith("data:text/html"), win.loaded[0]);
    for (const f of win.listeners["did-finish-load"] ?? []) f();
    assertMatch(win.injected.join("\n"), /REFUSED \(strict pin\)/);
    assertMatch(win.injected.join("\n"), /pair again/);
    // From the page, the same host again: said on the page, not a reload.
    for (const f of win.listeners["will-navigate"] ?? []) {
      f({ preventDefault() {} }, url);
    }
    await settled(
      c,
      () => c.errors.filter((e) => /REFUSED: /.test(e)).length === 2,
    );
    assertEquals(win.loaded.length, 1, "the connect page was loaded twice");

    // Not a pin refusal (nothing listens there): no connect page appears —
    // an unattended window is not handed an address box it never had.
    await new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
    const down = boot({ strictPin: true, argv: [`--server-url=${url}`] });
    down.api.pinCert(`127.0.0.1:${port}`, a1.certPem + rootA.certPem);
    down.handlers["ready"]!();
    const w2 = down.windows[0]!;
    await settled(down, () => w2.injected.length > 0);
    assertEquals(w2.loaded, []);
    // …and it is SAID, in the log: this window has no page to say it on
    // (tests/electron-client-down-server-e2e.test.ts measures that). The
    // address, with the key it carries masked.
    const said = down.errors.filter((e) => e.includes("cannot open"));
    assertEquals(said.length, 1, down.errors.join("\n"));
    assert(said[0]!.includes(`https://127.0.0.1:${port}/?token=`), said[0]);
    assert(!said[0]!.includes("token=k"), said[0]);
    // The script is the connect page's: on a page without `err` it is a
    // no-op, not a throw.
    new Function("document", w2.injected[0]!)({ getElementById: () => null });
  } finally {
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});
