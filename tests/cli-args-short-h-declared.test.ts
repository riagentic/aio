// `-h` was hard-wired to help, BEFORE the spec's own shorts were consulted —
// so `host: { type: "string", short: "h" }` was unreachable: `-h example.com`
// printed the help and exited 0, the tool never ran. A declared `h` now wins;
// `--help` (and `-h` when nothing claims it) still help.
import { assertEquals, assertThrows } from "@std/assert";
import { args, CliExit, testIO } from "../src/cli.ts";

const SPEC = {
  name: "t",
  flags: { host: { type: "string", short: "h" } },
} as const;

Deno.test("cli args: a declared short `h` is that flag, not help", () => {
  const io = testIO();
  const a = args(SPEC, { argv: ["-h", "example.com"], io });
  assertEquals(a.flags.host, "example.com");
  assertEquals(io.stdout, "");
});

Deno.test("cli args: --help still helps; bare -h helps when nothing claims it", () => {
  for (
    const [spec, argv] of [[SPEC, ["--help"]], [{ name: "t" }, ["-h"]]] as const
  ) {
    const io = testIO();
    const e = assertThrows(() => args(spec, { argv, io }), CliExit);
    assertEquals(e.code, 0);
    assertEquals(io.stdout.includes("usage: t"), true);
  }
});
