// `--version` on an `args()` tool with no `version` in its spec was passed
// through as an aio runtime flag — and with no aio runtime in the process to
// answer it, the tool ran its action as if nothing had been asked. It is
// refused now, unless an aio runtime is loaded (it answers `--version`).
import { assert, assertEquals } from "@std/assert";
import { args, testIO } from "../src/cli.ts";
import { noteAioRuntime } from "../src/diagnostics/runtime-flags.ts";

/** Run `body` in a FRESH process: "no aio runtime loaded" is process-wide,
 *  and the suite runs many files in one process — another file loading the
 *  runtime first made these order-dependent. */
async function fresh(body: string): Promise<{ out: string; ok: boolean }> {
  const src = `import { args, CliExit, testIO } from ${
    JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)
  };\nimport { aioRuntimeLoaded } from ${
    JSON.stringify(
      new URL("../src/diagnostics/runtime-flags.ts", import.meta.url).href,
    )
  };\n${body}`;
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--ext=ts", src],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    out: new TextDecoder().decode(o.stdout).trim(),
    ok: o.success || new TextDecoder().decode(o.stderr).length === 0,
  };
}

Deno.test("cli args: --version with no spec.version and no aio runtime refuses", async () => {
  const r = await fresh(`
    const io = testIO();
    let code = 0;
    try { args({ name: "t" }, { argv: ["--version"], io }); }
    catch (e) { if (e instanceof CliExit) code = e.code; else throw e; }
    console.log(JSON.stringify({ loaded: aioRuntimeLoaded(), code, err: io.stderr }));
  `);
  const got = JSON.parse(r.out.split("\n").at(-1)!);
  assertEquals(got.loaded, false, "aio/cli must not load the runtime");
  assert(got.code !== 0, r.out);
  assert(got.err.includes("declares no version"), got.err);
});

Deno.test("cli args: a tool's own `version` flag is parsed, never refused", async () => {
  const r = await fresh(`
    const io = testIO();
    const a = args({ name: "t", flags: { version: { type: "string" } } }, { argv: ["--version", "1.2.3"], io });
    console.log(JSON.stringify({ loaded: aioRuntimeLoaded(), v: a.flags.version, err: io.stderr }));
  `);
  const got = JSON.parse(r.out.split("\n").at(-1)!);
  assertEquals(got, { loaded: false, v: "1.2.3", err: "" });
});

Deno.test("cli args: --version is left to a loaded aio runtime", () => {
  noteAioRuntime();
  const io = testIO();
  args({ name: "t" }, { argv: ["--version"], io });
  assertEquals(io.stderr, "");
});
