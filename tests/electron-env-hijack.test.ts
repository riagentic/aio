// The ENVIRONMENT is not a trusted input either.
//
// `AIO_ELECTRON_ARGS` is an allow-list because whoever writes the launch
// environment — a .desktop file, a shell profile, a wrapper script — is not
// the app. A verify round pointed out that the same reasoning leaves a wider
// door open one line below: the spawn inherits the whole environment, and
// `ELECTRON_RUN_AS_NODE=1` makes the Electron binary run as PLAIN NODE. It was
// measured against the shipped runtime, not reasoned about: the binary printed
// `v24.21.0` and ran the script handed to it instead of opening the app's
// window. `NODE_OPTIONS=--require=<file>` then loads anything into it.
//
// Removing two keys is a PARTIAL mitigation and the warning says so — an
// environment you do not control can also set `PATH` or `LD_PRELOAD`. It is
// done anyway because an allow-list beside an open door reads as protection
// that is not there, and that inconsistency is the indefensible part.
//
// Pure, so the whole decision is a unit test: no Electron, no display, no
// 100 MB runtime.
//
// The one thing a unit test CANNOT answer is whether an empty value really
// turns the variable off, and the whole fix rests on it. Measured against the
// real runtime (Electron 44.4.1, `node_modules/.bin/electron`):
//
//   unset                    → ELECTRON APP  (process.type "browser")
//   ELECTRON_RUN_AS_NODE=1   → Node.js v24.21.0, the app never opens
//   ELECTRON_RUN_AS_NODE=""  → ELECTRON APP  ← what this fix sends
//
// The first probe for that lied: it asked `process.versions.electron`, which
// is set in BOTH modes, and cheerfully reported "ELECTRON app" for the
// hijacked run. The discriminator that works is `require("electron")` — the
// API object with `.app` on it as an app, the path STRING to the binary as
// node. Verify the instrument before believing it.

import { assert, assertEquals } from "@std/assert";
import {
  ELECTRON_ENV_REFUSED,
  electronChildEnv,
} from "../src/electron/electron-spawn.ts";

/** An environment reader over a plain object. */
const from = (env: Record<string, string>) => (k: string) => env[k];

Deno.test("a clean environment is passed through untouched", () => {
  const { env, dropped } = electronChildEnv(4242, from({ HOME: "/home/x" }));
  assertEquals(env, { AIO_PARENT_PID: "4242" });
  assertEquals(dropped, []);
});

Deno.test("ELECTRON_RUN_AS_NODE is removed, and said out loud", () => {
  const { env, dropped } = electronChildEnv(
    7,
    from({ ELECTRON_RUN_AS_NODE: "1" }),
  );
  // Empty, not absent: `Deno.Command`'s `env` MERGES into the inherited
  // environment, so an empty value is how a key is taken away there. A test
  // asserting the key is missing from this object would pass while the child
  // still inherited the real one — the mistake this line exists to prevent.
  assertEquals(env.ELECTRON_RUN_AS_NODE, "");
  assertEquals(env.AIO_PARENT_PID, "7");
  assertEquals(dropped.map((d) => d.key), ["ELECTRON_RUN_AS_NODE"]);
  assert(
    dropped[0]!.why.includes("plain Node"),
    "the warning must say what the variable actually does",
  );
});

Deno.test("NODE_OPTIONS is removed too", () => {
  const { env, dropped } = electronChildEnv(
    7,
    from({ NODE_OPTIONS: "--require=/tmp/evil.js" }),
  );
  assertEquals(env.NODE_OPTIONS, "");
  assertEquals(dropped.map((d) => d.key), ["NODE_OPTIONS"]);
});

Deno.test("both at once, each named", () => {
  const { dropped } = electronChildEnv(
    7,
    from({
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--inspect",
      TERM: "xterm",
    }),
  );
  assertEquals(
    dropped.map((d) => d.key).sort(),
    ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"],
  );
});

Deno.test("a variable that is set but EMPTY is not reported as dropped", () => {
  // An empty value already means "not set" to both Electron and Node, so
  // warning about it would be a wolf cried on every run of a shell that
  // exports the name blank.
  const { dropped } = electronChildEnv(7, from({ ELECTRON_RUN_AS_NODE: "" }));
  assertEquals(dropped, []);
});

Deno.test("every refused variable explains itself", () => {
  const entries = Object.entries(ELECTRON_ENV_REFUSED);
  // An empty screen list would make the loop below prove nothing while
  // passing — and an empty one is exactly what deleting the wrong line gives.
  assert(entries.length >= 2, `only ${entries.length} variables are screened`);
  for (const [key, why] of entries) {
    assert(why.length > 30, `${key}'s reason is too short to be a reason`);
    assert(
      !/^it is (not )?allowed/.test(why),
      `${key}'s reason must say what the variable DOES, not that it is refused`,
    );
  }
});
