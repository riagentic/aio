// Flags only an Electron window can honour, on a client that has no window.
//
// Four flags, one mistake, four different outcomes — none of them a refusal:
//
//   --client=browser --connect      overrode the client and started a ~100 MB
//                                   Electron runtime download
//   --client=browser --server-url=  same
//   --client=browser --cdp          printed "cdp 127.0.0.1:9222 (opt-in,
//                                   loopback)" for a port nothing listens on
//   --client=browser --width=100    assigned a window size no window reads
//   --client=browser --keep-server  refused — but AFTER the whole boot banner,
//                                   as an unhandled rejection, naming the
//                                   config key `keepServer` even when the
//                                   operator had typed the flag
//
// One pure decider (`electronOnlyFlagRefusal`) now answers for the whole
// family, before anything boots, naming WHAT WAS TYPED — the flag when it was
// the flag, the config key when it was the key.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { electronOnlyFlagRefusal, parseCli } from "../src/server/aio-cli.ts";
import { freePort } from "../src/testing/server-test.ts";
import { childCoverageDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const _childCovDir = childCoverageDir();

const refusal = (args: string[], client: string, config = {}): string =>
  String(electronOnlyFlagRefusal(parseCli(args), client, config) ?? "");

// ── The decider ───────────────────────────────────────────────────────

Deno.test("electron-only: an electron client is refused nothing", () => {
  for (
    const args of [
      ["--connect"],
      ["--server-url=https://10.0.0.5:8443"],
      ["--keep-server"],
      ["--cdp"],
      ["--width=1200", "--height=900"],
    ]
  ) {
    assertEquals(
      electronOnlyFlagRefusal(parseCli(args), "electron"),
      null,
      args.join(" "),
    );
  }
});

Deno.test("electron-only: nothing asked, nothing refused", () => {
  for (const client of ["browser", "cli", "server-only", "electron"]) {
    assertEquals(electronOnlyFlagRefusal(parseCli([]), client), null, client);
  }
});

Deno.test("electron-only: --connect on a browser client is refused BY NAME", () => {
  const msg = refusal(["--connect"], "browser");
  assertStringIncludes(msg, "--connect");
  assertStringIncludes(msg, "electron");
  assertStringIncludes(msg, '"browser"');
});

Deno.test("electron-only: --server-url= is the same refusal, not a client override", () => {
  const msg = refusal(["--server-url=https://10.0.0.5:8443"], "cli");
  assertStringIncludes(msg, "--server-url");
  assertStringIncludes(msg, '"cli"');
});

Deno.test("electron-only: --keep-server names THE FLAG, not the config key", () => {
  const msg = refusal(["--keep-server"], "browser");
  assertStringIncludes(msg, "--keep-server");
  assert(
    !msg.includes("Remove keepServer from aio.run()"),
    `the operator typed a flag; the fix must name the flag: ${msg}`,
  );
  // …and the config key when the config key is what was written.
  const fromConfig = String(
    electronOnlyFlagRefusal(parseCli([]), "browser", { keepServer: true }) ??
      "",
  );
  assertStringIncludes(fromConfig, "keepServer");
  assertStringIncludes(fromConfig, "aio.run()");
});

Deno.test("electron-only: --cdp and --width/--height join the family", () => {
  assertStringIncludes(refusal(["--cdp"], "browser"), "--cdp");
  assertStringIncludes(refusal(["--cdp=9333"], "server-only"), "--cdp");
  const w = refusal(["--width=100", "--height=100"], "browser");
  assertStringIncludes(w, "--width");
  // A browser page's size has a real answer — the refusal says it.
  assertStringIncludes(w, "ui: { width, height }");
  assertStringIncludes(refusal(["--height=100"], "browser"), "--height");
});

// ── The wiring: refused before anything boots ─────────────────────────

async function scaffold(appId: string): Promise<string> {
  const dir = await tempDir("aio-eflags-");
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ title: appId, imports: { aio: join(ROOT, "mod.ts") } }),
  );
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `import { aio, cell } from "aio";
cell("board", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ appId: "${appId}", persist: false, singleton: false, client: "server-only" });
Deno.exit(0);
`,
  );
  return dir;
}

async function boot(
  dir: string,
  flags: string[],
): Promise<{ out: string; code: number }> {
  const home = await tempDir("aio-eflags-home-");
  const r = await new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir, AIO_APPS_DIR: home },
    args: ["run", "-A", join(dir, "src", "app.ts"), ...flags],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { out: dec.decode(r.stdout) + dec.decode(r.stderr), code: r.code };
}

/** Nothing bound, nothing downloaded, nothing reported as running. */
function bootedNothing(out: string): void {
  assert(!out.includes("— every interface"), `it bound a port:\n${out}`);
  assert(!out.includes("— loopback only"), `it bound a port:\n${out}`);
  assert(
    !/download|electron v\d/i.test(out),
    `it went for the Electron runtime:\n${out}`,
  );
}

Deno.test({
  name: "--connect on --client=browser is refused before the Electron download",
  async fn() {
    const dir = await scaffold(`ef-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const { out, code } = await boot(dir, [
        "--client=browser",
        "--connect",
        `--port=${freePort()}`,
      ]);
      assertEquals(code, 1, `expected a refusal\n${out}`);
      assertStringIncludes(
        out,
        "--connect only applies when client is electron",
      );
      bootedNothing(out);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "--keep-server on --client=browser is refused BEFORE the banner",
  async fn() {
    const dir = await scaffold(`ef-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const { out, code } = await boot(dir, [
        "--client=browser",
        "--keep-server",
        `--port=${freePort()}`,
      ]);
      assertEquals(code, 1, `expected a refusal\n${out}`);
      assertStringIncludes(out, "--keep-server only applies");
      bootedNothing(out);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "--cdp on a non-electron client is refused, not advertised",
  async fn() {
    const dir = await scaffold(`ef-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const { out, code } = await boot(dir, [
        "--client=browser",
        "--cdp",
        `--port=${freePort()}`,
      ]);
      assertEquals(code, 1, `expected a refusal\n${out}`);
      assertStringIncludes(out, "--cdp only applies");
      assert(
        !out.includes("(opt-in, loopback)"),
        `advertised a debugger port nothing listens on:\n${out}`,
      );
      bootedNothing(out);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
