// The harness must behave like Chromium — measured by a three-tier
// differential (happy-dom `testUI` · Chromium via `am trigger` · Chromium with
// real CDP input). Each block pins a divergence that tier found; the expected
// values are the REAL-Chromium column, and `tests/e2e-ui-parity-chromium.test.ts`
// asserts the same answers in the browser through `am trigger`.
//
//  1. A cell-bound controlled input LOST KEYSTROKES when typing outran the
//     round trip: a render carrying an older keystroke's value was written
//     back mid-word. `testUI({ latency })` reproduces the race in process.
//  2. press("Enter") implicit submission was wrong six ways.
//  3. click() never moved focus (no change/blur on the field being edited).
//  4. Key/input events had no code/keyCode, no keypress, no beforeinput, and
//     `input` was a bare Event.
//  5. type() into number/date gave three different answers.
//  6. dblclick() delivered one click; hover() no pointer events / mousemove.
//  7. Escape did not close a modal <dialog>.
//  8. happy-dom did not retarget e.target across an open shadow root.
//  9. The render-burst tripwire blamed a render for server-push/timer writes.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { mount } from "../src/air.ts";
import { onMount, useRef, useSignal } from "../src/air.ts";

// deno-lint-ignore no-explicit-any
type Ev = any;

const A40 = "abcdefghijklmnopqrstuvwxyzabcdefghijklmn";

// ── 1. keystroke echoes ───────────────────────────────────────────────

const draft = cell("hbp-draft", {
  state: { text: "" },
  methods: {
    setText(s: { text: string }, t: string) {
      s.text = t;
    },
  },
});

const CellField = () => (
  <div>
    <input
      t="Field"
      value={draft.text}
      onInput={(e: Ev) => draft.setText(e.currentTarget.value)}
    />
    <span t="Echo">{draft.text}</span>
  </div>
);

Deno.test("echo: typing faster than the round trip keeps every keystroke", async () => {
  await using ui = await testUI(CellField, { latency: 4 });
  await ui.Field.type(A40);
  await ui.expectCell(draft, (c) => c.text === A40);
  assertEquals(ui.Field.value, A40);
});

Deno.test("echo: a value the input never emitted still wins while focused", async () => {
  await using ui = await testUI(CellField, { latency: 4 });
  await ui.Field.type("abc");
  await ui.expectCell(draft, (c) => c.text === "abc");
  // A server-side rewrite (a reset, a transform) is not an echo.
  await draft.setText("RESET");
  await ui.settle();
  assertEquals(ui.Field.value, "RESET");
});

Deno.test("echo: a local signal that refuses a keystroke still corrects the field", async () => {
  const Capped = () => {
    const v = useSignal("");
    const tries = useSignal(0); // re-renders on every keystroke, refused or not
    return (
      <label>
        {tries.value}
        <input
          t="Capped"
          value={v.value}
          onInput={(e: Ev) => {
            tries.set(tries.value + 1);
            const next = e.currentTarget.value as string;
            if (next.length <= 3) v.set(next);
          }}
        />
      </label>
    );
  };
  await using ui = await testUI(Capped);
  await ui.Capped.type("abcdef");
  assertEquals(ui.Capped.value, "abc");
});

// ── 2. implicit submission ────────────────────────────────────────────

const log: string[] = [];
const sub = (tag: string) => (e: Ev) =>
  log.push(`${tag}-submit${e.submitter ? "@" + e.submitter.id : ""}`);

const EnterForms = () => (
  <div>
    <form onSubmit={sub("B1")}>
      <input t="B1In" />
      <button
        id="b1"
        t="B1Btn"
        type="submit"
        onClick={() => log.push("B1-click")}
      >
        s
      </button>
    </form>
    <form onSubmit={sub("B2")}>
      <input t="B2In" />
      <input t="B2In2" />
    </form>
    <form onSubmit={sub("B3")}>
      <input t="B3In" />
    </form>
    <form onSubmit={sub("C")}>
      <textarea
        t="CArea"
        onInput={(e: Ev) =>
          log.push(`C-input:${JSON.stringify(e.currentTarget.value)}`)}
      />
      <button type="submit">s</button>
    </form>
    <form onSubmit={sub("F")}>
      <input t="FIn" />
      <button type="submit" disabled>s</button>
    </form>
    <form onSubmit={sub("D")}>
      <input
        t="DIn"
        onChange={(e: Ev) => log.push(`D-change:${e.currentTarget.value}`)}
      />
      <button t="DBtn" type="button" onClick={() => log.push("D-click")}>
        b
      </button>
    </form>
  </div>
);

