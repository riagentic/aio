// A release host that accepts the connection and then goes silent.
//
// `fetch` has no timeout of its own, so the manifest check and the artifact
// download used to await it FOREVER: the updates cell sat on "checking" (or
// "downloading", which also refuses every later check), and the poll — which
// re-arms only after a check returns — never ran again for the process's life.
import { assert, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  downloadArtifact,
  fetchManifest,
  gitLsRemote,
} from "../src/server/updates-check.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

/** Accepts TCP, reads nothing, answers nothing — until closed. */
function silentHost() {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns: Deno.Conn[] = [];
  const { promise: connected, resolve } = Promise.withResolvers<void>();
  const loop = (async () => {
    try {
      for await (const c of l) conns.push(c), resolve();
    } catch { /* aio-ok: listener closed by the test */ }
  })();
  return {
    url: `http://127.0.0.1:${(l.addr as Deno.NetAddr).port}`,
    /** Resolves when a client — git's transport helper — has connected. */
    connected,
    async [Symbol.asyncDispose]() {
      l.close();
      for (const c of conns) c.close();
      await loop;
    },
  };
}

Deno.test("updates: a manifest host that never answers is an error, not a hang", async () => {
  await using host = silentHost();
  const url = `${host.url}/stable/manifest.json`;
  const r = await fetchManifest(url, undefined, { timeoutMs: 300 });
  assert(r.kind === "error", `expected an error, got ${r.kind}`);
  assertMatch(r.error, /did not answer within 0\.3s/);
  assert(r.error.startsWith(url), r.error);
});

Deno.test("updates: a git remote that never answers is an error, not a hang", async () => {
  await using host = silentHost();
  const t0 = Date.now();
  const r = await gitLsRemote(`${host.url}/repo.git`, "main", 500);
  assert(!r.ok, "a silent remote must not resolve a head");
  assertMatch(r.error, /did not answer within 0\.5s/);
  assert(Date.now() - t0 < 10_000, `took ${Date.now() - t0}ms`);
});

/** Every live descendant of `root` (Linux `/proc`). */
function descendants(root = Deno.pid): number[] {
  const kids = new Map<number, number[]>();
  for (const e of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(e.name)) continue;
    try {
      const stat = Deno.readTextFileSync(`/proc/${e.name}/stat`);
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(e.name)]);
    } catch { /* aio-ok: the process exited mid-scan */ }
  }
  const out: number[] = [];
  const walk = (p: number) =>
    (kids.get(p) ?? []).forEach((c) => (out.push(c), walk(c)));
  walk(root);
  return out;
}

function alive(pid: number): boolean {
  try {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false; // aio-ok: gone
  }
}

