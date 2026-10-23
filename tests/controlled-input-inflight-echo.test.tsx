// A controlled input bound to a cell keeps every keystroke while its calls are
// in flight, even when a parent re-renders mid-flight.
//
// `<input value={c.x} onInput={(e) => c.set(e.target.value)}>` — an inline
// arrow, so the auto-memo never skips it — under a parent that re-renders
// while the call is out (a `$pending` sibling, a ticking clock). Every such
// render re-asserted the STALE prop: the value from before the first
// keystroke, or an older keystroke's echo, written over newer typed text. Real
// Chromium over a socket, "abcdef" typed at 40 ms against a 120 ms method,
// stored "cf". While a call is in flight, a value the field showed before the
// edit or one the user typed past is an echo, not an answer — not written.
// Anything else (a server rewrite, a reset) is written as before, and once
// every call has answered the state wins again (a refusal snaps back).
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { signal } from "../src/air.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { Input } from "../src/ui/mod.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const c = cell("ctl-inflight", {
  state: { name: "", n: 0 as number | null, done: false },
  methods: {
    async setSlow(s: { name: string }, v: string) {
      await sleep(60);
      s.name = v;
    },
    async setTrim(s: { name: string }, v: string) {
      await sleep(60);
      s.name = v.trim();
    },
    async refuse(_s: { name: string }, _v: string) {
      await sleep(30);
    },
    async setNum(s: { n: number | null }, v: string) {
      await sleep(60);
      const n = parseFloat(v);
      s.n = Number.isFinite(n) ? n : null;
    },
    async long(_s: { name: string }) {
      await sleep(600);
    },
    async refuseDone(_s: { done: boolean }, _v: boolean) {
      await sleep(30);
    },
    setSync(s: { name: string; n: number | null }, v: string) {
      s.name = v;
      s.n = 0;
    },
  },
});

/** Types like a user: append, fire `input`, wait `gap`. Returns what the
 *  field showed after each key. */
async function typeFast(sel: string, text: string, gap: number) {
  const el = document.querySelector(sel) as HTMLInputElement;
  el.focus();
  const Ev = (el.ownerDocument.defaultView as unknown as {
    InputEvent: typeof InputEvent;
  }).InputEvent;
  // A number field sanitizes a partial "-" to "", so it is given each
  // keystroke's whole text, as a browser holds it; a text field appends.
  const num = el.type === "number";
  const snaps: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    el.value = num ? text.slice(0, i + 1) : el.value + ch;
    el.dispatchEvent(new Ev("input", { bubbles: true, data: ch }));
    await sleep(gap);
    snaps.push(el.value);
  }
  return snaps;
}

const tick = signal(0);

const App = () => (
  <div>
    <input
      class="raw"
      aria-label="Raw"
      value={c.name}
      onInput={(e: Event) => c.setSlow((e.target as HTMLInputElement).value)}
    />
    <Input
      class="kit"
      aria-label="Kit"
      value={c.name}
      onInput={(v: string) => c.setSlow(v)}
    />
    <input
      class="trim"
      aria-label="Trim"
      value={c.name}
      onInput={(e: Event) => c.setTrim((e.target as HTMLInputElement).value)}
    />
    <input
      class="refuse"
      aria-label="Refuse"
      value={c.name}
      onInput={(e: Event) => c.refuse((e.target as HTMLInputElement).value)}
    />
    <input
      class="num"
      type="number"
      aria-label="Num"
      value={c.n ?? ""}
      onInput={(e: Event) => c.setNum((e.target as HTMLInputElement).value)}
    />
    <input
      class="box"
      type="checkbox"
      aria-label="Box"
      checked={c.done}
      onChange={(e: Event) =>
        c.refuseDone((e.target as HTMLInputElement).checked)}
    />
    <span>
      {(c as unknown as { $pending(): number }).$pending() ? "saving" : "idle"}
    </span>
    <span>{tick.value % 2 ? "x" : "y"}</span>
  </div>
);

/** Re-render the parent every few ms for `ms`. */
function ticking(ms: number): Promise<void> {
  const id = setInterval(() => tick.set(tick.peek() + 1), 5);
  return sleep(ms).then(() => clearInterval(id));
}

const val = (sel: string) =>
  (document.querySelector(sel) as HTMLInputElement).value;

for (const sel of ["input.raw", ".kit input, input.kit"]) {
  testUI(
    App,
    `in-flight typing under parent re-renders keeps every key (${sel})`,
    async (ui) => {
      const t = ticking(600);
      const snaps = await typeFast(sel, "abcdef", 20);
      await t;
      await ui.settle();
      await ui.expectCell(c, (s) => s.name === "abcdef");
      assertEquals(snaps, ["a", "ab", "abc", "abcd", "abcde", "abcdef"]);
      assertEquals(val(sel), "abcdef");
      c.setSync("");
      await ui.expectCell(c, (s) => s.name === "");
    },
  );
}

testUI(
  App,
  "a trimming handler still normalizes once its call answers",
  async (ui) => {
    await typeFast("input.trim", "a b ", 10);
    await ui.expectCell(c, (s) => s.name === "a b");
    tick.set(tick.peek() + 1);
    await ui.settle();
    assertEquals(val("input.trim"), "a b");
    c.setSync("");
    await ui.expectCell(c, (s) => s.name === "");
  },
);

testUI(App, "a refusal snaps back once its call has answered", async (ui) => {
  const t = ticking(200);
  await typeFast("input.refuse", "xy", 10);
  await t;
  await ui.settle();
  tick.set(tick.peek() + 1);
  await ui.settle();
  assertEquals(val("input.refuse"), "");
});

testUI(
  App,
  "an unrelated long call does not hold back this field's refusal",
  async (ui) => {
    // Only the calls this field's own keystrokes started count as "in
    // flight" for it — an upload elsewhere is not its echo.
    const long = c.long();
    await typeFast("input.refuse", "x", 10);
    await sleep(80); // the refusal has answered; `long` has not
    tick.set(tick.peek() + 1);
    await sleep(20);
    assertEquals(val("input.refuse"), "", "the refusal shows while long runs");
    await long;
    await ui.settle();
  },
);

testUI(
  App,
  "a call started elsewhere AFTER the first keystroke is not the field's",
  async (ui) => {
    await typeFast("input.refuse", "x", 5);
    const long = c.long(); // a poll / an autosave, mid-typing
    await sleep(80);
    tick.set(tick.peek() + 1);
    await sleep(20);
    assertEquals(val("input.refuse"), "", "the refusal shows while long runs");
    await long;
    await ui.settle();
  },
);

testUI(
  App,
  "a number field keeps '1.5' and '-1.5' while in flight",
  async (ui) => {
    const t = ticking(400);
    await typeFast("input.num", "1.5", 15);
    await t;
    await ui.expectCell(c, (s) => s.n === 1.5);
    assertEquals(val("input.num"), "1.5");
    c.setSync("");
    await ui.expectCell(c, (s) => s.n === 0);
    const el = document.querySelector("input.num") as HTMLInputElement;
    el.value = "";
    const t2 = ticking(400);
    await typeFast("input.num", "-1.5", 15);
    await t2;
    await ui.expectCell(c, (s) => s.n === -1.5);
    assertEquals(val("input.num"), "-1.5");
  },
);

testUI(
  App,
  "a refused raw checkbox snaps back on the next render (as 1.0.23)",
  async (ui) => {
    const box = document.querySelector("input.box") as HTMLInputElement;
    box.click();
    await sleep(60);
    await ui.settle();
    tick.set(tick.peek() + 1);
    await ui.settle();
    assertEquals(box.checked, false);
  },
);
