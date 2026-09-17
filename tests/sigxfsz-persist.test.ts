// A write past RLIMIT_FSIZE is a refused persist, not a dead process.
//
// The kernel's default for SIGXFSZ is terminate + core dump: the first persist
// that grew state.db (or the journal) past `ulimit -f` killed the app on the
// spot — no PERSIST_ERROR, no shutdown phases, no final persist, the lock left
// behind. With a listener installed the write instead fails with EFBIG ("File
// too large"), which the persist path already reports, and the app stays up.
// Linux/macOS only: Windows has no such signal.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;
const MOD = new URL("../mod.ts", import.meta.url).href;

Deno.test({
  name:
    "persist: a write past `ulimit -f` is reported and the app keeps running",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await tempDir("aio-sigxfsz-");
    try {
      const file = join(dir, "app.ts");
      await Deno.writeTextFile(
        file,
        `import { aio, cell } from ${JSON.stringify(MOD)};
const box = cell("big", {
  state: { s: "" },
  methods: { fill(st: { s: string }, n: number) { st.s = "x".repeat(n); } },
});
const app = await aio.run({
  cells: [box],
  appId: "sigxfsz",
  client: "server-only",
  port: 0,
  persistDebounceMs: 20,
});
await box.fill(8 * 1024 * 1024);
await new Promise((r) => setTimeout(r, 800));
console.log("STILL-ALIVE");
await app.close();
Deno.exit(0);
`,
      );
      // Cache the module graph first, OUTSIDE the limit: Deno's own cache
      // writes are not what this test is about.
      await new Deno.Command(Deno.execPath(), {
        args: ["cache", "--config", join(REPO, "deno.json"), file],
        stdout: "null",
        stderr: "null",
      }).output();
      const deno = Deno.execPath();
      const { code, signal, stdout, stderr } = await new Deno.Command("bash", {
        args: [
          "-c",
          `ulimit -f 5000; exec "$0" run -A --no-check --config "$1" "$2"`,
          deno,
          join(REPO, "deno.json"),
          file,
        ],
        env: { AIO_APPS_DIR: join(dir, "home"), NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(stdout) +
        new TextDecoder().decode(stderr);
      assertEquals(
        [code, signal],
        [0, null],
        `the process must not die of SIGXFSZ (exit 153 / signal 25):\n${
          out.slice(-3000)
        }`,
      );
      assert(out.includes("STILL-ALIVE"), out.slice(-3000));
      assert(
        /PERSIST_ERROR|File too large|persist: failed/.test(out),
        `the refused write is reported:\n${out.slice(-3000)}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});
