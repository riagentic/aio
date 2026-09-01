// Instance identity is appId AND data home (a field report, §2.1, §6).
//
// The lock was keyed by appId alone, so a deliberate second boot from an
// isolated home was refused — and the refusal printed the USER's port and pid,
// which a harness then killed. Now: a different home is a different lock
// (`<appId>@<hash8(home)>.lock`), the socket follows the lock, `am --home`
// reads that lock, `am instances` lists both with their home, `am dispatch`
// returns the method's value, and `am`'s transport timeout is strictly longer
// than the server's client-reply wait so the server's named reason surfaces.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  AppLock,
  hash8,
  instances,
  lockDir,
  lockKey,
  lockPath,
  parseLockKey,
  processStartToken,
  readLock,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { _resetAppDirs, appHome } from "../src/server/app-dirs.ts";
import { resolveSocketPath } from "../src/server/paths.ts";
import { acquireSingletonLock } from "../src/server/aio-run-helpers.ts";
import { registerRuntime } from "../src/server/shutdown.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import { amLockKey, readPid, targetHome } from "../src/am/am-utils.ts";
import { clientTimeout, FETCH_TIMEOUT, trojanPost } from "../src/am/am-http.ts";
import {
  CLIENT_REPLY_TIMEOUT_MS,
  clientReplyTimeoutError,
} from "../src/server/uds.ts";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";

const uid = () => crypto.randomUUID().slice(0, 8);

Deno.test("lockKey: default home is the plain appId, any other home is tagged", () => {
  const id = `home-key-${uid()}`;
  assertEquals(lockKey(id), id);
  assertEquals(lockKey(id, appHome(id)), id);
  assertEquals(lockKey(id, appHome(id) + "/"), id, "resolve() normalises");
  const other = `/tmp/aio-home-${uid()}`;
  const key = lockKey(id, other);
  assertEquals(key, `${id}@${hash8(resolve(other))}`);
  assertEquals(parseLockKey(key), { appId: id, tag: hash8(resolve(other)) });
  assertEquals(parseLockKey(id), { appId: id });
  assert(/^[0-9a-f]{8}$/.test(hash8(other)));
});

Deno.test({
  name:
    "same appId, two homes: both locks acquire; same home refuses with ITS OWN coordinates",
  async fn() {
    const id = `two-homes-${uid()}`;
    const homeA = join(await Deno.makeTempDir({ prefix: "aio-homeA-" }));
    const homeB = join(await Deno.makeTempDir({ prefix: "aio-homeB-" }));
    const a = new AppLock(id, homeA);
    const b = new AppLock(id, homeB);
    try {
      assert(a.key !== b.key, "two homes, two keys");
      assertEquals((await a.acquire(4101)).ok, true);
      assertEquals((await b.acquire(4102)).ok, true, "no collision");
      assertEquals(readLock(a.key)?.home, resolve(homeA));
      assertEquals(readLock(b.key)?.home, resolve(homeB));

      // The socket is named by the lock this process holds — but two locks of
      // one appId are held here, so the first registered wins; what matters is
      // that it is a TAGGED name, never the default instance's socket.
      const sock = resolveSocketPath(id);
      assert(sock.includes(`${id}@`), sock);

      // Discovery: both listed, each with its home, id from the lock's data.
      const seen = instances(id);
      assertEquals(seen.length, 2);
      assertEquals(
        seen.map((i) => i.home).sort(),
        [resolve(homeA), resolve(homeB)].sort(),
      );

      // A TRUE duplicate (same home) is refused, and `existing` is the
      // same-home instance — its port is this caller's own, never home B's.
      const dup = new AppLock(id, homeA);
      // An alive owner. `startToken` must be pid 1's, not the one this
      // process's own lock carries: a lock whose pid and start-time disagree
      // is EXACTLY the recycled-pid signature `isLockOwnerAlive` exists to
      // catch, so pairing them would make this "alive owner" read as stale and
      // the duplicate would be allowed in.
      writeLock({
        ...readLock(a.key)!,
        pid: 1,
        port: 4101,
        startToken: processStartToken(1) ?? undefined,
      });
      const r = await dup.acquire(4103);
      assert(!r.ok);
      if (!r.ok) {
        assertEquals(r.existing.port, 4101);
        assertEquals(r.existing.home, resolve(homeA));
      }
    } finally {
      removeLock(a.key);
      removeLock(b.key);
      a.release();
      b.release();
    }
  },
});

Deno.test({
  name:
    "acquireSingletonLock beside a foreign-home sibling: continues, and the info line names no port/pid",
  async fn() {
    const id = `foreign-home-${uid()}`;
    const foreignHome = await Deno.makeTempDir({ prefix: "aio-foreign-" });
    const myHome = await Deno.makeTempDir({ prefix: "aio-mine-" });
    // An alive foreign instance (pid 1 counts as alive) on a real port.
    const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
    const fport = (l.addr as Deno.NetAddr).port;
    writeLock({
      appId: id,
      pid: 1,
      port: fport,
      startedAt: Date.now() - 60_000,
      status: "started",
      cwd: Deno.cwd(),
      home: resolve(foreignHome),
    });
    const lines: string[] = [];
    setLogger(
      {
        logDir: myHome,
        pub: (_l: unknown, _c: unknown, msg: string) => {
          lines.push(msg);
        },
        perf: () => {},
      } as unknown as Parameters<typeof setLogger>[0],
    );
    const unregister = registerRuntime(() => Promise.resolve());
    const realExit = Deno.exit;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = () => {
      throw new Error("Deno.exit called");
    };
    let mine: AppLock | null = null;
    try {
      mine = await acquireSingletonLock(id, myHome, 0, true, false);
      assert(mine, "a different home must boot");
      const info = lines.find((m) => m.includes("different home"));
      assert(info, `expected the info line, got: ${lines.join(" | ")}`);
      assert(!info.includes(String(fport)), `must not name the port: ${info}`);
      assert(!/pid/i.test(info), `must not name the pid: ${info}`);
    } finally {
      Deno.exit = realExit;
      setLogger(null);
      unregister();
      mine?.release();
      removeLock(lockKey(id, foreignHome));
      l.close();
    }
  },
});

