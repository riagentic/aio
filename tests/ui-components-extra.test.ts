// aio/ui — Avatar, Pagination, Confirm/ConfirmButton, Toast (multi-app kit
// primitives every content/CRUD/user app otherwise re-rolls).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import {
  _resetToasts,
  Avatar,
  Confirm,
  ConfirmButton,
  Pagination,
  toast,
  ToastHost,
} from "../src/ui/mod.ts";

async function mountWithWin(App: ComponentFn) {
  const win = new Window();
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(App, { document: win.document as any });
  return { ui, win };
}

// ── Avatar ──

Deno.test("ui/Avatar: initials + deterministic color from name", async () => {
  await using ui =
    (await mountWithWin(() => h(Avatar, { name: "Ada Lovelace", size: 40 })))
      .ui;
  const html = ui.html();
  assertStringIncludes(html, "aio-avatar");
  assertStringIncludes(html, ">AL<"); // two initials
  assertStringIncludes(html, 'aria-label="Ada Lovelace"');
  assertStringIncludes(html, "hsl("); // derived color
  assertStringIncludes(html, "40px");
});

Deno.test("ui/Avatar: same name → same color (deterministic)", async () => {
  const one = (await mountWithWin(() => h(Avatar, { name: "root" }))).ui;
  const a = one.html().match(/hsl\([^)]+\)/)?.[0];
  await one.dispose();
  const two = (await mountWithWin(() => h(Avatar, { name: "root" }))).ui;
  const b = two.html().match(/hsl\([^)]+\)/)?.[0];
  await two.dispose();
  assertEquals(a, b);
  assert(a, "a color was derived");
});

Deno.test("ui/Avatar: src renders an <img> instead of initials", async () => {
  await using ui =
    (await mountWithWin(() => h(Avatar, { name: "Ada", src: "/a.png" }))).ui;
  const html = ui.html();
  assertStringIncludes(html, "aio-avatar__img");
  assertStringIncludes(html, 'src="/a.png"');
});

// ── Pagination ──

Deno.test("ui/Pagination: windows pages, marks current, clamps ends", async () => {
  const seen: number[] = [];
  const { ui, win } = await mountWithWin(() =>
    h(Pagination, {
      page: 1,
      pages: 10,
      window: 5,
      onPage: (p: number) => seen.push(p),
    })
  );
  const html = ui.html();
  assertStringIncludes(html, "aio-page__btn--current");
  // window of 5 around page 1 → pages 1..5 shown, not 10
  assertStringIncludes(html, ">5<");
  assert(!html.includes(">7<"), "page 7 is outside the window");
  // prev disabled at page 1
  const btns = [...win.document.querySelectorAll("button.aio-page__btn")];
  assert(
    (btns[0] as unknown as { disabled: boolean }).disabled,
    "prev disabled",
  );
  // click page 3
  (btns.find((b) =>
    (b as unknown as { textContent: string }).textContent === "3"
  ) as unknown as { click: () => void }).click();
  assertEquals(seen, [3]);
  await ui.dispose();
});

Deno.test("ui/Pagination: next disabled on the last page", async () => {
  const { ui, win } = await mountWithWin(() =>
    h(Pagination, { page: 4, pages: 4, onPage: () => {} })
  );
  const btns = [...win.document.querySelectorAll("button.aio-page__btn")];
  const next = btns[btns.length - 1] as unknown as { disabled: boolean };
  assert(next.disabled, "next disabled on last page");
  await ui.dispose();
});

// ── Confirm ──

Deno.test("ui/Confirm: renders message + buttons; fires the right callback", async () => {
  let confirmed = 0, cancelled = 0;
  const { ui, win } = await mountWithWin(() =>
    h(Confirm, {
      open: true,
      message: "Delete this?",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => confirmed++,
      onCancel: () => cancelled++,
    })
  );
  const html = ui.html();
  assertStringIncludes(html, "Delete this?");
  assertStringIncludes(html, "aio-btn--danger"); // danger confirm button
  const buttons = [
    ...win.document.querySelectorAll(".aio-modal__footer button"),
  ];
  const del = buttons.find((b) =>
    (b as unknown as { textContent: string }).textContent === "Delete"
  ) as unknown as { click: () => void };
  del.click();
  assertEquals(confirmed, 1);
  assertEquals(cancelled, 0);
  await ui.dispose();
});

Deno.test("ui/Confirm: closed → renders nothing", async () => {
  await using ui =
    (await mountWithWin(() =>
      h(Confirm, { open: false, onConfirm: () => {}, onCancel: () => {} })
    )).ui;
  assert(!ui.html().includes("aio-modal"), "nothing renders when closed");
});

