// The static audit's LOW tier, worked rather than filed.
//
// Twenty-six findings were read and accepted in triage and none was fixed at
// the time; most turned out to be already closed by later releases. These are
// the ones that were still true, and they are all one shape — a path that does
// the wrong thing QUIETLY, which is the class this project treats as
// disqualifying regardless of severity.
import { assert, assertEquals, assertThrows } from "@std/assert";

// ── L9: useLocal().patch() on non-object state ──────────────────────────────
//
// `patch` merged only when the current value was a non-array object and did
// NOTHING otherwise — no throw, no warning. The type says `never` for non-object
// state, so reaching it means a cast or an untyped call: precisely the case
// where a silent no-op is least likely to be noticed and most likely to be
// blamed on the framework ("useLocal doesn't update").
Deno.test("L9: patch() on non-object local state throws instead of doing nothing", async () => {
  const { useLocal } = await import("../src/adapters/air.ts");
  const { mount, _setDocument, _unmount } = await import(
    "../src/air/aio-renderer.ts"
  );
  const { h } = await import("../src/air/vdom.ts");
  const { Window } = await import("happy-dom");

  const win = new Window({ url: "https://localhost" });
  _setDocument(win.document as unknown as Document);
  const root = (win.document as unknown as Document).createElement("div");
  (win.document as unknown as Document).body.appendChild(root);

  const seen: string[] = [];
  const App = () => {
    // deno-lint-ignore no-explicit-any
    const n = useLocal(0 as any);
    // deno-lint-ignore no-explicit-any
    const arr = useLocal([] as any);
    for (const [label, l] of [["number", n], ["array", arr]] as const) {
      try {
        // deno-lint-ignore no-explicit-any
        (l as any).patch({ x: 1 });
        seen.push(`${label}: SILENT`);
      } catch (e) {
        seen.push(`${label}: ${(e as Error).message}`);
      }
    }
    return h("div", null, "x");
  };
  const handle = mount(root, App);
  try {
    assertEquals(seen.length, 2);
    assert(seen[0]!.includes("number"), seen[0]);
    assert(seen[0]!.includes(".set("), "it must name the API that DOES work");
    assert(seen[1]!.includes("an array"), seen[1]);
    for (const s of seen) assert(!s.includes("SILENT"), s);
  } finally {
    _unmount(handle);
    win.happyDOM.close();
  }
});

// ── L16: a drop reason nothing can ever emit ────────────────────────────────
//
// `"buffer-full"` sat in the callback's reason union and was never passed —
// a handler could switch on it forever and be dead code, and a reader would
// reasonably conclude aio distinguishes a case it does not.
Deno.test("L16: every declared drop reason is one the buffer can actually emit", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/sync/op-buffer.ts", import.meta.url),
  );
  const declared = src
    .match(/reason:\s*((?:"[a-z-]+"\s*\|?\s*)+),/)?.[1]
    ?.match(/"([a-z-]+)"/g)
    ?.map((q) => q.slice(1, -1)) ?? [];
  assert(declared.length > 0, "could not read the reason union");
  const emitted = new Set(
    [...src.matchAll(/onDrop\?\.\([^,]+,\s*"([a-z-]+)"\)/g)].map((m) => m[1]!),
  );
  assertEquals(
    declared.filter((r) => !emitted.has(r)),
    [],
    `declared but never emitted — a case a handler cannot be written for. ` +
      `Emitted: ${[...emitted].join(", ")}`,
  );
});

// ── L8: the auto-dismiss timer outliving a manual dismiss ───────────────────
Deno.test("L8: dismissing a toast by hand clears its auto-dismiss timer", async () => {
  const { toast } = await import("../src/ui/mod.ts");
  const live = new Set<number>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let seq = 0;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout = ((fn: () => void, ms?: number) => {
    const id = ++seq;
    live.add(id);
    realSet(() => {}, 0); // keep the loop honest; the real fn never runs here
    void fn;
    void ms;
    return id as unknown as number;
    // deno-lint-ignore no-explicit-any
  }) as any;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).clearTimeout = ((id: number) => {
    live.delete(id);
    // deno-lint-ignore no-explicit-any
  }) as any;
  try {
    const dismiss = toast("saved", { duration: 4000 });
    assertEquals(live.size, 1, "the auto-dismiss timer is armed");
    dismiss();
    assertEquals(
      live.size,
      0,
      "a toast dismissed by hand must not leave a timer running for its " +
        "full duration — an app toasts on every save",
    );
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

// ── L10: log lines emitted before init() finished ───────────────────────────
//
// `write()` returned early until the log files were ready, so everything a boot
// said before that — the config it read, the port it chose, the first error —
// never reached app.log. Invisible in development, because the CONSOLE half was
// never affected: the developer watching a terminal saw everything, and only
// the file you read after a crash was short.
Deno.test("L10: lines emitted before the log files exist are not lost", async () => {
  const { AioLogger } = await import("../src/diagnostics/logger-core.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-l10-" });
  try {
    const logger = new AioLogger({
      dir,
      console: false,
      appName: "l10",
      heartbeat: 0,
    });
    // BEFORE init resolves — the whole point.
    logger.pub("info", "boot", "the very first thing this run said");
    logger.pub("error", "boot", "and the error that happened immediately");
    await logger.init();
    await logger.flush();
    // Give the debounced writer a moment.
    await new Promise((r) => setTimeout(r, 350));
    await logger.flush();
    let text = "";
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".log")) {
        text += await Deno.readTextFile(`${dir}/${e.name}`);
      }
    }
    assert(
      text.includes("the very first thing this run said"),
      `pre-init lines must be replayed once the files exist:\n${text}`,
    );
    assert(text.includes("and the error that happened immediately"), text);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── L3: one transport queues, the other throws ──────────────────────────────
//
// The WS branch wraps `send` and enqueues on failure; the IPC branch did not,
// so a bridge that refuses the write threw synchronously out of the cell
// binding's dispatch. Same failure, two behaviours, decided by which target the
// app was built for — and IPC is Electron.
Deno.test("L3: the IPC send path guards its write like the WS path does", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/browser/browser-air-transport.ts", import.meta.url),
  );
  // The dispatch-time send: both branches must enqueue rather than escape.
  const branch = src.slice(
    src.indexOf("} else if (_ipc && _ipcConnected) {"),
  ).slice(0, 900);
  assert(
    branch.includes("try {") && branch.includes("_enqueue(tagged)"),
    `the IPC branch must queue on a refused write, like WS:\n${branch}`,
  );
});

