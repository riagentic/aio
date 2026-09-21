// An EMBEDDED app dies of SIGXFSZ exactly like a normal one did.
//
// `tests/sigxfsz-persist.test.ts` proves a normal boot survives a write past
// `ulimit -f`: the kernel's default for SIGXFSZ is terminate + core dump, and
// `AppLock._registerCleanupHandlers` installs a no-op listener that turns it
// into EFBIG on the write, which the persist path reports.
//
// `libraryMode` takes NO `AppLock` (`acquireSingletonLock` returns `null` for
// it, because an embedded app must not claim the single-instance lock), so it
// got none of that protection — the listener rode on the LOCK rather than on
// the boot. Same app, same write, dead process, and nothing said why.
//
// The listener is process-wide, costs nothing and grants no exclusivity, so
// `libraryMode` installs it directly. Linux/macOS only: Windows has no such
// signal.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  _fileSizeGuardHeld,
  holdFileSizeGuard,
} from "../src/server/single-instance-lock.ts";

const REPO = new URL("..", import.meta.url).pathname;
const MOD = new URL("../mod.ts", import.meta.url).href;

Deno.test({
  name:
    "libraryMode: a write past `ulimit -f` is reported and the embedded app keeps running",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await tempDir("aio-sigxfsz-lib-");
    try {
      const file = join(dir, "app.ts");
      await Deno.writeTextFile(
        file,
        `import { aio, cell } from ${JSON.stringify(MOD)};
const box = cell("big", {
  state: { s: "" },
  methods: { fill(st: { s: string }, n: number) { st.s = "x".repeat(n); } },
});
// libraryMode: aio embedded in a host process. No lock, therefore (before the
// fix) no SIGXFSZ listener.
const app = await aio.run({
  cells: [box],
  appId: "sigxfszlib",
  client: "server-only",
  port: 0,
  libraryMode: true,
  appDir: ${JSON.stringify(join(dir, "home"))},
  persistDebounceMs: 20,
});
await box.fill(8 * 1024 * 1024);
await new Promise((r) => setTimeout(r, 800));
console.log("STILL-ALIVE");
await app.close();
Deno.exit(0);
`,
      );
      // See sigxfsz-persist.test.ts: the module graph is cached OUTSIDE the
      // limit, and `--no-code-cache` keeps V8's own multi-gigabyte code cache
      // out of it, so the app's writes are the only writes under `ulimit -f`.
      await new Deno.Command(Deno.execPath(), {
        args: ["cache", "--config", join(REPO, "deno.json"), file],
        stdout: "null",
        stderr: "null",
      }).output();
      const { code, signal, stdout, stderr } = await new Deno.Command("bash", {
        args: [
          "-c",
          `ulimit -f 5000; exec "$0" run -A --no-check --no-code-cache ` +
          `--config "$1" "$2"`,
          Deno.execPath(),
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
        `an embedded app must not die of SIGXFSZ (exit 153 / signal 25):\n${
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

// Two apps in one process (D2 — an app plus its admin panel, and every
// `testServer()` pair) each hold the guard. The first one to shut down must
// not take the listener out from under the second, and a double release must
// not decrement someone else's hold.
Deno.test({
  name: "file-size guard: refcounted, so a sibling app's shutdown cannot " +
    "un-protect this one",
  ignore: Deno.build.os === "windows",
  fn() {
    const base = _fileSizeGuardHeld();
    const a = holdFileSizeGuard();
    const b = holdFileSizeGuard();
    assertEquals(_fileSizeGuardHeld(), base + 2);
    a();
    a(); // idempotent: a second release is not a second decrement
    a();
    assertEquals(
      _fileSizeGuardHeld(),
      base + 1,
      "releasing one holder (even three times) leaves the other's hold",
    );
    b();
    assertEquals(_fileSizeGuardHeld(), base);
  },
});
