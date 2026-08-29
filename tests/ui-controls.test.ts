// The alpha72 controls, driven BY KEYBOARD.
//
// A menu that opens on click and cannot be closed with Escape, tabs you cannot
// arrow between, a switch that is a styled div — those look finished and are
// not, and shipping one is worse than shipping none: an app author reasonably
// assumes the framework's own components work. So the assertions here are the
// WAI-ARIA keyboard contracts, not the rendered markup.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, mount } from "../src/air/aio-renderer.ts";
import {
  _resetControlIds,
  Alert,
  Breadcrumb,
  EmptyState,
  Menu,
  Progress,
  RadioGroup,
  Skeleton,
  Switch,
  Tabs,
  Tooltip,
} from "../src/ui/controls.ts";

/** AIR batches renders, so a test that acts and then reads must flush in
 *  between — exactly as the app does on the next frame. Returned by `render`
 *  so every case below reads committed DOM, never a stale tree. */
type Flush = () => void;

function setup() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  // happy-dom has no CSS.escape; Tabs uses it for the roving-focus lookup.
  const g = globalThis as { CSS?: { escape(s: string): string } };
  if (!g.CSS) g.CSS = { escape: (s: string) => s.replace(/[^\w-]/g, "\\$&") };
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _resetControlIds();
  return { win, doc, root, cleanup: () => win.happyDOM.close() };
}

/** Dispatch a real keydown the component's handler will see. */
function key(el: Element, k: string): void {
  const doc = el.ownerDocument!;
  const ev = new (doc.defaultView as unknown as {
    KeyboardEvent: typeof KeyboardEvent;
  }).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
}

/** Mount and hand back the flush. */
function render(root: Element, app: () => ReturnType<typeof h>): Flush {
  const handle = mount(root as HTMLElement, app) as { _flush?: () => void };
  const flush: Flush = () => handle._flush?.();
  flush();
  return flush;
}

function click(el: Element): void {
  const doc = el.ownerDocument!;
  const ev = new (doc.defaultView as unknown as { Event: typeof Event }).Event(
    "click",
    { bubbles: true, cancelable: true },
  );
  el.dispatchEvent(ev);
}

// ── Switch ───────────────────────────────────────────────────────────

Deno.test("Switch: a real checkbox with role=switch, not a styled div", async () => {
  const { root, doc, cleanup } = setup();
  const flush = render(
    root,
    () => h(Switch, { checked: true, label: "Notifications" }),
  );
  const input = root.querySelector("input")!;
  assertEquals(input.getAttribute("type"), "checkbox");
  assertEquals(
    input.getAttribute("role"),
    "switch",
    'role="switch" is what makes a reader say "on/off" instead of "checked"',
  );
  assertEquals(
    input.getAttribute("aria-label"),
    "Notifications",
    "the wrapping <label> is a valid association but invisible to a checker " +
      "reading the input's own props — name it outright",
  );
  assert(input.checked);
  await cleanup();
  void doc;
});

Deno.test("Switch: toggling reports the new value", async () => {
  const { root, cleanup } = setup();
  let got: boolean | null = null;
  const flush = render(
    root,
    () =>
      h(Switch, {
        checked: false,
        label: "x",
        onChange: (v: boolean) => (got = v),
      }),
  );
  const input = root.querySelector("input") as HTMLInputElement;
  input.checked = true;
  // AIR maps `onChange` on a form element to the "input" event (React
  // semantics — fires per interaction, not on blur). Dispatching "change"
  // here would test the DOM, not the component.
  input.dispatchEvent(
    new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event })
      .Event("input", { bubbles: true }),
  );
  assertEquals(got, true);
  await cleanup();
});

// ── RadioGroup ───────────────────────────────────────────────────────

