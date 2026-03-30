import { assertEquals, assertNotStrictEquals } from "@std/assert";
import {
  applyPatches,
  enablePatches,
  type Patch,
  produceWithPatches,
} from "immer";
import {
  _getState,
  _injectState,
  _reset,
  getFeatureSignal,
  handleMessage,
} from "../src/state-core.ts";

enablePatches();

// ── Immer patches round-trip tests ─────────────────────────────────
// Server generates patches via produceWithPatches, client applies via handleMessage($patches)

function setup(initial: Record<string, unknown>) {
  _reset();
  _injectState(initial);
}

function serverProduce(
  state: Record<string, unknown>,
  recipe: (draft: Record<string, unknown>) => void,
): { next: Record<string, unknown>; patches: Patch[] } {
  const [next, patches] = produceWithPatches(state, recipe);
  return { next, patches };
}

// ── Basic value changes ─────────────────────────────────────────────

Deno.test("patches: single field update round-trip", () => {
  const initial = { counter: { count: 0, label: "hits" } };
  setup(initial);

  const { next, patches } = serverProduce(initial, (d) => {
    (d.counter as Record<string, unknown>).count = 10;
  });

  assertEquals(patches.length, 1);
  const result = handleMessage({ $patches: patches });
  assertEquals(result, "delta");
  assertEquals(_getState().counter, next.counter);
});

Deno.test("patches: multiple field updates in one produce", () => {
  const initial = {
    counter: { count: 0, label: "hits" },
    timer: { elapsed: 0 },
  };
  setup(initial);

  const { next, patches } = serverProduce(initial, (d) => {
    (d.counter as Record<string, unknown>).count = 5;
    (d.timer as Record<string, unknown>).elapsed = 100;
  });

  handleMessage({ $patches: patches });
  assertEquals(_getState().counter, next.counter);
  assertEquals(_getState().timer, next.timer);
});

// ── Additions ───────────────────────────────────────────────────────

Deno.test("patches: add new top-level feature", () => {
  const initial = { counter: { count: 0 } };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    d.newFeature = { enabled: true, items: [1, 2, 3] };
  });

  handleMessage({ $patches: patches });
  const state = _getState();
  assertEquals(state.newFeature, { enabled: true, items: [1, 2, 3] });
  assertEquals(state.counter, { count: 0 }); // untouched
});

Deno.test("patches: add nested property", () => {
  const initial = { settings: { theme: "dark" } };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    (d.settings as Record<string, unknown>).fontSize = 14;
  });

  handleMessage({ $patches: patches });
  assertEquals(_getState().settings, { theme: "dark", fontSize: 14 });
});

// ── Deletions ───────────────────────────────────────────────────────

Deno.test("patches: delete top-level feature", () => {
  const initial = { counter: { count: 0 }, toRemove: { x: 1 } };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    delete d.toRemove;
  });

  handleMessage({ $patches: patches });
  assertEquals(_getState().toRemove, undefined);
  assertEquals(_getState().counter, { count: 0 });
});

Deno.test("patches: delete nested property", () => {
  const initial = { settings: { theme: "dark", oldProp: true } };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    delete (d.settings as Record<string, unknown>).oldProp;
  });

  handleMessage({ $patches: patches });
  assertEquals(_getState().settings, { theme: "dark" });
});

// ── Arrays ──────────────────────────────────────────────────────────

Deno.test("patches: array push", () => {
  const initial = { list: { items: ["a", "b"] } };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    ((d.list as Record<string, unknown>).items as string[]).push("c");
  });

  handleMessage({ $patches: patches });
  assertEquals((_getState().list as Record<string, unknown>).items, [
    "a",
    "b",
    "c",
  ]);
});

Deno.test("patches: array splice (remove element)", () => {
  const initial = { list: { items: ["a", "b", "c"] } };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    ((d.list as Record<string, unknown>).items as string[]).splice(1, 1);
  });

  handleMessage({ $patches: patches });
  assertEquals((_getState().list as Record<string, unknown>).items, ["a", "c"]);
});

