// An element ACTION called on a COMPONENT handle must name the KIND mistake.
//
// From a field report (§4): `t="SendSol"` sat on a component, so `ui.SendSol`
// resolved to a COMPONENT handle and `ui.SendSol.click()` looked "click" up as
// a CHILD NAME. The miss read:
//
//   no element or component named "click" under form/SendSolForm/Dialog/MemoField
//     available: Label, Input, …
//
// Literally accurate, aimed at the wrong question: it reads as "your handle is
// wrong" when the handle was the one thing that was right — its KIND was wrong.
// The reporter calls this the most common way to lose ten minutes in testUI,
// and it is always one INFERENCE short rather than information short.
//
// Pinned here: an action name on a component says so and points at the element
// inside it (and a sibling); a genuinely mistyped CHILD name still gets the
// original listing, which is right about it; and the action set is read off the
// element handle, so it cannot drift from the real API.
import { assert, assertThrows } from "@std/assert";
import { testUI } from "aio/testing";

function MemoField(_p: { t?: string }) {
  return (
    <div>
      <label>
        Memo<input t="SendSolMemo" onInput={() => {}} />
      </label>
    </div>
  );
}

function SendSolForm() {
  return (
    <form>
      <MemoField t="SendSol" />
      <button type="button" t="SendSolBtn" onClick={() => {}}>Send</button>
    </form>
  );
}

function Bare(_p: { t?: string }) {
  return <div>nothing to act on</div>;
}

function App() {
  return (
    <div>
      <SendSolForm />
      <Bare t="Empty" />
    </div>
  );
}

Deno.test("an element action on a component names the KIND, not the handle", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  const err = assertThrows(() =>
    (ui as Record<string, { click: () => void }>).SendSol!.click()
  ) as Error;
  const m = err.message;

  // The diagnosis the old message was one inference short of.
  assert(
    /ui\.SendSol is a COMPONENT \(MemoField\)/.test(m),
    `names the handle AND its kind: ${m}`,
  );
  assert(
    /components have no \.click\(\)/.test(m),
    `names the action that does not exist on it: ${m}`,
  );
  // It must NOT read as "your handle is wrong".
  assert(
    !/no element or component named "click"/.test(m),
    `no longer aimed at the wrong question: ${m}`,
  );
  // …and it answers "so what DO I call?" — the element inside, and a sibling.
  assert(/ui\.SendSolMemo \(its input\)/.test(m), `points inside: ${m}`);
  assert(/ui\.SendSolBtn \(a button\)/.test(m), `points beside: ${m}`);
  assert(/available:/.test(m), "still lists what IS there");
});

Deno.test("every element action gets the component diagnosis, not just click", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  const comp = (ui as Record<string, Record<string, (a?: unknown) => void>>)
    .SendSol!;
  for (const action of ["type", "press", "check", "setValue", "focus"]) {
    const e = assertThrows(() => comp[action]!("x")) as Error;
    assert(
      /is a COMPONENT \(MemoField\)/.test(e.message),
      `${action}: ${e.message}`,
    );
    assert(
      new RegExp(`components have no \\.${action}\\(\\)`).test(e.message),
      `${action} names itself: ${e.message}`,
    );
  }
});

Deno.test("a component that renders nothing actionable says that, not a dead end", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  const err = assertThrows(() =>
    (ui as Record<string, { click: () => void }>).Empty!.click()
  ) as Error;
  assert(
    /ui\.Empty is a COMPONENT \(Bare\)/.test(err.message),
    err.message,
  );
  assert(
    /renders no element you can act on/.test(err.message),
    `says why there is nothing to suggest: ${err.message}`,
  );
});

Deno.test("a genuinely unknown CHILD name keeps the original listing", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  // "MemoInput" is a plausible child name and a real typo — not an action.
  // The old message is RIGHT about this one and must survive untouched.
  const err = assertThrows(() =>
    (ui as Record<string, Record<string, { checked: boolean }>>)
      .SendSol!.MemoInput!.checked
  ) as Error;
  assert(
    /no element or component named "MemoInput" under/.test(err.message),
    `unchanged for the case it is right about: ${err.message}`,
  );
  assert(
    !/is a COMPONENT/.test(err.message),
    `the new diagnosis does not leak onto it: ${err.message}`,
  );
  assert(/available:/.test(err.message), "lists what IS there");
});
