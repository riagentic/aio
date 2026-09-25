// `am trigger` (the live tier, src/air/ui-remote.ts → ui-trigger.ts) must refuse
// what a browser never delivers, exactly as testUI does: no hover and no focus
// on a `display:none` element, no focus on a disabled control — but hover on a
// disabled-yet-visible control still works (its tooltip is the point).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { getLiveSurfaces, runUITrigger } from "../src/air/ui-remote.ts";

const fired: string[] = [];

function Panel() {
  return (
    <div>
      <button
        t="Tip"
        style="display:none"
        onMouseEnter={() => fired.push("tip:hover")}
        onFocus={() => fired.push("tip:focus")}
      >
        tip
      </button>
      <button
        t="Save"
        disabled
        onMouseEnter={() => fired.push("save:hover")}
        onFocus={() => fired.push("save:focus")}
      >
        save
      </button>
    </div>
  );
}

function pathOf(suffix: string): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    const node = n as {
      path?: string;
      children?: unknown[];
      elements?: { path: string }[];
    };
    if (node.path) out.push(node.path);
    for (const e of node.elements ?? []) out.push(e.path);
    for (const c of node.children ?? []) walk(c);
  };
  for (const r of getLiveSurfaces(true)) walk(r);
  const p = out.find((x) => x.endsWith(suffix));
  assert(p, `no path ending ${suffix} in ${out.join(", ")}`);
  return p;
}

testUI(
  Panel,
  "am trigger: hover on a display:none element is refused, fires nothing",
  async () => {
    fired.length = 0;
    const r = await runUITrigger({ path: pathOf(":Tip"), action: "hover" });
    assertEquals(r.ok, false, "a browser delivers no mouseenter to it");
    assertStringIncludes(r.error ?? "", "not visible");
    assertEquals(fired, []);
  },
);

testUI(
  Panel,
  "am trigger: focus on a display:none element is refused, fires nothing",
  async () => {
    fired.length = 0;
    const r = await runUITrigger({ path: pathOf(":Tip"), action: "focus" });
    assertEquals(r.ok, false);
    assertStringIncludes(r.error ?? "", "not visible");
    assertEquals(fired, []);
  },
);

testUI(
  Panel,
  "am trigger: focus on a disabled control is refused, fires nothing",
  async () => {
    fired.length = 0;
    const r = await runUITrigger({ path: pathOf(":Save"), action: "focus" });
    assertEquals(r.ok, false);
    assertStringIncludes(r.error ?? "", "disabled");
    assertEquals(fired, []);
  },
);

testUI(
  Panel,
  "am trigger: hover on a disabled-but-visible control still fires",
  async () => {
    fired.length = 0;
    const r = await runUITrigger({ path: pathOf(":Save"), action: "hover" });
    assertEquals(r.ok, true, r.error);
    assertEquals(fired, ["save:hover"]);
  },
);
