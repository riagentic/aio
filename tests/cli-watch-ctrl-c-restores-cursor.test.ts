// Ctrl+C on a TTY `watch()` with no SIGINT handler of the app's own killed the
// process with the cursor still hidden (`\x1b[?25l`), leaving the terminal
// cursorless. The view now always shows the cursor again, and exits 130 only
// when the app has no SIGINT listener of its own — an app that handles Ctrl+C
// keeps its exit code and its (async) cleanup.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const WATCH = toFileUrl(join(import.meta.dirname!, "../src/cli/watch.ts")).href;

async function run(ownHandler: boolean) {
  const dir = await tempDir("cli-watch-sigint-");
  const script = join(dir, "w.ts");
  await Deno.writeTextFile(
    script,
    `import { watch } from ${JSON.stringify(WATCH)};
const enc = new TextEncoder();
const io = {
  out: (s: string) => Deno.stdout.writeSync(enc.encode(s)),
  err: (s: string) => Deno.stderr.writeSync(enc.encode(s)),
  tty: true, color: false, stdin: Deno.stdin,
  exit: (c: number) => Deno.exit(c),
};
const _w = watch({ subscribe: () => () => {} }, () => "frame", { io: io as never });
${
      ownHandler
        // Async cleanup and NO w.stop(): the shape that must keep its exit.
        ? `Deno.addSignalListener("SIGINT", async () => {
  await new Promise((r) => setTimeout(r, 100));
  console.log("CLEANED");
  Deno.exit(0);
});`
        : ""
    }
console.log("READY");
setInterval(() => {}, 1000);
`,
  );
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", script],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let seen = "";
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  try {
    while (!seen.includes("READY")) {
      const r = await reader.read();
      if (r.done) break;
      seen += dec.decode(r.value);
    }
    child.kill("SIGINT");
    // A child that ignores Ctrl+C would hang the test: kill it, and the exit
    // code assertions below go red instead.
    const late = setTimeout(() => child.kill("SIGKILL"), 10_000);
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      seen += dec.decode(r.value);
    }
    const code = (await child.status).code;
    clearTimeout(late);
    return { seen, code };
  } finally {
    reader.releaseLock();
    await child.stderr.cancel();
    await dropTempDir(dir);
  }
}

Deno.test({
  name: "cli watch: Ctrl+C with no app handler shows the cursor, exits 130",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { seen, code } = await run(false);
    assert(seen.includes("\x1b[?25l"), "cursor was never hidden");
    assert(seen.endsWith("\x1b[?25h"), JSON.stringify(seen));
    assertEquals(code, 130);
  },
});

Deno.test({
  name:
    "cli watch: an app SIGINT handler keeps its exit and its async cleanup; the cursor still comes back",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { seen, code } = await run(true);
    assert(seen.includes("\x1b[?25h"), JSON.stringify(seen));
    assert(
      seen.includes("CLEANED"),
      `cleanup was cut: ${JSON.stringify(seen)}`,
    );
    assertEquals(code, 0);
  },
});
