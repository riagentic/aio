// `<select value={x}>` did not reliably reflect state once the
// options re-rendered — the model dropdown showed one model while the command
// below it ran another. The reporter had to add `selected` on every <option>.
// That is the standard controlled-select pattern, so if it needs a workaround
// the framework is wrong.
//
// The original version of this test started with `picked` on the FIRST option,
// so its "initial controlled value" assertion was satisfied by the browser's
// own default and proved nothing. The initial render was in fact the WORST
// case: `createDom` applies props BEFORE it builds children, so `.value` was
// assigned to a `<select>` with no `<option>`s yet, the browser discarded it,
// and the control opened on the wrong entry — on mount, and on every
// server-rendered page. It starts on the second option now, so every assertion
// below can fail.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { _diff, _render, h, renderToString } from "../src/air/vdom.ts";
import { _hydrateNode } from "../src/air/renderer-hydrate.ts";

type S = { models: string[]; picked: string };

const models = cell("select-models", {
  state: { models: ["a.gguf", "b.gguf"], picked: "b.gguf" } as S,
  methods: {
    load(s: S, list: string[]) {
      s.models = list;
    },
    pick(s: S, id: string) {
      s.picked = id;
    },
  },
});

function App() {
  return (
    <select id="model" value={models.picked}>
      {models.models.map((m) => <option value={m}>{m}</option>)}
    </select>
  );
}

Deno.test("select: value reflects state after the options re-render", async () => {
  await using ui = await testUI(App);
  // The surface reports live element values — the same view `am surface` gives.
  const el = () => {
    const s = ui.surface();
    const found = JSON.stringify(s).match(/"value":"([^"]*)"/);
    return { value: found?.[1] ?? "" };
  };

  // NOT the first option — the mount-time assignment has to have landed.
  assertEquals(
    el().value,
    "b.gguf",
    "the very first render must already show the state's value, not the " +
      "first <option> — a select whose options are built in the same pass as " +
      "its value is every controlled select there is",
  );

  // The state changes…
  models.pick("a.gguf");
  await ui.settle();
  assertEquals(el().value, "a.gguf", "value follows state");

  // …and now the OPTION LIST re-renders under it, which is where it broke:
  // new option nodes are created and the select's value was left behind.
  models.load(["a.gguf", "b.gguf", "c.gguf"]);
  await ui.settle();
  assertEquals(
    el().value,
    "a.gguf",
    "after the options re-render the select must still show the state's value " +
      "— a dropdown showing one model while the app runs another is the bug",
  );

  // And a state change to a value that only exists in the NEW list.
  models.pick("c.gguf");
  await ui.settle();
  assertEquals(el().value, "c.gguf");
});

// ── the renderer-level shapes ────────────────────────────────────────────

function env() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  return {
    doc,
    ctx: { doc },
    host: doc.createElement("main"),
    cleanup: () => win.happyDOM.close(),
  };
}

const select = (value: string, opts: string[]) =>
  h(
    "select",
    { value },
    ...opts.map((o) => h("option", { value: o }, o)),
  );

Deno.test("select: mount selects the option the value names, not the first one", () => {
  const { ctx, host, cleanup } = env();
  try {
    _render(host, select("b", ["a", "b", "c"]), null, ctx);
    // deno-lint-ignore no-explicit-any
    const sel = host.firstChild as any;
    assertEquals(sel.value, "b");
    assertEquals(sel.selectedIndex, 1);
  } finally {
    cleanup();
  }
});

Deno.test("select: a diff that creates the options AND sets the value in one pass lands", () => {
  const { ctx, host, cleanup } = env();
  try {
    // Starts with no options at all — the list arrives with the value, which is
    // what an async load looks like.
    const empty = select("", []);
    _render(host, empty, null, ctx);
    _diff(host, select("c", ["a", "b", "c"]), empty, ctx);
    // deno-lint-ignore no-explicit-any
    const sel = host.firstChild as any;
    assertEquals(
      sel.value,
      "c",
      "props were applied before the child diff created the <option>s",
    );
    assertEquals(sel.selectedIndex, 2);
  } finally {
    cleanup();
  }
});

Deno.test("select: a hydrated select shows the state's option (SSR ≡ mount)", () => {
  const { ctx, host, cleanup } = env();
  try {
    const v = select("c", ["a", "b", "c"]);
    const html = renderToString(v);
    // `value` is not a <select> content attribute — the client writes it as a
    // DOM property, so SSR must not invent an attribute the client never sets.
    assert(
      !/<select[^>]*\bvalue=/.test(html),
      `SSR emitted a value attribute the client renderer never produces: ${html}`,
    );
    host.innerHTML = html;
    const consumed = _hydrateNode(host, v, ctx, false, 0);
    assert(consumed >= 0, "SSR output must hydrate without a mismatch");
    // deno-lint-ignore no-explicit-any
    const sel = host.firstChild as any;
    assertEquals(
      sel.value,
      "c",
      "a server-rendered controlled select showed its first option forever — " +
        "hydration never wrote the value, because SSR cannot express it",
    );
    assertEquals(sel.selectedIndex, 2);
  } finally {
    cleanup();
  }
});
