// A read inside a lifecycle callback subscribes to NOTHING, and nothing said so.
//
// The rule is correct and documented: a component subscribes only to what its
// render body touches. The failure mode is what makes it expensive — the effect
// runs once and never again, types pass, `aiol` passes, the code looks right,
// and the feature reports itself to a user as "it works sometimes".
//
// One codebase shipped this three times, in three features, by an author who
// had written the explaining comment into two of the earlier ones and read both
// while writing the third: "Understanding the rule is not enough, because
// nothing on the failing path mentions it." It is decidable at runtime — the
// renderer already knows the render-time read set and already knows when it is
// running an effect callback — so this is a warning rather than a doc.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  useRef,
} from "../src/air/aio-renderer.ts";
import { afterRender } from "../src/air/renderer-flush.ts";
import { onMount, useSignal } from "../src/air/renderer-lifecycle.ts";
import { useLocal } from "../src/adapters/air.ts";
import { signal } from "../src/state/signal.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { _resetUntrackedReadWarnings } from "../src/air/untracked-read.ts";

function dom() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, root, close: () => closeWindow(win) };
}

async function warningsFrom(build: () => void): Promise<string[]> {
  const out: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => out.push(String(a[0]));
  try {
    setDevModeOverride(true);
    _resetUntrackedReadWarnings();
    build();
    await new Promise((r) => setTimeout(r, 5));
  } finally {
    console.warn = real;
  }
  return out;
}

Deno.test("afterRender: a read the render body never made is named", async () => {
  const { root, close } = dom();
  const spoken = signal(0, "speech.spokenId");
  const Comp = () => {
    afterRender(() => {
      // The exact shape that shipped three times: the effect reads the marker,
      // so it looks reactive, and subscribes to nothing.
      if (spoken.get() > 0) { /* speak */ }
    });
    return h("div", null, "x");
  };
  const warns = await warningsFrom(() => {
    mount(root, Comp);
  });
  const hit = warns.filter((w) => w.includes("read inside afterRender"));
  assertEquals(hit.length, 1, warns.join("\n"));
  assert(hit[0]!.includes("speech.spokenId"), `name it: ${hit[0]}`);
  assert(
    hit[0]!.includes("once and never again"),
    `the CONSEQUENCE is the useful half: ${hit[0]}`,
  );
  await close();
});

Deno.test("afterRender: a value the render body DID read is fine", async () => {
  const { root, close } = dom();
  const n = signal(0, "counter.n");
  const Comp = () => {
    const current = n.get(); // tracked — the component re-renders on change
    afterRender(() => {
      if (current > 0) { /* … */ }
      // Reading it again here is harmless: the subscription already exists.
      void n.get();
    });
    return h("div", null, String(current));
  };
  const warns = await warningsFrom(() => {
    mount(root, Comp);
  });
  assertEquals(
    warns.filter((w) => w.includes("read inside afterRender")),
    [],
    "warning here would fire on the CORRECT pattern, which is how a good " +
      "warning becomes one people mute",
  );
  await close();
});

Deno.test("onMount: the same trap, the same warning", async () => {
  const { root, close } = dom();
  const flag = signal(false, "session.ready");
  const Comp = () => {
    onMount(() => {
      if (flag.get()) { /* … */ }
    });
    return h("div", null, "x");
  };
  const warns = await warningsFrom(() => {
    mount(root, Comp);
  });
  const hit = warns.filter((w) => w.includes("read inside onMount"));
  assertEquals(hit.length, 1, warns.join("\n"));
  assert(hit[0]!.includes("session.ready"));
  await close();
});

Deno.test("untracked read: warned once, not once per render", async () => {
  const { root, close } = dom();
  const tick = signal(0, "ui.tick");
  const other = signal(0, "ui.other");
  const Comp = () => {
    const t = tick.get();
    afterRender(() => void other.get());
    return h("div", null, String(t));
  };
  const warns = await warningsFrom(() => {
    mount(root, Comp);
    tick.set(1);
    tick.set(2);
  });
  assertEquals(
    warns.filter((w) => w.includes("read inside afterRender")).length,
    1,
    "one per (component, value) — a per-render warning is noise",
  );
  await close();
});

