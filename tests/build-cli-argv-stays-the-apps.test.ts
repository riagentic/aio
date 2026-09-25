// A `cli` binary's argv belongs to the app's own program.
//
// `deno compile` puts baked runtime args IN FRONT of the user's, so baking
// `--client=cli` into the scaffolded cli template (`am create --template=cli`,
// whose deno.json already says `"client": "cli"`) made `Deno.args[0]` the
// flag: the compiled `todo serve` skipped its `serve` branch and printed
// "no todo server running — start one: todo serve". The bake changed no
// decision there — the binary falls back to its embedded deno.json `client` —
// so it is not baked when that rung already says `cli`.
//
// …and only when that rung is EMBEDDED: `deno compile` carries a deno.json on
// its own only when the app imports it, so a hand-written `"client": "cli"`
// app compiled without `--include deno.json` found no rung and booted as
// Electron. The skip is keyed on the argv's own include list.
import { assert, assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { cliCompileArgs } from "../src/build/build-cli.ts";
import { assetIncludes, bakedClientArgs } from "../src/build/build-compile.ts";
import { BUILD_STAMP_FILE } from "../src/build/build-version.ts";
import { scaffold } from "../src/am/am-cmd-create.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const base = {
  doRemote: false,
  out: "/out/todo",
  entry: "src/app.ts",
  assets: ["--include", "deno.json"],
  excludes: [],
  v8Flags: [],
};

Deno.test("cli argv: a cli app that declares client cli gets no baked flag in front of its own args", () => {
  const args = cliCompileArgs({ ...base, declaredClient: "cli" });
  // The entry is LAST: nothing is prepended to the program's Deno.args.
  assertEquals(args.slice(-3), ["-o", "/out/todo", "src/app.ts"]);
  assert(!args.includes("--client=cli"), args.join(" "));
  assertEquals(
    bakedClientArgs({
      doCli: true,
      doRemote: false,
      doElectron: false,
      doHeadless: false,
      declaredClient: "cli",
    }),
    [],
  );
});

Deno.test("cli argv: client cli is baked when the argv does not embed the deno.json that says so", () => {
  // Nothing else would carry the rung into the binary — the flag must.
  for (const assets of [[], ["--include", "media"], ["deno.json"]]) {
    const args = cliCompileArgs({ ...base, assets, declaredClient: "cli" });
    assertEquals(args.at(-1), "--client=cli", JSON.stringify(assets));
  }
  // deno.jsonc is the same rung.
  const args = cliCompileArgs({
    ...base,
    assets: ["--include", "deno.jsonc"],
    declaredClient: "cli",
  });
  assertEquals(args.at(-1), "src/app.ts");
});

Deno.test("cli argv: a cli target of an app declaring another client still boots as cli", () => {
  // The field report behind baking (a target booting the app's deno.json
  // client instead of its own) still holds for every other declaration.
  for (const declaredClient of ["browser", "electron", undefined]) {
    const args = cliCompileArgs({ ...base, declaredClient });
    assertEquals(args.at(-1), "--client=cli", String(declaredClient));
  }
});

Deno.test("cli argv: the builder hands the app's deno.json client to the argv", async () => {
  // One call site, and dropping it fails nothing else until release E2E.
  const src = await Deno.readTextFile(
    new URL("../src/build/build-cli.ts", import.meta.url),
  );
  assert(
    /const declaredClient = dj\?\.client \?\? dj\?\.target;/.test(src) &&
      /target: cfg\.targetTriple,\s*declaredClient,/.test(src),
    "build-cli.ts no longer passes deno.json `client` into cliCompileArgs",
  );
});

// ── the artifact itself ──────────────────────────────────────────────────
// Real `deno compile` of the argv the builder assembles (its own include
// list), run from a foreign cwd with a sandboxed HOME and no display.

const AIO_ROOT = resolve(import.meta.dirname!, "..");
const dec = new TextDecoder();

