// What `deno task dev` says about a defect, a PACKAGED app says too.
//
// Every renderer diagnostic sat behind `isDevMode()`. For advice that is the
// right gate. For a DEFECT — server markup thrown away, a row re-created on
// every render, a hook whose value is not kept, a callback dropped — it made
// the built app the quiet one: nothing in `client.log`, and a field report
// found each of these only by driving the packaged build.
//
// One table. Per row, the same app runs in dev and in production mode, and:
//
//   • production says the fact ONCE however often it happens (a list of 500
//     rows is one fact), as `[aio] …` on the page's console — the stream the
//     console forwarder carries to `client.log`;
//   • the line is observe-only: what was rendered is byte-identical in both
//     modes, with and without it;
//   • `_resetAioRuntime()` forgets it, so a test's diagnostics cannot depend
//     on which test ran before.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { Fragment, h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  afterRender,
  hydrate,
  mount,
  onUnmount,
  setDevMode,
  useRef,
  useSignal,
} from "../src/air/aio-renderer.ts";
import { useFieldArray } from "../src/air/form.ts";
import { collectHead } from "../src/air/head.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import { _resetDevWarnings, _wrong } from "../src/air/vdom-types.ts";
import { computed, signal } from "../src/state/signal.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { _said, firstTime, saysOnce } from "../src/protocol/said-once.ts";
import { Progress } from "../src/ui/controls.ts";
import { Markdown } from "../src/ui/markdown.ts";
import { Textarea } from "../src/ui/mod.ts";
import { memo } from "../src/air/memo.ts";

type Env = { doc: Document; root: HTMLElement };

/** A row: the defect, driven once. Returns what ended up rendered (or any
 *  other observable result) — compared across modes. */
type Row = {
  name: string;
  /** The production line. */
  says: RegExp;
  run: (e: Env) => string | Promise<string>;
};

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Mount, optionally re-render through a signal, and read the DOM. */
async function rendered(
  { root }: Env,
  App: () => unknown,
  then?: () => void,
): Promise<string> {
  const handle = mount(root, App as never);
  if (then) {
    then();
    await tick();
  }
  const html = root.innerHTML;
  _unmount(handle);
  return html;
}

/** Hydrate `App` over `serverHtml` and read the DOM. */
function hydrated({ root }: Env, serverHtml: string, App: () => unknown) {
  root.innerHTML = serverHtml;
  const handle = hydrate(root, App as never);
  const html = root.innerHTML;
  _unmount(handle);
  return html;
}

