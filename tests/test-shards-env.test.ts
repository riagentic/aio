// What the shard runner gives each shard, and what it refuses from one.
//
// Two runner decisions that used to live inline in `main`, where no test could
// reach them: the per-shard environment (a private XDG_RUNTIME_DIR and a port
// slice), and the swallowed-press ratchet — a `ui.Field.press("Enter")` whose
// window shortcut ran ZERO times only WARNS in the harness (the surface is
// frozen: a user's passing test must not start failing), so in this repo the
// runner fails the file unless it says why.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  portSliceFor,
  shardEnv,
  SWALLOW_OK,
  SWALLOWED_PRESS,
  swallowedPresses,
} from "../scripts/test-shards.ts";

const ROOT = new URL("../", import.meta.url).pathname;

Deno.test("shardEnv: every non-window shard gets its own XDG_RUNTIME_DIR and portSliceFor's slice", async () => {
  const n = 6;
  const envs = Array.from(
    { length: n },
    (_, i) =>
      shardEnv(i, n, `/tmp/xdg-shard-${i}`, {
        home: `/h/${i}`,
        realWindow: false,
      }),
  );
  assertEquals(envs.length, n);
  for (const [i, env] of envs.entries()) {
    assertEquals(env.XDG_RUNTIME_DIR, `/tmp/xdg-shard-${i}`, `shard ${i}`);
    assertEquals(env.AIO_TEST_PORT_SLICE, portSliceFor(i, n), `shard ${i}`);
    assertEquals(env.AIO_APPS_DIR, `/h/${i}`);
  }
  // Private: no two shards share a runtime dir or a port slice.
  assertEquals(new Set(envs.map((e) => e.XDG_RUNTIME_DIR)).size, n);
  assertEquals(new Set(envs.map((e) => e.AIO_TEST_PORT_SLICE)).size, n);

  // The real-window shard inherits the session's dir (its Electron needs the
  // display/dbus sockets there) — and ONLY that shard may.
  const win = shardEnv(0, n, null, { home: "/h/0", realWindow: true });
  assertEquals("XDG_RUNTIME_DIR" in win, false);
  assertEquals(win.AIO_TEST_PORT_SLICE, portSliceFor(0, n));
  assertThrows(
    () => shardEnv(3, n, null, { home: "/h/3", realWindow: false }),
    Error,
    "no private XDG_RUNTIME_DIR",
  );
  // …and it is what the runner actually hands each shard.
  const src = await Deno.readTextFile(ROOT + "scripts/test-shards.ts");
  assert(
    src.includes(
      "env: shardEnv(i, shards.length, runtime, { home, realWindow }),",
    ),
    "scripts/test-shards.ts must spawn every shard with shardEnv(…)",
  );
});

Deno.test("swallowedPresses: a swallowed press fails its file unless the file says why", () => {
  const warn = `[aio-dev] press("Enter") on an <input> — ${SWALLOWED_PRESS} ` +
    `(ignoreInInput), so nothing ran.`;
  const log = [
    "\x1b[0m\x1b[38;5;245mrunning 2 tests from ./tests/a.test.tsx\x1b[0m",
    "presses ...",
    "------- post-test output -------",
    warn,
    "----- post-test output end -----",
    "running 1 test from ./tests/b.test.tsx",
    "clean ... ok",
    "running 3 tests from ./tests/c.test.tsx",
    warn,
  ].join("\n");
  const sources: Record<string, string> = {
    "tests/a.test.tsx": "// nothing to say",
    "tests/b.test.tsx": "",
    "tests/c.test.tsx":
      "// aio-ok: press swallowed on purpose — asserts the binding stays quiet",
  };
  assertEquals(swallowedPresses(log, (f) => sources[f] ?? ""), [
    "tests/a.test.tsx",
  ]);
  // A bare marker is not a reason.
  assertEquals(
    SWALLOW_OK.test("// aio-ok: press swallowed on purpose — "),
    false,
  );
  assertEquals(
    swallowedPresses("running 1 test from ./x.ts\nok", () => ""),
    [],
  );
});

Deno.test("swallowed press ratchet: real deno output is attributed, and the runner fails the shard on it", async () => {
  // The attribution is only as good as its reading of deno's real output, so
  // read REAL output: one case of a file that swallows a press on purpose.
  const file = "tests/on-global-key.test.tsx";
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "-A",
      "--sanitize-ops",
      "--sanitize-resources",
      file,
      "--filter",
      "a bare key does not fire while you are typing",
    ],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(r.stdout) +
    new TextDecoder().decode(r.stderr);
  assert(r.success, out.slice(-2000));
  assert(out.includes(SWALLOWED_PRESS), "the case no longer swallows a press");
  // Without its marker the file is named; with it (its real source), cleared.
  assertEquals(swallowedPresses(out, () => ""), [file]);
  assertEquals(
    swallowedPresses(out, (f) => Deno.readTextFileSync(ROOT + f)),
    [],
  );
  // …and `main` acts on the answer: a named file fails its shard.
  const src = await Deno.readTextFile(ROOT + "scripts/test-shards.ts");
  assert(
    /const swallowed = swallowedPresses\(out,/.test(src) &&
      src.includes("left: left.length > 0 || swallowed.length > 0,"),
    "scripts/test-shards.ts must fail a shard whose log has a swallowed press",
  );
});