async function scaffoldCli(root: string): Promise<void> {
  const name = `cli-${crypto.randomUUID().slice(0, 8)}`;
  for (
    const [rel, content] of Object.entries(scaffold(name, "cli", true, "cli"))
  ) {
    const path = join(root, rel);
    await Deno.mkdir(resolve(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  await Deno.mkdir(join(root, "dep"), { recursive: true });
  await Deno.symlink(AIO_ROOT, join(root, "dep", "aio"));
  await Deno.mkdir(join(root, ".aio"), { recursive: true });
  await Deno.writeTextFile(
    join(root, BUILD_STAMP_FILE),
    JSON.stringify({ version: "0.1.0" }),
  );
}

async function compileCli(root: string): Promise<string> {
  const out = join(root, "bin-out");
  const [cmd, ...rest] = cliCompileArgs({
    doRemote: false,
    out,
    entry: "src/app.ts",
    assets: await assetIncludes(root, "src/app.ts"),
    excludes: [],
    v8Flags: [],
    declaredClient: "cli",
  });
  const built = await new Deno.Command(Deno.execPath(), {
    args: [cmd!, "--no-check", ...rest],
    cwd: root,
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(built.success, dec.decode(built.stderr));
  return out;
}

function sandboxEnv(h: string): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: h,
    AIO_HOME: join(h, "aio"),
    AIO_VERSIONS_DIR: join(h, "versions"),
    AIO_FEEDBACK_DIR: join(h, "feedback"),
    AIO_INSTALL_ROOT: join(h, "install"),
    AIO_APPS_DIR: join(h, "apps"),
  };
}

Deno.test({
  name:
    "cli artifact: the scaffold's `serve` and a hand-written client-cli app both run as cli from a foreign cwd",
  sanitizeResources: false, // aio-ok: compiled binaries run as child processes; their pipes and timers are not this test's
  sanitizeOps: false, // aio-ok: compiled binaries run as child processes; their pipes and timers are not this test's
  async fn() {
    const scaffolded = await tempDir("cli-argv-scaffold-");
    const hand = await tempDir("cli-argv-hand-");
    const sandbox = await tempDir("cli-argv-home-");
    try {
      await scaffoldCli(scaffolded);
      // The same project, its entry rewritten by hand: no deno.json import,
      // no `client` in code — only the deno.json rung says `cli`.
      await scaffoldCli(hand);
      await Deno.writeTextFile(
        join(hand, "src", "app.ts"),
        `import { _denoJsonTargetClient, defaultClientFor } from "../dep/aio/src/server/aio.ts";
const flag = Deno.args.find((a) => a.startsWith("--client="))?.slice(9);
console.log("PROBE " + JSON.stringify({
  args: Deno.args,
  bootsAs: flag ?? defaultClientFor(undefined),
  rung: _denoJsonTargetClient() ?? null,
}));
Deno.exit(0);
`,
      );
      const [scaffoldBin, handBin] = await Promise.all([
        compileCli(scaffolded),
        compileCli(hand),
      ]);
      const cwd = join(sandbox, "elsewhere");
      await Deno.mkdir(cwd);
      const env = sandboxEnv(join(sandbox, "home"));

      // 1) hand-written: boots as cli, and its argv is its own.
      const h = await new Deno.Command(handBin, {
        args: ["serve"],
        cwd,
        env,
        clearEnv: true, // no DISPLAY / WAYLAND_DISPLAY, no real HOME
        stdout: "piped",
        stderr: "piped",
      }).output();
      const line = dec.decode(h.stdout).split("\n").find((l) =>
        l.startsWith("PROBE ")
      );
      assert(line, `no PROBE line:\n${dec.decode(h.stderr)}`);
      const got = JSON.parse(line.slice(6));
      assertEquals(got.bootsAs, "cli", line);
      assertEquals(got.args.at(-1), "serve", line);

      // 2) scaffold: `serve` is Deno.args[0], so the server comes up.
      const port = freePort();
      const child = new Deno.Command(scaffoldBin, {
        args: ["serve", `--port=${port}`],
        cwd,
        env,
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const outP = child.output();
      let up = false;
      try {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !up) {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/__aio/health`);
            await r.body?.cancel();
            up = r.ok;
          } catch { /* not yet */ }
          if (!up) await new Promise((r) => setTimeout(r, 200));
        }
      } finally {
        try {
          child.kill("SIGTERM");
        } catch { /* already exited */ }
      }
      const o = await outP;
      assert(
        up,
        `the scaffold's \`serve\` never served:\n${dec.decode(o.stdout)}\n${
          dec.decode(o.stderr)
        }`,
      );
    } finally {
      await dropTempDir(scaffolded);
      await dropTempDir(hand);
      await dropTempDir(sandbox);
    }
  },
});
