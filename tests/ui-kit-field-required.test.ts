// `<Field required>` tells assistive tech, not only the eye.
//
// It painted " *" inside the label and nothing more — and the control's
// accessible name is the bare label (Field sets `aria-label` without the
// asterisk), so a screen reader announced a required field as optional.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h, renderToString } from "../src/air/vdom.ts";
import {
  Checkbox,
  Field,
  Input,
  RadioGroup,
  Select,
  Switch,
} from "../src/ui/mod.ts";

const html = (child: ReturnType<typeof h>, required = true) =>
  renderToString(h(Field, { label: "Email", required }, child));

Deno.test("Field required: the control is aria-required", () => {
  for (
    const c of [
      h(Input, {}),
      h(Select, { options: ["a"] }),
      h("textarea", null),
    ]
  ) {
    assertStringIncludes(html(c), 'aria-required="true"');
  }
  assertStringIncludes(
    html(h(Checkbox, { label: "x" })),
    'aria-required="true"',
  );
});

Deno.test("Field required: not said when not required, nor where the role cannot take it", () => {
  assert(!html(h(Input, {}), false).includes("aria-required"));
  assert(!html(h(Switch, {})).includes("aria-required"));
  assert(
    !html(h(RadioGroup, { options: [{ value: "a", label: "A" }] })).includes(
      "aria-required",
    ),
  );
});

Deno.test("Field required: the control's own say wins", () => {
  assertStringIncludes(
    html(h(Input, { "aria-required": "false" })),
    'aria-required="false"',
  );
  const native = html(h("input", { required: true }));
  assertEquals(native.includes("aria-required"), false);
  assertStringIncludes(native, " required");
});
