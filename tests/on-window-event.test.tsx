// `onWindowEvent` — listen on the window the component is ACTUALLY mounted in.
//
// From a wallet field report (§19.2). The obvious spelling,
// `globalThis.addEventListener("mousemove", fn)`, looks right because in a
// single browser page `globalThis` IS the window. In aio it often is not: an
// Electron child window or a `<webview>` mounts a component whose window is not
// the bare global, and under testUI the mount lives in a happy-dom window while
// `globalThis` is Deno's. testUI already refuses that registration loudly — the
// remaining cost was ceremony: every component in that repo carried a
// `document.defaultView ?? globalThis` incantation, and the one place someone
// forgot it was invisible.
//
// So the fix is not to make the wrong spelling work. It is to make the right
// one short.
import { assert, assertEquals } from "@std/assert";
import { onMount, onWindowEvent, useSignal } from "../src/air/aio-renderer.ts";
import { testUI } from "../src/testing/ui-test.ts";

let heard: string[] = [];

function Dragger() {
  onWindowEvent("mousemove", (e) => heard.push(e.type));
  return <div class="stage">drag me</div>;
}

Deno.test("onWindowEvent: hears an event dispatched on the mounted window", async () => {
  heard = [];
  await using ui = await testUI(Dragger);
  await ui.settle();
  ui.window.dispatchEvent(new ui.window.Event("mousemove"));
  assertEquals(
    heard,
    ["mousemove"],
    "the handler never fired — this is the exact shape that let a drag test " +
      "pass while testing nothing",
  );
});

Deno.test("onWindowEvent: the listener is removed on unmount", async () => {
  heard = [];
  let win: { dispatchEvent: (e: Event) => boolean; Event: typeof Event };
  {
    await using ui = await testUI(Dragger);
    await ui.settle();
    win = ui.window as typeof win;
    win.dispatchEvent(new win.Event("mousemove"));
  }
  assertEquals(heard.length, 1, "the mount itself did not hear its event");
  // After teardown nothing may still be listening; a leak shows up later as
  // another test's phantom event, which is the worst way to find it.
  try {
    win.dispatchEvent(new win.Event("mousemove"));
  } catch {
    // aio-ok: a closed happy-dom window may refuse dispatch outright, which
    // proves the same thing this assertion does.
  }
  assertEquals(heard.length, 1, "the listener outlived its component");
});

Deno.test("onWindowEvent: the handler sees the LATEST render, not the first", async () => {
  // A listener registered once inside onMount closes over render 1's
  // variables forever unless the callback is read at event time. `onGlobalKey`,
  // `useRaf` and `useInterval` all solved this with a ref; this must agree, or
  // the three disagree on the same hazard.
  const seen: number[] = [];
  function Counter() {
    const n = useSignal(0);
    onWindowEvent("mousemove", () => seen.push(n.value));
    onMount(() => {
      // Two renders after mount, so the closure would be stale if frozen.
      n.set(1);
      queueMicrotask(() => n.set(2));
    });
    return <div class="count">{n.value}</div>;
  }
  await using ui = await testUI(Counter);
  await ui.settle();
  ui.window.dispatchEvent(new ui.window.Event("mousemove"));
  assertEquals(
    seen,
    [2],
    `the handler fired with a stale closure (saw ${JSON.stringify(seen)}) — ` +
      `it must read the callback at event time`,
  );
});

Deno.test("onWindowEvent: registering the WRONG way still fails loudly", async () => {
  // The ceremony is gone; the guard that made forgetting it visible is not.
  // A bare-global DOM listener is still wrong in aio's own targets (a child
  // window, a webview), so testUI must keep refusing it.
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    const Bad = () => {
      onMount(() => {
        globalThis.addEventListener("mousemove", () => {});
      });
      return <div class="bad">x</div>;
    };
    const ui = await testUI(Bad);
    let thrown: unknown;
    try {
      await ui.settle();
    } catch (e) {
      thrown = e;
    } finally {
      await ui.dispose().catch(() => {});
    }
    assert(
      thrown instanceof Error,
      "testUI stopped refusing a bare-global DOM listener — the ergonomic " +
        "fix must not cost the guard that makes the wrong form visible",
    );
    assert(
      thrown.message.includes("mousemove"),
      `the refusal names the event: ${thrown.message}`,
    );
  } finally {
    console.error = orig;
  }
});
