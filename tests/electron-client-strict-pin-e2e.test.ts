// REAL Electron, REAL aio server: the strict certificate pin.
//
// The aio client pins the certificate of an app it paired with, and keeps the
// app's key. By default a paired address that presents ANOTHER certificate is
// warned about and still handed the key (a server that regenerated its
// certificate must not lock its clients out). `electron: { strictPin }` /
// `build.strictPin` / `--strict-pin` refuses instead. That was proven against
// stubbed `https`/`electron` modules only (electron-client-generated-eval);
// here the generated client runs in a real Electron against a real exposed
// aio server whose TLS identity is the one aio mints:
//
//   1. pair by PIN                      → pinned, connected
//   2. the LEAF is re-issued, same root → strict still connects
//   3. the machine ROOT is replaced     → strict REFUSES: the server sees no
//      request at all (so no token), the window says how to pair again —
//      and pairing again there by PIN connects; the new root is the pin
//   4. the root is replaced again, and the client is NOT strict (the
//      default) → the server is asked to prove it holds the key before the
//      key is sent; it does, so: connected, re-pinned, no prompt
//  4b. the root is replaced while a not-strict window is OPEN → the same
//      proof, asked by the window's own reconnect: back, re-pinned, no
//      restart
//   5. root AND key replaced (what answers there does not hold the key),
//      not strict → the key is never sent; the window says so
//  5b. …nor by the WINDOW: a run that connected with the key holds the
//      server's key cookie; the address is then taken by something that
//      serves anyone and cannot prove, and is opened without the key — the
//      request lines AND their Cookie headers carry no key
//
// …and the client that is NOT strict against a server that cannot prove — one
// on aio 1.0.19 or older, which has no `/__aio/pin-proof` — must be reached
// exactly as 1.0.19's client reached it: no prompt, no lockout. (The server
// here is today's with that one route answering what a real 1.0.19 server
// answers, measured: 401 without the key, 404 with it.) A second profile,
// paired with such a server, so it has never seen a proof:
//
//   6. paired by PIN; the certificate does not change  → connected, no warning
//   7. the LEAF is re-issued, same root                → connected, no warning
//   8. the ROOT is replaced                            → warned about and
//      connected WITH the key, twice over (a restart changes nothing); the
//      pin is not moved and the pairing is still not one that proves
//
// The server is an `aio.run({ expose, key })` child whose `Deno.serve` handler
// is wrapped to append every request line to a file — what "arrived" means.
//
// Gate: ELECTRON_E2E=1 (deno task test:electron), Linux, the nested test
// display — no window lands on the desktop — and the client's profile in a
// temp directory.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { electronClientScript } from "../src/electron/electron.ts";
import { realElectronBin } from "../src/electron/electron-spawn.ts";
import { freePort } from "../src/testing/server-test.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { accountEnv } from "./e2e-app-harness.ts";
import { spec } from "./module-spec-helper.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";
const REPO_CONFIG = new URL("../deno.json", import.meta.url).pathname;

function shouldSkip(): string | null {
  if (Deno.build.os !== "linux") return "linux (nested X display)";
  try {
    Deno.statSync(ELECTRON_BIN);
  } catch {
    return "Electron not installed — run: deno task install:electron";
  }
  if (!Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY")) {
    return "no display (set DISPLAY or WAYLAND_DISPLAY)";
  }
  if (!Deno.env.get("ELECTRON_E2E")) {
    return "E2E disabled — set ELECTRON_E2E=1 to run";
  }
  return null;
}

/** Poll `probe` until it answers, or fail with `what` (and `detail()`). */
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

