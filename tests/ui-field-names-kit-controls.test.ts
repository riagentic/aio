// `<Field label>` names the control inside it (kit.md: "A string label also
// becomes the accessible name of the control inside — unless it already has
// one"). Two holes in that promise, both with the kit's own controls:
//
//   • Switch and RadioGroup were not recognised as controls, so a Switch in a
//     Field rendered unnamed and a RadioGroup in a Field was a nameless group.
//   • A Switch with its OWN `label` keeps it. A Checkbox keeps the
//     Field's name, as 1.0.11 shipped it (`NotificationsCheckbox` is frozen).
import { assert, assertEquals } from "@std/assert";
import { h, renderToString } from "../src/air/vdom.ts";
import { Checkbox, Field } from "../src/ui/mod.ts";
import { RadioGroup, Switch } from "../src/ui/controls.ts";

const html = (v: unknown): string => renderToString(v as never);

Deno.test("Field names a Switch and a RadioGroup inside it", () => {
  const sw = html(
    h(Field as never, { label: "Dark mode" }, h(Switch as never, {})),
  );
  assert(
    /<input(?=[^>]*role="switch")(?=[^>]*aria-label="Dark mode")/.test(sw),
    `the switch takes the field's name: ${sw}`,
  );
  const rg = html(
    h(
      Field as never,
      { label: "Environment" },
      h(RadioGroup as never, { options: [{ value: "dev", label: "Dev" }] }),
    ),
  );
  assert(
    /<div(?=[^>]*role="group")(?=[^>]*aria-label="Environment")/.test(rg),
    `the radio group takes the field's name: ${rg}`,
  );
});

Deno.test("Field keeps a Switch's own label and still names a Checkbox as 1.0.11 did", () => {
  const sw = html(
    h(
      Field as never,
      { label: "Settings" },
      h(Switch as never, { label: "Dark mode" }),
    ),
  );
  assert(
    /<input(?=[^>]*role="switch")(?=[^>]*aria-label="Dark mode")/.test(sw),
    `the switch keeps its own name: ${sw}`,
  );
  // Frozen: a Checkbox in a Field is named by the Field, labelled or not.
  const cb = html(
    h(
      Field as never,
      { label: "Notifications" },
      h(Checkbox as never, { label: "Email me" }),
    ),
  );
  const names = [...cb.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  assertEquals(names, ["Notifications"], cb);
});
