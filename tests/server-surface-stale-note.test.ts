// `am surface` with no client renders the UI module the SERVER imported, and a
// dynamic import is cached for the life of the process. So after an edit to
// App.tsx (or to a component it imports) the headless render shows the OLD UI.
// Measured: the watcher logged `reloaded App.tsx`, the browser bundle carried
// VERSION-TWO, and `am surface` still read VERSION-ONE, under a note that said
// only "this is a server-side render". Re-importing on every edit was rejected
// (the module graph grows per edit, and a busted child can load fresh copies
// of cells instead of the live ones), so the render keeps its import — and
// says, on the answer itself, when a source file is newer than that import.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { renderHeadlessSurface } from "../src/server/server-surface.ts";
import { headlessSurfaceNote } from "../src/am/am-cmd-inspect.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const later = (path: string) => {
  // Past any mtime granularity, and past the render that recorded the import.
  const t = new Date(Date.now() + 5_000);
  return Deno.utime(path, t, t);
};

Deno.test("headless surface: an edit after the server imported the UI marks the render stale, naming the file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "surface-stale-" });
  try {
    const vdom = `${toFileUrl(REPO).href}/src/air/vdom.ts`;
    await Deno.writeTextFile(
      join(dir, "Child.tsx"),
      `import { h } from "${vdom}";
export const Child = () => h("span", null, "VERSION-ONE");
`,
    );
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      `import { h } from "${vdom}";
import { Child } from "./Child.tsx";
export default function App() { return h("div", null, h(Child, null)); }
`,
    );
    const entry = join(dir, "App.tsx");

    const fresh = await renderHeadlessSurface(entry);
    assert(fresh.ok, !fresh.ok ? fresh.error : "");
    assertEquals(headlessSurfaceNote(fresh.roots), null, "nothing changed yet");
    assert(!JSON.stringify(fresh.roots).includes('"stale"'));

    // A component the entry imports, not the entry itself: the case an
    // entry-only mtime check would miss.
    await Deno.writeTextFile(
      join(dir, "Child.tsx"),
      `import { h } from "${vdom}";
export const Child = () => h("span", null, "VERSION-TWO");
`,
    );
    await later(join(dir, "Child.tsx"));

    const again = await renderHeadlessSurface(entry);
    assert(again.ok, !again.ok ? again.error : "");
    const surf = JSON.stringify(again.roots);
    assertStringIncludes(surf, "VERSION-ONE", "the cached import is kept");
    const root = (again.roots as { stale?: Record<string, string> }[])[0]!;
    assert(root.stale, `the --json answer carries the fact: ${surf}`);
    assertEquals(root.stale.file, "Child.tsx");
    const note = headlessSurfaceNote(again.roots);
    assert(note !== null, "the text answer says it too");
    assertStringIncludes(note, "Child.tsx");
    assertStringIncludes(note, "STALE");
    assertStringIncludes(note, "Open a client");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