const ROWS: Row[] = [
  {
    name: "useRef outside a render",
    says: /^\[aio\] useRef\(\) called outside a component render\./,
    run: () => String(useRef(7).current),
  },
  {
    name: "useSignal outside a render",
    says: /^\[aio\] useSignal\(\) called outside a component render\./,
    run: () => String(useSignal(7).peek()),
  },
  {
    name: "afterRender outside a render",
    says: /^\[aio\] afterRender\(\) called outside a render .* DROPPED\.$/,
    run: () => {
      let ran = false;
      afterRender(() => ran = true);
      return String(ran);
    },
  },
  {
    name: "hydrate falls back to a client render",
    says: /^\[aio\] hydrate\(\) found DOM that does not match .* discarded\.$/,
    run: (e) =>
      hydrated(e, "<p>server</p>", () => h("div", null, h("b", null, "x"))),
  },
  {
    name: "hydrate removes surplus server nodes",
    says:
      /^\[aio\] hydrate\(\) found 1 server node\(s\) in <div> .* removed\.$/,
    run: (e) =>
      hydrated(
        e,
        "<div><b>x</b><i>extra</i></div>",
        () => h("div", null, h("b", null, "x")),
      ),
  },
  {
    name: "hydrate repairs a server-only attribute",
    says:
      /^\[aio\] hydrate\(\) found <button> with server markup that disagrees with the component on disabled /,
    run: (e) =>
      hydrated(
        e,
        '<button disabled="">go</button>',
        () => h("button", null, "go"),
      ),
  },
  {
    name: "a duplicate key",
    says: /^\[aio\] Duplicate key "a" in children list\.$/,
    run: (e) => {
      const n = signal(0);
      return rendered(
        e,
        () =>
          h(
            "ul",
            { "data-n": n.value },
            ["a", "b", "a"].map((k) => h("li", { key: k }, k)),
          ),
        () => n.set(1),
      );
    },
  },
  // ── the reconciler's own lines ──────────────────────────────────────────
  // Three are about a text node that is not where the renderer left it. The
  // input is a page that was changed from outside: a translator wraps every
  // text node in a <font>, an extension removes one.
  {
    name: "a text child whose node was replaced from outside (a translator)",
    says: /^\[aio\] A text child \("0" → "1"\) was diffed against a <FONT> /,
    run: (e) => {
      const n = signal(0);
      return rendered(
        e,
        () => h("p", null, "count ", n.value, h("b", null, "!")),
        () => {
          const p = e.root.firstChild!;
          const font = e.doc.createElement("font");
          font.textContent = "zero";
          p.replaceChild(font, p.childNodes[1]!);
          n.set(1);
        },
      );
    },
  },
  {
    name: "a text child whose node was removed from outside",
    says:
      /^\[aio\] A text child \("0" → "1"\) was diffed without its DOM position/,
    run: (e) => {
      const n = signal(0);
      return rendered(
        e,
        () => h("p", null, h("b", null, "!"), "count ", n.value),
        () => {
          const p = e.root.firstChild!;
          p.removeChild(p.lastChild!);
          n.set(1);
        },
      );
    },
  },
  {
    name: "a text child removed by a render after it was removed from outside",
    says:
      /^\[aio\] A text child \("tail"\) is being removed without its DOM position/,
    run: (e) => {
      const n = signal(0);
      return rendered(
        e,
        () => h("p", null, h("b", null, "!"), ...(n.value ? [] : ["tail"])),
        () => {
          const p = e.root.firstChild!;
          p.removeChild(p.lastChild!);
          n.set(1);
        },
      );
    },
  },
  // Two are about a vnode the kept tree holds with no node. The input is a
  // commit that THREW part-way: a computed used as a child, throwing on its
  // first read. The render is kept (AIO-180) with the children after the
  // throw never built, and the next render says which ones stopped.
  ...([
    [
      "a signal child",
      /^\[aio\] A signal child has no text node to diff against/,
    ],
    ["an element", /^\[aio\] <u> has no DOM node to diff against/],
  ] as const).map(([what, says]): Row => ({
    name: `${what} left without a node by a commit that threw`,
    says,
    run: (e) => {
      const n = signal(0);
      const c = computed(() => {
        if (n.value === 1) throw new Error("computed boom");
        return "v" + n.value;
      });
      const App = () =>
        h(
          "p",
          { "data-n": n.value },
          h("i", null, "a"),
          n.value ? c as never : "plain",
          h("u", null, "z"),
        );
      return (async () => {
        const handle = mount(e.root, App as never);
        for (const v of [1, 2]) {
          n.set(v);
          await tick();
        }
        const html = e.root.innerHTML;
        _unmount(handle);
        return html;
      })();
    },
  })),
  {
    name: "a component that re-renders reading nothing",
    says: /^\[aio\] Once re-rendered with 0 signal deps/,
    run: (e) => {
      const n = signal(0);
      let first = true;
      function Once() {
        if (first) {
          first = false;
          return h("i", null, String(n.value));
        }
        return h("i", null, "later");
      }
      return rendered(e, () => h(Once, null), () => n.set(1));
    },
  },
  {
    name: "an instance that reads no signals while its sibling does",
    says: /^\[aio\] <Cell> rendered reading NO signals, while another/,
    run: (e) => {
      const n = signal(1);
      const Cell = (p: { live: boolean }) =>
        h("i", null, p.live ? String(n.value) : "cached");
      return rendered(
        e,
        () =>
          h(
            Fragment,
            null,
            h(Cell, { live: true }),
            h(Cell, { live: false }),
          ),
      );
    },
  },
  {
    name: "useFieldArray.remove out of range",
    says: /^\[aio\] useFieldArray\.remove\(9\) is out of range/,
    run: () => {
      const list = useFieldArray(["a"]);
      list.remove(9);
      return list.items.join(",");
    },
  },
  {
    name: "collectHead with a key that names no render",
    says: /^\[aio\] collectHead\(key\) was given an object .* EMPTY\.$/,
    run: () => collectHead({}),
  },
  {
    name: "<Progress> with a value that is not a number",
    says: /^\[aio\] <Progress value=\{NaN\}> is not a finite number/,
    run: () => renderToString(Progress({ value: NaN })),
  },
  {
    name: "<Progress> with a value outside its range",
    says: /^\[aio\] <Progress value=\{150\} max=\{100\}> is outside its range/,
    run: () => renderToString(Progress({ value: 150, showValue: true })),
  },
  {
    name: "<Textarea onChange>, which gets the Event",
    says:
      /^\[aio\] <Textarea onChange> receives the DOM Event, not the value\.$/,
    run: () => renderToString(Textarea({ onChange: () => {} })),
  },
  {
    name: "memo() with a comparator",
    says: /^\[aio\] memo\(Row, compare\) — the custom comparator is IGNORED\.$/,
    run: () => {
      const Row = () => h("i", null, "r");
      return renderToString(h(memo(Row, () => true) as never, null));
    },
  },
  {
    name: "class and className on one element",
    says:
      /^\[aio\] A component passes BOTH `class` and `className` .* dropped\.$/,
    run: (e) => rendered(e, () => h("p", { class: "a", className: "b" }, "x")),
  },
  {
    name: "dangerouslySetInnerHTML beside children",
    says:
      /^\[aio\] <p> has both dangerouslySetInnerHTML and children .* alike\)\.$/,
    run: (e) =>
      rendered(
        e,
        () =>
          h("p", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } }, "kid"),
      ),
  },
  {
    name: "a handler-less control showing typed text its prop does not",
    says:
      /^\[aio\] <input value=…> has no handler, so it shows what was typed .* `defaultValue` .*`onInput`/,
    run: async (e) => {
      const n = signal(0);
      const handle = mount(
        e.root,
        (() =>
          h("p", null, h("input", { value: "b" }), String(n.value))) as never,
      );
      const el = e.root.querySelector("input")!;
      el.value = "typed";
      n.set(1);
      await tick();
      const out = e.root.innerHTML + el.value;
      _unmount(handle);
      return out;
    },
  },
  {
    name: "a `use` prop that is not an action",
    says: /^\[aio\] A `use` prop holds number .* Nothing was applied\.$/,
    run: (e) => rendered(e, () => h("p", { use: 7 as never }, "x")),
  },
  {
    name: "a signal child holding an object",
    says: /^\[aio\] A signal used as a child holds an object /,
    run: (e) => {
      const s = signal<unknown>("text");
      return rendered(e, () => h("p", null, s as never), () => s.set({ a: 1 }));
    },
  },
  {
    name: "<Markdown> dropping a link target",
    says: /^\[aio\] <Markdown> dropped a link\/image target/,
    run: () => renderToString(Markdown({ source: "[x](javascript:alert(1))" })),
  },
];

