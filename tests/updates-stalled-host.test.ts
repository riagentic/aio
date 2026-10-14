// A release host that accepts the connection and then goes silent.
//
// `fetch` has no timeout of its own, so the manifest check and the artifact
// download used to await it FOREVER: the updates cell sat on "checking" (or
// "downloading", which also refuses every later check), and the poll — which
// re-arms only after a check returns — never ran again for the process's life.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  downloadArtifact,
  fetchManifest,
  gitLsRemote,
} from "../src/server/updates-check.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";
import { EXE, writeProgram } from "./fake-program-helper.ts";
import { _exitKillSaid } from "../src/server/updates-check.ts";
import { freePort } from "../src/testing/server-test.ts";
import {
  askToStop,
  descendantsIn,
  processList,
  processParents,
} from "./proc-helper.ts";

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

/** Every live descendant of `root`. */
const descendants = async (root = Deno.pid) =>
  descendantsIn(await processParents(), root);

/** Which of `pids` are still running. */
async function running(pids: number[]): Promise<number[]> {
  const live = await processParents();
  return pids.filter((p) => live.has(p));
}

const WIN = Deno.build.os === "windows";

Deno.test({
  name: "updates: a timed-out git ls-remote leaves no process behind",
  async fn() {
    await using host = silentHost();
    const before = new Set(await descendants());
    // Windows has no /proc: one look at its process table takes seconds, and
    // git must still be running when it is taken.
    const pending = gitLsRemote(
      `${host.url}/repo.git`,
      "main",
      WIN ? 12_000 : 1500,
    );
    // git's transport helper (and git, its parent) is up once the silent host
    // has a connection.
    await host.connected;
    const spawned = (await descendants()).filter((p) => !before.has(p));
    // The instrument: git AND its transport helper were both seen.
    assert(spawned.length >= 2, `saw only ${spawned.length} process(es)`);
    const r = await pending;
    assert(!r.ok);
    const t0 = Date.now();
    let left = await running(spawned);
    while (left.length > 0 && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
      left = await running(spawned);
    }
    assert(left.length === 0, `still running: ${left.join(", ")}`);
  },
});

Deno.test({
  // git runs in a process group of its own (for the deadline), so the
  // terminal's Ctrl-C no longer reaches it: an app stopped during its boot
  // check against a stalled host left git + its transport helper behind.
  name: "updates: SIGINT during a stalled boot ls-remote leaves no git behind",
  async fn() {
    await using host = silentHost();
    const dir = await tempDir("aio-upd-sigint-");
    const port = freePort();
    const root = fromFileUrl(new URL("..", import.meta.url));
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio } from "${spec(root)}mod.ts";
await aio.run({
  appId: "upd-sigint",
  client: "server-only",
  port: ${port},
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
      const cmd = new Map((await processList()).map((p) => [p.pid, p.cmd]));
      seen = (await descendants(app.pid)).filter((p) =>
        /\bgit\b/.test(cmd.get(p) ?? "")
      );
      assert(seen.length >= 2, `saw only ${seen.length} git process(es)`);
      if (WIN) {
        // No signal can be sent there: the stop is the one `am stop` makes,
        // and it ends in the same exit path (`unload`).
        await askToStop(
          app.pid,
          port,
          join(dir, "apps", "upd-sigint", "data", "control.key"),
        );
      } else app.kill("SIGINT");
      await app.status;
      // The group kill was SENT before the app exited; this only waits for the
      // kernel to finish it — a hang guard, not a readiness budget.
      const t0 = Date.now();
      let left = await running(seen);
      while (left.length > 0 && Date.now() - t0 < 10_000) {
        await new Promise((r) => setTimeout(r, 50));
        left = await running(seen);
      }
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
    // A program every OS can run (a real executable on Windows): were it a
    // `.sh` there, "never ran" would hold whatever git was told.
    const askpass = join(dir, `askpass${EXE}`);
    await writeProgram(askpass, `#!/bin/sh\ntouch "${marker}"\necho x\n`);
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

Deno.test("updates: the exit path's taskkill — ended and already-gone are silent, anything else is said with the pids", () => {
  assertEquals(_exitKillSaid([41, 42], 0, ""), null);
  // 128 is taskkill's "not found": the check ended as the app was leaving.
  assertEquals(
    _exitKillSaid([41], 128, 'ERROR: The process "41" not found.'),
    null,
  );
  const denied = _exitKillSaid([41, 42], 1, "ERROR: Access is denied.\r\n");
  for (
    const part of ["pid 41, 42", "taskkill exited 1", "Access is denied."]
  ) assert(denied?.includes(part), denied ?? "nothing said");
  const absent = _exitKillSaid([41], null, "NotFound: program not found");
  assert(absent?.includes("taskkill did not run"), absent ?? "nothing said");
  assert(_exitKillSaid([41], 5, "  ")?.includes("it said nothing"));
});
