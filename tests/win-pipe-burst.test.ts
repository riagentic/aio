// A named pipe under a BURST, and a pipe name taken at boot.
//
// A unix socket queues the connections it has not accepted yet (its backlog).
// A named pipe has no backlog: a client opens an INSTANCE, and a pipe whose
// every instance is taken answers ERROR_PIPE_BUSY. The host kept one instance
// waiting and the client gave up after five tries — 14 simultaneous
// `connectLocal` calls failed on Windows 11 against a healthy server. Now the
// host keeps several waiting and the client's bound is time, with the pipe
// named when it runs out.
//
// And the name: a socket file sits in the lock DIRECTORY, which carries the
// `AIO_APPS_DIR` scope; a pipe name is machine-wide, so the scope is in the
// name (`_pipeName`) — and the name is taken synchronously at boot
// (`reservePipe`), where a unix bind throws.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  connectLocal,
  isPipePath,
  PIPE_PREFIX,
} from "../src/server/local-listen.ts";
import { _pipeName, resolveSocketPath } from "../src/server/paths.ts";
import {
  connectPipe,
  listenPipe,
  PIPE_BACKLOG,
  PIPE_BUSY_WAIT_MS,
  PIPE_SPARE_INSTANCES,
  releasePipes,
  reservePipe,
  reservePipes,
} from "../src/server/win-pipe.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";

const WIN = Deno.build.os === "windows";
const enc = new TextEncoder();
const dec = new TextDecoder();

Deno.test("pipe name: unscoped it is what it always was, scoped it carries the lock dir's scope and can be no unscoped app's", () => {
  // Byte-for-byte the released names: an installed app, its window, `am` and
  // an older client find each other by them.
  assertEquals(_pipeName("aio", "wallet"), "aio-wallet");
  assertEquals(_pipeName("aio", "wallet", "http"), "aio-wallet-http");
  assertEquals(_pipeName("aio", "wallet@dev"), "aio-wallet@dev");
  // Scoped: two apps roots, two names — for one appId.
  const a = _pipeName("aio-tmp-a-apps", "wallet");
  const b = _pipeName("aio-tmp-b-apps", "wallet");
  assertEquals(a, "aio+tmp-a-apps+wallet");
  assert(a !== b && a !== _pipeName("aio", "wallet"));
  assertEquals(
    _pipeName("aio-tmp-a-apps", "wallet", "http"),
    "aio+tmp-a-apps+wallet-http",
  );
  // No unscoped app, whatever its id, is filed under a scoped name: an
  // unscoped name starts `aio-`, a scoped one `aio+`.
  assert(_pipeName("aio", "tmp-a-apps-wallet") !== a);
  assert(_pipeName("aio", "+tmp-a-apps+wallet") !== a);
  // An apps root with no ASCII letter or digit scopes the lock dir to `aio-`:
  // an EMPTY scope is still a scope, never the unscoped name.
  assertEquals(_pipeName("aio-", "wallet"), "aio++wallet");
  assertEquals(_pipeName("aio-", "wallet", "http"), "aio++wallet-http");
});

