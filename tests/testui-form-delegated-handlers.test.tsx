// `<form onClick|onKeyDown|onInput>` must fire under testUI.
//
// happy-dom's HTMLFormElement is a Proxy (named/indexed controls). Registration
// used to key handlers by WeakMap identity; composedPath() returns a twin
// identity, so form handlers were silently dead while a wrapping <div> worked.
// the wallet moved shortcuts off the form to work around it — this pins the fix.
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";

const seen: string[] = [];
function F() {
  return (
    <div onKeyDown={() => seen.push("div")}>
      <form
        onKeyDown={() => seen.push("form keydown")}
        onClick={() => seen.push("form click")}
        onInput={() => seen.push("form input")}
      >
        <button type="button" t="C">c</button>
        <input t="I" />
      </form>
    </div>
  );
}

testUI(
  F,
  "testUI: form onKeyDown/onClick/onInput fire (happy-dom Proxy)",
  async (ui) => {
    seen.length = 0;
    await ui.C.press("4");
    await ui.C.click();
    await ui.I.type("x");
    // press/type may synthesise more than one key event; the contract is that
    // each form handler KIND runs at least once (the pre-fix silence was []).
    for (const kind of ["form keydown", "form click", "form input"]) {
      assertEquals(
        seen.includes(kind),
        true,
        `missing ${kind}; saw ${JSON.stringify(seen)}`,
      );
    }
  },
);
