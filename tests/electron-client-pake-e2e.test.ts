// REAL Electron, REAL aio server: PIN pairing by PAKE (`pairing: { pake }`).
//
//  0. The CPace copy the client embeds (`cpaceSuite.toString()`, run by
//     Electron's own Node/BoringSSL) reproduces the draft's Appendix B.1
//     vectors and aio's golden application vector — no display needed.
//  1. A relay in front of the app, presenting a certificate of its own: the
//     client refuses with the relay message, the code is NOT consumed, and
//     nothing the relay saw contains the code.
//  2. Direct: the 8-digit code pairs, the window opens the app, the recent
//     holds the app's key and certificate, and no request body the server
//     received contains the code.
//
// Gate (1–2): ELECTRON_E2E=1, Linux, the nested test display; the client's
// profile in a temp directory.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { electronClientScript } from "../src/electron/electron.ts";
import { realElectronBin } from "../src/electron/electron-spawn.ts";
import { cpaceSuite } from "../src/server/cpace.ts";
import { loadOrCreateCert } from "../src/server/tls.ts";
import { freePort } from "../src/testing/server-test.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { accountEnv } from "./e2e-app-harness.ts";
import { spec } from "./module-spec-helper.ts";
import { AIO, DRAFT } from "./cpace-vectors.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";
const REPO_CONFIG = new URL("../deno.json", import.meta.url).pathname;

const hasElectron = (() => {
  try {
    Deno.statSync(ELECTRON_BIN);
    return true;
  } catch {
    return false; // aio-ok: the gate below says why it is skipped
  }
})();

function windowSkip(): string | null {
  if (Deno.build.os !== "linux") return "linux (nested X display)";
  if (!hasElectron) return "Electron not installed";
  if (!Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY")) {
    return "no display";
  }
  if (!Deno.env.get("ELECTRON_E2E")) return "set ELECTRON_E2E=1 to run";
  return null;
}

