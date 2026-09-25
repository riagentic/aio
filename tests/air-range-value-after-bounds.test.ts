// `<input type="range" value={150} max={200}>` shows 150, whatever order the
// JSX wrote its props in.
//
// The browser sanitizes a range input's value against the bounds it has AT
// ASSIGNMENT and never re-reads what it clamped away. Props were applied in
// source order, so `value` before `max` mounted at 100 (measured in Chromium;
// `step={0.5}` turned 2.5 into 3) — while SSR, where the parser sees every
// attribute before the value, showed 150. Same vnode, two sliders.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _diff, _render, h } from "../src/air/vdom.ts";
import { signal } from "../src/state/signal.ts";

Deno.test("a range input's value is written after its min/max/step on mount and diff", async () => {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    const host = doc.createElement("div");
    const a = h("input", { type: "range", value: 150, max: 200 });
    _render(host, a, null, { doc });
    const el = host.firstChild as HTMLInputElement;
    assertEquals(el.value, "150");
    _diff(host, h("input", { type: "range", value: 220, max: 250 }), a, {
      doc,
    });
    assertEquals(el.value, "220");
  } finally {
    await closeWindow(win);
  }
});

// The same clamp through a SIGNAL bound: signal-valued props are skipped by the
// plain-prop pass and written by their binding effect AFTER it, so a plain
// `value` still landed against the default max of 100 — and a bound `value`
// before a bound `max` in the JSX was bound first, clamped the same way.
Deno.test("a range input's value lands after SIGNAL-bound min/max/step too", async () => {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    const cases: [string, Record<string, unknown>, string][] = [
      ["plain value, bound max", { max: signal(200), value: 150 }, "150"],
      ["plain value, bound min", { min: signal(-50), value: -20 }, "-20"],
      ["plain value, bound step", { step: signal(0.5), value: 2.5 }, "2.5"],
      ["bound value first, bound max", {
        value: signal(150),
        max: signal(200),
      }, "150"],
    ];
    assertEquals(cases.length, 4);
    for (const [name, props, want] of cases) {
      const host = doc.createElement("div");
      _render(host, h("input", { type: "range", ...props }), null, { doc });
      const el = host.firstChild as HTMLInputElement;
      assertEquals(el.value, want, name);
    }
  } finally {
    await closeWindow(win);
  }
});