Deno.test("untracked read: production is untouched", async () => {
  const { root, close } = dom();
  const s = signal(0, "x.y");
  const Comp = () => {
    afterRender(() => void s.get());
    return h("div", null, "x");
  };
  const out: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => out.push(String(a[0]));
  try {
    setDevModeOverride(false);
    _resetUntrackedReadWarnings();
    const handle = mount(root, Comp);
    await new Promise((r) => setTimeout(r, 5));
    _unmount(handle);
  } finally {
    console.warn = real;
    setDevModeOverride(true);
  }
  assertEquals(out.filter((w) => w.includes("read inside")), []);
  await close();
});

Deno.test("afterRender: a listener it DISPATCHES to is not the callback — its reads are not blamed", async () => {
  // wallet report §8: `<PanelDivider>`'s afterRender fired `resize`; every other
  // component's resize listener ran inside that hook's frame, and their reads
  // were reported as `<PanelDivider>`'s — advice that cannot be followed.
  const { win, root, close } = dom();
  const nav = signal("list", "nav.panelType");
  const own = signal(0, "divider.width");
  const onResize = () => void nav.get(); // another component's listener
  win.addEventListener("resize", onResize);
  const PanelDivider = () => {
    afterRender(() => {
      win.dispatchEvent(new win.Event("resize"));
      void own.get(); // …while the hook's OWN read is still named
    });
    return h("div", null, "|");
  };
  const warns = await warningsFrom(() => {
    mount(root, PanelDivider);
  });
  const hit = warns.filter((w) => w.includes("read inside afterRender"));
  assertEquals(hit.length, 1, warns.join("\n"));
  assert(hit[0]!.includes("divider.width"), hit[0]);
  // …and the dispatch patch is gone once the callback returns.
  assert(
    !Object.hasOwn(win.EventTarget.prototype, "dispatchEvent") ||
      !String(win.EventTarget.prototype.dispatchEvent).includes("untrack"),
    "dispatchEvent must be restored",
  );
  win.removeEventListener("resize", onResize);
  await close();
});

Deno.test("untracked read: an unnamed hook signal is named by component and hook ordinal", async () => {
  const { root, close } = dom();
  const Portal = () => {
    const open = useSignal(false);
    const hidden = useLocal(false);
    afterRender(() => {
      void open.get();
      void hidden.local;
    });
    return h("div", null, "x");
  };
  const warns = await warningsFrom(() => {
    mount(root, Portal);
  });
  const hit = warns.filter((w) => w.includes("read inside afterRender"));
  assert(
    hit.some((w) => w.includes("`<Portal> useSignal #1`")),
    hit.join("\n"),
  );
  assert(hit.some((w) => w.includes("`<Portal> useLocal #1`")), hit.join("\n"));
  await close();
});

// A hook's number is its ORDINAL among hooks of its own kind, not the shared
// ref slot: `useRef; useLocal; useSignal; useLocal; useSignal` named the
// second useLocal "#4" (its slot), which sent a reader counting the wrong
// hooks to find it.
Deno.test("hook-signal names count each hook kind on its own", async () => {
  const { root, close } = dom();
  const warns = await warningsFrom(() => {
    const Mixed = () => {
      useRef(null);
      const l1 = useLocal("l1");
      const s1 = useSignal("s1");
      const l2 = useLocal("l2");
      const s2 = useSignal("s2");
      onMount(() => {
        void l1.local;
        void s1.get();
        void l2.local;
        void s2.get();
      });
      return h("div", null, "x");
    };
    mount(root, Mixed);
  });
  const named = warns.filter((w) => w.includes("read inside onMount"))
    .map((w) => /`([^`]+)`/.exec(w)?.[1]);
  assertEquals(named, [
    "<Mixed> useLocal #1",
    "<Mixed> useSignal #1",
    "<Mixed> useLocal #2",
    "<Mixed> useSignal #2",
  ]);
  await close();
});
