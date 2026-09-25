// `am --port=<a profile instance's port>` (and amui, which addresses every row
// by port + pid) reached the right INSTANCE since round 4 — and then presented
// the DEFAULT instance's credentials to it. `localCreds` read `control.key` and
// `app.key` from `appDirs(appId)`, the default home, while a `--profile=dev`
// instance mints both under `~/.<appId>-dev/data`. So a profile instance of an
// `auth: true` or keyed app answered every `am state --port=…`, dispatch and
// amui State tab with a 401 — or, with the default instance up too, with a
// credential that belonged to its sibling.
//
// The credentials now come from the home of the instance being addressed (its
// lock's `home`).
//
// No real app: the "instances" are tiny servers holding hand-written locks,
// each recording the credentials it was shown — which is exactly the fact
// under test.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { httpGet, trojanGet, trojanPost } from "../src/am/am-http.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { _resetHomePin } from "../src/am/am-utils.ts";
import {
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { appHome, profileHome } from "../src/server/app-dirs.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

function writeSecret(home: string, file: string, value: string): void {
  const data = join(home, "data");
  Deno.mkdirSync(data, { recursive: true, mode: 0o700 });
  Deno.chmodSync(home, 0o700);
  Deno.chmodSync(data, 0o700);
  Deno.writeTextFileSync(join(data, file), value + "\n", { mode: 0o600 });
}

/** The fake's gate: `/__aio/health` is gated (401 without the right bearer),
 *  the trojan also wants the right control key. */
function answer(
  appId: string,
  want: { control: string; key: string },
  path: string,
  control: string | null,
  auth: string | null,
): { status: number; body: string } {
  if (auth !== `Bearer ${want.key}`) {
    return { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }
  if (path === "/__aio/health") {
    return { status: 200, body: JSON.stringify({ appId, ok: true }) };
  }
  if (control !== want.control) {
    return { status: 401, body: JSON.stringify({ error: "no control" }) };
  }
  return { status: 200, body: JSON.stringify({ ok: true }) };
}

type Seen = { control: string | null; auth: string | null }[];

/** A fake TCP instance. Records what it was shown. */
function fakeTcp(
  appId: string,
  want: { control: string; key: string },
  port: number,
) {
  const seen: Seen = [];
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen() {} },
    (req) => {
      const control = req.headers.get("X-Aio-Control");
      const auth = req.headers.get("Authorization");
      seen.push({ control, auth });
      const a = answer(appId, want, new URL(req.url).pathname, control, auth);
      return new Response(a.body, { status: a.status });
    },
  );
  return { seen, close: () => server.shutdown() };
}

/** A fake UDS instance speaking the control frames (`ctl` in, `ctlr` out). */
function fakeUds(
  appId: string,
  want: { control: string; key: string },
  path: string,
) {
  const seen: Seen = [];
  const listener = Deno.listen({ transport: "unix", path });
  const serve = async (conn: Deno.UnixConn) => {
    const reader = conn.readable.getReader();
    const td = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += td.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const f = dec(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (f?.t !== "ctl") continue;
          const d = f.d as {
            id: string;
            path: string;
            headers: Record<string, string>;
          };
          const control = d.headers["X-Aio-Control"] ?? null;
          const auth = d.headers["Authorization"] ?? null;
          seen.push({ control, auth });
          const a = answer(appId, want, d.path, control, auth);
          await conn.write(
            new TextEncoder().encode(enc("ctlr", { id: d.id, ...a }) + "\n"),
          );
        }
      }
    } catch {
      /* aio-ok: the client hung up — this fake has nothing to report */
    }
  };
  const loop = (async () => {
    try {
      for await (const c of listener) serve(c as Deno.UnixConn);
    } catch { /* aio-ok: listener closed at teardown */ }
  })();
  return {
    seen,
    close: async () => {
      listener.close();
      await loop;
    },
  };
}

async function sandbox(
  fn: (s: { appId: string; dflt: string; dev: string; dir: string }) => Promise<
    void
  >,
): Promise<void> {
  const dir = await tempDir("aio-am-creds-home-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  const appId = `ch-${crypto.randomUUID().slice(0, 8)}`;
  const dflt = appHome(appId);
  const dev = profileHome(appId, "dev");
  writeSecret(dflt, "control.key", "default-control");
  writeSecret(dflt, "app.key", "default-key");
  writeSecret(dev, "control.key", "dev-control");
  writeSecret(dev, "app.key", "dev-key");
  _resetInstanceVerify();
  try {
    await fn({ appId, dflt, dev, dir });
  } finally {
    removeLock(lockKey(appId, dflt));
    removeLock(lockKey(appId, dev, "dev"));
    _resetHomePin();
    _resetInstanceVerify();
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(dir);
  }
}

Deno.test("am --port: a profile instance is shown ITS OWN control key and app key, over TCP", async () => {
  await sandbox(async ({ appId, dflt, dev }) => {
    const port = freePort();
    const inst = fakeTcp(appId, {
      control: "dev-control",
      key: "dev-key",
    }, port);
    const base = {
      appId,
      pid: Deno.pid,
      startedAt: Date.now(),
      status: "started" as const,
      cwd: dev,
    };
    // The default instance is up too, on another port — its keys are the
    // wrong ones for the port typed.
    writeLock({ ...base, port: freePort(), home: dflt });
    writeLock({ ...base, port, home: dev, profile: "dev" });
    try {
      const r = await trojanGet(port, "state", appId);
      assertEquals(r.ok, true, `trojanGet: ${JSON.stringify(r)}`);
      const h = await httpGet(port, "/__aio/health", appId);
      assertEquals(h.ok, true, `httpGet: ${JSON.stringify(h)}`);
      assert(inst.seen.length > 0);
      for (const s of inst.seen) {
        assert(s.control !== "default-control", "sibling's control key shown");
        assert(s.auth !== "Bearer default-key", "sibling's app key shown");
      }
    } finally {
      await inst.close();
    }
  });
});

Deno.test("amui by pid: a zero-port profile instance is shown ITS OWN keys over its socket", async () => {
  if (Deno.build.os === "windows") return; // UDS server needs a POSIX socket
  await sandbox(async ({ appId, dflt, dev, dir }) => {
    const sock = join(dir, "dev.sock");
    const inst = fakeUds(appId, {
      control: "dev-control",
      key: "dev-key",
    }, sock);
    const child = new Deno.Command("sleep", {
      args: ["120"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const base = {
      appId,
      port: 0,
      startedAt: Date.now(),
      status: "started" as const,
      cwd: dev,
    };
    writeLock({
      ...base,
      pid: Deno.pid,
      home: dflt,
      socketPath: join(dir, "d.sock"),
    });
    writeLock({
      ...base,
      pid: child.pid,
      home: dev,
      profile: "dev",
      socketPath: sock,
    });
    try {
      const r = await trojanPost(
        0,
        "dispatch",
        { x: 1 },
        appId,
        undefined,
        child.pid,
      );
      assertEquals(r.ok, true, `trojanPost: ${JSON.stringify(r)}`);
      assertEquals(inst.seen.at(-1)?.control, "dev-control");
      assertEquals(inst.seen.at(-1)?.auth, "Bearer dev-key");
    } finally {
      await inst.close();
      child.kill("SIGKILL");
      await child.status;
    }
  });
});
