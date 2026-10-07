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
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { renderHeadlessSurface } from "../src/server/server-surface.ts";
import { headlessSurfaceNote } from "../src/am/am-cmd-inspect.ts";
import { spec } from "./module-spec-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

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
      `import { h } from "${spec(vdom)}";
export const Child = () => h("span", null, "VERSION-ONE");
`,
    );
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      `import { h } from "${spec(vdom)}";
import { Child } from "./Child.tsx";
export default function App() { return h("div", null, h(Child, null)); }
`,
    );
    const entry = join(dir, "App.tsx");
    // Written before the import, and dated so: the import is stamped with
    // `Date.now()` and a file with the file system's clock, and the two do
    // not agree to the millisecond (measured on a Windows laptop: files
    // written just before the stamp were dated 8 ms after it — "STALE").
    const before = new Date(Date.now() - 5_000);
    await Deno.utime(join(dir, "Child.tsx"), before, before);
    await Deno.utime(entry, before, before);

    const fresh = await renderHeadlessSurface(entry);
    assert(fresh.ok, !fresh.ok ? fresh.error : "");
    assertEquals(headlessSurfaceNote(fresh.roots), null, "nothing changed yet");
    assert(!JSON.stringify(fresh.roots).includes('"stale"'));

    // A component the entry imports, not the entry itself: the case an
    // entry-only mtime check would miss.
    await Deno.writeTextFile(
      join(dir, "Child.tsx"),
      `import { h } from "${spec(vdom)}";
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

// The file system's clock is not `Date.now()`: a few ms apart on a Windows
// laptop, any distance on a network share. A file written BEFORE the import
// and dated after it by its file system read as changed after it — "STALE"
// on a render that is current. A file is compared with its own mtime as of
// the import, so the two clocks never meet.
Deno.test("headless surface: a file system clock AHEAD of the process is not an edit — and an edit is still one", async () => {
  const dir = await tempDir("surface-skew-");
  try {
    const vdom = `${toFileUrl(REPO).href}/src/air/vdom.ts`;
    const entry = join(dir, "App.tsx");
    await Deno.writeTextFile(
      entry,
      `import { h } from "${spec(vdom)}";
export default function App() { return h("div", null, "SKEW-ONE"); }
`,
    );
    const ahead = new Date(Date.now() + 60_000);
    await Deno.utime(entry, ahead, ahead);

    const fresh = await renderHeadlessSurface(entry);
    assert(fresh.ok, !fresh.ok ? fresh.error : "");
    assertEquals(headlessSurfaceNote(fresh.roots), null, "written before it");

    await Deno.writeTextFile(
      entry,
      `import { h } from "${spec(vdom)}";
export default function App() { return h("div", null, "SKEW-TWO"); }
`,
    );
    const edited = new Date(Date.now() + 120_000);
    await Deno.utime(entry, edited, edited);
    const again = await renderHeadlessSurface(entry);
    assert(again.ok, !again.ok ? again.error : "");
    const note = headlessSurfaceNote(again.roots);
    assert(note !== null && note.includes("STALE"), String(note));
  } finally {
    await dropTempDir(dir);
  }
});

// A file put back with an OLDER date — a rename over it, `cp -p`, `rsync -t`
// — is as much an edit as one dated later.
Deno.test("headless surface: a file replaced by one with an older mtime is an edit", async () => {
  const dir = await tempDir("surface-older-");
  try {
    const vdom = `${toFileUrl(REPO).href}/src/air/vdom.ts`;
    const entry = join(dir, "App.tsx");
    const write = (text: string) =>
      Deno.writeTextFile(
        entry,
        `import { h } from "${spec(vdom)}";
export default function App() { return h("div", null, "${text}"); }
`,
      );
    await write("OLDER-ONE");
    const fresh = await renderHeadlessSurface(entry);
    assert(fresh.ok, !fresh.ok ? fresh.error : "");
    assertEquals(headlessSurfaceNote(fresh.roots), null);

    await write("OLDER-TWO");
    const dayAgo = new Date(Date.now() - 86_400_000);
    await Deno.utime(entry, dayAgo, dayAgo);
    const again = await renderHeadlessSurface(entry);
    assert(again.ok, !again.ok ? again.error : "");
    const note = headlessSurfaceNote(again.roots);
    assert(note !== null && note.includes("STALE"), String(note));
  } finally {
    await dropTempDir(dir);
  }
});
