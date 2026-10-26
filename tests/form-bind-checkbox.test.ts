// `form.bind()` on a checkbox stored `el.value` — "on" whether ticked or not —
// so a boolean field could never be false again after the first click, and the
// box was not driven by the field (`value={false}` is the attribute "false").
import { assertEquals } from "@std/assert";
import { useForm } from "../src/air/form.ts";

const ev = (target: Record<string, unknown>) => ({ target }) as never;

Deno.test("bind: a boolean field drives `checked` and stores el.checked both ways", () => {
  const form = useForm({ agree: { initial: false } });
  const b = form.bind("agree") as unknown as Record<string, unknown>;
  assertEquals(b.checked, false);
  assertEquals("value" in b, false, "no `value` attribute text on the box");
  form.bind("agree").onInput(
    ev({ type: "checkbox", checked: true, value: "on" }),
  );
  assertEquals(form.fields.agree.value, true);
  assertEquals(
    (form.bind("agree") as unknown as { checked: boolean }).checked,
    true,
  );
  form.bind("agree").onInput(
    ev({ type: "checkbox", checked: false, value: "on" }),
  );
  assertEquals(form.fields.agree.value, false);
  assertEquals(form.fields.agree.dirty, false);
});

Deno.test("bind: spread on a radio says so (bind is not for radios)", () => {
  const form = useForm({ color: { initial: "red" } });
  const said: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    form.bind("color").onInput(
      ev({ type: "radio", checked: true, value: "red" }),
    );
  } finally {
    console.warn = w;
  }
  assertEquals(said.length, 1);
  assertEquals(
    said[0]!.includes('form.bind("color") is spread on a radio'),
    true,
  );
});
