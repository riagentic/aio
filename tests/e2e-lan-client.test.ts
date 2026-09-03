// A REAL aio client, over a REAL network interface, against a self-signed cert.
//
// `e2e-remote-lan.test.ts` proves the SERVER half over a non-loopback address:
// 0.0.0.0 binding, TLS SANs covering the LAN IP, the share token, PIN pairing,
// page serving. Every assertion in it is made with `fetch`. So the client half —
// `connectCli` over `wss://`, with a self-signed certificate it has to pin, a
// token it has to present, and a bound cell whose method call has to round-trip
// — was still only ever exercised over `ws://127.0.0.1`, where TLS and hostname
// verification do not happen at all.
//
// That is the gap this closes. It runs the client in a SEPARATE PROCESS with
// `--cert`, because pinning is a property of the client's TLS store and an
// in-process client would share the test runner's.
//
// What it still does not prove: a second MACHINE. Routing, MTU, a NAT in the
// middle and a clock that disagrees are not simulated here, and this comment is
// the honest boundary of the claim.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { childEnv } from "./e2e-app-harness.ts";
import { stopChild } from "./stop-child.ts";
import { childCoverageDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const dec = new TextDecoder();
const _childCovDir = childCoverageDir();

function lanIP(): string | null {
  if (Deno.env.get("AIO_E2E") === "0") return null;
  try {
    return Deno.networkInterfaces()
      .filter((i) => i.family === "IPv4" && !i.address.startsWith("127."))
      .map((i) => i.address)[0] ?? null;
  } catch {
    return null;
  }
}

const LAN_IP = lanIP();
const APP_ID = "lan-client-probe";

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

const CELL_TS = `import { cell } from "aio";
export const makeCounter = () =>
  cell("counter", {
    state: { count: 0 },
    methods: { bump(s, n = 1) { s.count += n; } },
  });
`;

const SERVER_TS = `import { aio } from "aio";
import { makeCounter } from "./counter.ts";
await aio.run({ cells: [makeCounter()], persist: false });
`;

// The client: a real aio client process. It binds its OWN instance of the cell
// definition — which is what a client process importing the same module has.
const CLIENT_TS = `import { connectCli } from "aio/server";
import { makeCounter } from "./counter.ts";

const [url, token] = Deno.args;
const counter = makeCounter();
// A script's first connection must be REPORTABLE: without a deadline a wrong
// cert or token is a client that retries forever, a test that never returns,
// and — once the runner is killed for it — a server nobody stops.
const app = connectCli(url, { token, readyTimeoutMs: 20_000 });
app.bind(counter);
await app.ready;
await counter.bump(7);
console.log("CLIENT_SAW:" + counter.count);
app.close();
`;

Deno.test({
  name: "e2e: connectCli over wss to a LAN address, pinning the app's own cert",
  ignore: LAN_IP === null,
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "aio-lan-client-" });
    const home = join(root, "home");
    const proj = join(root, "proj");
    await Deno.mkdir(join(proj, "src"), { recursive: true });
    await Deno.mkdir(home, { recursive: true });
    await Deno.writeTextFile(
      join(proj, "deno.json"),
      JSON.stringify({
        title: APP_ID,
        version: "0.0.1",
        unstable: ["kv"],
        imports: {
          "aio": `${ROOT}mod.ts`,
          "aio/server": `${ROOT}src/server-entry.ts`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@^1",
        },
      }),
    );
    await Deno.writeTextFile(join(proj, "src", "counter.ts"), CELL_TS);
    await Deno.writeTextFile(join(proj, "src", "app.ts"), SERVER_TS);
    await Deno.writeTextFile(join(proj, "src", "client.ts"), CLIENT_TS);

    const port = freePort();
    const server = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--unstable-kv",
        "--no-lock",
        "src/app.ts",
        "--client=server-only",
        "--expose",
        `--port=${port}`,
      ],
      cwd: proj,
      env: {
        DENO_COVERAGE_DIR: _childCovDir,
        ...childEnv({ AIO_APPS_DIR: home }),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    let serverLog = "";
    const drainErr = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) serverLog += dec.decode(c);
    };
    drainErr(server.stderr).catch(() => {});

    try {
      // The share token is printed at boot — the credential a remote client
      // must present. Read it from the banner, exactly as a person would.
      const reader = server.stdout.getReader();
      let buf = "";
      let token: string | null = null;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && token === null) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const m = buf.match(/share:\s+\S+\?token=([\w-]+)/);
        if (m) token = m[1]!;
      }
      // Keep draining so the child never blocks on a full pipe.
      (async () => {
        try {
          while (!(await reader.read()).done) { /* drain */ }
        } catch { /* closed */ }
      })();
      assert(
        token,
        `no share token in boot output:\n${buf.slice(-2000)}\n${
          serverLog.slice(-2000)
        }`,
      );

      // The certificate the client must trust. On one box this is a file read;
      // a genuinely remote client gets the same bytes from `/__aio/pair` (PIN)
      // or `am profile`. What is under test is what the client DOES with it.
      const certPath = join(home, APP_ID, "data", "tls", "tls-cert.pem");
      const cert = await Deno.readTextFile(certPath);
      assert(
        cert.includes("BEGIN CERTIFICATE"),
        `no usable cert at ${certPath}`,
      );

      const client = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--no-lock",
          // Pinning, at the only layer that can enforce it: the process TLS
          // store. Without this the connection fails hostname/issuer
          // verification — which is the point of running it out-of-process.
          `--cert=${certPath}`,
          "src/client.ts",
          `wss://${LAN_IP}:${port}/ws`,
          token,
        ],
        cwd: proj,
        env: { DENO_COVERAGE_DIR: _childCovDir, ...childEnv() },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        // The test's OWN bound, so a hung client fails THIS test instead of
        // hanging the runner until an outer `timeout` kills it.
        signal: AbortSignal.timeout(60_000),
      }).output();

      const out = dec.decode(client.stdout);
      const err = dec.decode(client.stderr);
      assertEquals(
        client.code,
        0,
        `the client failed over wss://${LAN_IP}:${port}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
      );
      // The round trip: bound method → server → broadcast → this client's read.
      assert(
        out.includes("CLIENT_SAW:7"),
        `client did not observe its own write over TLS: ${out}\n${err}`,
      );
    } finally {
      await stopChild(server, { quiet: true });
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});
