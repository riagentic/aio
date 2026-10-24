// peer(): an app reachable only over its local sockets (the Electron default:
// no TCP port) still takes upload/blob — over its HTTP socket, with the
// caller's proven identity; a refused first connection fails at once with the
// server's status; a closed handle refuses instead of hanging; a chunk JSON
// cannot carry is worded as a chunk. Real apps, real sockets.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { peer } from "../src/server/peer.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { chunkFrame } from "../src/server/call-stream.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { childEnv } from "./e2e-app-harness.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
let n = 0;
const counter = () =>
  cell(`psd${n++}`, {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        return ++s.n;
      },
    },
  });

Deno.test({
  name: "socket-only app: upload + blob (+ range) over its HTTP socket, proven",
  // Linux: "no desktop session" is how a test boots an Electron app without
  // a window (an empty DISPLAY) — elsewhere a window would open.
  ignore: Deno.build.os !== "linux",
  async fn() {
    const dir = await tempDir("peer-socket-door-");
    const mod = toFileUrl(join(ROOT, "mod.ts")).href;
    const srv = toFileUrl(join(ROOT, "src/server-entry.ts")).href;
    const callee = `psdcallee${Deno.pid}`;
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() { return null; }\n",
    );
    await Deno.writeTextFile(
      join(dir, "callee.ts"),
      `import { aio, cell } from "${mod}";
const c = cell("svc", { state: { n: 0 }, methods: { bump(s) { return ++s.n; } } });
await aio.run({ appId: "${callee}", cells: [c], client: "electron",
  resolvePeer: (p) => ({ id: p.app, role: "app" }) });
`,
    );
    await Deno.writeTextFile(
      join(dir, "caller.ts"),
      `import { aio, cell } from "${mod}";
import { peer } from "${srv}";
const c = cell("me", { state: { x: 0 }, methods: { getX(s) { return s.x; } } });
await aio.run({ appId: "psdcaller${Deno.pid}", cells: [c], client: "server-only" });
let p = null;
for (let i = 0; i < 200 && !p; i++) {
  p = await peer("${callee}");
  if (!p) await new Promise((r) => setTimeout(r, 100));
}
const out = {};
try {
  out.call = await p.call("svc", "bump");
  const bytes = new Uint8Array(300_000).map((_, i) => i % 251);
  const up = await p.upload(bytes, { name: "b.bin" });
  out.size = up.size;
  const back = new Uint8Array(await new Response(await p.blob(up.id)).arrayBuffer());
  out.same = back.length === bytes.length && back.every((b, i) => b === bytes[i]);
  out.range = [...new Uint8Array(await new Response(
    await p.blob(up.id, { start: 3, end: 6 })).arrayBuffer())];
} catch (e) { out.error = e.message; }
p?.close();
console.log("RESULT " + JSON.stringify(out));
Deno.exit(0);
`,
    );
    const env = {
      ...childEnv({ AIO_APPS_DIR: join(dir, "apps") }),
      DISPLAY: "",
      WAYLAND_DISPLAY: "",
    };
    const run = (file: string, stdout: "piped" | "null") =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(ROOT, "deno.json"), file],
        cwd: dir,
        env,
        stdout,
        stderr: "null",
      }).spawn();
    const app = run(join(dir, "callee.ts"), "null");
    try {
      const { stdout } = await run(join(dir, "caller.ts"), "piped").output();
      const line = new TextDecoder().decode(stdout).split("\n")
        .find((l) => l.startsWith("RESULT "));
      assert(line, "the caller printed no result");
      assertEquals(JSON.parse(line.slice(7)), {
        call: 1,
        size: 300_000,
        same: true,
        range: [3, 4, 5],
      });
    } finally {
      app.kill("SIGTERM");
      await app.status;
      await dropTempDir(dir);
    }
  },
});

Deno.test("a wrong or missing token fails at once with the server's status, not after readyTimeoutMs", async () => {
  await using srv = await testServer({
    cells: [counter()],
    users: { "good-token-123456": { id: "u1", role: "user" } },
  });
  for (const token of ["wrong-token", undefined]) {
    const t0 = Date.now();
    const e = await assertRejects(
      () => peer(srv.url, { token, readyTimeoutMs: 10_000 }),
      Error,
      "refused the connection (401)",
    );
    assert(Date.now() - t0 < 3_000, `took ${Date.now() - t0} ms`);
    // peer() closed its link: no "reconnection continues" promise.
    assert(!e.message.includes("Reconnection continues"), e.message);
  }
  using ok = (await peer(srv.url, { token: "good-token-123456" }))!;
  assert(ok.connected);
});

Deno.test("connectCli: ready rejects at once with the refusal's status", async () => {
  await using srv = await testServer({
    cells: [counter()],
    users: { "good-token-123456": { id: "u1", role: "user" } },
  });
  const c = connectCli(srv.url, { token: "nope", readyTimeoutMs: 10_000 });
  try {
    const e = await assertRejects(() => c.ready, Error, "(401)");
    assertEquals((e as Error & { status?: number }).status, 401);
  } finally {
    c.close();
  }
});

Deno.test("a call on a closed client rejects (it hung for ever in the queue); peer blob/upload after close refuse", async () => {
  const k = counter();
  await using srv = await testServer({ cells: [k] });
  const c = connectCli<Record<string, unknown>>(srv.url, {
    readyTimeoutMs: 5_000,
  });
  await c.ready;
  c.close();
  // It used to wait in a queue nothing drains again: bounded, so a
  // regression is a red test rather than a hung one.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, j) => {
    timer = setTimeout(
      () => j(new Error("HUNG: the call never settled")),
      2_000,
    );
  });
  try {
    await assertRejects(
      () =>
        Promise.race([
          (c as unknown as { call: (a: string, b: string) => Promise<unknown> })
            .call(k.__aio.id, "bump"),
          hung,
        ]),
      Error,
      "this client is closed",
    );
  } finally {
    clearTimeout(timer);
  }
  const p = (await peer(srv.url))!;
  p.close();
  await assertRejects(() => p.call(k.__aio.id, "bump"), Error, "is closed");
  await assertRejects(
    () => p.upload(new Uint8Array([1])),
    Error,
    "closed — POST /__aio/blobs was not sent",
  );
  await assertRejects(() => p.blob("a".repeat(64)), Error, "closed — GET");
});

Deno.test("a chunk JSON cannot carry is warned as a CHUNK, not a return value", () => {
  const warnings: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") warnings.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
    } as unknown as Parameters<typeof setLogger>[0],
  );
  try {
    chunkFrame("cid", 10n, "svc:big");
    chunkFrame("cid", { d: new Date(0) }, "svc:lossy");
  } finally {
    setLogger(prev);
  }
  assertEquals(warnings.length, 2, warnings.join("\n"));
  assert(warnings[0]!.includes('"svc:big" emitted a chunk'), warnings[0]);
  assert(warnings[0]!.includes("receives undefined for that chunk"));
  assert(warnings[1]!.includes('"svc:lossy" emitted a chunk'), warnings[1]);
  assert(!warnings.join("\n").includes("returned"), warnings.join("\n"));
});
