// `tool --watch | head -1`: once `head` exits, the next frame's write fails
// with EPIPE. The toolkit's stdout crashed the tool with "Uncaught BrokenPipe"
// and a stack trace on stderr (measured on the compiled examples/cli-tool).
// A reader that went away ends the tool quietly, 141 — what `yes | head -1`
// reports — like every unix tool.
import { assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { EXIT_BROKEN_PIPE, writeAll } from "../src/cli/io.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
const exit = (code: number): never => {
  throw new Exited(code);
};

Deno.test("cli io: a closed reader exits 141 quietly; other errors still throw; short writes complete", () => {
  const closed = {
    writeSync(): number {
      throw new Deno.errors.BrokenPipe("Broken pipe (os error 32)");
    },
  };
  const e = assertThrows(() => writeAll(closed, "x", exit), Exited);
  assertEquals(e.code, EXIT_BROKEN_PIPE);

  const other = {
    writeSync(): number {
      throw new Deno.errors.PermissionDenied("nope");
    },
  };
  assertThrows(() => writeAll(other, "x", exit), Deno.errors.PermissionDenied);

  const got: number[] = [];
  const short = {
    writeSync(p: Uint8Array): number {
      got.push(p[0]!);
      return 1; // one byte at a time
    },
  };
  writeAll(short, "abc", exit);
  assertEquals(String.fromCharCode(...got), "abc");
});

Deno.test("cli io: a real process whose stdout reader closed exits 141, no stack trace", async () => {
  const dir = await tempDir("aio-cli-epipe-");
  try {
    const app = join(dir, "spam.ts");
    await Deno.writeTextFile(
      app,
      `import { defaultIO } from ${
        JSON.stringify(new URL("../src/cli/io.ts", import.meta.url).href)
      };
const io = defaultIO();
for (let i = 0; i < 1e6; i++) io.out("line " + i + "\\n");
`,
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        fromFileUrl(new URL("../deno.json", import.meta.url)),
        app,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    // Read one chunk, then go away — `| head -1`.
    const errText = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    await reader.read();
    await reader.cancel();
    const { code } = await child.status;
    const err = await errText;
    assertEquals(code, EXIT_BROKEN_PIPE, err);
    assertEquals(err.includes("BrokenPipe"), false, err);
  } finally {
    await dropTempDir(dir);
  }
});
