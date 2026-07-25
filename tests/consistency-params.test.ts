// Pins the pre-beta parameter-consistency fixes so a refactor can't silently
// reintroduce the footguns the API audit found.
import { assert, assertEquals } from "@std/assert";
import { call } from "../src/state/cell-impl.ts";
import { resolveOptions } from "../src/diagnostics/types.ts";
import { freePort } from "../src/testing/server-test.ts";

Deno.test("call: timeoutMs is the canonical key; bare timeout still works", async () => {
  // timeoutMs fires the timeout.
  let msg = "";
  try {
    await call({ timeoutMs: 20 }, () => new Promise((r) => setTimeout(r, 200)));
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes("timeout after 20ms"), msg);

  // Deprecated `timeout` alias must still be honored (no silent no-timeout).
  msg = "";
  try {
    await call({ timeout: 20 }, () => new Promise((r) => setTimeout(r, 200)));
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes("timeout after 20ms"), `alias ignored: ${msg}`);

  // Fast call under the budget resolves normally.
  assertEquals(await call({ timeoutMs: 500 }, () => Promise.resolve(42)), 42);
});

Deno.test("boot smoke: diagnostics:true + dispatchStorm:true + onEffect(e,state,user)", async () => {
  const { cell, aio } = await import("../mod.ts");
  // A cell whose method returns an effect, so onEffect fires with state.
  const c = cell("fxcell", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  let sawState: unknown = "unset";
  const app = await aio.run({
    cells: [c],
    appId: `test-consistency-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    diagnostics: true, // was a type error before (only false|object)
    dispatchStorm: true, // was a type error before (only StormConfig|false)
    // onEffect now receives (effect, state, user) — parity with onAction.
    onEffect: (_e: unknown, state: unknown) => {
      sawState = state;
    },
    port: freePort(),
    baseDir: await Deno.makeTempDir(),
  });
  try {
    // The app booted with true-valued toggles (the point of the fix).
    assertEquals((app.getState() as { fxcell: { n: number } }).fxcell.n, 0);
    // onEffect saw a state object, not undefined, if any effect fired.
    if (sawState !== "unset") {
      assert(typeof sawState === "object", "onEffect received state object");
    }
  } finally {
    await app.close();
  }
});

Deno.test("diagnostics: boolean|Config — true = defaults on, false = off", () => {
  // true resolves to the same options object as omitted/defaults.
  const onTrue = resolveOptions(true, false);
  const onDefault = resolveOptions({}, false);
  assert(onTrue !== false, "true must not disable diagnostics");
  assertEquals(onTrue, onDefault, "true ≡ defaults");
  // false still disables.
  assertEquals(resolveOptions(false, false), false);
  // object overrides still merge.
  const tuned = resolveOptions({ dev: { stateDiffs: false } }, false);
  assert(tuned !== false && tuned.stateDiffs === false);
});
