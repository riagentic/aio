// Runtime smoke tests for examples/targets/* — every compile target's example
// boots from source and answers over its real interface (WS state or HTTP).
// Kept out of test:core (spawns real servers); runs in `deno task test` + CI.
import { assert, assertEquals } from "@std/assert";
import { connectCli } from "aio/server";

// Coverage profiles from spawned deno processes go to a throwaway temp dir —
// never into the repo (an empty DENO_COVERAGE_DIR means "cwd"), never into
// the parent's coverage profile.
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

const ROOT = new URL("..", import.meta.url).pathname;
const dir = (t: string) => `${ROOT}examples/${t}`;

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** Wait for a spawned example to answer.
 *
 *  The bound is deliberately generous. What these tests assert is that an
 *  example BOOTS AND SERVES — not that it does so within N seconds. Each one
 *  spawns a real Deno process that resolves and transpiles a module graph, and
 *  this file now boots EVERY example rather than three, so under the full
 *  suite a dozen of them compete for the same cores. A bound tight enough to
 *  flake there measures the machine, not the framework, and a gate that cries
 *  wolf is one people learn to re-run instead of read. Real boot failures
 *  (a throw, a missing module, a port already held) surface immediately and
 *  do not wait this out. */
async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function spawnExample(
  target: string,
  entry: string, // path relative to the example dir
  args: string[],
  opts: { stdin?: "piped"; stdout?: "piped" } = {},
): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir },
    args: ["run", "-A", "--unstable-kv", entry, ...args],
    cwd: dir(target),
    stdin: opts.stdin ?? "null",
    stdout: opts.stdout ?? "null",
    stderr: "null",
  }).spawn();
}

async function kill(proc: Deno.ChildProcess): Promise<void> {
  try {
    proc.kill();
  } catch { /* already exited */ }
  await proc.status;
}

// Boot the example headless, dispatch counter:increment over WS, observe state.
async function smokeServerExample(
  target: string,
  entry = "src/app.ts",
): Promise<void> {
  const port = freePort();
  const proc = spawnExample(target, entry, [
    "--client=server-only",
    `--port=${port}`,
  ]);
  try {
    const cli = await waitFor(
      `${target} server`,
      async () => {
        const c = connectCli<{ counter: { count: number } }>(
          `http://localhost:${port}`,
        );
        try {
          await c.ready;
          return c;
        } catch {
          c.close();
          return null;
        }
      },
    );
    try {
      const before = cli.state!.counter.count;
      const bumped = new Promise<number>((resolve) => {
        cli.subscribe((s) => {
          if (s.counter.count === before + 1) resolve(s.counter.count);
        });
      });
      cli.send({ type: "counter:increment", payload: { args: [1] } });
      assertEquals(
        await waitFor(
          `${target} increment`,
          () => Promise.race([bumped, Promise.resolve(null)]),
        ),
        before + 1,
      );
    } finally {
      cli.close();
    }
  } finally {
    await kill(proc);
  }
}

// Thin-client examples serve a connect page — boot headless, expect HTML on /.
async function smokeConnectPageExample(target: string): Promise<void> {
  const port = freePort();
  const proc = spawnExample(target, "src/app.ts", [
    "--client=server-only",
    `--port=${port}`,
  ]);
  try {
    const html = await waitFor(`${target} page`, async () => {
      const res = await fetch(`http://localhost:${port}/`);
      const body = await res.text();
      return res.ok ? body : null;
    });
    assert(
      html.includes("<"),
      `${target}: expected HTML, got: ${html.slice(0, 80)}`,
    );
  } finally {
    await kill(proc);
  }
}

const SERVER_TARGETS = [
  "browser",
  "browser-remote",
  "electron",
  "android",
  "cli",
  "service",
  "service-remote",
];

for (const target of SERVER_TARGETS) {
  Deno.test({
    name: `example targets/${target}: boots + counter increments over WS`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: () => smokeServerExample(`targets/${target}`),
  });
}

// Top-level app examples (entry at the dir root, not src/)
Deno.test({
  name: "example counter: boots + counter increments over WS",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => smokeServerExample("counter", "app.ts"),
});

Deno.test({
  name: "example todo: boots + serves UI",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = freePort();
    const proc = spawnExample("todo", "app.ts", [
      "--client=server-only",
      `--port=${port}`,
    ]);
    try {
      await waitFor("todo page", async () => {
        const res = await fetch(`http://localhost:${port}/`);
        await res.body?.cancel();
        return res.ok ? true : null;
      });
    } finally {
      await kill(proc);
    }
  },
});

for (const target of ["electron-remote", "android-remote"]) {
  Deno.test({
    name: `example ${target}: boots + serves connect page`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: () => smokeConnectPageExample(`targets/${target}`),
  });
}

Deno.test({
  name: "example cli-remote: client drives the cli example server via stdin",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = freePort();
    const server = spawnExample("targets/cli", "src/app.ts", [
      `--port=${port}`,
    ]);
    let client: Deno.ChildProcess | null = null;
    try {
      await waitFor("cli server", async () => {
        const res = await fetch(`http://localhost:${port}/`);
        await res.body?.cancel();
        return res.status < 500 ? true : null;
      });
      client = spawnExample(
        "targets/cli-remote",
        "src/client.ts",
        [`ws://localhost:${port}/ws`],
        { stdin: "piped", stdout: "piped" },
      );
      const writer = client.stdin.getWriter();
      const reader = client.stdout.getReader();
      const decoder = new TextDecoder();
      let out = "";
      const readAll = (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          out += decoder.decode(value);
        }
      })();
      await waitFor(
        "client connect",
        () => Promise.resolve(out.includes("Counter:") ? true : null),
      );
      const start = [...out.matchAll(/Counter: (\d+)/g)].at(-1)!;
      const before = Number(start[1]);
      await writer.write(new TextEncoder().encode("inc\n"));
      await waitFor(
        "incremented counter echo",
        () =>
          Promise.resolve(out.includes(`Counter: ${before + 1}`) ? true : null),
      );
      await writer.close();
      await readAll.catch(() => {});
    } finally {
      if (client) await kill(client);
      await kill(server);
    }
  },
});