Deno.test("RadioGroup: one shared name, so the browser gives arrow keys free", async () => {
  const { root, cleanup } = setup();
  const flush = render(root, () =>
    h(RadioGroup, {
      label: "Environment",
      value: "prod",
      options: [
        { value: "dev", label: "Dev" },
        { value: "prod", label: "Prod" },
        { value: "old", label: "Old", disabled: true },
      ],
    }));
  const inputs = [...root.querySelectorAll("input")] as HTMLInputElement[];
  assertEquals(inputs.length, 3);
  const names = new Set(inputs.map((i) => i.getAttribute("name")));
  assertEquals(
    names.size,
    1,
    "radios with different names are three separate groups — no arrow-key " +
      "navigation and no 'one of 3' announcement",
  );
  assertEquals(inputs[1]!.checked, true);
  assertEquals(inputs[2]!.disabled, true);
  const group = root.querySelector('[role="group"]')!;
  assertEquals(group.getAttribute("aria-label"), "Environment");
  await cleanup();
});

// ── Tabs ─────────────────────────────────────────────────────────────

Deno.test("Tabs: exactly one tab is in the page's tab order", async () => {
  const { root, cleanup } = setup();
  const flush = render(root, () =>
    h(Tabs, {
      label: "Sections",
      tabs: [
        { id: "a", label: "A", children: "panel a" },
        { id: "b", label: "B", children: "panel b" },
      ],
    }));
  const tabs = [...root.querySelectorAll('[role="tab"]')] as HTMLElement[];
  assertEquals(tabs.map((t) => t.getAttribute("tabindex")), ["0", "-1"]);
  assertEquals(
    tabs.map((t) => t.getAttribute("aria-selected")),
    ["true", "false"],
  );
  // Tab moves OUT of the list into the panel — that is the whole pattern.
  assertEquals(root.querySelector('[role="tabpanel"]')!.textContent, "panel a");
  await cleanup();
});

Deno.test("Tabs: arrows move, Home/End jump, disabled tabs are skipped", async () => {
  const { root, cleanup } = setup();
  const seen: string[] = [];
  const flush = render(root, () =>
    h(Tabs, {
      label: "S",
      tabs: [
        { id: "a", label: "A", children: "pa" },
        { id: "skip", label: "Skip", disabled: true, children: "ps" },
        { id: "c", label: "C", children: "pc" },
      ],
      onChange: (id: string) => seen.push(id),
    }));
  const tabs = () =>
    [...root.querySelectorAll('[role="tab"]')] as HTMLElement[];

  key(tabs()[0]!, "ArrowRight");
  assertEquals(
    seen.at(-1),
    "c",
    "a disabled tab is stepped OVER, not landed on",
  );

  key(tabs()[2]!, "ArrowRight");
  assertEquals(seen.at(-1), "a", "and the list wraps");

  key(tabs()[0]!, "End");
  assertEquals(seen.at(-1), "c");
  key(tabs()[2]!, "Home");
  assertEquals(seen.at(-1), "a");
  await cleanup();
});

Deno.test("Tabs: the panel is wired to its tab both ways", async () => {
  const { root, cleanup } = setup();
  const flush = render(
    root,
    () => h(Tabs, { tabs: [{ id: "only", label: "Only", children: "body" }] }),
  );
  const tab = root.querySelector('[role="tab"]')!;
  const panel = root.querySelector('[role="tabpanel"]')!;
  assertEquals(tab.getAttribute("aria-controls"), panel.getAttribute("id"));
  assertEquals(panel.getAttribute("aria-labelledby"), tab.getAttribute("id"));
  assert(panel.getAttribute("id"), "the association needs a real id on both");
  await cleanup();
});

// ── Menu ─────────────────────────────────────────────────────────────

Deno.test("Menu: closed by default, and says so", async () => {
  const { root, cleanup } = setup();
  const flush = render(
    root,
    () => h(Menu, { trigger: "Actions", items: [{ id: "x", label: "X" }] }),
  );
  const trigger = root.querySelector(".aio-menu__trigger")!;
  assertEquals(trigger.getAttribute("aria-haspopup"), "menu");
  assertEquals(trigger.getAttribute("aria-expanded"), "false");
  assertEquals(root.querySelector('[role="menu"]'), null);
  await cleanup();
});

