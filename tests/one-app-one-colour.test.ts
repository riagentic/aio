// The page and its icon must take their colour from the SAME name.
//
// CLAUDE.md and the `ui.theme` docs both promise "All three take the
// accent/hue from the same hash of the appId, so one app is one colour
// everywhere it appears." The page's theme took `appId || title`; the
// `/__aio/icon` route took `title`. So the moment an author gave their app a
// human title — `appId: "notes-app"` with `ui.title: "My Notes"`, the normal
// case; the scaffold only matches because `am create` writes `title = name` —
// the favicon in the tab was a different hue from the page it labels.
//
// Measured before the fix: page `--aio-hue: 148`, icon gradient hue 190.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const hueOf = (s: string): string[] =>
  [...s.matchAll(/hsl\(\s*([0-9.]+)/g)].map((m) => m[1]!);

Deno.test({
  name: "one app, one colour: the page and /__aio/icon agree",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const c = cell("notes", { state: { n: 0 }, methods: {} });
    const port = freePort();
    const dir = await tempDir("aio-one-colour-");
    const app = await aio.run({
      cells: [c],
      // The shape that broke it: an identity and a HUMAN title.
      appId: "notes-app",
      ui: { title: "My Notes", theme: "full" },
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      // deno-lint-ignore no-explicit-any
    } as any);
    try {
      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      const icon = await (await fetch(`http://127.0.0.1:${port}/__aio/icon`))
        .text();

      const pageHue = /--aio-hue:\s*([0-9.]+)/.exec(page)?.[1];
      assert(pageHue, `the page must carry a theme hue: ${page.slice(0, 200)}`);
      const iconHues = hueOf(icon);
      assert(
        iconHues.length > 0,
        `the icon must be hue-based: ${icon.slice(0, 200)}`,
      );
      assertEquals(
        iconHues[0],
        pageHue,
        `the favicon in the tab is a different colour from the page it ` +
          `labels — "one app is one colour everywhere it appears"`,
      );
    } finally {
      await app.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