Deno.test("patches: array element update (objects with id)", () => {
  const initial = {
    fleet: {
      members: [
        { id: "SOL", price: 100 },
        { id: "BTC", price: 50000 },
      ],
    },
  };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    const members = (d.fleet as Record<string, unknown>).members as Array<
      Record<string, unknown>
    >;
    members[0]!.price = 142;
  });

  handleMessage({ $patches: patches });
  const members = (_getState().fleet as Record<string, unknown>)
    .members as Array<Record<string, unknown>>;
  assertEquals(members[0], { id: "SOL", price: 142 });
  assertEquals(members[1], { id: "BTC", price: 50000 });
});

// ── Edge cases ──────────────────────────────────────────────────────

Deno.test("patches: empty patches array → noop", () => {
  const initial = { counter: { count: 5 } };
  setup(initial);

  const result = handleMessage({ $patches: [] });
  assertEquals(result, "noop");
  assertEquals(_getState().counter, { count: 5 });
});

Deno.test("patches: null value assignment", () => {
  const initial = { data: { value: "hello", extra: 42 } };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    (d.data as Record<string, unknown>).value = null;
  });

  handleMessage({ $patches: patches });
  assertEquals((_getState().data as Record<string, unknown>).value, null);
  assertEquals((_getState().data as Record<string, unknown>).extra, 42);
});

Deno.test("patches: deeply nested update", () => {
  const initial = { app: { ui: { panel: { width: 300, visible: true } } } };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    (((d.app as Record<string, unknown>).ui as Record<string, unknown>)
      .panel as Record<string, unknown>).width = 500;
  });

  handleMessage({ $patches: patches });
  const panel =
    ((_getState().app as Record<string, unknown>).ui as Record<string, unknown>)
      .panel as Record<string, unknown>;
  assertEquals(panel.width, 500);
  assertEquals(panel.visible, true);
});

Deno.test("patches: feature signal updated on patch", () => {
  const initial = { counter: { count: 0 } };
  setup(initial);

  const sig = getFeatureSignal("counter");
  assertEquals(sig.peek(), { count: 0 });

  const { patches } = serverProduce(initial, (d) => {
    (d.counter as Record<string, unknown>).count = 42;
  });

  handleMessage({ $patches: patches });
  assertEquals(sig.peek(), { count: 42 });
});

Deno.test("patches: replace entire array", () => {
  const initial = { data: { tags: ["a", "b", "c"] } };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    (d.data as Record<string, unknown>).tags = ["x", "y"];
  });

  handleMessage({ $patches: patches });
  assertEquals((_getState().data as Record<string, unknown>).tags, ["x", "y"]);
});

Deno.test("patches: boolean toggle", () => {
  const initial = { feature: { enabled: false } };
  setup(initial);

  const { patches } = serverProduce(initial, (d) => {
    (d.feature as Record<string, unknown>).enabled = true;
  });

  handleMessage({ $patches: patches });
  assertEquals((_getState().feature as Record<string, unknown>).enabled, true);
});

// ── Multiple sequential patches ─────────────────────────────────────

Deno.test("patches: multiple sequential applies", () => {
  const initial = { counter: { count: 0 } };
  setup(initial);

  // First update
  const { next: s1, patches: p1 } = serverProduce(initial, (d) => {
    (d.counter as Record<string, unknown>).count = 1;
  });
  handleMessage({ $patches: p1 });
  assertEquals((_getState().counter as Record<string, unknown>).count, 1);

  // Second update (based on first result)
  const { patches: p2 } = serverProduce(s1, (d) => {
    (d.counter as Record<string, unknown>).count = 2;
  });
  handleMessage({ $patches: p2 });
  assertEquals((_getState().counter as Record<string, unknown>).count, 2);
});

// ── Dropped before initial state ────────────────────────────────────

Deno.test("patches: dropped if no initial state received", () => {
  _reset(); // no _injectState — initial state not received

  const result = handleMessage({
    $patches: [{ op: "replace", path: ["x"], value: 1 }],
  });
  assertEquals(result, "dropped");
});
