// `am state --prod` — the read-only production probe (GET /__aio/view).
//
// A production build has no trojan, so a smoke test of a shipped app could
// only check `am health` and its logs. The view answers what a WebSocket with
// the SAME credential receives (`getUIState(user)`: the `visible` projection
// and the `forUser` pass) and nothing else — so it can never hand out more
// than that socket already gets, and it is gated by the same credential:
// nothing on a loopback app without auth, the shared key on an exposed one,
// that user's token on a per-user app.
//
// Real `aio.run` children booted `--prod` — the gates under test live in the
// listener, not in a helper a unit test could call.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { viewDiagnosis } from "../src/am/am-http.ts";
import { appKeyPath } from "../src/server/app-key.ts";
import { spec } from "./module-spec-helper.ts";
import { createServer } from "../src/server/server.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const ALICE = "alice-" + crypto.randomUUID().replaceAll("-", "");
const BOB = "bob-" + crypto.randomUUID().replaceAll("-", "");
const CAROL = "carol-" + crypto.randomUUID().replaceAll("-", "");

const CELL = `
type Item = { name: string; done: boolean; owner: string };
const vault = cell("vault", {
  state: {
    items: [
      { name: "a", done: false, owner: "alice" },
      { name: "b", done: true, owner: "bob" },
      { name: "c", done: true, owner: "alice" },
    ] as Item[],
    secret: "s3cr3t",
  },
  methods: { touch(s: { secret: string }) { s.secret += "!"; } },
  visible: {
    exclude: ["secret"],
    forUser: (v: { items: Item[] }, u?: { id: string }) => {
      if (u?.id === "carol") throw new Error("filter broke near " + v.items[1].name + "-leaked-row");
      return u ? { ...v, items: v.items.filter((i) => i.owner === u.id) } : v;
    },
  },
});`;

type Booted = {
  dir: string;
  appId: string;
  port: number;
  control: number;
  env: Record<string, string>;
  out: () => string;
  stop: () => Promise<void>;
};

async function boot(
  name: string,
  runOpts: string,
  args: string[] = [],
): Promise<Booted> {
  const dir = await tempDir(`aio-prod-view-${name}-`);
  const appId = `prod-view-${name}`;
  const port = freePort();
  await Deno.writeTextFile(
    join(dir, "app.ts"),
    `import { aio, cell } from "${spec(REPO)}/mod.ts";
${CELL}
await aio.run({ cells: [vault], appId: ${JSON.stringify(appId)},
  client: "server-only", persist: false,
  appDir: ${JSON.stringify(join(dir, "home"))}, ${runOpts} });
await new Promise(() => {});
`,
  );
  const env = { AIO_APPS_DIR: join(dir, "apps") };
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      join(REPO, "deno.json"),
      join(dir, "app.ts"),
      "--prod",
      `--port=${port}`,
      ...args,
    ],
    cwd: dir,
    env: { ...Deno.env.toObject(), ...env },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let out = "";
  const drain = (s: ReadableStream<Uint8Array>) =>
    s.pipeTo(
      new WritableStream({
        write: (c) => {
          out += new TextDecoder().decode(c);
        },
      }),
    ).catch(() => {});
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  // deno-lint-ignore no-control-regex
  const plain = () => out.replace(/\x1b\[[0-9;]*m/g, "");
  const stop = async () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
    await child.status;
    await drained;
    await dropTempDir(dir);
  };
  const deadline = Date.now() + 90_000;
  while (!/^.*\bpid\s+\d+/m.test(plain())) {
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`app never booted:\n${plain()}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const ctl = /\bcontrol\s+http:\/\/localhost:(\d+)/m.exec(plain())?.[1];
  return {
    dir,
    appId,
    port,
    control: ctl ? Number(ctl) : port,
    env,
    out: plain,
    stop,
  };
}

/** `am state --prod <path>` as a real CLI run, against the booted app. */
async function amState(
  b: Booted,
  path: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      join(REPO, "deno.json"),
      join(REPO, "src", "am.ts"),
      "state",
      "--prod",
      path,
      `--app=${b.appId}`,
      `--port=${b.port}`,
      "--json",
    ],
    cwd: b.dir,
    env: { ...Deno.env.toObject(), ...b.env, ...extraEnv },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  // `--json` reports a refusal on stdout; either stream carries the text.
  const said = d.decode(r.stdout) + d.decode(r.stderr);
  return { code: r.code, stdout: d.decode(r.stdout), stderr: said };
}

const get = async (url: string, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { headers });
  return { status: r.status, body: await r.text() };
};

/** The first full-state frame a WebSocket with this token receives. */
async function wsView(port: number, token: string): Promise<unknown> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no state frame")), 10_000);
      ws.onerror = () => reject(new Error("ws error"));
      ws.onmessage = (e) => {
        try {
          const f = JSON.parse(String(e.data));
          if (f?.t === "state") {
            clearTimeout(t);
            resolve(f.d);
          }
        } catch { /* a non-JSON frame (proto hello) — keep reading */ }
      };
    });
  } finally {
    ws.close();
  }
}

Deno.test({
  name: "prod view: a loopback app without auth answers the client view only",
  sanitizeOps: false, // aio-ok: child process, stopped in finally
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const b = await boot("open", "");
    try {
      const base = `http://127.0.0.1:${b.port}`;
      // The trojan stays dev-only.
      assertEquals((await get(`${base}/__aio/trojan/state`)).status, 404);
      const v = await get(`${base}/__aio/view`);
      assertEquals(v.status, 200, v.body);
      const view = JSON.parse(v.body);
      assertEquals(view.vault.items.length, 3);
      assert(!("secret" in view.vault), "an excluded field leaked: " + v.body);
      // Read-only: no write verb exists on it.
      const post = await fetch(`${base}/__aio/view`, {
        method: "POST",
        headers: { "X-AIO": "1" },
      });
      await post.body?.cancel();
      assertEquals(post.status, 405);
      // A foreign page is refused exactly as its WebSocket would be.
      const foreign = await get(`${base}/__aio/view`, {
        Origin: "http://evil.example",
      });
      assertEquals(foreign.status, 403, foreign.body);
      assertStringIncludes(foreign.body, "allowedOrigins");
      // The CLI, through the [?k] filter.
      const am = await amState(b, "vault.items[?done].name");
      assertEquals(am.code, 0, am.stderr);
      assertEquals(JSON.parse(am.stdout), ["b", "c"]);
      const miss = await amState(b, "vault.secret");
      assertEquals(miss.code, 1);
      assertStringIncludes(miss.stderr, "not found in the client view");
    } finally {
      await b.stop();
    }
  },
});

