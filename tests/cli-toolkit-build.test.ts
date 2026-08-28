// examples/cli-tool — the todo CLI built on `aio/cli`, proven the way a user
// meets it: from SOURCE against a real server (always on), and as a compiled
// `cli` binary run from a FOREIGN cwd (gated on AIO_BUILD_E2E=1, like
// tests/build-e2e.test.ts — a real `deno compile`, ~1 min).
//
// "It type-checks" proves nothing about a CLI. What is asserted here is what
// the shell sees: exit codes, stdout vs stderr, and `--json` being parseable.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import { childEnv, freePort, kill, waitForHttp } from "./e2e-app-harness.ts";
import { stopChild } from "./stop-child.ts";

const ROOT = resolve(import.meta.dirname!, "..");
const EXAMPLE = join(ROOT, "examples", "cli-tool");
const APP = join(EXAMPLE, "src", "app.ts");
const CONFIG = join(EXAMPLE, "deno.json");
const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";
const dec = new TextDecoder();

/** Run the example from SOURCE, from a throwaway cwd, capturing everything. */
async function todo(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string; err: string }> {
  const cwd = opts.cwd ?? await Deno.makeTempDir({ prefix: "cli-tool-cwd-" });
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, APP, ...args],
    cwd,
    env: { ...childEnv(), NO_COLOR: "1", ...opts.env },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: p.code, out: dec.decode(p.stdout), err: dec.decode(p.stderr) };
}

Deno.test("cli-tool: --help from a foreign cwd, exit 0, generated from the spec", async () => {
  const r = await todo(["--help"]);
  assertEquals(r.code, 0, r.err);
  assertStringIncludes(r.out, "usage: todo <command> [arg...] [flags]");
  assertStringIncludes(r.out, "  serve  run the server");
  assertStringIncludes(r.out, "  list   show the list");
  assertStringIncludes(r.out, "-w, --watch");
  assertStringIncludes(
    r.out,
    '--url=<string>  the server to talk to (default: "ws://localhost:8000/ws")',
  );
});

Deno.test("cli-tool: a typo is refused with exit 2; no server is exit 1 on stderr — or {error} JSON on stdout", async () => {
  const typo = await todo(["lsit"]);
  assertEquals(typo.code, 2);
  assertStringIncludes(
    typo.err,
    "error: unknown command: lsit (did you mean list?)",
  );
  const flag = await todo(["list", "--wtach"]);
  assertEquals(flag.code, 2);
  assertStringIncludes(
    flag.err,
    "unknown flag: --wtach (did you mean --watch?)",
  );

  const dead = `ws://127.0.0.1:${freePort()}/ws`;
  const noServer = await todo(["list", `--url=${dead}`]);
  assertEquals(noServer.code, 1);
  assertStringIncludes(
    noServer.err,
    `error: no server at ${dead} — start one: todo serve`,
  );
  const asJson = await todo(["list", "--json", `--url=${dead}`]);
  assertEquals(asJson.code, 1);
  assertEquals(
    JSON.parse(asJson.out).error,
    `no server at ${dead} — start one: todo serve`,
  );
});

