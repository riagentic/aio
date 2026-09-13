// Rendering with no browser: routed components, and selectors.
//
// Measured by an agent previewing a scaffolded app's components:
//   · any component using <Route> or useRoute() failed `am preview` and a
//     client-less `am surface` with "page has no HTTP origin and no IPC
//     bridge" — the router's boot hook was the BROWSER entry's, which opens a
//     WebSocket to `location`, and a headless mount has no location;
//   · `am preview` of a component calling a selector threw "notes.open is not
//     a function" — nothing in the am process had bound the cells, while the
//     live `am surface` (inside the server, cells bound) rendered it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { toFileUrl } from "@std/path";
import { renderHeadlessSurface } from "../src/server/server-surface.ts";
import { _getRouterBoot } from "../src/air/router.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;

/** A routed component and a selector-reading one, with no JSX (so the fixture
 *  needs no app-side compiler config) and the app's real imports. */
async function fixture(): Promise<string> {
  const dir = await tempDir("am-preview-routed-");
  await Deno.mkdir(`${dir}/src`, { recursive: true });
  await Deno.writeTextFile(`${dir}/deno.json`, "{}\n");
  await Deno.writeTextFile(`${dir}/src/app.ts`, "await 1;\n");
  await Deno.writeTextFile(
    `${dir}/src/notes.ts`,
    `import { cell } from "${REPO}mod.ts";
export const notes = cell("notes", {
  state: { items: [{ open: true }, { open: false }, { open: true }] },
  methods: {},
  selectors: { open: (s: { items: { open: boolean }[] }) =>
    s.items.filter((i) => i.open).length },
});
`,
  );
  await Deno.writeTextFile(
    `${dir}/src/Routed.ts`,
    `import { h } from "${REPO}src/air/vdom.ts";
import { Route, useRoute } from "${REPO}src/air.ts";
export function Routed() {
  const r = useRoute();
  return h("div", null,
    h("p", { t: "path" }, r.path),
    h(Route, { path: "/" }, h("h2", { t: "home" }, "Home")));
}
`,
  );
  await Deno.writeTextFile(
    `${dir}/src/Open.ts`,
    `import { h } from "${REPO}src/air/vdom.ts";
import { Route } from "${REPO}src/air.ts";
import { notes } from "./notes.ts";
export function Open() {
  return h(Route, { path: "/" }, h("p", { t: "open" }, "open " + notes.open()));
}
`,
  );
  return dir;
}

Deno.test("headless surface: a <Route>/useRoute component renders at /", async () => {
  const dir = await fixture();
  try {
    // The browser entry (imported by the fixture) installs its own boot.
    await import(toFileUrl(`${dir}/src/Routed.ts`).href);
    const before = _getRouterBoot();
    const r = await renderHeadlessSurface(`${dir}/src/Routed.ts`, true, {
      exportName: "Routed",
    });
    assert(r.ok, `render failed: ${!r.ok && r.error}`);
    const text = JSON.stringify(r.roots);
    assertStringIncludes(text, `"text":"/"`);
    assertStringIncludes(text, "Home");
    assertEquals(
      _getRouterBoot(),
      before,
      "the headless mount must put back the boot hook it replaced",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am preview: a selector is bound, as in the live surface", async () => {
  const dir = await fixture();
  try {
    const o = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        `${REPO}deno.json`,
        `${REPO}src/am.ts`,
        "preview",
        "src/Open.ts",
        "--export=Open",
        "--json",
      ],
      cwd: dir,
      env: {
        AIO_APPS_DIR: `${dir}/.aio-home`,
        AIO_AM_NO_DELEGATE: "1",
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    const text = d.decode(o.stdout) + d.decode(o.stderr);
    assertEquals(o.code, 0, text);
    assertStringIncludes(text, "open 2");
  } finally {
    await dropTempDir(dir);
  }
});