/** Run a row `times` times in one mode; every console line, and each result. */
async function drive(
  row: Row,
  dev: boolean,
  times: number,
): Promise<{ lines: string[]; results: string[] }> {
  const lines: string[] = [];
  const orig = { warn: console.warn, error: console.error };
  const take = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.warn = take;
  console.error = take;
  const g = globalThis as Record<string, unknown>;
  const had = g.__aioDev;
  // `__aioDev` is THE flag (the dev shell and every harness set it); the
  // renderer follows it and `aio/ui` reads it directly. Not `setDevMode(true)`:
  // that is the explicit opt-in that also stamps `data-component` on the DOM.
  g.__aioDev = dev;
  setDevMode("auto");
  _resetDevWarnings();
  const results: string[] = [];
  try {
    for (let i = 0; i < times; i++) {
      const win = new Window({ url: "https://localhost" });
      const doc = win.document as unknown as Document;
      _setDocument(doc);
      const root = doc.createElement("div") as unknown as HTMLElement;
      doc.body.appendChild(root as unknown as Node);
      try {
        results.push(await row.run({ doc, root }));
      } finally {
        await closeWindow(win);
      }
    }
  } finally {
    console.warn = orig.warn;
    console.error = orig.error;
    g.__aioDev = had;
    setDevMode("auto");
  }
  return { lines, results };
}

for (const row of ROWS) {
  Deno.test(`prod says: ${row.name} — once, observe-only, forgotten by the runtime reset`, async () => {
    _resetAioRuntime();
    const dev = await drive(row, true, 1);
    const prod = await drive(row, false, 3);
    const said = prod.lines.filter((l) => row.says.test(l));
    assertEquals(
      said.length,
      1,
      `production says it once in three runs:\n  ${prod.lines.join("\n  ")}`,
    );
    assertEquals(
      prod.lines.filter((l) => l.startsWith("[aio-dev]")),
      [],
      "no dev line in a production page",
    );
    // What dev says about it is at least as long: prod drops the prose.
    const devLine = dev.lines.find((l) => l.includes(said[0]!.slice(6, 40)));
    assert(devLine, `dev says it too:\n  ${dev.lines.join("\n  ")}`);
    assert(devLine.length >= said[0]!.length, `${devLine}\n${said[0]}`);
    assertEquals(
      prod.results,
      [dev.results[0], dev.results[0], dev.results[0]],
      "the line is observe-only: same result in dev, and with or without it",
    );
    _resetAioRuntime();
    const again = await drive(row, false, 1);
    assertEquals(
      again.lines.filter((l) => row.says.test(l)).length,
      1,
      "after _resetAioRuntime() it is said again",
    );
  });
}