Deno.test("cli-tool: serve + add/list/done/--json/--watch against the real server", async () => {
  const port = freePort();
  const url = `ws://127.0.0.1:${port}/ws`;
  const home = await Deno.makeTempDir({ prefix: "cli-tool-home-" });
  const server = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, APP, "serve", `--port=${port}`],
    cwd: EXAMPLE,
    env: { ...childEnv(), AIO_APPS_DIR: home },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let log = "";
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) log += dec.decode(c);
  };
  drain(server.stderr).catch(() => {});
  drain(server.stdout).catch(() => {});
  try {
    await waitForHttp(`http://127.0.0.1:${port}/__aio/health`, 60_000).catch(
      (e) => {
        throw new Error(`${e}\n--- server log ---\n${log}`);
      },
    );
    const env = { AIO_APPS_DIR: home };
    const empty = await todo(["list", `--url=${url}`], { env });
    assertEquals(empty.code, 0, empty.err);
    assertEquals(empty.out, "(nothing to do)\n");

    const add = await todo(["add", `--url=${url}`, "buy", "milk"], { env });
    assertEquals(add.code, 0, add.err);
    assertEquals(add.out, "id  done  text\n 1        buy milk\n");

    const done = await todo(["done", "1", `--url=${url}`], { env });
    assertEquals(done.code, 0, done.err);
    assertStringIncludes(done.out, " 1  x     buy milk");

    const json = await todo(["list", "--json", `--url=${url}`], { env });
    assertEquals(json.code, 0, json.err);
    assertEquals(JSON.parse(json.out), [{
      id: 1,
      text: "buy milk",
      done: true,
    }]);

    // a method's refusal is the command's failure: exit 1, the reason, no stack
    const bad = await todo(["done", "99", `--url=${url}`], { env });
    assertEquals(bad.code, 1);
    assertStringIncludes(bad.err, "no todo #99");
    assertStringIncludes(bad.err, "error: ");
    assertEquals(bad.out, "");
    const usage = await todo(["done", "x", `--url=${url}`], { env });
    assertEquals(usage.code, 2);
    assertStringIncludes(usage.err, "error: todo done <id>");

    // --watch on a pipe: plain frames appended as the server changes
    const watcher = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        CONFIG,
        APP,
        "list",
        "--watch",
        `--url=${url}`,
      ],
      cwd: await Deno.makeTempDir({ prefix: "cli-tool-cwd-" }),
      env: { ...childEnv(), NO_COLOR: "1", ...env },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let frames = "";
    const reader = (async () => {
      for await (const c of watcher.stdout) frames += dec.decode(c);
    })();
    const until = async (probe: () => boolean, what: string) => {
      const deadline = Date.now() + 30_000;
      while (!probe()) {
        if (Date.now() > deadline) {
          throw new Error(`timeout: ${what}\n${frames}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await until(() => frames.includes("buy milk"), "first frame");
    const add2 = await todo(["add", `--url=${url}`, "walk", "dog"], { env });
    assertEquals(add2.code, 0, add2.err);
    await until(() => frames.includes("walk dog"), "redraw after a change");
    assert(!frames.includes("\x1b"), `no escapes on a pipe:\n${frames}`);
    // SIGINT is the interactive stop this watcher exists to honour — bounded,
    // so a watcher that ignores it fails the test instead of hanging the suite.
    await stopChild(watcher, {
      label: "the `todo watch` client",
      graceMs: 10_000,
    });
    await reader.catch(() => {});
  } finally {
    await kill(server);
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name:
    "cli-tool: compiles with --targets=cli and answers --help from a foreign cwd",
  ignore: !GATE,
  fn: async () => {
    // A copy of the example wired to THIS checkout through dep/aio — the same
    // layout `am create` scaffolds, so the build runs the way a user's does.
    const dir = await Deno.makeTempDir({ prefix: "cli-tool-build-" });
    for (const rel of ["src/app.ts", "src/cell/todos.ts"]) {
      await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
      await Deno.copyFile(join(EXAMPLE, rel), join(dir, rel));
    }
    await Deno.mkdir(join(dir, "dep"));
    await Deno.symlink(ROOT, join(dir, "dep", "aio"));
    const cfg = JSON.parse(await Deno.readTextFile(CONFIG));
    cfg.title = `cli-tool-${crypto.randomUUID().slice(0, 8)}`;
    for (
      const [k, v] of Object.entries(cfg.imports as Record<string, string>)
    ) {
      if (v.startsWith("../../")) cfg.imports[k] = `./dep/aio/${v.slice(6)}`;
    }
    cfg.tasks = {
      compile:
        "deno run -A dep/aio/src/build-all.ts --build-spec=dep/aio/src/build.ts --targets=cli",
    };
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify(cfg, null, 2),
    );

    const build = await new Deno.Command(Deno.execPath(), {
      args: ["task", "compile"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      build.code,
      0,
      dec.decode(build.stderr) + dec.decode(build.stdout),
    );
    const bins = [...Deno.readDirSync(dir)].filter((e) =>
      e.isFile && !e.name.includes(".")
    ).map((e) => e.name);
    assertEquals(
      bins.length,
      1,
      `one binary expected, got: ${bins.join(", ")}`,
    );
    const bin = join(dir, bins[0]!);
    await Deno.chmod(bin, 0o755);

    const foreign = await Deno.makeTempDir({ prefix: "foreign-cwd-" });
    const help = await new Deno.Command(bin, {
      args: ["--help"],
      cwd: foreign,
      env: { ...childEnv(), NO_COLOR: "1" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(help.code, 0, dec.decode(help.stderr));
    assertStringIncludes(
      dec.decode(help.stdout),
      "usage: todo <command> [arg...] [flags]",
    );
    const typo = await new Deno.Command(bin, {
      args: ["lsit"],
      cwd: foreign,
      env: { ...childEnv(), NO_COLOR: "1" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(typo.code, 2);
    assertStringIncludes(dec.decode(typo.stderr), "unknown command: lsit");

    // and the binary IS the server too: `serve` boots from the foreign cwd
    const port = freePort();
    const home = await Deno.makeTempDir({ prefix: "cli-tool-home-" });
    const proc = new Deno.Command(bin, {
      args: ["serve", `--port=${port}`],
      cwd: foreign,
      env: { ...childEnv(), AIO_APPS_DIR: home },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let binLog = "";
    const log = () => binLog;
    for (const s of [proc.stdout, proc.stderr]) {
      (async () => {
        for await (const c of s) binLog += dec.decode(c);
      })().catch(() => {});
    }
    try {
      await waitForHttp(`http://127.0.0.1:${port}/__aio/health`, 45_000).catch(
        (e) => {
          throw new Error(`${e}\n--- binary log ---\n${log()}`);
        },
      );
      const list = await new Deno.Command(bin, {
        args: ["add", "from", "binary", `--url=ws://127.0.0.1:${port}/ws`],
        cwd: foreign,
        env: { ...childEnv(), NO_COLOR: "1" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(list.code, 0, dec.decode(list.stderr));
      assertStringIncludes(dec.decode(list.stdout), "from binary");
    } finally {
      await kill(proc);
      await Deno.remove(home, { recursive: true }).catch(() => {});
    }
  },
});
