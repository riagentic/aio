// concepts.md, rule AIO2: "a stray `cell.x = …` from a component throws … and a
// dev hint explains the rule." The hint listened for the GLOBAL `error` event —
// but a component's writes happen in event handlers, and AIR's handler wrapper
// CATCHES every throw (so one bad handler cannot take the page) and logs it. The
// global event never fired, so the hint never did either. Its pattern also
// matched only "read only": the top-level write `counter.count = 5` throws V8's
// "Cannot set property count of #<Object> which has only a getter", which names
// neither the cell nor the fix. Both writes now get the hint, from the handler.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import {
  _hintReadOnly,
  _resetReadOnlyHint,
} from "../src/air/dev-readonly-hint.ts";

const stray = cell("strayWrite", {
  state: { count: 0, box: { n: 0 } },
  methods: {},
});

function App() {
  return (
    <div>
      <button
        type="button"
        t="top"
        onClick={() => {
          (stray as unknown as { count: number }).count = 5;
        }}
      >
        top
      </button>
      <button
        type="button"
        t="deep"
        onClick={() => {
          (stray.box as { n: number }).n = 5;
        }}
      >
        deep
      </button>
    </div>
  );
}

async function hintsFor(which: "top" | "deep"): Promise<string[]> {
  _resetReadOnlyHint();
  const infos: string[] = [];
  const orig = console.info;
  console.info = (...a: unknown[]) => void infos.push(a.map(String).join(" "));
  try {
    await using ui = await testUI(App);
    ui[which].click();
    // The harness rightly refuses to pass a contained handler throw; the
    // throw is the setup here, the hint is what is under test.
    await ui.settle().catch(() => {});
  } finally {
    console.info = orig;
  }
  return infos;
}

function assertOneHint(infos: string[]): void {
  const hints = infos.filter((l) => l.includes("rule AIO2"));
  assertEquals(hints.length, 1, `hint lines: ${JSON.stringify(infos)}`);
  assert(hints[0]!.includes("call a cell method"), hints[0]);
}

Deno.test("a stray top-level state write from a click handler prints the AIO2 hint", async () => {
  assertOneHint(await hintsFor("top"));
});

Deno.test("a stray deep-level state write from a click handler prints the AIO2 hint", async () => {
  assertOneHint(await hintsFor("deep"));
});

// The same two writes, as the OTHER engines word them — an app's dev loop is
// just as often Firefox or Safari as Chromium. The pattern knew V8's wording
// only: Safari's "readonly" (no separator) and Firefox's "getter-only" printed
// no hint at all.
Deno.test("the AIO2 hint recognises every engine's read-only write error", () => {
  const messages = [
    "Cannot set property count of #<Object> which has only a getter", // V8
    "Cannot assign to read only property 'n' of object '#<Object>'", // V8
    'setting getter-only property "count"', // SpiderMonkey
    '"n" is read-only', // SpiderMonkey
    "Attempted to assign to readonly property.", // JavaScriptCore
  ];
  assertEquals(messages.length, 5);
  const g = globalThis as Record<string, unknown>;
  const wasDev = g.__aioDev;
  const orig = console.info;
  g.__aioDev = true;
  try {
    for (const m of messages) {
      _resetReadOnlyHint();
      const infos: string[] = [];
      console.info = (...a: unknown[]) =>
        void infos.push(a.map(String).join(" "));
      _hintReadOnly(new TypeError(m));
      console.info = orig;
      assertOneHint(infos);
    }
  } finally {
    console.info = orig;
    g.__aioDev = wasDev;
    _resetReadOnlyHint();
  }
});
