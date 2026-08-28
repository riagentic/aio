// A worker cell must not be freeze-checked more loosely than a local one.
//
// `createDispatch` deep-freezes committed state when `freezeState` is on —
// `config.freezeState ?? !prod`, so ON in dev, and the boot line prints it.
// A cell WORKER builds its dispatch before the `init` message that tells it
// whether this app is in dev, and the flag was captured at construction, so a
// worker cell's committed state was never deep-frozen: it carried only Immer's
// `autoFreeze`, a narrower tripwire inside the worker than outside it, in dev
// AND prod alike. `todo.md` recorded it as a deliberate deferral; this is it,
// closed.
//
// The check is STRUCTURAL, and deliberately so. The freeze protects the
// worker's own committed-state object, which no method can reach — a method is
// handed a live proxy, and that proxy is revoked when the method ends, so every
// attempt to observe the difference from inside a method reports revocation
// rather than freezing. (The one historically observable difference — a
// non-empty `Uint8Array`, which `Object.freeze` refuses — stopped
// discriminating when `deepFreeze` started skipping typed arrays to match
// Immer, which is itself a dev==prod fix.) What IS checkable is that the owner's
// decision reaches the worker and nothing captures it too early.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const read = (p: string) => Deno.readTextFileSync(join(REPO, p));

Deno.test("dispatch reads freezeState at commit time, not at construction", () => {
  const src = read("src/state/dispatch.ts");
  // Captured in the destructure = frozen at construction, which is the bug.
  assertEquals(
    /^\s*freezeState,\s*$/m.test(src.slice(0, src.indexOf("} = deps;"))),
    false,
    "freezeState is destructured again — a worker builds its dispatch before " +
      "`init`, so a captured value is permanently the default",
  );
  assertStringIncludes(
    src,
    "deps.freezeState",
    "the commit path must read the live value off `deps`",
  );
});

Deno.test("the owner's resolved freezeState reaches a worker", () => {
  // One decider: aio.ts computes `config.freezeState ?? !prod` once, prints it
  // on the boot line, and hands THAT to the pool — rather than each isolate
  // recomputing a rule they could disagree about.
  assertStringIncludes(
    read("src/server/aio.ts"),
    "freezeState: freezeEnabled",
    "the worker pool must be given the same value the boot line prints",
  );
  assertStringIncludes(
    read("src/server/cell-worker-pool.ts"),
    "freezeState",
    "the pool must forward it to each worker",
  );
  assertStringIncludes(
    read("src/server/cell-worker.ts"),
    "freezeState: deps.freezeState",
    "the init message must carry it",
  );
});

Deno.test("the worker applies it at init, and is strict until then", () => {
  const host = read("src/server/cell-worker-host.ts");
  assertStringIncludes(
    host,
    "dispatchDeps.freezeState = msg.freezeState",
    "`init` must set the owner's value before any call can arrive",
  );
  // Before `init` the safe answer is the strict one: a worker must never be
  // MORE permissive than the isolate that spawned it, and `init` is the first
  // message it can possibly receive.
  assertStringIncludes(
    host,
    "freezeState: true",
    "the pre-init default must be the strict one",
  );
});
