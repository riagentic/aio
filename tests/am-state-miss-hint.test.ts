// `am state counter.cnt` (a typo one level down) answered
//
//     path "counter.cnt" not found in state (available: counter)
//
// — the ROOT keys, one of which is the very key the caller just typed
// correctly. The hint named nothing that would fix the path. It now names the
// keys where the walk stopped: `counter` resolved, `cnt` did not, so the
// choices are counter's own keys.
import { assertEquals } from "@std/assert";
import { _missHint } from "../src/am/am-cmd-state.ts";

Deno.test("am state: a miss names the keys where the path stopped resolving", () => {
  const state = {
    counter: { count: 1, step: 2 },
    todo: { items: [{ title: "a" }] },
  };
  const cases: [string, string][] = [
    ["nope", ` (available: counter, todo)`],
    ["counter.cnt", ` (available under "counter": count, step)`],
    ["todo.items.0.titl", ` (available under "todo.items.0": title)`],
    ["todo.items[0].titl", ` (available under "todo.items.0": title)`],
    ["todo.items.5", ` ("todo.items" has 1 item: 0..0)`],
    // A scalar has no keys: say where the path went through a leaf.
    ["counter.count.x", ` ("counter.count" is a number, not an object)`],
  ];
  assertEquals(cases.length, 6);
  for (const [path, want] of cases) {
    assertEquals(_missHint(state, path), want, path);
  }
});