Deno.test("instances() parses a tagged lock file and reports lock.appId + lock.home", () => {
  const id = `tagged-${uid()}`;
  const home = `/tmp/aio-tagged-${uid()}`;
  const key = lockKey(id, home);
  assertEquals(lockPath(key), join(lockDir(), `${key}.lock`));
  writeLock({
    appId: id,
    pid: Deno.pid,
    port: 0,
    startedAt: Date.now(),
    status: "started",
    cwd: "/",
    home,
  });
  try {
    const [inst, ...rest] = instances(id);
    assertEquals(rest.length, 0);
    assertEquals(inst?.appId, id);
    assertEquals(inst?.home, home);
    assertEquals(instances("someone-else").length, 0);
  } finally {
    removeLock(key);
  }
});

Deno.test("instances() fills `home` for a pre-alpha66 lock (default home)", () => {
  const id = `legacy-${uid()}`;
  writeLock({
    appId: id,
    pid: Deno.pid,
    port: 0,
    startedAt: Date.now(),
    status: "started",
    cwd: "/",
  });
  try {
    assertEquals(instances(id)[0]?.home, appHome(id));
  } finally {
    removeLock(id);
  }
});

Deno.test("am --home: targetHome makes readPid read the tagged lock, not the default one", () => {
  const id = `am-home-${uid()}`;
  const home = `/tmp/aio-am-home-${uid()}`;
  const base = {
    appId: id,
    pid: Deno.pid,
    startedAt: Date.now(),
    status: "started" as const,
    cwd: "/",
  };
  writeLock({ ...base, port: 1111 });
  writeLock({ ...base, port: 2222, home, socketPath: "/x/tagged.sock" });
  try {
    assertEquals(amLockKey(id), id);
    assertEquals(readPid(id)?.port, 1111);
    targetHome(id, home);
    assertEquals(amLockKey(id), lockKey(id, home));
    assertEquals(readPid(id)?.port, 2222);
    assertEquals(readPid(id)?.socketPath, "/x/tagged.sock");
  } finally {
    _resetAppDirs();
    removeLock(id);
    removeLock(lockKey(id, home));
  }
});

Deno.test({
  name: "am dispatch: the method's return value rides back in the reply",
  async fn() {
    const c = cell("calc", {
      state: { n: 1 },
      methods: {
        add(s: { n: number }, k: number) {
          s.n += k;
          return { n: s.n, doubled: s.n * 2 };
        },
        nothing() {},
      },
    });
    await using srv = await testServer({ cells: [c], appId: `disp-${uid()}` });
    const port = Number(new URL(srv.url).port);
    const r = await trojanPost(port, "dispatch", {
      type: "calc:add",
      payload: { args: [4] },
    });
    assert(r.ok, JSON.stringify(r));
    assertEquals(r.data, { ok: true, result: { n: 5, doubled: 10 } });
    const none = await trojanPost(port, "dispatch", { type: "calc:nothing" });
    assert(none.ok);
    assertEquals(none.data, { ok: true });
  },
});

Deno.test("am timeouts: transport waits strictly longer than the server's client-reply wait", () => {
  assert(FETCH_TIMEOUT > CLIENT_REPLY_TIMEOUT_MS);
  assertEquals(clientTimeout(undefined), FETCH_TIMEOUT);
  assertEquals(
    clientTimeout(CLIENT_REPLY_TIMEOUT_MS + 1),
    CLIENT_REPLY_TIMEOUT_MS + 1,
  );
  assertThrows(
    () => clientTimeout(CLIENT_REPLY_TIMEOUT_MS),
    Error,
    "--timeout",
  );
  const msg = clientReplyTimeoutError(3);
  assert(msg.includes("client 3"), msg);
  assert(msg.includes(`${CLIENT_REPLY_TIMEOUT_MS}ms`), msg);
  assert(
    /busy/.test(msg) && /headless/.test(msg) && /am clients/.test(msg),
    msg,
  );
  // VISIBILITY, first and by name. A field report lost two debugging passes to
  // this message: Chromium throttles an occluded or minimised renderer until it
  // stops answering, and the old text offered only two causes, both of them
  // "something is busy" — so the reader went hunting a render loop that did not
  // exist, twice, while Electron CPU sat at ~0%.
  assert(/VISIBLE/.test(msg), `visibility must be named: ${msg}`);
  assert(
    msg.indexOf("VISIBLE") < msg.indexOf("main thread really is busy"),
    `and listed FIRST — it is the most common cause: ${msg}`,
  );
  // The CPU tell, which is what makes the three distinguishable in practice.
  assert(/CPU/.test(msg), `name the signal that separates them: ${msg}`);
  // …and the flag that buys more time, which the message never mentioned.
  assert(/--timeout/.test(msg), msg);
});