Deno.test("resolveSocketPath: with no AIO_APPS_DIR the windows names are the released ones, to the byte", async () => {
  // In a child: the suite itself runs under an AIO_APPS_DIR, so here the
  // unscoped row can only be computed, never met. The lock dir it makes on
  // the way goes under a base of this test's.
  const base = await tempDir("aio-pipe-unscoped-");
  try {
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { resolveSocketPath } from ${
          JSON.stringify(
            new URL("../src/server/paths.ts", import.meta.url).href,
          )
        };
console.log(JSON.stringify([
  resolveSocketPath("some-app", undefined, "windows"),
  resolveSocketPath("some-app", "http", "windows"),
]));`,
      ],
      env: { AIO_APPS_DIR: "", XDG_RUNTIME_DIR: base, TEMP: base, TMP: base },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(code, 0, dec.decode(stderr));
    assertEquals(JSON.parse(dec.decode(stdout)), [
      "\\\\.\\pipe\\aio-some-app",
      "\\\\.\\pipe\\aio-some-app-http",
    ]);
  } finally {
    await dropTempDir(base);
  }
  // Here, whatever the scope: the pipe named for THIS lock dir.
  const p = resolveSocketPath("some-app", undefined, "windows");
  assert(isPipePath(p), p);
  assert(p.startsWith(PIPE_PREFIX + "aio"), p);
  assertEquals(resolveSocketPath("some-app", "http", "windows"), `${p}-http`);
});

Deno.test({
  name: "pipe burst: 32 simultaneous connects all get in, and each is answered",
  ignore: !WIN, // named pipes are the Windows transport (win-pipe.ts)
  async fn() {
    const dir = await tempDir("aio-pipe-burst-");
    const path = localEndpoint(join(dir, "b.sock"));
    try {
      const l = listenPipe(path);
      const served = (async () => {
        let n = 0;
        for await (const c of l) {
          const w = c.writable.getWriter();
          await w.write(enc.encode(`hello ${n++}`));
          await c.drain?.();
          c.close();
        }
      })();
      try {
        // `allSettled`: a connect that failed is reported with the others
        // still read to their end — nothing is left open behind a failure.
        const got = await Promise.allSettled(
          Array.from({ length: 32 }, async () => {
            const c = await connectLocal(path);
            let text = "";
            for await (const chunk of c.readable) text += dec.decode(chunk);
            return text;
          }),
        );
        assertEquals(
          got.flatMap((r) => r.status === "rejected" ? [`${r.reason}`] : []),
          [],
        );
        assertEquals(
          got.map((r) =>
            Number((r as PromiseFulfilledResult<string>).value.slice(6))
          ).sort((a, b) => a - b),
          Array.from({ length: 32 }, (_, i) => i),
        );
      } finally {
        l.close();
        await served;
        await localIdle();
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "pipe burst: a burst no larger than the spare instances never meets a busy pipe",
  ignore: !WIN, // named pipes are the Windows transport (win-pipe.ts)
  async fn() {
    const dir = await tempDir("aio-pipe-spare-");
    const path = localEndpoint(join(dir, "s.sock"));
    try {
      const l = listenPipe(path);
      const served = (async () => {
        for await (const c of l) {
          c.close();
        }
      })();
      try {
        // Every one of them opens its instance in THIS turn — the host has
        // not run in between — and a bound of 0 makes the first
        // ERROR_PIPE_BUSY the failure it would be without spares. One MORE
        // than the spares is that failure: the bound of 0 is a real one, and
        // the spares are as many as the constant says.
        const tries = await Promise.allSettled(
          Array.from(
            { length: PIPE_SPARE_INSTANCES + 1 },
            () => connectPipe(path, 0),
          ),
        );
        for (const t of tries) if (t.status === "fulfilled") t.value.close();
        assertEquals(
          tries.map((t) =>
            t.status === "fulfilled"
              ? "in"
              : /ERROR_PIPE_BUSY/.test(`${t.reason}`)
              ? "busy"
              : `${t.reason}`
          ),
          [...Array(PIPE_SPARE_INSTANCES).fill("in"), "busy"],
        );
      } finally {
        l.close();
        await served;
        await localIdle();
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "pipe burst: a pipe whose host accepts no one fails after the bound, naming the pipe",
  ignore: !WIN, // named pipes are the Windows transport (win-pipe.ts)
  async fn() {
    const dir = await tempDir("aio-pipe-busy-");
    const path = localEndpoint(join(dir, "busy.sock"));
    try {
      // Hosted and never iterated: ONE instance exists, nothing accepts.
      const l = listenPipe(path);
      const first = await connectPipe(path);
      try {
        const t0 = performance.now();
        const e = await assertRejects(() => connectPipe(path, 300), Error);
        const took = performance.now() - t0;
        for (
          const part of [
            path,
            "Win32 error 231 ERROR_PIPE_BUSY",
            "stayed taken for 300 ms",
          ]
        ) assertStringIncludes(e.message, part);
        assert(took >= 300 && took < 5000, `gave up after ${took} ms`);
      } finally {
        first.close();
        l.close();
        await localIdle();
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test("pipe burst: the bounds are numbers a reader can rely on", () => {
  assert(PIPE_SPARE_INSTANCES >= 2 && PIPE_SPARE_INSTANCES <= 16);
  assertEquals(PIPE_BUSY_WAIT_MS, 2000);
});

Deno.test({
  name:
    "pipe reserve: the name is taken synchronously — a hosted one throws there, and the listener that follows serves on the reserved one",
  ignore: !WIN, // named pipes are the Windows transport (win-pipe.ts)
  async fn() {
    const dir = await tempDir("aio-pipe-reserve-");
    const path = localEndpoint(join(dir, "r.sock"));
    const taken = localEndpoint(join(dir, "taken.sock"));
    try {
      const other = listenPipe(taken);
      const e = assertThrows(() => reservePipe(taken), Error);
      // Who may hold it, the name, and the ways out that work.
      for (
        const part of [
          taken,
          "another instance of this app",
          "another Windows user",
          "a pipe name is machine-wide",
          "`-http` added or removed",
          "a distinct appId",
          "`--transport=ws`",
        ]
      ) assertStringIncludes(e.message, part);
      other.close();

      reservePipe(path);
      // Held from this line — the name exists before any listener does.
      assert(
        [...Deno.readDirSync(PIPE_PREFIX)].some((e) =>
          e.name === path.slice(PIPE_PREFIX.length)
        ),
        `${path} is not in the pipe namespace`,
      );
      // Asked for again in this process — a second app of the same id — it
      // is refused HERE, in the same words, not at that app's first accept.
      const twice = assertThrows(() => reservePipe(path), Error);
      assertStringIncludes(twice.message, "already reserved in this process");
      assertStringIncludes(twice.message, path);
      assertStringIncludes(twice.message, "`--transport=ws`");
      const l = listenPipe(path);
      const served = (async () => {
        for await (const c of l) {
          await c.writable.getWriter().write(enc.encode("reserved"));
          await c.drain?.();
          c.close();
        }
      })();
      const c = await connectLocal(path);
      let text = "";
      for await (const chunk of c.readable) text += dec.decode(chunk);
      assertEquals(text, "reserved");
      l.close();
      await served;
      await localIdle();
    } finally {
      await dropTempDir(dir);
    }
  },
});

/** Read `path` to its end, as text. */
async function readAll(path: string): Promise<string> {
  const c = await connectLocal(path);
  let text = "";
  for await (const chunk of c.readable) text += dec.decode(chunk);
  return text;
}

Deno.test({
  name:
    "pipe reserve: a client that opened the reserved instance and left before the listener came does not cost the app its door",
  ignore: !WIN, // named pipes are the Windows transport (win-pipe.ts)
  async fn() {
    const dir = await tempDir("aio-pipe-nodata-");
    const path = localEndpoint(join(dir, "n.sock"));
    try {
      reservePipe(path);
      // What a liveness probe does — connect, close — to the one instance
      // that exists between the reserve and the first accept.
      (await connectPipe(path)).close();
      const l = listenPipe(path);
      const served = (async () => {
        for await (const c of l) {
          await c.writable.getWriter().write(enc.encode("served"));
          await c.drain?.();
          c.close();
        }
      })();
      try {
        assertEquals(await readAll(path), "served");
        // And again: the listener is whole, not on its last instance.
        assertEquals(await readAll(path), "served");
      } finally {
        l.close();
        await served;
        await localIdle();
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "pipe reserve: names are taken all or none, and a released name is free — for a client and for the next host",
  ignore: !WIN, // named pipes are the Windows transport (win-pipe.ts)
  async fn() {
    const dir = await tempDir("aio-pipe-release-");
    const free = localEndpoint(join(dir, "free.sock"));
    const taken = localEndpoint(join(dir, "taken.sock"));
    try {
      const other = listenPipe(taken);
      try {
        // The second name is refused: the first is given back with it.
        assertThrows(() => reservePipes([free, taken]), Error, taken);
        await assertRejects(() => connectPipe(free, 0), Deno.errors.NotFound);
      } finally {
        other.close();
      }
      // A boot that failed after reserving gives its names back.
      reservePipes([free, taken]);
      (await connectPipe(free, 0)).close(); // hosted: a client gets in
      releasePipes([free, taken]);
      await assertRejects(() => connectPipe(free, 0), Deno.errors.NotFound);
      await assertRejects(() => connectPipe(taken, 0), Deno.errors.NotFound);
      // …and they can be taken again, by this process as by any other.
      reservePipes([free, taken]);
      releasePipes([free, taken]);
      // A name a listener already serves is not the release's to close.
      reservePipe(free);
      const l = listenPipe(free);
      releasePipes([free]);
      (await connectPipe(free, 0)).close();
      l.close();
      await localIdle();
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "pipe burst: a consumer that stops accepting is owed at most the backlog — the next client is told the pipe is busy, and gets in when one is taken",
  ignore: !WIN, // named pipes are the Windows transport (win-pipe.ts)
  async fn() {
    const dir = await tempDir("aio-pipe-backlog-");
    const path = localEndpoint(join(dir, "q.sock"));
    try {
      const l = listenPipe(path);
      const it = l[Symbol.asyncIterator]();
      // The consumer takes ONE connection and then no more.
      const firstTaken = it.next();
      const clients = [await connectPipe(path)];
      const taken = [(await firstTaken).value!];
      try {
        // One at a time, each given the bound to get in: the host hears of
        // every connect and makes the next instance — until it is the
        // backlog behind.
        let busy: unknown;
        for (let i = 0; i < PIPE_BACKLOG + 8 && busy === undefined; i++) {
          try {
            clients.push(await connectPipe(path, 300));
          } catch (e) {
            busy = e;
          }
        }
        assertStringIncludes(`${busy}`, "ERROR_PIPE_BUSY");
        assertEquals(clients.length, 1 + PIPE_BACKLOG);
        // One taken, one place free.
        taken.push((await it.next()).value!);
        clients.push(await connectPipe(path));
      } finally {
        for (const c of [...clients, ...taken]) c.close();
        l.close();
        await localIdle();
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});
