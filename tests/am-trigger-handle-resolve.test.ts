// `am trigger` resolves a handle the way `testUI` does (field report a desktop agent app
// §3). The element lived in a child component — `App/ModelSelect:opencode-model`
// — and `am trigger App:opencode-model select …` answered "element not found",
// while `ui["opencode-model"].select(…)` in a test reached it by name. The live
// executor only accepted the exact path, whose `#2` even depends on render
// order. Pinned against `runUITrigger`, the function `am trigger` reaches.
import { assert, assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";
import { runUITrigger } from "../src/air/ui-remote.ts";

type R = { ok: boolean; error?: string; available?: string[] };

function fixture() {
  const picked: Record<string, string> = {};
  const ModelSelect = (p: { id: string }) =>
    h(
      "select",
      {
        t: p.id,
        "aria-label": p.id,
        onChange: (e: { target: { value: string } }) => {
          picked[p.id] = e.target.value;
        },
      },
      h("option", { value: "a/one" }, "one"),
      h("option", { value: "ollama/llama3.1" }, "llama"),
    );
  const Row = () =>
    h("button", { t: "delete", type: "button", onClick: () => {} }, "Delete");
  const App = () =>
    h(
      "div",
      null,
      h(ModelSelect, { id: "opencode-model" }),
      h(ModelSelect, { id: "openclaude-model" }),
      h(Row, null),
      h(Row, null),
    );
  return { App, picked };
}

Deno.test("am trigger: a handle in a child component resolves like testUI (bare, App:, Component:)", async () => {
  const { App, picked } = fixture();
  await using ui = await testUI(App);
  await ui.settle();
  for (
    const [path, id] of [
      ["App:opencode-model", "opencode-model"],
      ["opencode-model", "opencode-model"],
      ["ModelSelect:openclaude-model", "openclaude-model"],
      ["App/ModelSelect#2:openclaude-model", "openclaude-model"],
    ] as const
  ) {
    delete picked[id];
    const r = await runUITrigger({
      path,
      action: "select",
      text: "ollama/llama3.1",
    }) as R;
    assertEquals(r.ok, true, `${path}: ${r.error} ${r.available}`);
    assertEquals(picked[id], "ollama/llama3.1", `${path} did not select`);
  }
});

Deno.test("am trigger: an ambiguous handle refuses and lists exactly the candidates", async () => {
  const { App } = fixture();
  await using ui = await testUI(App);
  await ui.settle();
  const r = await runUITrigger({ path: "App:delete", action: "click" }) as R;
  assertEquals(r.ok, false);
  assert(/matches 2 elements/.test(r.error ?? ""), r.error);
  assertEquals(r.available, ["App/Row:delete", "App/Row#2:delete"]);
});

Deno.test("am trigger: a prefix naming no component on the path still misses", async () => {
  const { App } = fixture();
  await using ui = await testUI(App);
  await ui.settle();
  for (const path of ["Row:opencode-model", "Nope:opencode-model", ":x"]) {
    const r = await runUITrigger({ path, action: "click" }) as R;
    assertEquals(r.ok, false, path);
    assertEquals(r.error, "element not found on the live surface", path);
    assert(r.available?.includes("window"), path);
  }
});
