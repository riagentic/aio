// A typo in `memory: { … }` is said out loud even when the app has no `ui`.
// The check used to live INSIDE the `ui` one, so without `ui` any key was
// accepted and did nothing. Warned, not refused: that app booted yesterday,
// and the surface is frozen. With `ui` it was always (and stays) a refusal.
import { assert, assertRejects } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

function capture() {
  const out: string[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  for (const k of ["warn", "error", "log"] as const) {
    console[k] = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  }
  return { out, restore: () => Object.assign(console, orig) };
}

Deno.test("memory typo without ui: boots, and warns with the nearest key", async () => {
  _resetAioRuntime();
  const c = cell("memtypo", { state: { n: 0 }, methods: {} });
  const cap = capture();
  try {
    const app = await aio.run({
      appId: "memtypo-test",
      cells: [c],
      libraryMode: true,
      client: "server-only",
      dbPath: ":memory:",
      // deno-lint-ignore no-explicit-any
      memory: { trendWindw: 5 } as any,
    });
    await app.close();
  } finally {
    cap.restore();
    _resetAioRuntime();
  }
  assert(
    cap.out.some((l) =>
      l.includes("unknown memory config key: trendWindw") &&
      l.includes('did you mean "trendWindow"')
    ),
    cap.out.join("\n"),
  );
});

Deno.test("memory typo WITH ui: still refused, as before", async () => {
  _resetAioRuntime();
  const c = cell("memtypo2", { state: { n: 0 }, methods: {} });
  try {
    await assertRejects(
      () =>
        aio.run({
          appId: "memtypo2-test",
          cells: [c],
          libraryMode: true,
          client: "server-only",
          dbPath: ":memory:",
          ui: { title: "x" },
          // deno-lint-ignore no-explicit-any
          memory: { trendWindw: 5 } as any,
        }),
      Error,
      "unknown memory config key: trendWindw",
    );
  } finally {
    _resetAioRuntime();
  }
});
