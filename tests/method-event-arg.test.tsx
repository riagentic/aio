// A DOM Event landing in a method PARAMETER is named, once, before anything
// else happens. `<input onInput={form.setTitle}>` hands `setTitle(s, v)` the
// Event, not the text; it used to surface as four warnings about symbol keys
// and frozen accessors, then a TypeError blaming "a write to cell state".
//
// Warned, NEVER refused: `onClick={counter.inc}` passes an Event too and has
// always worked (inc declares no parameter), and a client cell may take the
// Event on purpose. Refusing broke the first shape — caught before release.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { eventArgWarning } from "../src/state/event-arg.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

/** Warnings logged while `fn` runs. */
async function warnings(fn: () => Promise<void>): Promise<string[]> {
  const got: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") got.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    await fn();
  } finally {
    setLogger(prev);
  }
  return got;
}

const counter = cell("evarg-counter", {
  state: { n: 0 },
  methods: {
    inc(s: { n: number }) {
      s.n++;
    },
  },
});

function Clicker() {
  return (
    <div>
      <button class="button" onClick={counter.inc as never}>Add</button>
    </div>
  );
}

Deno.test("onClick={cell.method} with no parameter still WORKS, and says nothing", async () => {
  const got = await warnings(async () => {
    await using ui = await testUI(Clicker);
    ui.AddButton.click();
    await ui.settle();
    assertEquals(counter.n, 1);
  });
  assertEquals(got.filter((m) => m.includes("DOM")), []);
});

const form = cell("evarg-form", {
  state: { title: "" },
  methods: {
    setTitle(s: { title: string }, v: string) {
      s.title = v;
    },
  },
});

function Form() {
  return (
    <div>
      <input
        aria-label="Title"
        value={form.title}
        onInput={form.setTitle as never}
      />
    </div>
  );
}

Deno.test("a raw <input onInput={cell.method}> is named FIRST, before the confusing aftermath", async () => {
  const got = await warnings(async () => {
    await using ui = await testUI(Form);
    ui.TitleInput.type("hi");
    await ui.settle().catch(() => {}); // what follows is unchanged, and may throw
  });
  assert(got.length > 0, "a warning is said");
  assert(
    got[0]!.startsWith(
      'evarg-form.setTitle() got a DOM InputEvent ("input") as argument 1',
    ),
    got.join("\n"),
  );
  assertEquals(got.filter((m) => m.includes("got a DOM")).length, 1, "once");
});

/** A DOM-shaped event from any realm (happy-dom's is not the global Event). */
class InputEvent {
  type = "input";
  currentTarget = null;
  preventDefault() {}
  stopPropagation() {}
}

Deno.test("eventArgWarning: only an Event in a DECLARED parameter", () => {
  const ev = new InputEvent();
  const two = (_s: unknown, _a: string, _b: string) => {};
  const none = (_s: unknown) => {};
  const rest = (_s: unknown, ..._xs: unknown[]) => {};
  assertEquals(
    eventArgWarning("notes", "add", two, ["x", ev]),
    'notes.add() got a DOM InputEvent ("input") as argument 2 — a raw element ' +
      "handler passes the EVENT, not the value. If you meant the value: " +
      "onInput={(e) => notes.add(e.currentTarget.value)}, or the kit's " +
      "<Input onInput={notes.add}> (it passes the string). Said once per method.",
  );
  assertEquals(
    eventArgWarning("c", "inc", none, [ev]),
    null,
    "ignored by the method",
  );
  assert(
    eventArgWarning("c", "log", rest, [ev]) !== null,
    "a rest parameter takes it",
  );
  for (
    const args of [[], ["text", 1], [{ type: "task", title: "x" }]]
  ) assertEquals(eventArgWarning("c", "m", two, args), null);
});

const draft = cell("evarg-draft", {
  scope: "client",
  state: { title: "" },
  methods: {
    // A client cell taking the Event ON PURPOSE — it runs in the page, so it
    // works; the hint must not cry wolf here.
    onTitle(s: { title: string }, e: { currentTarget: { value: string } }) {
      s.title = e.currentTarget.value;
    },
  },
});

function Draft() {
  return (
    <div>
      <input
        aria-label="Draft"
        value={draft.title}
        onInput={draft.onTitle as never}
      />
    </div>
  );
}

Deno.test("a CLIENT cell that takes the Event on purpose works, and says nothing", async () => {
  const got = await warnings(async () => {
    await using ui = await testUI(Draft);
    ui.DraftInput.type("hey");
    await ui.settle();
    assertEquals(draft.title, "hey");
  });
  assertEquals(got.filter((m) => m.includes("got a DOM")), []);
});