Deno.test("Menu: click opens, Escape closes, and focus goes BACK to the trigger", async () => {
  const { root, doc, cleanup } = setup();
  const flush = render(root, () =>
    h(Menu, {
      trigger: "Actions",
      items: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    }));
  const trigger = root.querySelector(".aio-menu__trigger") as HTMLElement;
  click(trigger);
  flush();
  assertEquals(trigger.getAttribute("aria-expanded"), "true");
  assertEquals(root.querySelectorAll('[role="menuitem"]').length, 2);

  key(root.querySelector(".aio-menu")!, "Escape");
  flush();
  assertEquals(root.querySelector('[role="menu"]'), null);
  assertEquals(
    doc.activeElement,
    trigger,
    "returning focus to the trigger is the step people skip, and it is the " +
      "one that strands a keyboard user at the top of the document",
  );
  await cleanup();
});

Deno.test("Menu: ArrowDown on the trigger opens it", async () => {
  const { root, cleanup } = setup();
  const flush = render(
    root,
    () => h(Menu, { trigger: "A", items: [{ id: "a", label: "A" }] }),
  );
  const trigger = root.querySelector(".aio-menu__trigger") as HTMLElement;
  key(trigger, "ArrowDown");
  flush();
  assertEquals(trigger.getAttribute("aria-expanded"), "true");
  await cleanup();
});

Deno.test("Menu: Tab closes without stealing focus", async () => {
  const { root, doc, cleanup } = setup();
  const flush = render(
    root,
    () => h(Menu, { trigger: "A", items: [{ id: "a", label: "A" }] }),
  );
  const trigger = root.querySelector(".aio-menu__trigger") as HTMLElement;
  click(trigger);
  flush();
  const before = doc.activeElement;
  key(root.querySelector(".aio-menu")!, "Tab");
  flush();
  assertEquals(root.querySelector('[role="menu"]'), null);
  assertEquals(
    doc.activeElement,
    before,
    "Tab means 'leave' — pulling focus back would fight the user",
  );
  await cleanup();
});

Deno.test("Menu: selecting reports the id, and a disabled item does not", async () => {
  const { root, cleanup } = setup();
  const picked: string[] = [];
  const flush = render(root, () =>
    h(Menu, {
      trigger: "A",
      items: [{ id: "ok", label: "Ok" }, {
        id: "no",
        label: "No",
        disabled: true,
      }],
      onSelect: (id: string) => picked.push(id),
    }));
  click(root.querySelector(".aio-menu__trigger")!);
  flush();
  const items = [
    ...root.querySelectorAll('[role="menuitem"]'),
  ] as HTMLElement[];
  click(items[1]!); // disabled
  flush();
  assertEquals(picked, []);
  click(items[0]!);
  flush();
  assertEquals(picked, ["ok"]);
  await cleanup();
});

// ── Tooltip ──────────────────────────────────────────────────────────

Deno.test("Tooltip: described-by wired, and Escape dismisses it", async () => {
  const { root, cleanup } = setup();
  const flush = render(
    root,
    () => h(Tooltip, { text: "Deletes everything" }, "?"),
  );
  const bubble = root.querySelector('[role="tooltip"]')!;
  const trigger = root.querySelector(".aio-tip__trigger")!;
  assertEquals(
    trigger.getAttribute("aria-describedby"),
    bubble.getAttribute("id"),
    "`title=` never appears for a keyboard user — this is why the component " +
      "exists at all",
  );
  const tip = root.querySelector(".aio-tip")!;
  assertEquals(tip.getAttribute("data-hidden"), null);
  key(tip, "Escape");
  flush();
  assertEquals(
    root.querySelector(".aio-tip")!.getAttribute("data-hidden"),
    "",
    "a tooltip stuck over the thing you are reading is its own a11y bug",
  );
  await cleanup();
});

// ── Progress ─────────────────────────────────────────────────────────

Deno.test("Progress: determinate carries a value, indeterminate carries none", async () => {
  const { root, cleanup } = setup();
  const flush = render(
    root,
    () => h(Progress, { value: 40, max: 100, label: "Uploading" }),
  );
  const bar = root.querySelector("progress")!;
  assertEquals(bar.getAttribute("value"), "40");
  assertEquals(bar.getAttribute("aria-label"), "Uploading");
  await cleanup();

  const b = setup();
  const flush2 = render(b.root, () => h(Progress, { label: "Working" }));
  assertEquals(
    b.root.querySelector("progress")!.getAttribute("value"),
    null,
    "no value is the HONEST answer when the work has no measurable end — " +
      "not 0, which reads as stuck",
  );
  await b.cleanup();
});

