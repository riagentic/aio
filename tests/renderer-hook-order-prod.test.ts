// A conditional state hook in PRODUCTION: said, not swallowed.
//
// State hooks are matched across renders by call order. A hook behind an
// early `return` (or an `if`) changes how many run, every later hook lands on
// another hook's slot, and the component reads state that is not its own. Dev
// reported it; a packaged build did the same wrong thing and said nothing —
// a field report found it only by driving the built app. A difference that is
// "dev warns, prod is silently wrong" is the one this project does not allow.
//
// Prod now says it once per component, on `console.error` — the channel the
// console forwarder carries to the server log — and changes nothing else.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  onCleanup,
  onMount,
  onUnmount,
  setDevMode,
  useRef,
  useSignal,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { useHead } from "../src/air/head.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, doc, root };
}

async function inProd(
  fn: (root: HTMLElement, errors: string[]) => void,
): Promise<void> {
  const { win, doc, root } = createDOM();
  _setDocument(doc);
  setDevMode(false);
  const errors: string[] = [];
  const orig = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  console.warn = console.error;
  try {
    fn(root, errors);
  } finally {
    console.error = orig;
    console.warn = origWarn;
    setDevMode("auto");
    await closeWindow(win);
  }
}

Deno.test("prod: hooks after an early return are reported, once, by name", async () => {
  await inProd((root, errors) => {
    const loading = signal(true);
    function ProdJobsPanel() {
      if (loading.value) return h("p", null, "loading");
      const draft = useRef("draft");
      const count = useSignal(7);
      return h("p", null, `${draft.current}/${count.value}`);
    }
    const handle = mount(root, ProdJobsPanel);
    assertEquals(errors, [], "a first render has nothing to compare with");
    loading.set(false);
    handle._flush();
    assertEquals(root.textContent, "draft/7", "rendering goes on as before");
    assertEquals(errors.length, 1, JSON.stringify(errors));
    assertStringIncludes(errors[0]!, "<ProdJobsPanel>");
    assertStringIncludes(errors[0]!, "2 state hooks this render but 0");
    // Once per component: the next flip is the same fact.
    loading.set(true);
    handle._flush();
    loading.set(false);
    handle._flush();
    assertEquals(errors.length, 1, JSON.stringify(errors));
    _unmount(handle);
  });
});

Deno.test("prod: a conditional hook hands a later hook someone else's state — and says so", async () => {
  await inProd((root, errors) => {
    const extra = signal(false);
    let total: { current: number } | undefined;
    function ProdShift() {
      const name = useRef("NAME");
      const flag = extra.value ? useRef("EXTRA") : null;
      total = useRef(0);
      return h("p", null, `${name.current}/${String(flag?.current)}`);
    }
    const handle = mount(root, ProdShift);
    total!.current = 99; // state the component owns
    extra.set(true);
    handle._flush();
    // What "silently wrong" means, measured: the conditional hook took the
    // slot holding 99, and `total` is a fresh ref — its state is gone.
    assertEquals(root.textContent, "NAME/99");
    assertEquals(total!.current, 0);
    assertEquals(errors.length, 1, JSON.stringify(errors));
    assertStringIncludes(errors[0]!, "<ProdShift>");
    _unmount(handle);
  });
});

Deno.test("prod: a stable hook count says nothing", async () => {
  await inProd((root, errors) => {
    const n = signal(0);
    function ProdStable() {
      const a = useRef(1);
      const b = useSignal(2);
      return h("p", null, `${a.current}${b.value}${n.value}`);
    }
    const handle = mount(root, ProdStable);
    n.set(1);
    handle._flush();
    n.set(2);
    handle._flush();
    assertEquals(root.textContent, "122");
    assertEquals(errors, []);
    _unmount(handle);
  });
});

// The sibling: a lifecycle call with no component to attach to is DROPPED —
// the subscription never runs, the title is never set. Dev said so; prod did
// not. Once per hook in prod: the same timer usually asks again.
Deno.test("prod: a lifecycle call dropped outside a render is said, once per hook", async () => {
  await inProd((_root, errors) => {
    for (let i = 0; i < 3; i++) {
      onMount(() => {});
      onCleanup(() => {});
      onUnmount(() => {});
      useHead({ title: "from a timer" });
    }
    assertEquals(errors.length, 4, JSON.stringify(errors));
    for (
      const [i, hook] of ["onMount", "onCleanup", "onUnmount", "useHead"]
        .entries()
    ) {
      assertStringIncludes(
        errors[i]!,
        `[aio] ${hook}() called outside a component render`,
      );
      assertStringIncludes(errors[i]!, "DROPPED");
    }
  });
});