Deno.test("press Enter: HTML implicit submission, as Chromium does it", async () => {
  await using ui = await testUI(EnterForms);
  const step = async (fn: () => Promise<void>) => {
    log.length = 0;
    await fn();
    return log.join("|");
  };
  assertEquals(
    await step(() => ui.B1In.press("Enter")),
    "B1-click|B1-submit@b1",
  );
  assertEquals(
    await step(() => ui.B2In.press("Enter")),
    "",
    "two fields, no button",
  );
  assertEquals(await step(() => ui.B3In.press("Enter")), "B3-submit");
  assertEquals(await step(() => ui.CArea.press("Enter")), 'C-input:"\\n"');
  assertEquals(ui.CArea.value, "\n");
  assertEquals(
    await step(() => ui.FIn.press("Enter")),
    "",
    "disabled default button",
  );
  assertEquals(
    await step(async () => {
      await ui.DIn.type("x");
      await ui.DIn.press("Enter");
    }),
    "D-change:x|D-submit",
    "change commits before the submit",
  );
  assertEquals(
    await step(() => ui.DBtn.press("Enter")),
    "D-click",
    "Enter on a type=button",
  );
  assertEquals(
    await step(() => ui.B1Btn.press("Enter")),
    "B1-click|B1-submit@b1",
  );
  assertEquals(
    await step(() => ui.DBtn.press(" ")),
    "D-click",
    "Space clicks a button",
  );
});

// ── 3. click moves focus ──────────────────────────────────────────────

Deno.test("click: focus moves to the button, and the edited field commits first", async () => {
  const seen: string[] = [];
  const Commit = () => (
    <div>
      <input
        id="ci"
        t="Commit"
        onInput={() => {}}
        onChange={(e: Ev) => seen.push(`change:${e.currentTarget.value}`)}
      />
      <button
        id="cb"
        t="Go"
        type="button"
        onClick={() =>
          seen.push(`click active=${ui.document.activeElement?.id}`)}
      >
        go
      </button>
      <div
        t="Plain"
        role="group"
        onClick={() => seen.push("plain")}
        onKeyDown={() => {}}
      >
        p
      </div>
    </div>
  );
  // `ui` is read by the click handler, which only runs after it is assigned.
  const ui = await testUI(Commit);
  try {
    await ui.Commit.type("z");
    await ui.Go.click();
    assertEquals(seen, ["change:z", "click active=cb"]);
    await ui.Plain.click();
    assertEquals(
      ui.document.activeElement,
      ui.document.body,
      "a non-focusable click blurs",
    );
  } finally {
    await ui.dispose();
  }
});

// ── 4. event fields ───────────────────────────────────────────────────

Deno.test("type/press: code, keyCode, keypress, beforeinput and InputEvent", async () => {
  const seen: string[] = [];
  const rec = (e: Ev) =>
    seen.push(
      [e.type, e.code, e.keyCode, e.inputType, e.data].filter((x) =>
        x !== undefined && x !== "" && x !== 0 && x !== null
      ).join(" "),
    );
  const Fid = () => (
    <input
      t="Fid"
      onKeyDown={rec}
      onKeyPress={rec}
      {...({ onBeforeInput: rec } as Record<string, unknown>)}
      onInput={rec}
      onKeyUp={rec}
    />
  );
  await using ui = await testUI(Fid);
  await ui.Fid.type("a");
  await ui.Fid.press("Enter");
  assertEquals(seen, [
    "keydown KeyA 65",
    "keypress KeyA 97",
    "beforeinput insertText a",
    "input insertText a",
    "keyup KeyA 65",
    "keydown Enter 13",
    "keypress Enter 13",
    "beforeinput insertLineBreak",
    "keyup Enter 13",
  ]);
});

// ── 5. number / date ──────────────────────────────────────────────────

Deno.test("type: a number field drops letters; a date field refuses type() and takes setValue()", async () => {
  const Nums = () => {
    const n = useSignal("");
    const d = useSignal("");
    return (
      <div>
        <input
          t="Num"
          type="number"
          value={n.value}
          onInput={(e: Ev) => n.set(e.currentTarget.value)}
        />
        <input
          t="When"
          type="date"
          value={d.value}
          onInput={(e: Ev) => d.set(e.currentTarget.value)}
        />
        <span t="WhenState">{d.value}</span>
      </div>
    );
  };
  await using ui = await testUI(Nums);
  await ui.Num.type("1a2");
  assertEquals(ui.Num.value, "12");
  await assertRejects(() => ui.When.type("2024-01-05"), Error, "setValue");
  await ui.When.setValue("2024-01-05");
  assertEquals(ui.When.value, "2024-01-05");
  assertEquals(ui.WhenState.text, "2024-01-05");
});

