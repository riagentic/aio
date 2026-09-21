// `electron: { requireSandbox }` — an app's say in the ONE security downgrade
// aio performs on its own behalf.
//
// On a kernel that restricts unprivileged user namespaces (Ubuntu 24.04+, every
// container) and with a `chrome-sandbox` that an npm install could not make
// setuid-root, Chromium ABORTS rather than starting — so aio measures both and
// launches with `--no-sandbox`. That is the right default: the alternative is a
// framework whose default target does not start. It was also log-only, and an
// audit's §6 named the shape: a security downgrade the app cannot refuse.
//
// So the app can now say "not for me": `electron: { requireSandbox: true }`
// refuses the launch, loudly, with the two lines that make the sandbox usable
// instead. The decision is a pure table with the measurement injected — the
// same seam `sandboxUsable`/`usernsAvailable` already use, because a fleet of
// VMs is not a unit test.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  SandboxRefusal,
  sandboxSwitches,
  sandboxUsable,
} from "../src/electron/electron-spawn.ts";
import { electronLaunchFailurePlan } from "../src/server/aio-lifecycle.ts";
import {
  NESTED_CONFIGS,
  SHAPE_VALUES,
  VALID_ELECTRON_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  validateConfig,
} from "../src/server/config.ts";
import { electronMetaPolicy } from "../src/electron/electron.ts";

const no = () => Promise.resolve(false);
const yes = () => Promise.resolve(true);

Deno.test("sandbox: a usable sandbox adds no switch, whatever the app asked for", async () => {
  for (const requireSandbox of [false, true]) {
    const r = await sandboxSwitches("/opt/electron", requireSandbox, yes);
    assertEquals(r.args, []);
    assertEquals(r.warn, undefined);
  }
});

Deno.test("sandbox: without requireSandbox the downgrade happens, and SAYS so", async () => {
  const r = await sandboxSwitches("/opt/electron", false, no);
  assertEquals(r.args, ["--no-sandbox"], "the app would not start otherwise");
  assert(r.warn, "a silent --no-sandbox is the thing we refuse");
  // The warning has to carry the way OUT of it, not just the news.
  assert(r.warn.includes("chmod 4755"), `no remedy in: ${r.warn}`);
  assert(r.warn.includes("requireSandbox"), `no opt-out named in: ${r.warn}`);
});

Deno.test("sandbox: requireSandbox REFUSES the launch instead of downgrading", async () => {
  const e = await assertRejects(
    () => sandboxSwitches("/opt/electron", true, no),
    Error,
  );
  assert(
    e.message.includes("requireSandbox"),
    `the refusal must name the config that caused it: ${e.message}`,
  );
  assert(
    e.message.includes("chmod 4755"),
    `…and the way to satisfy it: ${e.message}`,
  );
  assert(
    !e.message.includes("not installed"),
    "a refusal must not read like a missing Electron",
  );
});

// ── …and what the refusal MEANS for the process that made it ─────────────
//
// "Refuses the launch" was only half done. The throw landed in the one catch
// around the Electron launch, which answers every failure the same way:
//
//   electron: the desktop window could not be started — <error>. The server is
//   still running at <url>; open it in a browser, or run with --client=browser.
//
// So an app that said "I would rather not open than open unsandboxed" kept
// serving its UI — and was told, in its own log, to open it in an uncontrolled
// browser instead. That is precisely the downgrade the key exists to refuse,
// arriving one step later. A missing Electron is a different thing and keeps
// the old answer: nothing about the app's security was decided there.
Deno.test("sandbox: a refusal STOPS the app; every other launch failure does not", async () => {
  const refusal = await assertRejects(
    () => sandboxSwitches("/opt/electron", true, no),
    SandboxRefusal,
    "requireSandbox",
  );
  const stop = electronLaunchFailurePlan(refusal, "http://127.0.0.1:1234");
  assertEquals(stop.stop, true, "the app it protects kept running");
  assert(
    stop.lines.join("\n").includes("requireSandbox"),
    "the exit must name the config that caused it",
  );
  assertEquals(
    stop.lines.some((l) => l.includes("--client=browser")),
    false,
    "an app that refused an unsandboxed window must not be pointed at a browser",
  );

  // Anything else: the server stays up and says where it is. Unchanged.
  const other = electronLaunchFailurePlan(
    new Error("Electron not installed"),
    "http://127.0.0.1:1234",
  );
  assertEquals(other.stop, false);
  assert(other.lines.join("\n").includes("http://127.0.0.1:1234"));
  assert(other.lines.join("\n").includes("--client=browser"));
});

