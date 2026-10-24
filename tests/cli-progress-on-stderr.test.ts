// `tool --json | jq`: progress() and spinner() wrote their plain `label...` /
// `copy 3/10 (30%)` lines to STDOUT on a pipe, so the script reading stdout
// got them mixed into the program's output. Progress is on stderr (the unix
// convention); stdout carries only what the program prints. A real child with
// both streams piped — the in-process testIO cannot show which fd a byte hit.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { testIO } from "../src/cli/io.ts";
import { progress, spinner } from "../src/cli/output.ts";

Deno.test("cli progress/spinner: a piped stdout gets only the program's output; progress is on stderr", async () => {
  const dir = await tempDir("aio-cli-progress-stderr-");
  try {
    const app = join(dir, "tool.ts");
    await Deno.writeTextFile(
      app,
      `import { progress, spinner } from ${
        JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)
      };
const s = spinner("loading");
s.stop("loaded");
const p = progress(2, { label: "copy" });
p.tick();
p.done();
console.log(JSON.stringify({ ok: true }));
`,
    );
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        fromFileUrl(new URL("../deno.json", import.meta.url)),
        app,
      ],
      cwd: dir,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    assertEquals(code, 0, err);
    assertEquals(out, '{"ok":true}\n', "stdout is the program's output only");
    assertStringIncludes(err, "loading...\nloaded\n");
    assertStringIncludes(err, "copy 0/2 (0%)\n");
    assertStringIncludes(err, "copy 2/2 (100%)\n");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("cli progress/spinner: redraw follows stderr — stdout a terminal, stderr not (`tool 2>log`) → plain lines, no escapes", () => {
  const io = testIO({ tty: true });
  io.errTty = false;
  const p = progress(2, { io, label: "copy" });
  p.tick();
  p.done();
  const s = spinner("loading", { io });
  s.stop("loaded");
  assertEquals(
    io.stderr,
    "copy 0/2 (0%)\ncopy 1/2 (50%)\ncopy 2/2 (100%)\nloading...\nloaded\n",
  );
  assertEquals(io.stdout, "");
  // A custom io without `errTty` keeps `tty` deciding, as before.
  const legacy = testIO({ tty: true });
  progress(1, { io: legacy, label: "x" }).done();
  assertStringIncludes(legacy.stderr, "\r\x1b[2K");
});

// The real wiring: defaultIO() under a pty (util-linux `script`), stdout the
// terminal, stderr redirected to a file — the file gets plain lines.
const hasScript = Deno.build.os === "linux" &&
  (await new Deno.Command("sh", {
    args: ["-c", "command -v script"],
    stdout: "null",
    stderr: "null",
  }).output()).success;

Deno.test({ // aio-ok: fn() asserts exit code and the exact log text
  name:
    "cli progress: real terminal stdout + `2>file` → the file gets plain lines, no escapes",
  ignore: !hasScript,
  async fn() {
    const dir = await tempDir("aio-cli-progress-errtty-");
    try {
      const app = join(dir, "tool.ts"), log = join(dir, "err.log");
      await Deno.writeTextFile(
        app,
        `import { progress } from ${
          JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)
        };
const p = progress(2, { label: "copy" });
p.tick();
p.done();
`,
      );
      const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
      const cmd = [
        q(Deno.execPath()),
        "run -A --config",
        q(fromFileUrl(new URL("../deno.json", import.meta.url))),
        q(app),
        "2>" + q(log),
      ].join(" ");
      const { code } = await new Deno.Command("script", {
        args: ["-qec", cmd, "/dev/null"],
        cwd: dir,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const err = await Deno.readTextFile(log);
      assertEquals(code, 0, err);
      assertEquals(err, "copy 0/2 (0%)\ncopy 1/2 (50%)\ncopy 2/2 (100%)\n");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test('cli progress/spinner: `stream: "out"` opts back into stdout, redraw follows stdout\'s tty; a bad stream throws', () => {
  const io = testIO({ tty: true });
  io.errTty = false; // stderr not a terminal must NOT matter for "out"
  const p = progress(1, { io, label: "copy", width: 2, stream: "out" });
  p.done();
  const s = spinner("loading", { io, stream: "out", intervalMs: 1e6 });
  s.stop("loaded");
  assertEquals(
    io.stdout,
    "\r\x1b[2Kcopy [--] 0/1 0%\r\x1b[2Kcopy [##] 1/1 100%\n" +
      "\r\x1b[2K⠋ loading\r\x1b[2Kloaded\n",
  );
  assertEquals(io.stderr, "");
  const pipe = testIO({ tty: false });
  spinner("x", { io: pipe, stream: "out" }).stop();
  assertEquals(pipe.stdout, "x...\nx\n");
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => progress(1, { io, stream: "stdout" as any }),
    TypeError,
    'stream must be "err" or "out"',
  );
});
