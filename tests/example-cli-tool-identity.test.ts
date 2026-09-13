// examples/cli-tool finds its server through the lock file, keyed by appId —
// and took that appId from `resolveAppId()`, which in source mode reads the
// deno.json of the directory you happen to be standing in. So the same program
// had a different identity per cwd: `todo serve` via `deno task dev` locked as
// `ex-cli-tool`, `todo list` from `~` looked for `cli-tool` (the entry's folder
// name) and said "no todo server running" against a running server, and either
// role run from inside another app's folder BECAME that app — its lock, its
// data directory. A tool's identity is where the tool is, not where you are.
import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { childEnv, freePort, kill, waitForHttp } from "./e2e-app-harness.ts";

const ROOT = resolve(import.meta.dirname!, "..");
const EXAMPLE = join(ROOT, "examples", "cli-tool");
const APP = join(EXAMPLE, "src", "app.ts");
const CONFIG = join(EXAMPLE, "deno.json");
const dec = new TextDecoder();

/** Collect a child's output for the failure message. */
async function drain(
  s: ReadableStream<Uint8Array>,
  onText: (t: string) => void,
): Promise<void> {
  for await (const c of s) onText(dec.decode(c));
}

Deno.test("cli-tool: serve and commands agree on the tool's identity from any cwd", async () => {
  const home = await Deno.makeTempDir({ prefix: "cli-tool-id-home-" });
  // Somebody else's project: `todo serve` started from here must not become it.
  const otherApp = await Deno.makeTempDir({ prefix: "cli-tool-id-other-" });
  await Deno.writeTextFile(
    join(otherApp, "deno.json"),
    JSON.stringify({ title: "ex-todo" }),
  );
  // …and a directory with no deno.json at all, like `~`.
  const bare = await Deno.makeTempDir({ prefix: "cli-tool-id-bare-" });
  const env = { ...childEnv(), NO_COLOR: "1", AIO_APPS_DIR: home };
  const port = freePort();
  const server = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, APP, "serve", `--port=${port}`],
    cwd: otherApp,
    env,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  let log = "";
  const drained = drain(server.stderr, (t) => log += t);
  try {
    await waitForHttp(`http://127.0.0.1:${port}/__aio/health`, 60_000).catch(
      (e) => {
        throw new Error(`${e}\n--- server log ---\n${log}`);
      },
    );
    for (const cwd of [bare, EXAMPLE, otherApp]) {
      const r = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", CONFIG, APP, "list", "--json"],
        cwd,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = dec.decode(r.stdout);
      assertEquals(
        r.code,
        0,
        `\`todo list\` from ${cwd} did not find the server started from ` +
          `${otherApp}:\n${out}${dec.decode(r.stderr)}`,
      );
      assertEquals(JSON.parse(out), []);
    }
    // The server itself is the tool, not the project it was started in.
    const lock = [...Deno.readDirSync(home)].map((e) => e.name);
    assertEquals(lock, ["ex-cli-tool"], "one data dir, named for the tool");
  } finally {
    await kill(server);
    await drained.catch(() => {});
    for (const d of [home, otherApp, bare]) {
      await Deno.remove(d, { recursive: true }).catch(() => {});
    }
  }
});
