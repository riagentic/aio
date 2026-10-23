// What an agent meets first in a fresh app is `am surface` over the template's
// UI — so every element a template renders must have a NAME a reader can
// address, not the positional fallback (`Button`, `Button2`, …). The todo
// template's per-row "×" (remove) button had no letters and no label: two rows
// surfaced as `Button` and `Button2`, and `am trigger App:Button2 click`
// removed whichever row happened to be second. The assets template's prose
// rendered "served at/media/hello.txt" (a JSX line break eats the space).
// A real render of each scaffold, in a temp dir, against THIS checkout.
import "./store-sandbox.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { scaffold } from "../src/am/am-cmd-create.ts";
import { AIO_ENTRY_PATHS } from "../src/entries.ts";
import { spec } from "./module-spec-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

const PROBE = `
import { testUI } from "aio/testing";
import App from "../src/App.tsx";
import * as cells from "../src/cell.ts";
const seed = Deno.env.get("SEED");
await using ui = await testUI(App);
if (seed) { ui.seed(JSON.parse(seed)); await ui.settle(); }
const names: string[] = [];
const walk = (n: any) => {
  for (const e of n.elements ?? []) names.push(e.name);
  for (const c of n.children ?? []) walk(c);
};
const s = ui.surface();
for (const n of Array.isArray(s) ? s : [s]) walk(n);
void cells;
console.log("@@" + JSON.stringify({ names, text: ui.document.body.textContent }));
`;

async function render(
  template: "counter" | "todo" | "canvas" | "assets",
  seed?: unknown,
): Promise<{ names: string[]; text: string }> {
  const dir = await tempDir("aio-create-names-");
  try {
    for (
      const [rel, content] of Object.entries(scaffold("t", template, true))
    ) {
      if (rel === "deno.json") continue;
      const path = join(dir, rel);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
    await Deno.writeTextFile(join(dir, "tests/probe.ts"), PROBE);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: Object.fromEntries(
          Object.entries(AIO_ENTRY_PATHS).map((
            [k, v],
          ) => [k, `${spec(ROOT)}/${v}`]),
        ),
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
      }),
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", "tests/probe.ts"],
      cwd: dir,
      env: seed ? { SEED: JSON.stringify(seed) } : {},
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    const line = text.split("\n").find((l) => l.startsWith("@@"));
    if (out.code !== 0 || !line) {
      throw new Error(
        `probe failed (${out.code}):\n${text}\n${
          new TextDecoder().decode(out.stderr)
        }`,
      );
    }
    return JSON.parse(line.slice(2));
  } finally {
    await dropTempDir(dir);
  }
}

const positional = (names: string[]) =>
  names.filter((n) => /^(Button|Input|Element|Checkbox|Link)\d*$/.test(n));

Deno.test("todo template: every row's remove button is addressable by its row", async () => {
  const r = await render("todo", {
    todo: {
      items: [
        { id: 1, text: "buy milk", done: false },
        { id: 2, text: "walk dog", done: false },
      ],
      nextId: 3,
    },
  });
  assertEquals(positional(r.names), [], `names: ${r.names.join(", ")}`);
  assertEquals(
    ["RemoveBuyMilkButton", "RemoveWalkDogButton"].filter((n) =>
      !r.names.includes(n)
    ),
    [],
    `names: ${r.names.join(", ")}`,
  );
});

for (const t of ["counter", "canvas", "assets"] as const) {
  Deno.test(`${t} template: no element falls back to a positional name`, async () => {
    const r = await render(t);
    assertEquals(positional(r.names), [], `names: ${r.names.join(", ")}`);
  });
}

Deno.test("assets template: the prose keeps its space before the path", async () => {
  const r = await render("assets");
  if (!/served at \/media\/hello\.txt/.test(r.text.replace(/\s+/g, " "))) {
    throw new Error(`rendered text: ${r.text}`);
  }
});