Deno.test("Progress: showValue renders the percentage", async () => {
  const { root, cleanup } = setup();
  const flush = render(
    root,
    () => h(Progress, { value: 25, max: 50, showValue: true }),
  );
  assertEquals(root.querySelector(".aio-progress__value")!.textContent, "50%");
  await cleanup();
});

// ── Alert ────────────────────────────────────────────────────────────

Deno.test("Alert: only an error interrupts", async () => {
  const { root, cleanup } = setup();
  const flush = render(
    root,
    () => h(Alert, { variant: "error", title: "Failed" }, "why"),
  );
  assertEquals(root.querySelector(".aio-alert")!.getAttribute("role"), "alert");
  await cleanup();

  const b = setup();
  const flush2 = render(
    b.root,
    () => h(Alert, { variant: "success" }, "Saved"),
  );
  assertEquals(
    b.root.querySelector(".aio-alert")!.getAttribute("role"),
    "note",
    'interrupting someone to say "saved" is a bug, not an accessibility win',
  );
  await b.cleanup();
});

Deno.test("Alert: the dismiss button exists only when it does something", async () => {
  const { root, cleanup } = setup();
  const flush = render(root, () => h(Alert, {}, "no dismiss"));
  assertEquals(root.querySelector(".aio-alert__x"), null);
  await cleanup();

  const b = setup();
  let closed = false;
  const flush2 = render(
    b.root,
    () => h(Alert, { onDismiss: () => (closed = true) }, "x"),
  );
  const x = b.root.querySelector(".aio-alert__x")!;
  assertEquals(x.getAttribute("aria-label"), "Dismiss", "× is not a label");
  click(x);
  assertEquals(closed, true);
  await b.cleanup();
});

// ── Breadcrumb ───────────────────────────────────────────────────────

Deno.test("Breadcrumb: the current page is not a link to itself", async () => {
  const { root, cleanup } = setup();
  const flush = render(root, () =>
    h(Breadcrumb, {
      items: [
        { label: "Home", href: "/" },
        { label: "Apps", href: "/apps" },
        { label: "This one" },
      ],
    }));
  assertEquals(
    root.querySelector("nav")!.getAttribute("aria-label"),
    "Breadcrumb",
  );
  const links = root.querySelectorAll("a");
  assertEquals(links.length, 2, "the last crumb is text, not an anchor");
  assertEquals(
    root.querySelector('[aria-current="page"]')!.textContent,
    "This one",
  );
  const seps = root.querySelectorAll(".aio-crumbs__sep");
  assertEquals(seps.length, 2, "n-1 separators for n crumbs");
  assertEquals(
    seps[0]!.getAttribute("aria-hidden"),
    "true",
    "a separator is decoration; reading it aloud is noise",
  );
  await cleanup();
});

// ── Skeleton / EmptyState ────────────────────────────────────────────

Deno.test("Skeleton: hidden from screen readers, however many lines", async () => {
  const { root, cleanup } = setup();
  const flush = render(root, () => h(Skeleton, { lines: 3 }));
  const bars = root.querySelectorAll(".aio-skel");
  assertEquals(bars.length, 3);
  for (const b of bars) assertEquals(b.getAttribute("aria-hidden"), "true");
  assertEquals(
    root.querySelector(".aio-skel-stack")!.getAttribute("aria-hidden"),
    "true",
    "nobody wants six grey rectangles read to them",
  );
  await cleanup();
});

Deno.test("EmptyState: says what happened AND what to do", async () => {
  const { root, cleanup } = setup();
  const flush = render(root, () =>
    h(EmptyState, {
      icon: "📭",
      title: "No apps yet",
      description: "Create one to get started.",
      action: h("button", { type: "button" }, "Create"),
    }));
  assertEquals(
    root.querySelector(".aio-empty__title")!.textContent,
    "No apps yet",
  );
  assertEquals(
    root.querySelector(".aio-empty__icon")!.getAttribute("aria-hidden"),
    "true",
  );
  assert(
    root.querySelector(".aio-empty__action button"),
    "an empty table with no way out is indistinguishable from a failed load",
  );
  await cleanup();
});