Deno.test({
  name: "prod view: an --expose app requires its shared key",
  sanitizeOps: false, // aio-ok: child process, stopped in finally
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const b = await boot("keyed", `tls: false`, ["--expose"]);
    try {
      const base = `http://127.0.0.1:${b.port}`;
      const none = await get(`${base}/__aio/view`);
      assertEquals(none.status, 401, none.body);
      const wrong = await get(`${base}/__aio/view`, {
        Authorization: "Bearer not-the-key",
      });
      assertEquals(wrong.status, 401);
      const key = (await Deno.readTextFile(
        appKeyPath(b.appId, join(b.dir, "home")),
      )).trim();
      const ok = await get(`${base}/__aio/view`, {
        Authorization: `Bearer ${key}`,
      });
      assertEquals(ok.status, 200, ok.body);
      assert(!ok.body.includes("s3cr3t"), ok.body);
      // am finds the key in the app's data dir, as the aio client is given it.
      const am = await amState(b, "vault.items.length");
      assertEquals(am.code, 0, am.stderr);
      assertEquals(JSON.parse(am.stdout), 3);
    } finally {
      await b.stop();
    }
  },
});

const USERS = `users: {
  ${JSON.stringify(ALICE)}: { id: "alice", role: "user" },
  ${JSON.stringify(BOB)}: { id: "bob", role: "user" },
  ${JSON.stringify(CAROL)}: { id: "carol", role: "user" },
}`;