Deno.test({
  name: "updates: a timed-out git ls-remote leaves no process behind",
  ignore: Deno.build.os !== "linux", // descendants are read from /proc
  async fn() {
    await using host = silentHost();
    const before = new Set(descendants());
    const pending = gitLsRemote(`${host.url}/repo.git`, "main", 1500);
    await new Promise((r) => setTimeout(r, 1000));
    const spawned = descendants().filter((p) => !before.has(p));
    // The instrument: git AND its transport helper were both seen.
    assert(spawned.length >= 2, `saw only ${spawned.length} process(es)`);
    const r = await pending;
    assert(!r.ok);
    const t0 = Date.now();
    while (spawned.some(alive) && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const left = spawned.filter(alive);
    assert(left.length === 0, `still running: ${left.join(", ")}`);
  },
});

Deno.test({
  // git runs in a process group of its own (for the deadline), so the
  // terminal's Ctrl-C no longer reaches it: an app stopped during its boot
  // check against a stalled host left git + its transport helper behind.
  name: "updates: SIGINT during a stalled boot ls-remote leaves no git behind",
  ignore: Deno.build.os !== "linux", // descendants are read from /proc
  async fn() {
    await using host = silentHost();
    const dir = await tempDir("aio-upd-sigint-");
    const root = fromFileUrl(new URL("..", import.meta.url));
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio } from "${spec(root)}mod.ts";
await aio.run({
  appId: "upd-sigint",
  client: "server-only",
  updates: { source: "${host.url}/repo.git", kind: "git", channel: "main" },
});
`,
    );
    const app = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "-c", `${root}deno.json`, join(dir, "app.ts")],
      cwd: dir,
      env: { AIO_APPS_DIR: join(dir, "apps"), HOME: dir, NO_COLOR: "1" },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    let seen: number[] = [];
    try {
      // Readiness is an EVENT, not a time budget: once the silent host has a
      // connection, git-remote-http (and git, its parent) are up and waiting
      // on it — however long the app took to boot under load. An app that
      // exits first fails here instead of waiting forever — and so does one
      // that does neither (a boot wedged before its check), at a bound far
      // past any loaded boot (~25 s).
      let bound: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        host.connected.then(() => "connected" as const),
        app.status.then(() => "exited" as const),
        new Promise<"stuck">((r) => bound = setTimeout(r, 120_000, "stuck")),
      ]).finally(() => clearTimeout(bound));
      assert(
        outcome === "connected",
        outcome === "exited"
          ? "the app exited before its boot check reached git"
          : "the app neither reached git nor exited within 120 s of starting",
      );
      // git AND git-remote-http, both waiting on the silent host.
      seen = descendants(app.pid).filter((p) => {
        try {
          return /\bgit\b/.test(Deno.readTextFileSync(`/proc/${p}/cmdline`));
        } catch {
          return false; // aio-ok: exited mid-scan
        }
      });
      assert(seen.length >= 2, `saw only ${seen.length} git process(es)`);
      app.kill("SIGINT");
      await app.status;
      // The group kill was SENT before the app exited; this only waits for the
      // kernel to finish it — a hang guard, not a readiness budget.
      const t0 = Date.now();
      while (seen.some(alive) && Date.now() - t0 < 10_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const left = seen.filter(alive);
      assert(left.length === 0, `still running: ${left.join(", ")}`);
    } finally {
      for (const p of [app.pid, ...seen]) {
        try {
          Deno.kill(p, "SIGKILL");
        } catch { /* aio-ok: already gone */ }
      }
      await app.status;
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "updates: an auth challenge on a poll never runs an askpass program",
  async fn() {
    const dir = await tempDir("aio-upd-askpass-");
    const marker = join(dir, "asked");
    const askpass = join(dir, "askpass.sh");
    await Deno.writeTextFile(askpass, `#!/bin/sh\ntouch "${marker}"\necho x\n`);
    await Deno.chmod(askpass, 0o755);
    const ac = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} },
      () =>
        new Response("no", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="r"' },
        }),
    );
    const prev = Deno.env.get("GIT_ASKPASS");
    Deno.env.set("GIT_ASKPASS", askpass);
    try {
      const r = await gitLsRemote(
        `http://127.0.0.1:${server.addr.port}/repo.git`,
        "main",
        10_000,
      );
      assert(!r.ok);
      let asked = true;
      try {
        await Deno.stat(marker);
      } catch {
        asked = false; // aio-ok: the marker's absence IS the pass
      }
      assert(!asked, "git ran GIT_ASKPASS — a GUI prompt on every poll");
    } finally {
      if (prev === undefined) Deno.env.delete("GIT_ASKPASS");
      else Deno.env.set("GIT_ASKPASS", prev);
      ac.abort();
      await server.finished;
      await dropTempDir(dir);
    }
  },
});

Deno.test("updates: a manifest body that stalls after the headers is cut off", async () => {
  const ac = new AbortController();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} },
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("{"));
          }, // …and never another byte
        }),
      ),
  );
  try {
    const r = await fetchManifest(
      `http://127.0.0.1:${server.addr.port}/m.json`,
      undefined,
      { timeoutMs: 300 },
    );
    assert(r.kind === "error", `expected an error, got ${r.kind}`);
    assertMatch(r.error, /did not answer within/);
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test("updates: an artifact download that stalls is aborted and cleaned up", async () => {
  const dir = await tempDir("aio-upd-stall-");
  const ac = new AbortController();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} },
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(10)); // 10 of the promised 100
          },
        }),
      ),
  );
  try {
    const r = await downloadArtifact({
      url: `http://127.0.0.1:${server.addr.port}/app`,
      dest: join(dir, "app"),
      expectSha256: "0".repeat(64),
      expectSize: 100,
      stallMs: 300,
    });
    assert(!r.ok, "a stalled download must not succeed");
    assertMatch(r.error, /sent nothing for 0\.3s/);
    // The 0700 staging dir is gone — nothing half-written is left behind.
    const left = [...Deno.readDirSync(dir)].map((e) => e.name);
    assert(left.length === 0, `left behind: ${left.join(", ")}`);
  } finally {
    ac.abort();
    await server.finished;
    await dropTempDir(dir);
  }
});