Deno.test("prod says: the memory is bounded, and one reset clears it", () => {
  _resetAioRuntime();
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    saysOnce("a fact", "kind");
    saysOnce("the same kind, other words", "kind");
    assertEquals(lines, ["[aio] a fact"]);
    for (let i = 0; i < 1000; i++) firstTime(`generated-${i}`);
    assert(_said.size <= 200, `the set grew to ${_said.size}`);
    _resetAioRuntime();
    assertEquals(_said.size, 0);

    // `_wrong`: dev says fact + advice per id, prod the fact per kind.
    setDevMode(false);
    lines.length = 0;
    _wrong("kind-row-1", "It broke.", " Do this instead.", "kind");
    _wrong("kind-row-2", "It broke.", " Do this instead.", "kind");
    assertEquals(lines, ["[aio] It broke."]);
    setDevMode(true);
    lines.length = 0;
    _wrong("kind-row-1", "It broke.", " Do this instead.", "kind");
    _wrong("kind-row-1", "It broke.", " Do this instead.", "kind");
    assertMatch(lines.join("|"), /^\[aio-dev\] It broke\. Do this instead\.$/);
  } finally {
    console.warn = orig;
    setDevMode("auto");
    _resetAioRuntime();
  }
});

// The "stranded" line: an instance flagged pending and absent from the queue.
// Two inputs reach that state. One was a false alarm and says nothing now;
// the other is the fail-safe doing its job.
Deno.test("prod says: unmounting a root with a render still queued is not a strand — a cleanup may write what a queued sibling reads", async () => {
  for (const dev of [true, false]) {
    const lines = await strandLines(dev, async ({ root }) => {
      const n = signal(0);
      const A = () => {
        onUnmount(() => n.set(n.peek() + 1));
        return h("i", null, "a");
      };
      const B = () => h("b", null, "b" + n.value);
      const handle = mount(
        root,
        (() => h("p", null, h(A, null), h(B, null))) as never,
      );
      n.set(1); // B is queued…
      _unmount(handle); // …the queue is emptied, and A's cleanup writes n
      await tick();
    });
    assertEquals(lines, [], `dev=${dev}`);
  }
});

Deno.test("prod says: an instance stranded by a flush that was thrown out of is recovered, and said once", async () => {
  for (const dev of [true, false]) {
    let after = "";
    const lines = await strandLines(dev, async ({ root }) => {
      const n = signal(0), m = signal(0);
      const c = computed(() => {
        if (n.value === 1) throw new Error("computed boom");
        return "v" + n.value;
      });
      // A's commit throws; B waits behind it in the same flush.
      const A = () => h("i", { "data-n": n.value }, n.value ? c as never : "-");
      const B = () => h("b", null, `b${n.value}${m.value}`);
      const handle = mount(
        root,
        (() => h("p", null, h(A, null), h(B, null))) as never,
      );
      // The flush reports A's error through console.error. An app whose
      // console.error throws (an error reporter that failed) takes the flush
      // down with it: B is flagged pending and no longer queued.
      const take = console.error;
      console.error = (...a: unknown[]) => {
        if (String(a[0]).includes("Uncaught error re-rendering")) {
          console.error = take;
          throw new Error("reporter down");
        }
        take(...a);
      };
      const escaped = new Promise<void>((resolve) => {
        const on = (ev: Event) => {
          ev.preventDefault();
          globalThis.removeEventListener("error", on);
          resolve();
        };
        globalThis.addEventListener("error", on);
      });
      n.set(1);
      await escaped;
      console.error = take;
      for (let i = 1; i <= 3; i++) {
        m.set(i); // the first is the recovery; the others are ordinary
        await tick();
      }
      after = root.querySelector("b")!.textContent!;
      _unmount(handle);
    });
    assertEquals(after, "b13", `dev=${dev}: B renders again`);
    assertEquals(lines.length, 1, lines.join("\n"));
    assertMatch(lines[0]!, /Recovered a stranded <B>/);
    assert(lines[0]!.startsWith(dev ? "[aio-dev] " : "[aio] "), lines[0]);
  }
});

/** Every "stranded" line `fn` causes, in one mode, on a fresh document. */
async function strandLines(
  dev: boolean,
  fn: (e: Env) => Promise<void>,
): Promise<string[]> {
  _resetAioRuntime();
  const lines: string[] = [];
  const orig = { warn: console.warn, error: console.error };
  const take = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.warn = take;
  console.error = take;
  const g = globalThis as Record<string, unknown>;
  const had = g.__aioDev;
  g.__aioDev = dev;
  setDevMode("auto");
  _resetDevWarnings();
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div") as unknown as HTMLElement;
  doc.body.appendChild(root as unknown as Node);
  try {
    await fn({ doc, root });
  } finally {
    await closeWindow(win);
    console.warn = orig.warn;
    console.error = orig.error;
    g.__aioDev = had;
    setDevMode("auto");
  }
  return lines.filter((l) => l.includes("stranded"));
}
