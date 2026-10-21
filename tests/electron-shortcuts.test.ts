// jot §8: the desktop shell took Ctrl+R and Ctrl+P from every page, with no
// way out — Ctrl+R is "align right" in every word processor and a reload can
// lose unsaved work; Ctrl+P printed the whole window, chrome and all.
// `electron: { shortcuts: { reload: false, print: false } }` hands the keys
// back. The generated `before-input-event` fragment is RUN here.
import { assertEquals } from "@std/assert";
import { tmplKeyboardShortcuts } from "../src/electron/electron-shared.ts";

type Input = { type: string; key: string; control?: boolean; shift?: boolean };

function shell(s?: { reload: boolean; print: boolean }) {
  let onInput: ((e: { preventDefault(): void }, i: Input) => void) | null =
    null;
  const did: string[] = [];
  const win = {
    webContents: {
      on: (ev: string, fn: typeof onInput) => {
        if (ev === "before-input-event") onInput = fn;
      },
      reloadIgnoringCache: () => did.push("reload"),
      print: () => did.push("print"),
      toggleDevTools: () => did.push("devtools"),
    },
  };
  new Function("win", tmplKeyboardShortcuts(s))(win);
  /** Press a key; returns whether the page still gets it, and what the shell did. */
  const press = (key: string, mods: Partial<Input> = { control: true }) => {
    let taken = false;
    did.length = 0;
    onInput!({ preventDefault: () => taken = true }, {
      type: "keyDown",
      key,
      ...mods,
    });
    return { page: !taken, did: [...did] };
  };
  return press;
}

Deno.test("shortcuts: by default the shell keeps Ctrl+R / Ctrl+F5 (reload) and Ctrl+P (print)", () => {
  for (const press of [shell(), shell({ reload: true, print: true })]) {
    assertEquals(press("r"), { page: false, did: ["reload"] });
    assertEquals(press("F5"), { page: false, did: ["reload"] });
    assertEquals(press("p"), { page: false, did: ["print"] });
  }
});

Deno.test("shortcuts: reload:false / print:false leave the keys to the page; the rest stay", () => {
  const press = shell({ reload: false, print: false });
  assertEquals(press("r"), { page: true, did: [] });
  assertEquals(press("R", { control: true, shift: true }), {
    page: true,
    did: [],
  });
  assertEquals(press("F5"), { page: true, did: [] });
  assertEquals(press("p"), { page: true, did: [] });
  assertEquals(press("F12", {}), { page: false, did: ["devtools"] });

  const onlyPrint = shell({ reload: true, print: false });
  assertEquals(onlyPrint("r").did, ["reload"]);
  assertEquals(onlyPrint("p"), { page: true, did: [] });
});
