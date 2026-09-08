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
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { afterRender } from "../src/air/renderer-flush.ts";
import { onMount } from "../src/air/renderer-lifecycle.ts";
import { signal } from "../src/state/signal.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { _resetUntrackedReadWarnings } from "../src/air/untracked-read.ts";

function dom() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { root, close: () => closeWindow(win) };
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
