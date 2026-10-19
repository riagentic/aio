// `present()` answers what a browser shows (feedback cc §4, docs/upgrade
// README): a `hidden` element is absent — unless author CSS gives it a
// `display`, which beats the UA `[hidden] { display: none }`, and a real
// browser then shows it too.
import { assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";

function App() {
  return (
    <div>
      <style>{".mic { display: grid; }"}</style>
      <button type="button" t="plain" hidden>a</button>
      <button type="button" t="styled" class="mic" hidden>b</button>
    </div>
  );
}

Deno.test("present(): a hidden element is absent unless author CSS shows it", async () => {
  await using ui = await testUI(App);
  assertEquals(ui.present("plain"), false);
  assertEquals(ui.present("styled"), true);
});
