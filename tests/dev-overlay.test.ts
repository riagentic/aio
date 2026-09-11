// The dev error overlay — the problems a page makes, ON the page.
//
// One app's MediaPipe call failed on every single frame and the only evidence
// was a counter in a panel the author happened to have written (vidtune §12.4,
// watcher §8.7). Everything aio knew was in the console and in `client.log`,
// both of which require you to be looking somewhere other than the page.
//
// The seam had existed since alpha52 — `_deliverDiag` calls `window._aioDiag`,
// "overlay when the page has one, console otherwise" — and only the console
// branch ever ran, "since nothing injects it". This is the injection, and these
// are the four rules it has to keep.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  _overlayEntries,
  _report,
  _resetDevOverlay,
  installDevOverlay,
} from "../src/browser/dev-overlay.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";

/** Deliver a diagnostic exactly the way `_deliverDiag` does — by calling
 *  `window._aioDiag`.
 *
 *  NOT through `_deliverDiag` itself, and the reason is worth recording:
 *  `protocol-diagnostics.ts` captures `_w` at MODULE LOAD (`typeof window !==
 *  "undefined"`), so under Deno it is `undefined` forever and every call
 *  returns immediately. Driving it here would either test nothing or depend on
 *  which file in the suite imported that module first — the cross-file leak
 *  this repo keeps paying for. What the overlay owns is the HOOK, so the hook
 *  is what is driven; that `_deliverDiag` calls it is that module's contract
 *  and its own tests' business. */
const deliver = (ev: Record<string, unknown>) =>
  (globalThis as D)._aioDiag?.(ev);

// deno-lint-ignore no-explicit-any
type D = any;

async function withPage(fn: (doc: D) => void | Promise<void>) {
  const win = new Window({ url: "https://localhost" });
  const prevDoc = (globalThis as D).document;
  const prevAdd = (globalThis as D).addEventListener;
  (globalThis as D).document = win.document;
  (globalThis as D).addEventListener = win.addEventListener.bind(win);
  try {
    await fn(win.document as D);
  } finally {
    _resetDevOverlay();
    setDevModeOverride(null);
    (globalThis as D).document = prevDoc;
    (globalThis as D).addEventListener = prevAdd;
    delete (globalThis as D)._aioDiag;
    await closeWindow(win);
  }
}

Deno.test("PROD carries no overlay at all", async () => {
  await withPage((doc) => {
    setDevModeOverride(false);
    installDevOverlay();
    assertEquals(
      doc.getElementById("aio-dev-overlay"),
      null,
      "a production page must not carry a dev diagnostic",
    );
    assertEquals(typeof (globalThis as D)._aioDiag, "undefined");
  });
});

Deno.test("a diagnostic reaches the page through the seam that already existed", async () => {
  await withPage((doc) => {
    setDevModeOverride(true);
    installDevOverlay();
    // Through `_deliverDiag`, not by calling `_report` — that is the path a
    // server-sent diagnostic actually takes, and the one that had no listener.
    deliver({
      type: "state-shape-drift",
      severity: "warning",
      message: "a key vanished",
      hint: "add a migration",
    });
    const root = doc.getElementById("aio-dev-overlay");
    assert(root, "the overlay must attach itself");
    const text = root.textContent ?? "";
    assert(text.includes("state-shape-drift"), text);
    assert(text.includes("a key vanished"), text);
    assert(text.includes("add a migration"), `the hint travels too: ${text}`);
  });
});

Deno.test("the SAME problem twice is one row and a count", async () => {
  // THE case that motivated this: a failure on every frame is one problem, and
  // two thousand rows of it is the same silence in a different font.
  await withPage((doc) => {
    setDevModeOverride(true);
    installDevOverlay();
    for (let i = 0; i < 500; i++) _report("error", "frame decode failed");
    assertEquals(_overlayEntries().length, 1);
    assertEquals(_overlayEntries()[0]!.count, 500);
    const text = doc.getElementById("aio-dev-overlay")!.textContent ?? "";
    assert(text.includes("x500"), `the count is the whole point: ${text}`);
  });
});

Deno.test("the list is BOUNDED — a misbehaving page must not also leak", async () => {
  await withPage(() => {
    setDevModeOverride(true);
    installDevOverlay();
    for (let i = 0; i < 200; i++) _report("error", `distinct ${i}`);
    assert(
      _overlayEntries().length <= 20,
      `unbounded: ${_overlayEntries().length}`,
    );
    // Newest first, so the thing that just happened is the thing you read.
    assertEquals(_overlayEntries()[0]!.title, "distinct 199");
  });
});

Deno.test("it never swallows the page", async () => {
  // A diagnostic that blocks the UI it is diagnosing has replaced one problem
  // with another. The root takes no pointer events; only its controls do.
  await withPage((doc) => {
    setDevModeOverride(true);
    installDevOverlay();
    _report("error", "boom");
    const root = doc.getElementById("aio-dev-overlay")!;
    assertEquals(root.style.getPropertyValue("pointer-events"), "none");
    const badge = root.firstElementChild as D;
    assertEquals(badge.style.getPropertyValue("pointer-events"), "auto");
    // Bottom-anchored, never full-screen.
    assertEquals(root.style.getPropertyValue("position"), "fixed");
    assert(root.style.getPropertyValue("inset").startsWith("auto"));
  });
});

Deno.test("an app's own _aioDiag handler is CHAINED, not replaced", async () => {
  await withPage(() => {
    setDevModeOverride(true);
    const seen: unknown[] = [];
    (globalThis as D)._aioDiag = (ev: unknown) => seen.push(ev);
    installDevOverlay();
    deliver({ type: "chained", severity: "info", message: "hello" });
    assertEquals(seen.length, 1, "the app's handler still runs");
    assertEquals(_overlayEntries().length, 1, "…and so does the overlay");
  });
});

Deno.test("installing twice is a no-op", async () => {
  await withPage((doc) => {
    setDevModeOverride(true);
    installDevOverlay();
    installDevOverlay();
    installDevOverlay();
    _report("error", "once");
    assertEquals(
      doc.querySelectorAll("#aio-dev-overlay").length,
      1,
      "three installs must not stack three overlays",
    );
  });
});

Deno.test("no document (SSR, a worker, a Deno test) is a silent no-op", () => {
  // The browser runtime loads in all three. Throwing here would take the
  // transport down in the one place it has nothing to draw on.
  const prev = (globalThis as D).document;
  delete (globalThis as D).document;
  try {
    setDevModeOverride(true);
    installDevOverlay();
    // It did not install itself, so it did not hook anything either — that is
    // what "no-op" has to mean, and asserting only "it did not throw" would
    // pass for an overlay that half-installed against a missing document.
    assertEquals(
      typeof (globalThis as D)._aioDiag,
      "undefined",
      "nothing to draw on is nothing to hook",
    );
    _report("error", "nowhere to draw");
    // …and reporting into it is still safe, and still records nothing to show.
    assertEquals(_overlayEntries().length, 1, "the report is kept");
  } finally {
    _resetDevOverlay();
    setDevModeOverride(null);
    if (prev) (globalThis as D).document = prev;
  }
});
