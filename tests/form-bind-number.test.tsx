// A NUMBER field bound to a number control holds a number.
//
// `bind()`'s onInput stored `e.target.value` — always a string — so
// `useForm({ age: { initial: 41 } })` held "42" after one keystroke while its
// type (and `bindInput`, whose whole point is `value: number`) said number:
// `bindInput(form, "age").value + 1` was "421" and `values().age` failed a
// `=== 42`, with no error anywhere. A number/range control only holds a
// numeric string or "", so it is parsed; an empty one is NaN (what
// `valueAsNumber` answers), shown as an empty field and not counted as drift.
import { assertEquals } from "@std/assert";
import { bindInput, useForm } from "../src/air.ts";
import { testUI } from "../src/testing/ui-test.ts";

const form = useForm({
  age: { initial: 41 },
  code: { initial: 7 },
  name: { initial: "" },
});

const App = () => (
  <form onSubmit={() => {}}>
    <input type="number" aria-label="Age" {...bindInput(form, "age")} />
    <input aria-label="Code" {...bindInput(form, "code")} />
    <input aria-label="Name" {...bindInput(form, "name")} />
  </form>
);

testUI(
  App,
  "a number field bound to a number input stores numbers",
  async (ui) => {
    const warns: string[] = [];
    const keep = console.warn;
    console.warn = (...a: unknown[]) =>
      void warns.push(a.map(String).join(" "));
    try {
      ui.AgeInput.clear();
      ui.AgeInput.type("42");
      await ui.settle();
      assertEquals(form.values().age, 42);
      assertEquals(bindInput(form, "age").value + 1, 43);
      assertEquals(form.fields.age.dirty, true);

      ui.AgeInput.clear();
      await ui.settle();
      assertEquals(Number.isNaN(form.values().age), true, "empty is NaN");
      const el = ui.document.querySelector(
        "input[aria-label=Age]",
      ) as HTMLInputElement;
      assertEquals(el.value, "", "NaN shows as an empty field");
      await new Promise((r) => setTimeout(r, 1_200));
      assertEquals(
        warns.filter((w) => w.includes("did not store")),
        [],
        "an empty number field is not drift",
      );

      // Not a number control: the string it has always stored.
      ui.CodeInput.clear();
      ui.CodeInput.type("8");
      ui.NameInput.type("ann");
      await ui.settle();
      assertEquals(form.values().code as unknown, "8");
      assertEquals(form.values().name, "ann");
    } finally {
      console.warn = keep;
    }
  },
);
