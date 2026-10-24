// A controlled input whose CELL method stores nothing new — a server-side cap
// (`s.code = v.slice(0, 3)`), an upper-casing that lands on the value already
// held, a refusal — answers with no state change, so nothing re-renders and
// the field keeps text the state does not hold. The local-handler version of
// this has warned in dev since the drift check landed (control-drift.ts); a
// handler that started a call was skipped as "decides later" and then never
// looked at again once it HAD decided: the screen said "abcdef", the cell said
// "abc", and nothing said anything. Dev now checks once the field's own calls
// have answered — observe-only, as before (prod and the DOM are unchanged).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const c = cell("drift-after-call", {
  state: { code: "", name: "" },
  methods: {
    cap: (s: { code: string }, v: string) => void (s.code = v.slice(0, 3)),
    store: (s: { name: string }, v: string) => void (s.name = v),
  },
});

const App = () => (
  <div>
    <input
      aria-label="Code"
      value={c.code}
      onInput={(e: Event) => c.cap((e.target as HTMLInputElement).value)}
    />
    <input
      aria-label="Name"
      value={c.name}
      onInput={(e: Event) => c.store((e.target as HTMLInputElement).value)}
    />
  </div>
);

function captureWarns(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const keep = console.warn;
  console.warn = (...a: unknown[]) => {
    const s = a.map(String).join(" ");
    if (s.includes("did not store the typed value")) warns.push(s);
    else keep(...a);
  };
  return { warns, restore: () => void (console.warn = keep) };
}

testUI(
  App,
  "a cell call that stored nothing new warns once it has answered",
  async (ui) => {
    const w = captureWarns();
    try {
      ui.CodeInput.type("abcdef");
      await ui.expectCell(c, (s) => s.code === "abc");
      await sleep(1_300);
      const el = ui.document.querySelector(
        "input[aria-label=Code]",
      ) as HTMLInputElement;
      assertEquals(
        el.value,
        "abcdef",
        "observe-only: the DOM is not rewritten",
      );
      assertEquals(w.warns.length, 1, w.warns.join("\n"));
      assert(w.warns[0]!.includes('aria-label="Code"'), w.warns[0]);
    } finally {
      w.restore();
    }
  },
);

testUI(
  App,
  "a cell call that stored the typed value stays quiet",
  async (ui) => {
    const w = captureWarns();
    try {
      ui.NameInput.type("abcdef");
      await ui.expectCell(c, (s) => s.name === "abcdef");
      await sleep(1_300);
      assertEquals(w.warns, []);
    } finally {
      w.restore();
    }
  },
);
