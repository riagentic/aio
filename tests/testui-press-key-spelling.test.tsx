// The key spellings people write press the key they mean.
//
// `ui.window.press("ctrl+k")` — the spelling `am trigger window press` takes,
// printed on the same docs page — dispatched a KeyboardEvent whose `key` was
// the literal "ctrl+k". No `onGlobalKey("k", …, { mod: true })` matched it, no
// default action ran, and the test went on green having pressed nothing. The
// same for `press("enter")` (no implicit submit), `press("esc")` and
// `press("space")`. They now resolve to the real key (+ modifiers), and only
// a spelling that can mean no key at all throws.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { onGlobalKey } from "../src/air.ts";
import { testUI } from "../src/testing/ui-test.ts";

const keys = cell("press-spelling", {
  state: { palette: 0, sent: 0, plus: 0, closed: 0, spaced: 0, newline: 0 },
  methods: {
    open(s: { palette: number }) {
      s.palette++;
    },
    send(s: { sent: number }) {
      s.sent++;
    },
    zoom(s: { plus: number }) {
      s.plus++;
    },
    close(s: { closed: number }) {
      s.closed++;
    },
    spaceBar(s: { spaced: number }) {
      s.spaced++;
    },
    shiftEnter(s: { newline: number }) {
      s.newline++;
    },
  },
});

const ZERO = { palette: 0, sent: 0, plus: 0, closed: 0, spaced: 0, newline: 0 };

function App() {
  onGlobalKey("k", () => keys.open(), { mod: true, shift: false });
  onGlobalKey("+", () => keys.zoom());
  onGlobalKey("Escape", () => keys.close());
  onGlobalKey(" ", () => keys.spaceBar());
  return (
    <form
      onSubmit={(e: Event) => {
        e.preventDefault();
        keys.send();
      }}
    >
      <input
        aria-label="Message"
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" && e.shiftKey) {
            e.preventDefault();
            keys.shiftEnter();
          }
        }}
      />
    </form>
  );
}

Deno.test("chord strings press the key with its modifiers", async () => {
  await using ui = await testUI(App);
  ui.window.press("ctrl+k");
  ui.window.press("Meta+k");
  ui.window.press("ctrl+shift+k"); // shift: false — must NOT open
  ui.MessageInput.press("shift+Enter");
  await ui.expectCell(keys, (s) => s.palette === 2 && s.newline === 1);
  assertEquals((ui.fullState(keys) as typeof ZERO).sent, 0);
});

Deno.test("lowercase and short key names press the real key", async () => {
  await using ui = await testUI(App);
  ui.MessageInput.press("enter");
  ui.window.press("esc");
  ui.window.press("ESCAPE");
  ui.window.press("space");
  ui.window.press("Space");
  await ui.expectCell(
    keys,
    (s) => s.sent === 1 && s.closed === 2 && s.spaced === 2,
  );
});

Deno.test("real keys still press — modifiers, Enter and the literal +", async () => {
  await using ui = await testUI(App);
  ui.window.press("k", { ctrlKey: true });
  ui.window.press("+");
  ui.window.press("ctrl++"); // the + key with ctrl: zoom has no chord filter
  ui.MessageInput.press("Enter");
  await ui.expectCell(
    keys,
    (s) => s.palette === 1 && s.plus === 2 && s.sent === 1,
  );
});

Deno.test("mod+k presses the platform modifier with k", async () => {
  // `mod` was an unknown segment: the literal key "mod+k" was refused.
  await using ui = await testUI(App);
  ui.window.press("mod+k");
  await ui.expectCell(keys, (s) => s.palette === 1);
});

Deno.test("mod follows the DOM window's platform", async () => {
  await using ui = await testUI(App);
  const seen: string[] = [];
  ui.window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => seen.push(`${e.key}:${e.ctrlKey}:${e.metaKey}`),
  );
  // happy-dom builds `platform` from the HOST ("X11; Darwin arm64" on a Mac,
  // which `mod` read as Ctrl), so every case pins it.
  for (const platform of ["Linux x86_64", "MacIntel", "X11; Darwin arm64"]) {
    Object.defineProperty(ui.window.navigator, "platform", {
      value: platform,
      configurable: true,
    });
    ui.window.press("mod+k");
    await ui.settle();
  }
  assertEquals(seen, ["k:true:false", "k:false:true", "k:false:true"]);
});

Deno.test("releasing a modifier reports it released, as a browser does", async () => {
  // keyUp("Shift") said shiftKey:true — a real keyup of Shift says false.
  await using ui = await testUI(App);
  const seen: string[] = [];
  ui.window.addEventListener(
    "keyup",
    (e: KeyboardEvent) =>
      seen.push(`${e.key}:${e.shiftKey}${e.ctrlKey}${e.metaKey}${e.altKey}`),
  );
  for (const k of ["Shift", "Control", "Meta", "Alt"]) ui.window.keyUp(k);
  ui.window.keyUp("Shift", { ctrlKey: true, shiftKey: true });
  ui.window.press("ctrl+shift");
  ui.window.keyUp("shift+a");
  await ui.settle();
  assertEquals(seen, [
    "Shift:falsefalsefalsefalse",
    "Control:falsefalsefalsefalse",
    "Meta:falsefalsefalsefalse",
    "Alt:falsefalsefalsefalse",
    "Shift:falsetruefalsefalse",
    "Shift:falsetruefalsefalse",
    "a:truefalsefalsefalse",
  ]);
});

Deno.test("a bare modifier presses the modifier itself", async () => {
  await using ui = await testUI(App);
  const seen: string[] = [];
  ui.window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => seen.push(`${e.key}:${e.shiftKey}`),
  );
  ui.window.press("Shift");
  await ui.settle();
  assertEquals(seen, ["Shift:true"]);
});

Deno.test("a spelling that names no key is refused", async () => {
  // "a+" sent "a", "shift+a+" sent shift+a — a different key, silently.
  for (const bad of ["hyper+k", "", "a+", "shift+a+"]) {
    await using ui = await testUI(App);
    ui.window.press(bad);
    const e = await assertRejects(() => ui.settle(), Error);
    assertStringIncludes(e.message, "names no key");
    assertEquals(ui.fullState(keys), ZERO);
  }
});