Deno.test("sandbox: the launch's catch USES that plan", async () => {
  // The decider is pure so it can be a unit test; this is the wire it hangs
  // on. A plan nobody calls is a plan that protects nothing.
  const src = await Deno.readTextFile(
    new URL("../src/server/aio-lifecycle.ts", import.meta.url),
  );
  const at = src.indexOf("electronLaunchFailurePlan(e");
  assert(at > 0, "the Electron launch's catch no longer asks the plan");
  const tail = src.slice(at, at + 400);
  assert(
    tail.includes("stopProcess"),
    `…and must act on it: ${tail.slice(0, 200)}`,
  );
});

Deno.test("sandbox: AIO_ELECTRON_SANDBOX=1 still forces the strict answer", async () => {
  const prev = Deno.env.get("AIO_ELECTRON_SANDBOX");
  Deno.env.set("AIO_ELECTRON_SANDBOX", "1");
  try {
    // …without ever consulting the filesystem or the kernel.
    assertEquals(await sandboxUsable("/opt/electron"), true);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_ELECTRON_SANDBOX");
    else Deno.env.set("AIO_ELECTRON_SANDBOX", prev);
  }
});

// ── The config key itself ─────────────────────────────────────────────────
//
// A block whose sub-keys are not validated is a block whose misspelled key is
// accepted in silence — and the control the author asked for is simply absent.
// That is the one failure mode a SECURITY key must not have.
function refused(obj: Record<string, unknown>): boolean {
  let code: number | null = null;
  const orig = { error: console.error, warn: console.warn, log: console.log };
  for (const k of ["error", "warn", "log"] as const) console[k] = () => {};
  try {
    validateConfig(
      obj,
      VALID_FEATURES_CONFIG_KEYS,
      "CellsConfig",
      ((c: number) => {
        code = c;
        throw new Error("exit");
      }) as (c: number) => never,
    );
  } catch { /* the exit stub */ }
  Object.assign(console, orig);
  return code === 1;
}

Deno.test("electron config: every key of the block reaches the window's meta", () => {
  // The config-bridge bug class: a key typed, validated, documented — and then
  // not copied at the one call site that matters, so it is `undefined` all the
  // way down while the app believes it is protected. `electronMetaPolicy` is
  // the one mapping; this is what keeps it TOTAL.
  const on = electronMetaPolicy({
    requireSandbox: true,
    unsandboxedChildWindows: true,
  }) as Record<string, unknown>;
  const off = electronMetaPolicy(undefined) as Record<string, unknown>;
  for (const key of VALID_ELECTRON_KEYS) {
    assertEquals(
      on[key],
      true,
      `electron.${key} is dropped on the way to meta`,
    );
    assertEquals(off[key], false, `electron.${key} has no default`);
  }
  assertEquals(
    Object.keys(on).length,
    VALID_ELECTRON_KEYS.size,
    "meta carries a policy key the config cannot set",
  );
});

Deno.test("electron config: the block is real, nested-validated and shape-checked", () => {
  assertEquals(
    refused({
      electron: { requireSandbox: true, unsandboxedChildWindows: true },
    }),
    false,
    "the documented spelling must boot",
  );
  assert(
    refused({ electron: { requireSanbox: true } }),
    "a misspelled sub-key would leave the app unprotected in silence",
  );
  assert(refused({ electron: true }), "a non-object block must be refused");
  assertEquals(SHAPE_VALUES.electron, "object");
  assert("electron" in NESTED_CONFIGS, "the block must be walked as a config");
});
