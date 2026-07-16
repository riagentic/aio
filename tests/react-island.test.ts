// reactIsland — mounts a React component into an AIR page WITHOUT aio depending
// on React. Proven with fake react / react-dom loaders (the user supplies real
// ones in their app), so this test needs no React install.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { reactIsland } from "../src/air/react-island.ts";

const tick = () => new Promise((r) => setTimeout(r, 30));

Deno.test("reactIsland: loads, mounts, and renders the React component's output", async () => {
  const calls: string[] = [];
  // Fake React runtime — the user provides real import()s in their app.
  const fakeReact = {
    createElement: (type: unknown, props: Record<string, unknown>) => ({
      type,
      props,
    }),
  };
  const fakeReactDom = {
    createRoot: (el: Element) => ({
      render: (node: { props: Record<string, unknown> }) => {
        calls.push("render");
        el.textContent = `react:${node.props.label}`;
      },
      unmount: () => calls.push("unmount"),
    }),
  };
  const Widget = reactIsland<{ label: string }>({
    component: () => Promise.resolve({ default: (p: { label: string }) => p }),
    react: () => Promise.resolve(fakeReact),
    reactDomClient: () => Promise.resolve(fakeReactDom),
    props: () => ({ label: "hi" }),
  });

  const win = new Window();
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(() => h("div", null, h(Widget, null)), {
    document: win.document as any,
  });
  await tick(); // island load + mount resolve on a microtask after first render
  assertStringIncludes(ui.html(), "react:hi");
  assert(calls.includes("render"), "React root rendered");
  await ui.dispose();
});

Deno.test("reactIsland: component module can be the component itself (no default)", async () => {
  let rendered = "";
  const Widget = reactIsland<{ n: number }>({
    component: () => Promise.resolve((p: { n: number }) => p), // not wrapped in { default }
    react: () =>
      Promise.resolve({
        createElement: (_t: unknown, p: Record<string, unknown>) => ({
          props: p,
        }),
      }),
    reactDomClient: () =>
      Promise.resolve({
        createRoot: (el: Element) => ({
          render: (node: { props: Record<string, unknown> }) => {
            rendered = `n=${node.props.n}`;
            el.textContent = rendered;
          },
          unmount: () => {},
        }),
      }),
    props: () => ({ n: 42 }),
  });
  const win = new Window();
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(() => h("div", null, h(Widget, null)), {
    document: win.document as any,
  });
  await tick();
  assertEquals(rendered, "n=42");
  await ui.dispose();
});
