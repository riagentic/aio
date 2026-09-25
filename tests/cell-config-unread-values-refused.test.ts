// `scope`, `worker` and `diagnostics` are read by EXACT comparison, so any
// other value was quietly the default: `scope: "browser"` ran on the server,
// `worker: "yes"` on the main thread, and `diagnostics: "off"` (or the
// app-level `{ dev: … }` shape) kept recording the cell's calls and payloads.
import { assertStringIncludes, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";

Deno.test("cell(): a scope/worker/diagnostics value aio would not read is refused", () => {
  let i = 0;
  const methods = {
    set(s: { n: number }, v: number) {
      s.n = v;
    },
  };
  for (
    const [cfg, says] of [
      [
        { scope: "browser" },
        'scope must be "client" or "server", got "browser"',
      ],
      [{ worker: "yes" }, 'worker must be a boolean, got "yes"'],
      [{ diagnostics: "off" }, "diagnostics must be false"],
      [
        { diagnostics: { dev: { actionLog: false } } },
        "diagnostics must be false",
      ],
    ] as const
  ) {
    const m = assertThrows(
      () => cell(`unread${i++}`, { state: { n: 0 }, methods, ...cfg } as never),
      Error,
    ).message;
    assertStringIncludes(m, says);
  }
  // Every documented value still builds.
  for (
    const cfg of [
      { scope: "server" as const },
      { scope: "client" as const },
      { worker: false },
      { diagnostics: false as const },
      {},
    ]
  ) cell(`unreadOk${i++}`, { state: { n: 0 }, methods, ...cfg });
});

// `ttl` and `listensTo` are keyed BY METHOD; a bare value (`ttl: 5000` for
// "cache the whole cell") had no keys to walk and configured nothing.
Deno.test("cell(): a bare ttl or listensTo value is refused, not a silent no-op", () => {
  const methods = {
    // deno-lint-ignore require-await
    async load(s: { n: number }) {
      s.n++;
    },
    on(s: { n: number }) {
      s.n = 0;
    },
  };
  let i = 0;
  for (
    const [cfg, says] of [
      [{ ttl: 5000 }, "ttl: 5000 is not a per-method map"],
      [{ ttl: true }, "ttl: true is not a per-method map"],
      [{ listensTo: 5 }, "listensTo: 5 is not a per-method map"],
      [{ listensTo: true }, "listensTo: true is not a per-method map"],
    ] as const
  ) {
    const m = assertThrows(
      () =>
        cell(`bareMap${i++}`, { state: { n: 0 }, methods, ...cfg } as never),
      Error,
    ).message;
    assertStringIncludes(m, says);
  }
  cell(`bareMapOk${i++}`, { state: { n: 0 }, methods, ttl: { load: 5000 } });
});
