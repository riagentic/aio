// Two DOM-property props whose paths disagreed.
//
// `<select multiple value={["en", "de"]}>`: SSR marked both options selected,
// but every client path assigned `select.value = array` — stringified to
// "en,de", matching no option — so mount showed nothing chosen and hydrate
// WIPED the server's selection.
//
// `<option value={null|undefined}>`: mount skipped it, while hydrate and the
// incremental diff assigned `option.value = ""`, which reflects to `value=""`,
// and an option with a value attribute stops taking its value from its text —
// the form submitted "" instead of "English". null/undefined is the prop being
// absent, on every path.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom-create.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

function env() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const host = () => {
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    return el;
  };
  return { host, done: () => closeWindow(win) };
}

const picked = (root: Element) =>
  Array.from((root.querySelector("select") as HTMLSelectElement).options)
    .filter((o) => o.selected).map((o) => o.value);

const Langs = (value: unknown) => () =>
  h(
    "select",
    { multiple: true, value },
    h("option", { value: "en" }, "EN"),
    h("option", { value: "de" }, "DE"),
    h("option", { value: "fr" }, "FR"),
  );

Deno.test("select multiple: an array value selects its options on mount, hydrate and diff", async () => {
  const { host, done } = env();
  try {
    const m = host();
    mount(m, Langs(["en", "de"]));
    assertEquals(picked(m), ["en", "de"], "mount");

    const r = host();
    r.innerHTML = renderToString(h(Langs(["en", "de"]), null));
    assertEquals(picked(r), ["en", "de"], "SSR markup");
    hydrate(r, Langs(["en", "de"]));
    assertEquals(
      picked(r),
      ["en", "de"],
      "hydrate keeps the server's selection",
    );

    const s = signal<string[]>(["en"]);
    const d = host();
    const handle = mount(d, () => Langs(s.value)());
    assertEquals(picked(d), ["en"]);
    s.set(["de", "fr"]);
    handle._flush();
    assertEquals(picked(d), ["de", "fr"], "incremental diff");
    s.set([]);
    handle._flush();
    assertEquals(picked(d), [], "empty array deselects all");
    _unmount(handle);

    // A SIGNAL-valued array goes through the binder's write.
    const sig = signal<string[]>(["fr"]);
    const b = host();
    mount(b, Langs(sig));
    assertEquals(picked(b), ["fr"], "signal value on mount");
    sig.set(["en", "fr"]);
    assertEquals(picked(b), ["en", "fr"], "signal value update");
  } finally {
    await done();
  }
});

Deno.test("option value={null|undefined}: text stays the value on mount, hydrate and diff", async () => {
  const { host, done } = env();
  try {
    for (const empty of [null, undefined]) {
      const App = (v: unknown) => () =>
        h("select", null, h("option", { value: v }, "English"));
      const opt = (root: Element) =>
        root.querySelector("option") as HTMLOptionElement;

      const m = host();
      mount(m, App(empty));
      assertEquals(opt(m).value, "English", `mount ${empty}`);
      assertEquals(opt(m).hasAttribute("value"), false);

      const r = host();
      r.innerHTML = renderToString(h(App(empty), null));
      hydrate(r, App(empty));
      assertEquals(opt(r).value, "English", `hydrate ${empty}`);
      assertEquals(r.innerHTML, m.innerHTML, `hydrate == mount (${empty})`);

      const s = signal<unknown>("en");
      const d = host();
      const handle = mount(d, () => App(s.value)());
      assertEquals(opt(d).value, "en");
      s.set(empty);
      handle._flush();
      assertEquals(opt(d).value, "English", `diff "en" -> ${empty}`);
      assertEquals(d.innerHTML, m.innerHTML, `diff == mount (${empty})`);
      _unmount(handle);
    }
  } finally {
    await done();
  }
});
