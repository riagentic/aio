// `present()`/`absent()` for a COMPONENT answer what a browser shows.
//
// The element branch honoured `hiddenReason`; the component branch only asked
// "did it render text or an element", so `<div hidden>Saved</div>` or a
// `display:none` toast was `present("Toast") === true` — and
// `waitFor(() => ui.absent("Toast"))` never fired for a toast hidden by CSS
// (docs/testing/ui-testing.md, "Presence means SHOWING").
import { assertEquals } from "@std/assert";
import { signal } from "../src/state/signal.ts";
import { testUI } from "../src/testing/ui-test.ts";

const mode = signal<"shown" | "none" | "hidden" | "invisible" | "button">(
  "shown",
);

function Toast() {
  const m = mode.value;
  if (m === "none") return <div style={{ display: "none" }}>Saved</div>;
  if (m === "hidden") return <div hidden>Saved</div>;
  if (m === "invisible") {
    return <div style={{ visibility: "hidden" }}>Saved</div>;
  }
  if (m === "button") {
    return (
      <div style={{ display: "none" }}>
        <button type="button">Undo</button>
      </div>
    );
  }
  return <div>Saved</div>;
}

/** Hidden wrapper, visible child: `visibility` is overridable, so it shows. */
function Peek() {
  return (
    <div style={{ visibility: "hidden" }}>
      <span style={{ visibility: "visible" }}>Peek</span>
    </div>
  );
}

function App() {
  return (
    <main>
      <Toast />
      <Peek />
    </main>
  );
}

Deno.test("present(): a component hidden by CSS is absent", async () => {
  mode.set("shown");
  await using ui = await testUI(App);
  assertEquals(ui.present("Toast"), true, "baseline: visible text shows");
  for (const m of ["none", "hidden", "invisible", "button"] as const) {
    mode.set(m);
    await ui.settle();
    assertEquals(ui.present("Toast"), false, `${m}: nothing on screen`);
    assertEquals(ui.absent("Toast"), true, `${m}: absent`);
  }
  mode.set("shown");
  await ui.waitFor(() => ui.present("Toast"));
  assertEquals(ui.present("Peek"), true, "a visibility:visible child shows");
});