Deno.test({
  name:
    "aio client: the CPace copy it embeds reproduces the draft and aio vectors in Electron's runtime",
  ignore: !hasElectron,
  fn: async () => {
    const dir = await tempDir("el-pake-vec-");
    try {
      const script = join(dir, "vec.cjs");
      await Deno.writeTextFile(
        script,
        `const crypto = require('crypto');\n` +
          `const CPACE = (${cpaceSuite.toString()})();\n` +
          `const hex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));\n` +
          `const h = (b) => Buffer.from(b).toString('hex');\n` +
          `const V = ${JSON.stringify(DRAFT)}, A = ${JSON.stringify(AIO)};\n` +
          `(async () => {\n` +
          `  const te = new TextEncoder();\n` +
          `  const g = await CPACE.calculateGenerator(te.encode(V.PRS), hex(V.CI), hex(V.sid));\n` +
          `  const Ya = await CPACE.scalarMultVfy(hex(V.ya), g), Yb = await CPACE.scalarMultVfy(hex(V.yb), g);\n` +
          `  const K = await CPACE.scalarMultVfy(hex(V.ya), Yb);\n` +
          `  const isk = await CPACE.isk(hex(V.sid), K, Ya, te.encode(V.ADa), Yb, te.encode(V.ADb));\n` +
          `  const low = []; for (const [u] of V.lowOrder) low.push(h(await CPACE.scalarMultVfy(hex(V.lowOrderS), hex(u))));\n` +
          `  const fp = await CPACE.fingerprint(te.encode(A.leaf));\n` +
          `  const st = await CPACE.start(A.pin, fp, hex(V.ya), hex(V.sid));\n` +
          `  const r = await CPACE.respond(A.pin, fp, hex(V.sid), st.Ya, hex(V.yb));\n` +
          `  const f = await CPACE.finish(st, r.Yb, r.ADb);\n` +
          `  const box = await CPACE.seal(r.isk, hex(V.sid), A.profile, hex(A.iv));\n` +
          `  console.log(JSON.stringify({ g: h(g), Ya: h(Ya), Yb: h(Yb), K: h(K), isk: h(isk), low,\n` +
          `    aYa: h(st.Ya), aYb: h(r.Yb), ta: h(f.ta), tb: h(f.tb), box: h(box),\n` +
          `    opened: await CPACE.open(f.isk, hex(V.sid), box) }));\n` +
          `})().catch((e) => { console.error(e); process.exit(1); });\n`,
      );
      const out = await new Deno.Command(await realElectronBin(ELECTRON_BIN), {
        args: [script],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const err = new TextDecoder().decode(out.stderr);
      assert(out.success, err);
      const got = JSON.parse(new TextDecoder().decode(out.stdout));
      assertEquals(
        [got.g, got.Ya, got.Yb, got.K, got.isk],
        [DRAFT.g, DRAFT.Ya, DRAFT.Yb, DRAFT.K, DRAFT.ISK_IR],
      );
      assertEquals(
        got.low,
        DRAFT.lowOrder.map(([, q]) => q === "0" ? "00".repeat(32) : q),
      );
      assertEquals(
        [got.aYa, got.aYb, got.ta, got.tb, got.box, got.opened],
        [AIO.Ya, AIO.Yb, AIO.ta, AIO.tb, AIO.box, AIO.profile],
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

async function until<T>(
  what: string,
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  detail: () => string = () => "",
  ms = 45_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}\n${detail()}`);
}

const read = (p: string) => {
  try {
    return Deno.readTextFileSync(p);
  } catch {
    return ""; // aio-ok: not written yet
  }
};

function find(dir: string, name: string): string | null {
  for (const e of Deno.readDirSync(dir)) {
    const p = join(dir, e.name);
    if (e.isFile && e.name === name) return p;
    if (e.isDirectory) {
      const hit = find(p, name);
      if (hit) return hit;
    }
  }
  return null;
}

Deno.test({
  name:
    "aio client, real Electron: an 8-digit code pairs by PAKE without ever sending it, and a relay with its own certificate is refused with the code left unspent",
  ignore: windowSkip() !== null,
  // aio-ok: real Electron, a server child and a TLS relay, driven over CDP
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const dir = await tempDir("el-pake-");
    const apps = join(dir, "apps");
    const bodies = join(dir, "bodies.log");
    const pinFile = join(dir, "pin");
    const KEY = crypto.randomUUID().replaceAll("-", "");
    const port = freePort();
    await Deno.writeTextFile(
      join(dir, "server.ts"),
      `import { aio, cell } from "${
        spec(new URL("../mod.ts", import.meta.url).href)
      }";\n` +
        `import { generatePin } from "${
          spec(new URL("../src/server/pairing.ts", import.meta.url).href)
        }";\n` +
        `const serve = Deno.serve;\n` +
        `const note = (h: (r: Request, i: unknown) => unknown) => async (r: Request, i: unknown) => {\n` +
        `  if (new URL(r.url).pathname === "/__aio/pair") Deno.writeTextFileSync(${
          JSON.stringify(bodies)
        }, (await r.clone().text()) + "\\n", { append: true });\n` +
        `  return h(r, i);\n` +
        `};\n` +
        `// deno-lint-ignore no-explicit-any\n` +
        `(Deno as any).serve = (a: any, b: any) =>\n` +
        `  typeof b === "function" ? serve(a, note(b) as any)\n` +
        `    : typeof a === "function" ? serve(note(a) as any)\n` +
        `    : serve({ ...a, handler: note(a.handler) });\n` +
        `await aio.run({\n` +
        `  cells: [cell("pake_e2e", { state: { n: 0 } })],\n` +
        `  appId: "pake-e2e", client: "server-only", persist: false,\n` +
        `  expose: true, key: ${JSON.stringify(KEY)}, port: ${port},\n` +
        `  pairing: { pake: true },\n` +
        `});\n` +
        `Deno.writeTextFileSync(${JSON.stringify(pinFile)}, generatePin(${
          JSON.stringify(KEY)
        }, { pake: true }));\n`,
    );
    const env = { ...Deno.env.toObject(), AIO_APPS_DIR: apps, NO_COLOR: "1" };
    delete (env as Record<string, string>).AIO_PORT;
    const server = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", "--config", REPO_CONFIG, "server.ts"],
      cwd: dir,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let serverOut = "";
    const dec = new TextDecoder();
    for (const s of [server.stdout, server.stderr]) {
      (async () => {
        for await (const c of s) serverOut += dec.decode(c);
      })().catch(() => {});
    }

    // The relay: its own certificate (another machine root), TCP to the app.
    const relayPort = freePort();
    const prevApps = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", join(dir, "relay-apps"));
    const relayCert = await loadOrCreateCert(join(dir, "relay-tls"));
    if (prevApps === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prevApps);
    const relay = Deno.listenTls({
      hostname: "127.0.0.1",
      port: relayPort,
      cert: relayCert.cert,
      key: relayCert.key,
    });
    const relayed: string[] = [];
    (async () => {
      for await (const conn of relay) {
        (async () => {
          const up = await Deno.connectTls({
            hostname: "127.0.0.1",
            port,
            caCerts: [read(join(apps, ".aio-ca", "aio-root.pem"))],
          });
          const tap = new TransformStream<Uint8Array, Uint8Array>({
            transform(c, ctl) {
              relayed.push(dec.decode(c));
              ctl.enqueue(c);
            },
          });
          await Promise.allSettled([
            conn.readable.pipeThrough(tap).pipeTo(up.writable),
            up.readable.pipeTo(conn.writable),
          ]);
        })().catch(() => {});
      }
    })().catch(() => {});

    const main = join(dir, "client.cjs");
    await Deno.writeTextFile(main, electronClientScript(null));
    const bin = await realElectronBin(ELECTRON_BIN);
    const cdp = freePort();
    const cenv: Record<string, string> = {
      ...Deno.env.toObject(),
      ...testDisplayEnv(),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "no-bus")}`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      ...accountEnv(join(dir, "config")),
      HOME: join(dir, "home"),
      AIO_DISCOVERY_PORT: String(freePort()),
    };
    delete cenv.WAYLAND_DISPLAY;
    const client = new Deno.Command(bin, {
      args: [
        main,
        `--remote-debugging-port=${cdp}`,
        "--no-sandbox",
        "--disable-gpu",
        "--connect",
      ],
      env: cenv,
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).spawn();
    let clientErr = "";
    (async () => {
      for await (const c of client.stderr) clientErr += dec.decode(c);
    })().catch(() => {});

    type Target = { type: string; url: string; webSocketDebuggerUrl: string };
    const page = async (): Promise<Target | null> => {
      try {
        const all = await (await fetch(`http://127.0.0.1:${cdp}/json`))
          .json() as Target[];
        return all.find((t) => t.type === "page") ?? null;
      } catch {
        return null; // aio-ok: DevTools not listening yet
      }
    };
    const evalIn = async (expression: string): Promise<unknown> => {
      const t = await until("a page target", page, () => clientErr);
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      try {
        await new Promise<void>((res, rej) => {
          ws.onopen = () => res();
          ws.onerror = () => rej(new Error("CDP socket failed"));
        });
        const reply = new Promise<{ result?: { value?: unknown } }>((res) => {
          ws.onmessage = (ev) => {
            const m = JSON.parse(String(ev.data));
            if (m.id === 1) res(m.result);
          };
        });
        ws.send(JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        }));
        return (await reply)?.result?.value;
      } finally {
        ws.close();
      }
    };
    const pair = async (p: number, pin: string) => {
      await until(
        "the connect page",
        async () => (await page())?.url.startsWith("data:text/html") || null,
        () => clientErr,
      );
      const info = { host: "127.0.0.1", port: p, tls: true, pin };
      await evalIn(
        `location.href = "aio-pair:" + encodeURIComponent(${
          JSON.stringify(JSON.stringify(info))
        }); 1`,
      );
    };
    try {
      const pin = await until(
        "the PAKE code",
        () => read(pinFile),
        () => serverOut,
        90_000,
      );
      assert(/^[0-9]{8}$/.test(pin), `an 8-digit code: ${pin}`);

      // 1 — through the relay: refused, said, nothing consumed.
      let lastErr = "";
      await pair(relayPort, pin);
      const said = await until(
        "the relay refusal on the connect page",
        async () => {
          const t = String(
            await evalIn(
              "(document.getElementById('err')||{}).textContent||''",
            ) ?? "",
          );
          lastErr = t;
          return /not the one the app serves/.test(t) ? t : null;
        },
        () => `page said: ${lastErr}\nclient:\n${clientErr}`,
      );
      assert(said.startsWith("Pairing failed"), said);
      assert(
        !relayed.join("").includes(pin),
        "the code crossed the relay",
      );

      // 2 — direct: pairs (the same code: the relay spent nothing), opens.
      await pair(port, pin);
      // The pairing is saved (the window then opens the app with its key —
      // a headless app answers that page with its 503, which is not this
      // test's business).
      const list = await until(
        "the pairing in recents.json",
        () => {
          const rec = find(join(dir, "config"), "recents.json");
          const l = rec
            ? JSON.parse(read(rec) || "[]") as { key?: string; cert?: string }[]
            : [];
          return l.some((r) => r.key === KEY) ? l : null;
        },
        () => `client:\n${clientErr}\nserver:\n${serverOut}`,
      );
      const mine = list.find((r) => r.key === KEY);
      assert(mine, "the pairing was not saved");
      assert(mine.cert?.includes("BEGIN CERTIFICATE"), "no certificate pin");
      const sent = read(bodies);
      assert(sent.includes('"cpace"'), `no PAKE bodies arrived:\n${sent}`);
      assert(!sent.includes(pin), "the code reached the server in a body");
    } finally {
      try {
        client.kill("SIGKILL");
      } catch { /* aio-ok: already gone */ }
      await client.status;
      relay.close();
      try {
        server.kill("SIGTERM");
      } catch { /* aio-ok: already gone */ }
      await server.status;
      await dropTempDir(dir);
    }
  },
});