/** The first file named `name` under `dir`. */
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
    "aio client, real Electron: a strict pin survives a re-issued leaf, refuses a new root before any request leaves, and pairs again; not strict, the key goes only to a server that proves it holds it — and a server too old to prove is reached as 1.0.19 reached it",
  ignore: shouldSkip() !== null,
  // aio-ok: real Electron and a real server child, driven over CDP and TLS
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const dir = await tempDir("el-strict-pin-");
    const apps = join(dir, "apps");
    const reqLog = join(dir, "requests.log");
    const pinFile = join(dir, "pin");
    const KEY = crypto.randomUUID().replaceAll("-", "");
    const port = freePort();
    const base = `https://127.0.0.1:${port}`;
    const appUrl = `${base}/?token=${KEY}`;

    // ── the server: aio's own, with every request line written down ──
    // A page to land on: an app with no UI entry answers `/` 503 in dev as
    // in prod (the headless-build refusal), and the client would stop there.
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      `export default function App() {\n  return <div>pinned</div>;\n}\n`,
    );
    await Deno.writeTextFile(
      join(dir, "server.ts"),
      `import { aio, cell } from "${
        spec(new URL("../mod.ts", import.meta.url).href)
      }";\n` +
        `import { generatePin } from "${
          spec(new URL("../src/server/pairing.ts", import.meta.url).href)
        }";\n` +
        `const serve = Deno.serve;\n` +
        `const note = (h: (r: Request, i: unknown) => unknown) => (r: Request, i: unknown) => {\n` +
        `  Deno.writeTextFileSync(${
          JSON.stringify(reqLog)
        }, r.method + " " + r.url + (r.headers.get("cookie") ? " cookie=" + r.headers.get("cookie") : "") + "\\n", { append: true });\n` +
        `  // A server on aio 1.0.19 has no proof route: its key gate answers\n` +
        `  // 401, and behind the gate there is nothing there (404).\n` +
        `  const u = new URL(r.url);\n` +
        `  if (Deno.env.get("E2E_OLD") && u.pathname === "/__aio/pin-proof") {\n` +
        `    return u.searchParams.get("token") === Deno.env.get("E2E_KEY")\n` +
        `      ? new Response("Not Found", { status: 404 })\n` +
        `      : new Response("Unauthorized", { status: 401 });\n` +
        `  }\n` +
        `  return h(r, i);\n` +
        `};\n` +
        `// deno-lint-ignore no-explicit-any\n` +
        `(Deno as any).serve = (a: any, b: any) =>\n` +
        `  typeof b === "function" ? serve(a, note(b) as any)\n` +
        `    : typeof a === "function" ? serve(note(a) as any)\n` +
        `    : serve({ ...a, handler: note(a.handler) });\n` +
        `await aio.run({\n` +
        `  cells: [cell("strict_pin_e2e", { state: { n: 0 } })],\n` +
        `  appId: "strict-pin-e2e", client: "server-only", persist: false,\n` +
        `  expose: true, key: Deno.env.get("E2E_KEY") || false, port: ${port},\n` +
        `});\n` +
        `Deno.writeTextFileSync(${
          JSON.stringify(pinFile)
        }, Deno.env.get("E2E_KEY") ? generatePin(Deno.env.get("E2E_KEY")!) : "open");\n`,
    );
    let server: Deno.ChildProcess | null = null;
    let serverOut = "";
    /** Start the server; resolves with a fresh pairing PIN once it serves. */
    const startServer = async (key = KEY, old = false): Promise<string> => {
      await Deno.remove(pinFile).catch(() => {});
      const env = {
        ...Deno.env.toObject(),
        AIO_APPS_DIR: apps,
        NO_COLOR: "1",
        E2E_KEY: key,
        ...(old ? { E2E_OLD: "1" } : {}),
      };
      delete (env as Record<string, string>).AIO_PORT;
      const proc = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--no-check", "--config", REPO_CONFIG, "server.ts"],
        cwd: dir,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      server = proc;
      const dec = new TextDecoder();
      for (const s of [proc.stdout, proc.stderr]) {
        (async () => {
          for await (const c of s) serverOut += dec.decode(c);
        })().catch(() => {});
      }
      return await until(
        "the server's pairing PIN",
        () => read(pinFile),
        () => serverOut,
        90_000,
      );
    };
    const stopServer = async () => {
      if (!server) return;
      try {
        server.kill("SIGTERM");
      } catch { /* aio-ok: already gone */ }
      await server.status;
      server = null;
    };
    /** One request of the test's own, so "nothing arrived before it" has an
     *  event to wait for instead of a sleep. Returns the lines before it. */
    const arrivedBefore = async (mark: string): Promise<string[]> => {
      const client = Deno.createHttpClient({
        caCerts: [read(join(apps, ".aio-ca", "aio-root.pem"))],
      });
      try {
        // `client` is a Deno-only RequestInit field (absent from the DOM type).
        await (await fetch(
          `${base}/__mark/${mark}`,
          { client } as RequestInit,
        )).body
          ?.cancel();
      } finally {
        client.close();
      }
      const lines = await until(
        `the ${mark} mark in the request log`,
        () => read(reqLog).includes(`/__mark/${mark}`) ? read(reqLog) : null,
      );
      return lines.split("\n").filter(Boolean).filter((l) =>
        !l.includes("/__mark/")
      );
    };

    // ── the client: the generated main.cjs, strict and not, one profile ──
    const mains = {
      strict: join(dir, "strict.cjs"),
      loose: join(dir, "loose.cjs"),
    };
    await Deno.writeTextFile(
      mains.strict,
      electronClientScript(null, { strictPin: true }),
    );
    await Deno.writeTextFile(mains.loose, electronClientScript(null));
    const bin = await realElectronBin(ELECTRON_BIN);
    type Client = {
      cdp: number;
      err: () => string;
      close: () => Promise<void>;
    };
    const live: Client[] = [];
    /** The client profile in use (its recents: the pin and the key). */
    let profile = "config";
    const launch = (main: string, ...args: string[]): Client => {
      const cdp = freePort();
      const env: Record<string, string> = {
        ...Deno.env.toObject(),
        ...testDisplayEnv(),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "no-bus")}`,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        // The client's profile (its recents: the pin and the key) and home.
        ...accountEnv(join(dir, profile)),
        HOME: join(dir, "home"),
        // LAN discovery on a port of this test's own: no app is found.
        AIO_DISCOVERY_PORT: String(freePort()),
      };
      delete env.WAYLAND_DISPLAY;
      const proc = new Deno.Command(bin, {
        args: [
          main,
          `--remote-debugging-port=${cdp}`,
          "--no-sandbox",
          "--disable-gpu",
          ...args,
        ],
        env,
        stdin: "null",
        stdout: "null",
        stderr: "piped",
      }).spawn();
      let err = "";
      const dec = new TextDecoder();
      (async () => {
        for await (const c of proc.stderr) err += dec.decode(c);
      })().catch(() => {});
      const c: Client = {
        cdp,
        err: () => err,
        close: async () => {
          try {
            proc.kill("SIGKILL");
          } catch { /* aio-ok: already gone */ }
          await proc.status;
        },
      };
      live.push(c);
      return c;
    };
    type Target = { type: string; url: string; webSocketDebuggerUrl: string };
    const page = async (c: Client): Promise<Target | null> => {
      try {
        const all = await (await fetch(`http://127.0.0.1:${c.cdp}/json`))
          .json() as Target[];
        return all.find((t) => t.type === "page") ?? null;
      } catch {
        return null; // aio-ok: DevTools not listening yet
      }
    };
    /** One DevTools call on the window's page; its result. */
    const cdpCall = async (
      c: Client,
      method: string,
      params: Record<string, unknown>,
    ): Promise<{ result?: { value?: unknown } } | undefined> => {
      const t = await until("a page target", () => page(c), c.err);
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
        ws.send(JSON.stringify({ id: 1, method, params }));
        return await reply;
      } finally {
        ws.close();
      }
    };
    /** Evaluate in the window's page; the value, by value. */
    const evalIn = async (c: Client, expression: string): Promise<unknown> =>
      (await cdpCall(c, "Runtime.evaluate", {
        expression,
        returnByValue: true,
      }))?.result?.value;
    /** A login the window's jar holds for the app's host (persistent, as an
     *  /__aio/auth session is), and the key cookie a keyed connect leaves. */
    const LOGIN = "login-" + crypto.randomUUID();
    const plantJar = async (c: Client) => {
      for (const [name, value] of [["e2e_login", LOGIN], ["aio_key_x", KEY]]) {
        const r = await cdpCall(c, "Network.setCookie", {
          url: `${base}/`,
          name,
          value,
          secure: true,
          httpOnly: true,
          expires: Math.floor(Date.now() / 1000) + 3600,
        });
        assert(
          (r as { success?: boolean } | undefined)?.success !== false,
          `the jar refused ${name}`,
        );
      }
    };
    const jarLines = () =>
      read(reqLog).split("\n").filter((l) =>
        l.includes(" cookie=") &&
        (l.includes(LOGIN) || l.split(" cookie=")[1]!.includes(KEY))
      );
    const onApp = (c: Client) =>
      until(
        "the app page in the window",
        async () => (await page(c))?.url === appUrl ? true : null,
        () => `stderr:\n${c.err()}\nserver:\n${serverOut}`,
      );
    /** Pair from the connect page, as its own form does. */
    const pair = async (c: Client, pin: string) => {
      await until(
        "the connect page",
        async () =>
          (await page(c))?.url.startsWith("data:text/html") ? true : null,
        c.err,
      );
      const info = { host: "127.0.0.1", port, tls: true, pin };
      await evalIn(
        c,
        `location.href = "aio-pair:" + encodeURIComponent(${
          JSON.stringify(JSON.stringify(info))
        }); 1`,
      );
    };
    const tokenLines = (lines: string[]) =>
      lines.filter((l) => l.includes(KEY));

    try {
      // 1 — pair by PIN: pinned, connected, and the key reached the server.
      let pin = await startServer();
      const rootA = read(join(apps, ".aio-ca", "aio-root.pem"));
      const leafPath = find(apps, "tls-cert.pem");
      assert(leafPath, `no tls-cert.pem under ${apps}\n${serverOut}`);
      const leafA = read(leafPath);
      assert(rootA && leafA.includes(rootA.trim()), "leaf file = leaf + root");
      /** A new TLS identity for the next start: the leaf, or root and leaf. */
      const forget = async (what: "leaf" | "root") => {
        await stopServer();
        if (what === "root") {
          await Deno.remove(join(apps, ".aio-ca"), { recursive: true });
        }
        await Deno.remove(leafPath);
        await Deno.remove(join(leafPath, "..", "tls-key.pem"));
        await Deno.remove(reqLog).catch(() => {});
      };
      const recents = () => {
        const f = find(join(dir, profile), "recents.json");
        return f
          ? JSON.parse(read(f) || "[]") as { cert: string; proves?: boolean }[]
          : [];
      };
      const refused = (c: Client, what: RegExp) =>
        until(
          `"${what.source}" on the connect page`,
          async () => {
            if (!(await page(c))?.url.startsWith("data:text/html")) return null;
            const text = await evalIn(
              c,
              `(document.getElementById("err") || {}).textContent || ""`,
            );
            return typeof text === "string" && what.test(text) ? text : null;
          },
          c.err,
        );
      let c = launch(mains.strict, "--connect");
      await pair(c, pin);
      await onApp(c);
      assert(tokenLines(await arrivedBefore("paired")).length > 0);
      // A connect that met its pin learns that this server can prove.
      await until(
        "the pairing marked as proving",
        () => recents()[0]?.proves === true,
        c.err,
      );
      await c.close();

      // 2 — the leaf is re-issued under the SAME root: the pin still holds.
      await forget("leaf");
      await startServer();
      assertEquals(read(join(apps, ".aio-ca", "aio-root.pem")), rootA);
      assert(read(leafPath) !== leafA, "the leaf was not re-issued");
      c = launch(mains.strict, `--server-url=${appUrl}`);
      await onApp(c);
      assert(
        !c.err().includes("has CHANGED"),
        `a leaf under the pinned root was treated as a change:\n${c.err()}`,
      );
      assert(tokenLines(await arrivedBefore("releaf")).length > 0);
      await c.close();

      // 3 — a NEW root at the paired address: strict refuses, nothing leaves.
      await forget("root");
      pin = await startServer();
      assert(read(join(apps, ".aio-ca", "aio-root.pem")) !== rootA);
      c = launch(mains.strict, `--server-url=${appUrl}`);
      await until(
        "the strict refusal",
        () => c.err().includes("REFUSED (strict pin)") ? true : null,
        c.err,
      );
      assertEquals(
        await arrivedBefore("refused"),
        [],
        "a request reached the server that took the paired address",
      );
      // …and the window is where pairing again happens, saying why.
      const shown = await refused(c, /CHANGED/);
      assertMatch(shown, /REFUSED \(strict pin\): nothing was sent/);
      assertMatch(shown, /pair again/);
      // The same window pairs again by PIN: the new root becomes the pin.
      await pair(c, pin);
      await onApp(c);
      await c.close();
      c = launch(mains.strict, `--server-url=${appUrl}`);
      await onApp(c);
      assert(!c.err().includes("has CHANGED"), c.err());
      await c.close();

      // 4 — not strict (the default), and the root is replaced again. The
      // server still holds the app's key, and is asked to prove it before
      // the key is sent: connected and re-pinned, with no prompt.
      await forget("root");
      await startServer();
      c = launch(mains.loose, `--server-url=${appUrl}`);
      await onApp(c);
      const order = await arrivedBefore("proved");
      assertMatch(order[0]!, /^POST https:\/\/[^/]+\/__aio\/pin-proof$/);
      assertEquals(tokenLines(order.slice(0, 1)), [], "asked with the key");
      assert(tokenLines(order).length > 0, "never connected");
      assertMatch(c.err(), /proved it holds this app's key/);
      assert(!c.err().includes("has CHANGED"), c.err());
      await c.close();
      // The proved certificate IS the pin now: strict agrees.
      c = launch(mains.strict, `--server-url=${appUrl}`);
      await onApp(c);
      assert(!c.err().includes("has CHANGED"), c.err());
      await c.close();

      // 4b — the root is replaced WHILE a client that is not strict has its
      // window open on the app. No connect is there to decide: the window's
      // own reconnect meets the new certificate, the server is asked to
      // prove, and the window is back, re-pinned — with no restart. (It was
      // refused, with a line in the log, until the client was restarted.)
      c = launch(mains.loose, `--server-url=${appUrl}`);
      await onApp(c);
      assert(tokenLines(await arrivedBefore("open")).length > 0);
      await forget("root");
      await startServer();
      const rootNow = read(join(apps, ".aio-ca", "aio-root.pem")).trim();
      await until(
        "the open window's own request after the proof",
        () => {
          const lines = read(reqLog).split("\n").filter(Boolean);
          const i = lines.findIndex((l) => /\/__aio\/pin-proof$/.test(l));
          return i >= 0 && lines.length > i + 1 ? true : null;
        },
        () => `stderr:\n${c.err()}\nrequests:\n${read(reqLog)}`,
      );
      assertMatch(c.err(), /proved it holds this app's key/);
      await until(
        "the new root as the pin",
        () => recents()[0]?.cert.includes(rootNow) ? true : null,
        c.err,
      );
      assertEquals((await page(c))?.url, appUrl, "the window left the app");
      await c.close();
      c = launch(mains.strict, `--server-url=${appUrl}`);
      await onApp(c);
      assert(!c.err().includes("has CHANGED"), c.err());
      await c.close();

      // 5 — root AND key replaced: what answers at the paired address does
      // not hold this app's key. Not strict: the key is never sent.
      await forget("root");
      await startServer(crypto.randomUUID().replaceAll("-", ""));
      c = launch(mains.loose, `--server-url=${appUrl}`);
      const told = await refused(c, /the key was NOT sent/);
      assertMatch(told, /pair again/);
      const got = await arrivedBefore("withheld");
      assert(got.length > 0, "it was never asked to prove");
      assertEquals(tokenLines(got), [], "the key reached it");
      await c.close();
      // Strict, the same profile: refused outright — nothing at all arrives.
      await Deno.remove(reqLog);
      c = launch(mains.strict, `--server-url=${appUrl}`);
      await until(
        "the strict refusal of the same address",
        () => c.err().includes("REFUSED (strict pin)") ? true : null,
        c.err,
      );
      assertEquals(await arrivedBefore("refused-again"), []);
      await c.close();

      // 5b — the window's cookie jar. It holds what a connect of the script
      // never sends: the key cookie a keyed connect left, and a login (an
      // /__aio/auth session lives across runs). Both are planted from the
      // connect page, before the connect. Control: the server that proves is
      // sent them …
      const bare = `${base}/`;
      const connectFromPage = async (to: string) => {
        c = launch(mains.loose, "--connect");
        await until(
          "the connect page",
          async () =>
            (await page(c))?.url.startsWith("data:text/html") ? true : null,
          c.err,
        );
        await plantJar(c);
        await evalIn(c, `location.href = ${JSON.stringify(to)}; 1`);
        await until(
          `${to} in the window`,
          async () =>
            (await page(c))?.url === to.split("?")[0] ||
              (await page(c))?.url === to
              ? true
              : null,
          () => `stderr:\n${c.err()}\nrequests:\n${read(reqLog)}`,
        );
        // The page is loaded and has asked for more (its socket): those are
        // the requests a cookie rides on.
        await until(
          "a follow-up request of the page",
          () => /\/ws\b/.test(read(reqLog)) ? true : null,
          () => `requests:\n${read(reqLog)}`,
        );
      };
      await stopServer();
      await Deno.remove(reqLog).catch(() => {});
      await startServer();
      await connectFromPage(appUrl);
      await arrivedBefore("jar-control");
      assert(
        jarLines().some((l) => l.includes(LOGIN)),
        `the planted login never reached the server (the control):\n${
          read(reqLog)
        }`,
      );
      await c.close();
      // … then the address is taken by something with a new root that serves
      // its page to anyone and cannot prove it holds the key: the key is
      // withheld from the address — and the window sends that host no
      // cookie at all, the key's or the login's.
      await forget("root");
      await startServer("");
      await connectFromPage(appUrl);
      assertEquals((await page(c))?.url, bare);
      assertMatch(c.err(), /the key was NOT sent/);
      const keyless = await arrivedBefore("keyless");
      assert(
        keyless.some((l) => l.startsWith(`GET ${bare}`)),
        `the page was never asked for:\n${keyless.join("\n")}`,
      );
      assertEquals(tokenLines(keyless), [], "the key reached it");
      assertEquals(jarLines(), [], "the jar's login reached it");
      await c.close();

      // 5c — a host with no pin (no key, never paired: a login app typed in
      // by hand). The certificate it was first seen with is kept …
      profile = "config-tofu";
      await forget("root");
      await startServer("");
      await connectFromPage(bare);
      await c.close();
      const seen = (recents()[0] as { seen?: string } | undefined)?.seen;
      assert(seen, `no certificate kept for the host:\n${c.err()}`);
      // … a leaf re-issued under the same root is that server: the login
      // goes along, nothing is said …
      await forget("leaf");
      await startServer("");
      await connectFromPage(bare);
      await arrivedBefore("tofu-releaf");
      assert(jarLines().some((l) => l.includes(LOGIN)), read(reqLog));
      assert(!c.err().includes("has CHANGED"), c.err());
      await c.close();
      // … another root is not: the host's cookies are out of the jar before
      // the page loads, and it is said.
      await forget("root");
      await startServer("");
      await connectFromPage(bare);
      await arrivedBefore("tofu-reroot");
      assertMatch(c.err(), /cookies \(a login\) were NOT sent/);
      assertEquals(jarLines(), [], "the jar's login reached a new root");
      await c.close();

      // ── not strict, and the server cannot prove (aio 1.0.19 or older) ──
      // 6 — a profile of its own, paired by PIN with such a server. The
      // connect that met its pin asks once whether the server can prove, with
      // the key it already sends there, and learns that it cannot.
      profile = "config-old";
      await forget("root");
      pin = await startServer(KEY, true);
      c = launch(mains.loose, "--connect");
      await pair(c, pin);
      await onApp(c);
      await until(
        "the one question whether this server can prove",
        () => read(reqLog).includes(`/__aio/pin-proof?token=${KEY}`),
        c.err,
      );
      await c.close();
      const paired = recents();
      assertEquals(paired.length, 1);
      assert(paired[0]!.proves !== true, "a server with no proof route proved");
      // The certificate does not change: reached, nothing said, no prompt.
      c = launch(mains.loose, `--server-url=${appUrl}`);
      await onApp(c);
      assert(tokenLines(await arrivedBefore("old-same")).length > 0);
      assert(!c.err().includes("has CHANGED"), c.err());
      await c.close();

      // 7 — its leaf is re-issued under the same root: the pin still holds.
      const rootOld = read(join(apps, ".aio-ca", "aio-root.pem"));
      await forget("leaf");
      await startServer(KEY, true);
      assertEquals(read(join(apps, ".aio-ca", "aio-root.pem")), rootOld);
      c = launch(mains.loose, `--server-url=${appUrl}`);
      await onApp(c);
      assert(tokenLines(await arrivedBefore("old-releaf")).length > 0);
      assert(!c.err().includes("has CHANGED"), c.err());
      await c.close();

      // 8 — its ROOT is replaced, and this pairing has never seen a proof:
      // exactly what 1.0.19's client did — warned about, and connected with
      // the key. Not a refusal, not the connect page, and not for one run
      // only: Chromium loads the page over the changed certificate each time.
      await forget("root");
      await startServer(KEY, true);
      assert(read(join(apps, ".aio-ca", "aio-root.pem")) !== rootOld);
      for (const run of ["old-reroot", "old-reroot-again"]) {
        // The server is still up from the run before: a request of that
        // window, received just before it closed, was logged AFTER the log
        // was removed and read as this run's first line (1 run in 2 beside a
        // busy machine, 2026-10-12). A mark of our own is logged after
        // everything received before it; then the log is cleared.
        await arrivedBefore(`drained-before-${run}`);
        await Deno.remove(reqLog).catch(() => {});
        c = launch(mains.loose, `--server-url=${appUrl}`);
        await onApp(c);
        const seen = await arrivedBefore(run);
        // Asked to prove first, WITHOUT the key; it cannot (401) …
        assertMatch(seen[0]!, /^POST https:\/\/[^/]+\/__aio\/pin-proof$/);
        // … and is reached with the key all the same.
        assert(tokenLines(seen).length > 0, `${run}: never connected`);
        assertMatch(c.err(), /has CHANGED/);
        assert(!c.err().includes("the key was NOT sent"), c.err());
        assert(!c.err().includes("REFUSED"), c.err());
        await c.close();
      }
      // The pin was not moved by an unproved connect, and nothing was learnt.
      assertEquals(recents()[0]!.cert, paired[0]!.cert);
      assert(recents()[0]!.proves !== true);
    } finally {
      for (const c of live) await c.close();
      await stopServer();
      await dropTempDir(dir);
    }
  },
});
