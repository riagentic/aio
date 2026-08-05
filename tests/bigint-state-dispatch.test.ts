// A value JSON cannot serialize (BigInt is the everyday one — ids, balances,
// nanosecond timestamps) sat in cell state. With `diagnostics: auto` the
// state differ handed it to JSON.stringify inside the OBSERVE-ONLY afterAction
// hook, which was called unguarded from the dispatch loop: the throw escaped as
// an unhandled rejection and took the process down (exit 1) — or, in the
// variant, left the method promise forever unsettled. With `diagnostics: false`
// the same app ran fine and the persist path reported the real problem loudly.
// That second behaviour is the one that must ALWAYS hold: diagnostics observe,
// they never decide, and they never break dispatch. (restart fuzzer, 2026-08)
import { assert, assertEquals } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

async function settledWithin(
  p: Promise<unknown>,
  ms: number,
): Promise<"settled" | "hung"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"hung">((r) => {
    t = setTimeout(() => r("hung"), ms);
  });
  const outcome = await Promise.race([
    p.then(() => "settled" as const, () => "settled" as const),
    timeout,
  ]);
  if (t !== undefined) clearTimeout(t);
  return outcome;
}

Deno.test("bigint state: diagnostics on — dispatch survives, the method promise settles, the real problem is reported", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bigint-state-" });
  const errors: string[] = [];
  _resetAioRuntime();
  const c = cell("bigcell", {
    state: { n: 0, big: 0n },
    methods: {
      bump(s: { n: number; big: bigint }) {
        s.n++;
        s.big += 1n;
      },
    },
  });
  const app = await aio.run({
    cells: [c],
    appId: "bigint-state",
    dbPath: `${dir}/data.db`,
    baseDir: dir,
    libraryMode: true,
    client: "server-only",
    persistDebounceMs: 1,
    // The reported repro: diagnostics at their dev defaults (state diffs,
    // action log, checkpoint) — everything that wants to serialize state.
    diagnostics: { dev: { crashHandler: false } },
    onError: (e: { message?: string }) => errors.push(e.message ?? String(e)),
  });
  const bump = (c as unknown as { bump: () => Promise<void> }).bump;
  try {
    assertEquals(
      await settledWithin(bump(), 3000),
      "settled",
      "the method promise must settle",
    );
    // still alive and still dispatching — not a wedged loop, not a dead process
    assertEquals(await settledWithin(bump(), 3000), "settled");
    const state = app.getState() as unknown as {
      bigcell: { n: number; big: bigint };
    };
    assertEquals(state.bigcell.n, 2, "both actions applied");
    assertEquals(state.bigcell.big, 2n);

    // …and the REAL problem — state that cannot be persisted — is still loud.
    await new Promise((r) => setTimeout(r, 300)); // let the debounced flush run
    assert(
      errors.some((m) => /bigint/i.test(m)),
      `the unserializable value must be reported, got: ${
        JSON.stringify(errors)
      }`,
    );
  } finally {
    await app.close();
    _resetAioRuntime();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
