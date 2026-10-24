// The accessible-name lint must agree with the SURFACE about what has a name.
// `src/air/ui-surface.ts` names a control by a wrapping `<label>`'s text, by
// `name=` and by `data-testid=` — so `<label>Email <input /></label>` is
// `EmailInput` in `am surface`, and a warning saying it "has no semantic path"
// was false. The truly unnamed control keeps its warning.
import { assertEquals } from "@std/assert";
import { checkUI } from "../aiol/checks.ts";

function unnamed(content: string): number {
  let n = 0;
  // deno-lint-ignore no-explicit-any
  const ctx: any = {
    tsxFiles: [{ relative: "src/App.tsx", ext: ".tsx", content }],
    appTsx: { relative: "src/App.tsx", ext: ".tsx", content },
    cells: [],
    denoJson: { imports: {} },
    report: (_l: string, _a: string, msg: string) => {
      if (msg.includes("accessible name")) n++;
    },
    pass: () => {},
  };
  checkUI(ctx);
  return n;
}

Deno.test("aiol accessible name: a wrapping <label> names its control", () => {
  assertEquals(unnamed(`const A = () => <label>Email <input /></label>;`), 0);
  assertEquals(
    unnamed(
      `const A = () => (\n  <label>\n    New todo\n    <input value={v} />\n  </label>\n);`,
    ),
    0,
  );
  // After the label closes, a bare control is unnamed again.
  assertEquals(
    unnamed(`const A = () => <div><label>Email</label><input /></div>;`),
    1,
  );
});

Deno.test("aiol accessible name: name= and data-testid= are names", () => {
  assertEquals(unnamed(`const A = () => <input name="email" />;`), 0);
  assertEquals(unnamed(`const A = () => <input data-testid="phone" />;`), 0);
  assertEquals(unnamed(`const A = () => <textarea name="bio"></textarea>;`), 0);
  assertEquals(unnamed(`const A = () => <input data-x="1" />;`), 1);
});