Deno.test({
  name:
    "prod view: a per-user app answers each user exactly their socket's view",
  sanitizeOps: false, // aio-ok: child process, stopped in finally
  sanitizeResources: false, // aio-ok: same
  async fn() {
    // `auth: true` too: its public shell must not make the view anonymous.
    const b = await boot("users", `${USERS}, auth: true`);
    try {
      const base = `http://127.0.0.1:${b.port}`;
      const anon = await get(`${base}/__aio/view`);
      assertEquals(anon.status, 401, anon.body);
      const bob = await get(`${base}/__aio/view`, {
        Authorization: `Bearer ${BOB}`,
      });
      assertEquals(bob.status, 200, bob.body);
      assertEquals(
        JSON.parse(bob.body),
        await wsView(b.port, BOB),
        "the view must equal that user's WebSocket view",
      );
      assertEquals(
        JSON.parse(bob.body).vault.items.map((i: { name: string }) => i.name),
        ["b"],
      );
      const am = await amState(b, "vault.items[*].name", { AIO_TOKEN: ALICE });
      assertEquals(am.code, 0, am.stderr);
      assertEquals(JSON.parse(am.stdout), ["a", "c"]);
      // No token: refused, with both credentials that would pass named.
      const noTok = await amState(b, "vault");
      assertEquals(noTok.code, 1);
      assertStringIncludes(noTok.stderr, "AIO_TOKEN=");
      // A throwing forUser fails CLOSED: carol gets no vault, never all of it.
      const carol = await get(`${base}/__aio/view`, {
        Authorization: `Bearer ${CAROL}`,
      });
      assertEquals(carol.status, 200, carol.body);
      assert(!("vault" in JSON.parse(carol.body)), carol.body);
      const badTok = await amState(b, "vault", { AIO_TOKEN: "nobody-at-all" });
      assertEquals(badTok.code, 1);
      assertStringIncludes(badTok.stderr, "AIO_TOKEN was refused");
    } finally {
      await b.stop();
    }
  },
});

Deno.test({
  name:
    "prod view: a TLS app's control listener applies the same per-user view",
  sanitizeOps: false, // aio-ok: child process, stopped in finally
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const b = await boot("tls", USERS, ["--expose", "--host=0.0.0.0"]);
    try {
      assert(b.control !== b.port, `no control listener:\n${b.out()}`);
      const base = `http://127.0.0.1:${b.control}`;
      assertEquals((await get(`${base}/__aio/view`)).status, 401);
      const bob = await get(`${base}/__aio/view`, {
        Authorization: `Bearer ${BOB}`,
      });
      assertEquals(bob.status, 200, bob.body);
      assertEquals(
        JSON.parse(bob.body).vault.items.map((i: { name: string }) => i.name),
        ["b"],
      );
      // am reaches it through the lock's control port.
      const am = await amState(b, "vault.items[*].owner", { AIO_TOKEN: ALICE });
      assertEquals(am.code, 0, am.stderr);
      assertEquals(JSON.parse(am.stdout), ["alice", "alice"]);
    } finally {
      await b.stop();
    }
  },
});

Deno.test("prod view: every refusal names its fix", () => {
  assertStringIncludes(
    viewDiagnosis(401, "Unauthorized", { userToken: false, appId: "x" }),
    "AIO_TOKEN=<that user's token>",
  );
  assertStringIncludes(
    viewDiagnosis(401, "Unauthorized", { userToken: false, keyPath: "/k" }),
    "/k",
  );
  assertStringIncludes(
    viewDiagnosis(404, '{"error":"Not Found — local-peer lockdown: …"}', {
      userToken: false,
    }),
    "am state --offline",
  );
  assertStringIncludes(
    viewDiagnosis(404, "Not Found", { userToken: false }),
    "older than this am",
  );
});

Deno.test({
  name:
    "prod view: an exposed app with no credential (key: false) answers its own machine only",
  sanitizeOps: false, // aio-ok: child process, stopped in finally
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const b = await boot("public", `key: false, tls: false`, ["--expose"]);
    try {
      const url = `http://127.0.0.1:${b.port}/__aio/view`;
      assertEquals((await get(url)).status, 200);
      // A relayed request is not a same-machine one (`_isLocalRequest`).
      const remote = await get(url, { "X-Forwarded-For": "203.0.113.9" });
      assertEquals(remote.status, 403, remote.body);
      assertStringIncludes(remote.body, "key: true");
    } finally {
      await b.stop();
    }
  },
});

Deno.test("prod view: a view that cannot be built answers a fixed 500 — the cause stays in the log", async () => {
  const dir = await tempDir("aio-prod-view-500-");
  const port = freePort();
  const server = createServer({
    port,
    title: "ViewFails",
    getUIState: () => {
      throw new Error("row b-leaked-row is malformed");
    },
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  try {
    const r = await get(`http://127.0.0.1:${port}/__aio/view`);
    assertEquals(r.status, 500);
    // The exception may quote app data, and the caller may be remote.
    assert(!r.body.includes("leaked-row"), r.body);
    assertStringIncludes(r.body, "see the app log");
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
  assertStringIncludes(
    viewDiagnosis(500, "{}", { userToken: false }),
    "am logs",
  );
});