// ── L4: an invalid config warned on every recompute ─────────────────────────
Deno.test("L4: a bad virtualList config warns once per list, not per frame", async () => {
  const { useVirtualList } = await import("../src/air/virtual-list.ts");
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
  try {
    // deno-lint-ignore no-explicit-any
    const list = useVirtualList<number>(
      { items: 42 as any, itemHeight: 20, containerHeight: 100 },
    );
    // Read the derived values repeatedly — this is what a scroll does.
    for (let i = 0; i < 25; i++) {
      void list.visible;
      void list.totalHeight;
    }
    assertEquals(
      warnings.filter((w) => w.includes("virtualList")).length,
      1,
      `one warning, not one per recompute: ${warnings.length} emitted`,
    );
  } finally {
    console.warn = realWarn;
  }
});

// A second list is a second misconfiguration and gets its own warning — the
// dedupe must be per list, not a module-wide latch that the first bad list
// closes for everyone.
Deno.test("L4: a second bad list still warns", async () => {
  const { useVirtualList } = await import("../src/air/virtual-list.ts");
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
  try {
    for (let n = 0; n < 2; n++) {
      // deno-lint-ignore no-explicit-any
      const l = useVirtualList<number>(
        { items: "nope" as any, itemHeight: 20, containerHeight: 100 },
      );
      void l.visible;
      void l.visible;
    }
    assertEquals(warnings.filter((w) => w.includes("virtualList")).length, 2);
  } finally {
    console.warn = realWarn;
  }
});

// ── L1: the enter-cleanup timer outliving its element ───────────────────────
//
// "Leaving cancels arriving" is now ONE decider in transition.ts, shared by
// <Transition> and <TransitionGroup>. It used to be written twice and the two
// copies disagreed: the group armed an UNTRACKED timeout that fired mid-exit
// and wiped the exit animation, while the component tracked its timer and
// merely CLEARED it on exit — throwing away the one thing that would ever have
// removed the keyframes the entrance injected (measured: 5 leaked <style>
// nodes in <head> over 5 toggles). Cancelling must do BOTH.
Deno.test("L1: leaving cancels arriving — one decider, and it cleans up", async () => {
  const shared = await Deno.readTextFile(
    new URL("../src/air/transition.ts", import.meta.url),
  );
  const cancel = shared.slice(shared.indexOf("export function _cancelEnter"));
  assert(
    cancel.includes("clearTimeout") && cancel.includes("_removeTransition"),
    "_cancelEnter must clear the timer AND remove the injected keyframes",
  );
  for (const file of ["transition-component.ts", "transition-group.ts"]) {
    const src = await Deno.readTextFile(
      new URL(`../src/air/${file}`, import.meta.url),
    );
    assert(
      src.includes("_trackEnter("),
      `${file} must track its enter animation through the shared decider`,
    );
    assert(
      src.includes("_cancelEnter("),
      `${file}'s exit handler must cancel a pending enter`,
    );
  }
});

// The dead-code half of L9's neighbourhood: `patch` still WORKS for the state
// it is for. A guard that breaks the happy path is worse than the no-op.
Deno.test("L9: patch() still merges object state", async () => {
  const { useLocal } = await import("../src/adapters/air.ts");
  const { mount, _setDocument, _unmount } = await import(
    "../src/air/aio-renderer.ts"
  );
  const { h } = await import("../src/air/vdom.ts");
  const { Window } = await import("happy-dom");
  const win = new Window({ url: "https://localhost" });
  _setDocument(win.document as unknown as Document);
  const root = (win.document as unknown as Document).createElement("div");
  (win.document as unknown as Document).body.appendChild(root);
  let after: Record<string, unknown> = {};
  const App = () => {
    const s = useLocal({ a: 1, b: 2 });
    s.patch({ b: 3 });
    after = s.local as Record<string, unknown>;
    return h("div", null, "x");
  };
  const handle = mount(root, App);
  try {
    assertEquals(after, { a: 1, b: 3 });
  } finally {
    _unmount(handle);
    win.happyDOM.close();
  }
});

void assertThrows;