// ── Found by the randomized audit (scripts/audit-round.ts 16 / 17) ──

Deno.test("Menu: aria-controls names the list ONLY while it exists", () => {
  // An `aria-controls` naming an absent id is an invalid reference: a screen
  // reader is told "this button controls element X", looks for X, and finds
  // nothing. `aria-expanded` is what says the menu is closed.
  const { root, cleanup } = setup();
  const flush = render(
    root,
    () => h(Menu, { trigger: "Actions", items: [{ id: "a", label: "A" }] }),
  );
  const trigger = root.querySelector(".aio-menu__trigger") as HTMLElement;
  assertEquals(trigger.getAttribute("aria-controls"), null, "closed");
  assertEquals(trigger.getAttribute("aria-expanded"), "false");
  click(trigger);
  flush();
  const id = trigger.getAttribute("aria-controls");
  assert(id && root.querySelector(`[id="${id}"]`), "open: it must resolve");
  return cleanup();
});

Deno.test("Tabs: every tab names the ONE panel that exists", () => {
  // Per-tab panel ids looked tidier and were invalid references: only the
  // active panel is rendered, so every INACTIVE tab claimed to control an
  // element that is not in the document. One panel, one id — the single-panel
  // variant of the WAI-ARIA tabs pattern.
  const { root, cleanup } = setup();
  render(root, () =>
    h(Tabs, {
      label: "S",
      tabs: [
        { id: "a", label: "A", children: "pa" },
        { id: "b", label: "B", children: "pb" },
        { id: "c", label: "C", children: "pc" },
      ],
    }));
  const panel = root.querySelector('[role="tabpanel"]')!;
  const tabs = [...root.querySelectorAll('[role="tab"]')] as HTMLElement[];
  assertEquals(tabs.length, 3);
  for (const t of tabs) {
    const id = t.getAttribute("aria-controls");
    assertEquals(id, panel.getAttribute("id"), "every tab names the one panel");
    assert(root.querySelector(`[id="${id}"]`), `${id} must resolve`);
  }
  // …and the panel still names the ACTIVE tab back.
  assertEquals(
    panel.getAttribute("aria-labelledby"),
    tabs[0]!.getAttribute("id"),
  );
  return cleanup();
});

Deno.test("Progress: a non-finite value degrades instead of blanking the page", () => {
  // The DOM's answer to a non-finite progress value is to THROW ("The provided
  // double value is non-finite"), which blanks the page for a number that was
  // only ever decoration.
  const { root, cleanup } = setup();
  for (const bad of [NaN, Infinity, -Infinity]) {
    const host = root.ownerDocument!.createElement("div");
    root.appendChild(host);
    render(
      host as unknown as Element,
      () => h(Progress, { value: bad, label: "x", showValue: true }),
    );
    const bar = host.querySelector("progress")!;
    assertEquals(
      bar.getAttribute("value"),
      null,
      `value=${bad} must render the indeterminate bar`,
    );
    assertEquals(
      host.querySelector(".aio-progress__value"),
      null,
      "…and not a percentage of nonsense",
    );
  }
  // A max of 0 would be a division by zero in the percentage.
  const host = root.ownerDocument!.createElement("div");
  root.appendChild(host);
  render(
    host as unknown as Element,
    () => h(Progress, { value: 5, max: 0, showValue: true }),
  );
  assertEquals(host.querySelector(".aio-progress__value"), null);
  return cleanup();
});

Deno.test("RadioGroup: each radio carries its own accessible name", () => {
  // The wrapping <label> IS a valid association and is invisible to anything
  // reading the input's own props — including this framework's dev a11y check,
  // which told authors their labelled radios had no label, about markup the
  // kit wrote and they could not change.
  const { root, cleanup } = setup();
  render(root, () =>
    h(RadioGroup, {
      label: "Env",
      value: "dev",
      options: [{ value: "dev", label: "Dev" }, {
        value: "prod",
        label: "Prod",
      }],
    }));
  const inputs = [...root.querySelectorAll("input")] as HTMLInputElement[];
  assertEquals(inputs.map((i) => i.getAttribute("aria-label")), [
    "Dev",
    "Prod",
  ]);
  return cleanup();
});
