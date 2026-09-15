// examples/targets/cli and cli-remote defaulted their client to
// ws://localhost:8000/ws — a port nothing binds (`deno task dev` picks a FREE
// one) — and connected with no deadline, so the example you copy to learn
// "how a CLI talks to its server" sat retrying forever without a word. Now: an
// explicit URL wins; the local example finds its running server through the
// lock file (as `am` does); the remote one reads `build.server`; and every
// dead end exits with a sentence.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import { childEnv, freePort, kill, waitForHttp } from "./e2e-app-harness.ts";

const ROOT = resolve(import.meta.dirname!, "..");
const dec = new TextDecoder();

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Run a client from a FOREIGN cwd, killed if it outlives `ms` — a client
 *  that hangs is the failure under test, so the test must not hang with it. */
async function client(
  example: "cli" | "cli-remote",
  args: string[],
  env: Record<string, string>,
  ms = 20_000,
): Promise<{ code: number | "hung"; out: string; err: string }> {
  const dir = join(ROOT, "examples", "targets", example);
  const cwd = await Deno.makeTempDir({ prefix: "cli-client-cwd-" });
  const p = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      join(dir, "deno.json"),
      join(dir, "src", "client.ts"),
      ...args,
    ],
    cwd,
    env: {
      ...Deno.env.toObject(),
      ...childEnv(),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...env,
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    try {
      p.kill("SIGKILL");
    } catch { /* already gone */ }
  }, ms);
  const r = await p.output();
  clearTimeout(timer);
  await Deno.remove(cwd, { recursive: true }).catch(() => {});
  return {
    code: hung ? "hung" : r.code,
    out: stripAnsi(dec.decode(r.stdout)),
    err: stripAnsi(dec.decode(r.stderr)),
  };
}

Deno.test("cli-remote client: no URL is a usage error, a dead URL an exit — never a hang", async () => {
  const home = await Deno.makeTempDir({ prefix: "cli-client-home-" });
  try {
    const none = await client("cli-remote", [], { AIO_APPS_DIR: home });
    assertEquals(none.code, 2, none.out + none.err);
    assertStringIncludes(none.err, "usage: client <url>");

    const dead = `http://127.0.0.1:${freePort()}`;
    const gone = await client("cli-remote", [dead], { AIO_APPS_DIR: home });
    assertEquals(gone.code, 1, gone.out + gone.err);
    assertStringIncludes(gone.err, `no server at ${dead}`);
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("cli client: finds its running server with no URL, and says so when there is none", async () => {
  const home = await Deno.makeTempDir({ prefix: "cli-client-home-" });
  const env = { AIO_APPS_DIR: home };
  try {
    const none = await client("cli", [], env);
    assertEquals(none.code, 1, none.out + none.err);
    assertStringIncludes(none.err, "no ex-cli server running");

    const dir = join(ROOT, "examples", "targets", "cli");
    const port = freePort();
    const server = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "src/app.ts",
        "--client=server-only",
        `--port=${port}`,
      ],
      cwd: dir, // `deno task dev`
      env: { ...childEnv(), ...env },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await waitForHttp(`http://127.0.0.1:${port}/__aio/health`, 60_000);
      // stdin is closed, so the command loop ends at once and the client exits
      // — after printing the live count it read from the server it found.
      const found = await client("cli", [], env);
      assertEquals(found.code, 0, found.out + found.err);
      assertStringIncludes(found.out, `ws://localhost:${port}/ws`);
      assert(/Counter: \d+/.test(found.out), found.out);
    } finally {
      await kill(server);
    }
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});