Deno.test("ui/ConfirmButton: click opens confirm, confirm fires onConfirm once", async () => {
  let acted = 0;
  const { ui, win } = await mountWithWin(() =>
    h(ConfirmButton, {
      variant: "danger",
      confirm: "Really?",
      onConfirm: () => acted++,
      children: "Remove",
    })
  );
  // dialog not shown yet
  assert(!ui.html().includes("aio-modal"), "confirm hidden until click");
  const trigger = win.document.querySelector("button.aio-btn") as unknown as {
    click: () => void;
  };
  trigger.click();
  await ui.settle();
  assertStringIncludes(ui.html(), "Really?");
  const confirm = [
    ...win.document.querySelectorAll(".aio-modal__footer button"),
  ]
    .find((b) =>
      (b as unknown as { textContent: string }).textContent === "Confirm"
    ) as unknown as { click: () => void };
  confirm.click();
  await ui.settle();
  assertEquals(acted, 1);
  assert(!ui.html().includes("aio-modal"), "dialog closes after confirm");
  await ui.dispose();
});

// ── Toast ──

Deno.test("ui/Toast: toast() shows in ToastHost; dismiss removes it", async () => {
  _resetToasts();
  const { ui } = await mountWithWin(() => h(ToastHost, null));
  assert(!ui.html().includes("aio-toast--"), "empty at first");
  const dismiss = toast("Saved", { variant: "success", duration: 0 });
  await ui.settle();
  assertStringIncludes(ui.html(), "aio-toast--success");
  assertStringIncludes(ui.html(), "Saved");
  dismiss();
  await ui.settle();
  assert(!ui.html().includes("Saved"), "dismiss removes it");
  await ui.dispose();
  _resetToasts();
});

Deno.test("ui/Toast: error variant gets role=alert", async () => {
  _resetToasts();
  const { ui } = await mountWithWin(() => h(ToastHost, null));
  toast("Boom", { variant: "error", duration: 0 });
  await ui.settle();
  assertStringIncludes(ui.html(), 'role="alert"');
  await ui.dispose();
  _resetToasts();
});

// Every way a toast can go away must clear its auto-dismiss timer.
//
// There were two dismissal paths and only one of them did: `toast()`'s returned
// closure cleared the timer (and carried a comment saying why), while the ×
// button inside `ToastHost` filtered the queue and left it running. The × is
// the path a USER takes, so the leak lived exactly where it would actually
// happen — one live timer per dismissed toast, for the rest of its duration,
// in a helper an app calls on every save. Every existing toast test passed
// `duration: 0`, so no timer was ever armed and nothing could have caught it.
//
// Counted rather than reasoned about: arm real timers, take each dismissal
// path, and require `clearTimeout` to have matched `setTimeout` by the end.
Deno.test("ui/Toast: every dismissal path clears its auto-dismiss timer", async () => {
  _resetToasts();
  // A distinctive duration, so only the TOAST timers are counted — the
  // harness arms plenty of its own.
  const DUR = 60_000;
  let set = 0, cleared = 0;
  const armed = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout = (
    fn: unknown,
    ms?: number,
    ...a: unknown[]
  ) => {
    // deno-lint-ignore no-explicit-any
    const id = (realSet as any)(fn, ms, ...a);
    if (ms === DUR) {
      set++;
      armed.add(id);
    }
    return id;
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).clearTimeout = (id: unknown) => {
    if (armed.delete(id)) cleared++;
    // deno-lint-ignore no-explicit-any
    return (realClear as any)(id);
  };
  try {
    const { ui } = await mountWithWin(() => h(ToastHost, null));

    // Checked after EACH path, never only at the end: a later path (or the
    // reset in `finally`) would otherwise clear an earlier path's leaked timer
    // and the tally would balance while the bug stood.
    const balanced = (what: string) => {
      assertEquals(
        cleared,
        set,
        `${what} must clear the timer it armed — ${set} armed, ${cleared} ` +
          `cleared. A timer that outlives its toast is a leaked op per ` +
          `dismissal, and this helper is called on every save.`,
      );
    };

    // 1 — the returned closure.
    const dismiss = toast("by closure", { duration: DUR });
    await ui.settle();
    assertEquals(set, 1, "a toast arms exactly one auto-dismiss timer");
    dismiss();
    await ui.settle();
    balanced("the dismiss function toast() returns");

    // 2 — the × button, i.e. what a user does.
    toast("by button", { duration: DUR });
    await ui.settle();
    ui.DismissButton.click();
    await ui.settle();
    assert(!ui.html().includes("by button"), "the × must remove the toast");
    balanced("the × button in ToastHost");

    // 3 — the reset seam, with a toast still outstanding.
    toast("by reset", { duration: DUR });
    await ui.settle();
    _resetToasts();
    await ui.settle();
    balanced("_resetToasts() with a toast still outstanding");

    assertEquals(set, 3, "one timer per toast, three toasts");
    await ui.dispose();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    _resetToasts();
  }
});
