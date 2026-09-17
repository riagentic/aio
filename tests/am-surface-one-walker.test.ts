// `am surface --names` and `ui.names()` must list the SAME paths, in the same
// order — so they share the one walker (`collectElementPaths`). 1.0.2's
// changelog said so; `am` still carried a hand-kept copy.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { _surfaceNames, NO_UI_CLIENT_HINT } from "../src/am/am-cmd-inspect.ts";
import {
  collectElementPaths,
  type UISurfaceNode,
} from "../src/air/ui-surface.ts";

const el = (path: string) => ({
  name: path.split(":").at(-1)!,
  tag: "button",
  text: "",
  events: ["click"],
  path,
});
const node = (
  path: string,
  elements: string[],
  children: UISurfaceNode[] = [],
  key?: number,
): UISurfaceNode => ({
  component: path.split("/").at(-1)!.replace(/\[\d+\]$/, ""),
  ...(key !== undefined ? { key } : {}),
  path,
  text: "",
  elements: elements.map((e) => el(`${path}:${e}`)),
  children,
});

// Nested AND ordinal: two keyed rows under a list, each with its own element,
// plus an element on the root — the shape where a hand-kept walker and the
// real one drift (ordering, ordinals, nested elements).
const SURFACE: UISurfaceNode[] = [
  node("App", ["AddButton"], [
    node("App/TodoList", [], [
      node("App/TodoList/TodoRow[0]", ["DoneCheckbox", "RemoveButton"], [], 0),
      node("App/TodoList/TodoRow[1]", ["DoneCheckbox", "RemoveButton"], [], 1),
    ]),
    node("App/Footer", ["ClearButton"]),
  ]),
];

Deno.test("am surface --names uses THE walker: it agrees with collectElementPaths", () => {
  const theirs = SURFACE.flatMap(collectElementPaths);
  assertEquals(_surfaceNames(SURFACE), theirs);
  assertEquals(theirs, [
    "App:AddButton",
    "App/TodoList/TodoRow[0]:DoneCheckbox",
    "App/TodoList/TodoRow[0]:RemoveButton",
    "App/TodoList/TodoRow[1]:DoneCheckbox",
    "App/TodoList/TodoRow[1]:RemoveButton",
    "App/Footer:ClearButton",
  ]);
});

Deno.test("am surface --names: no second walker in am", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/am/am-cmd-inspect.ts", import.meta.url),
  );
  assert(
    /import\s*\{[^}]*collectElementPaths[^}]*\}\s*from\s*"\.\.\/air\/ui-surface\.ts"/
      .test(src),
    "am must import the walker from air/ui-surface.ts",
  );
  assert(
    !/names\.push\(e\.path\)/.test(src),
    "the hand-kept `names.push(e.path)` walker must be gone",
  );
});

Deno.test("am trigger with no client never says `am open`", () => {
  // `am open` hands a URL to the desktop's browser — the one thing an agent
  // driving an app must never do. The hint names a launch that stays contained.
  assert(!NO_UI_CLIENT_HINT.includes("am open"), NO_UI_CLIENT_HINT);
  assertStringIncludes(NO_UI_CLIENT_HINT, "am start --client=electron");
  assertStringIncludes(NO_UI_CLIENT_HINT, "--client=browser");
  assertStringIncludes(NO_UI_CLIENT_HINT, "nested display");
});
