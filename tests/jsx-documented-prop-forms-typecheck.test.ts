// Four prop forms `docs/ui/air-components.md` documents, all of which the
// renderer handles, and none of which compiled:
//
//   className={["foo", isActive && "active"]}  — TS2322 `string | boolean`
//   style={{ color: colorSignal }}              — TS2322 `Signal<string>`
//   <select multiple value={["en", "de"]}>      — TS2322 `string[]`
//   style={{ display: hidden && "none" }}       — TS2322 `string | boolean`
//
// A doc example that fails `deno task check` in the app that copies it is
// worse than no example: the reader concludes the feature does not exist. The
// types now say what the runtime does. Pinned both ways — the fixture must
// type-check, AND each form must actually render the way the doc says, so the
// types can never again be widened past what the runtime handles.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const FIXTURE = `
import { signal } from "aio/air";
const isActive = Math.random() > 0.5;
const hidden = Math.random() > 0.5;
const colorSignal = signal("red");
const size = signal(12);
const a = <div className={["foo", isActive && "active"]} />;
const a2 = <div className={["foo", null, undefined, isActive ? "on" : ""]} />;
const b = <div style={{ color: colorSignal, fontSize: size }} />;
const c = (
  <select multiple value={["en", "de"]}>
    <option value="en">en</option>
    <option value="de">de</option>
  </select>
);
const d = <div style={{ display: hidden && "none", opacity: hidden ? 0 : null }} />;
// Widened to what the runtime handles, and no further:
// @ts-expect-error — an object is not a style value
const e1 = <div style={{ color: { a: 1 } }} />;
// @ts-expect-error — a number in a class list would render as "1"
const e2 = <div className={["foo", 1]} />;
// @ts-expect-error — a select value array holds strings/numbers only
const e3 = <select multiple value={[{ v: "en" }]} />;
export const _ = [a, a2, b, c, d, e1, e2, e3];
`;

Deno.test("jsx types: the documented className/style/select-multiple forms type-check", async () => {
  const dir = await Deno.makeTempDir();
  const repo = new URL("..", import.meta.url).pathname;
  try {
    await Deno.writeTextFile(
      `${dir}/deno.jsonc`,
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "aio",
          lib: ["deno.ns", "dom"],
        },
        imports: {
          "aio/jsx-runtime": `${repo}src/jsx-runtime.ts`,
          "aio/air": `${repo}src/air.ts`,
          "aio": `${repo}mod.ts`,
        },
      }),
    );
    await Deno.writeTextFile(`${dir}/fixture.tsx`, FIXTURE);
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["check", "-c", `${dir}/deno.jsonc`, `${dir}/fixture.tsx`],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(
      code,
      0,
      `deno check failed:\n${new TextDecoder().decode(stderr)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("jsx forms: the same four forms render the way the doc says", async () => {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const color = signal("red");
  const App = () =>
    h("div", null, [
      h("i", { id: "cls", className: ["foo", false && "active", "bar"] }),
      h("i", { id: "sig", style: { color } }),
      h("select", { id: "sel", multiple: true, value: ["en", "de"] }, [
        h("option", { value: "en" }, ["en"]),
        h("option", { value: "fr" }, ["fr"]),
        h("option", { value: "de" }, ["de"]),
      ]),
      h("i", { id: "off", style: { display: false && "none", color: "blue" } }),
      h("i", { id: "on", style: { display: true && "none" } }),
    ]);
  const handle = mount(root, App as never);
  try {
    const q = (id: string) => root.querySelector(`#${id}`);
    assertEquals(q("cls").className, "foo bar");
    assertEquals(q("sig").style.color, "red");
    color.set("green");
    handle._flush();
    assertEquals(q("sig").style.color, "green", "a raw signal is bound");
    const picked = [...q("sel").options].filter((o: { selected: boolean }) =>
      o.selected
    ).map((o: { value: string }) => o.value);
    assertEquals(picked, ["en", "de"]);
    assertEquals(q("off").style.display, "", "false means no declaration");
    assertEquals(q("off").style.color, "blue");
    assertEquals(q("on").style.display, "none");
  } finally {
    _unmount(handle);
    _setDocument(null as never);
    await closeWindow(win);
  }
});