// ── 6. dblclick / hover ───────────────────────────────────────────────

Deno.test("dblclick: two clicks then dblclick; hover: pointer events and mousemove", async () => {
  const seen: string[] = [];
  const Mouse = () => (
    <div>
      <button
        t="Dbl"
        type="button"
        onClick={(e: Ev) => seen.push(`click${e.detail}`)}
        onDblClick={(e: Ev) => seen.push(`dbl${e.detail}`)}
      >
        d
      </button>
      <div
        t="Zone"
        role="group"
        onKeyDown={() => {}}
        onPointerOver={() => seen.push("pointerover")}
        onPointerEnter={() => seen.push("pointerenter")}
        onMouseOver={() => seen.push("mouseover")}
        onMouseEnter={() => seen.push("mouseenter")}
        onMouseMove={() => seen.push("mousemove")}
      >
        z
      </div>
    </div>
  );
  await using ui = await testUI(Mouse);
  await ui.Dbl.dblclick();
  // (the first click is the native `el.click()`, whose `detail` each DOM
  // fills its own way; the second is dispatched with detail 2)
  assertEquals(seen.splice(0).map((s) => s.replace(/^click[01]$/, "click")), [
    "click",
    "click2",
    "dbl2",
  ]);
  await ui.Zone.hover();
  assertEquals(seen, [
    "pointerover",
    "pointerenter",
    "mouseover",
    "mouseenter",
    "mousemove",
  ]);
});

// ── 7. Escape closes a modal dialog ───────────────────────────────────

Deno.test("press Escape: the modal dialog gets cancel then close; a plain one stays open", async () => {
  const seen: string[] = [];
  const Modal = () => {
    const dlg = useRef<Ev>(null);
    return (
      <div>
        <dialog t="Plain" open>plain</dialog>
        <button t="Open" type="button" onClick={() => dlg.current.showModal()}>
          open
        </button>
        <dialog
          ref={dlg}
          {...({
            onCancel: () => seen.push("cancel"),
            onClose: () => seen.push("close"),
          } as Record<string, unknown>)}
        >
          <button t="Inside" type="button">x</button>
        </dialog>
      </div>
    );
  };
  await using ui = await testUI(Modal);
  await ui.Open.click();
  const modal = ui.document.querySelectorAll("dialog")[1];
  assertEquals(modal.open, true);
  await ui.Inside.press("Escape");
  assertEquals(modal.open, false);
  assertEquals(seen, ["cancel", "close"]);
  assertEquals(ui.document.querySelectorAll("dialog")[0].open, true);
});

// ── 8. shadow retargeting ─────────────────────────────────────────────

Deno.test("delegation: a shadow host's handler sees the host as e.target", async () => {
  const seen: string[] = [];
  const Inner = () => <button id="sbtn" type="button">sb</button>;
  const Host = () => {
    const host = useRef<Ev>(null);
    onMount(() => {
      const sr = host.current.attachShadow({ mode: "open" });
      mount(sr, Inner);
    });
    return (
      <div
        id="host"
        ref={host}
        role="group"
        onKeyDown={() => {}}
        onClick={(e: Ev) => seen.push(`host@${e.target.id}`)}
      />
    );
  };
  await using ui = await testUI(Host);
  const btn = ui.document.getElementById("host").shadowRoot.getElementById(
    "sbtn",
  );
  btn.click();
  await ui.settle();
  assertEquals(seen, ["host@host"]);
});

// ── 9. the tripwire names the source ──────────────────────────────────

Deno.test("burst tripwire: timer/push writes get push advice, not render advice", async () => {
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(String(a[0]));
  try {
    const Ticker = () => {
      const n = useSignal(0);
      onMount(() => {
        let k = 0;
        const id = setInterval(() => {
          n.set(++k);
          if (k >= 60) clearInterval(id);
        }, 1);
      });
      return <span t="N">{n.value}</span>;
    };
    await using ui = await testUI(Ticker);
    await ui.waitFor(() => ui.N.text === "60");
  } finally {
    console.warn = real;
  }
  const hit = warns.find((w) => w.includes("Ticker re-rendered 50 times"));
  assert(hit, `no tripwire: ${JSON.stringify(warns)}`);
  assert(hit.includes("server pushes, timers"), hit);
  assert(hit.includes("useLocal"), hit);
});
