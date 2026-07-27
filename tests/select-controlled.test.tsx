// llama.md #10: `<select value={x}>` did not reliably reflect state once the
// options re-rendered — the model dropdown showed one model while the command
// below it ran another. The reporter had to add `selected` on every <option>.
// That is the standard controlled-select pattern, so if it needs a workaround
// the framework is wrong.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

type S = { models: string[]; picked: string };

const models = cell("select-models", {
  state: { models: ["a.gguf", "b.gguf"], picked: "a.gguf" } as S,
  methods: {
    load(s: S, list: string[]) {
      s.models = list;
    },
    pick(s: S, id: string) {
      s.picked = id;
    },
  },
});

function App() {
  return (
    <select id="model" value={models.picked}>
      {models.models.map((m) => <option value={m}>{m}</option>)}
    </select>
  );
}

Deno.test("select: value reflects state after the options re-render", async () => {
  await using ui = await testUI(App);
  // The surface reports live element values — the same view `am surface` gives.
  const el = () => {
    const s = ui.surface();
    const found = JSON.stringify(s).match(/"value":"([^"]*)"/);
    return { value: found?.[1] ?? "" };
  };

  assertEquals(el().value, "a.gguf", "initial controlled value");

  // The state changes…
  models.pick("b.gguf");
  await ui.settle();
  assertEquals(el().value, "b.gguf", "value follows state");

  // …and now the OPTION LIST re-renders under it, which is where it broke:
  // new option nodes are created and the select's value was left behind.
  models.load(["a.gguf", "b.gguf", "c.gguf"]);
  await ui.settle();
  assertEquals(
    el().value,
    "b.gguf",
    "after the options re-render the select must still show the state's value " +
      "— a dropdown showing one model while the app runs another is the bug",
  );

  // And a state change to a value that only exists in the NEW list.
  models.pick("c.gguf");
  await ui.settle();
  assertEquals(el().value, "c.gguf");
});
