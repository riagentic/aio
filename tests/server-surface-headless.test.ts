// machine M2 regression — `am surface` with NO connected client:
// the server renders the UI entry in-process against live cell state and
// returns the same semantic surface a client would report.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { renderHeadlessSurface } from "../src/server/server-surface.ts";
import { handleTrojan } from "../src/server/server-trojan.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("renderHeadlessSurface: renders a UI entry against live cells", async () => {
  const dir = await Deno.makeTempDir({ prefix: "surface-headless-" });
  try {
    // A minimal app: one cell + a default-exported component reading it.
    await Deno.writeTextFile(
      join(dir, "cell.ts"),
      `import { cell } from "${toFileUrl(REPO).href}/src/state/cell-create.ts";
export const hstate = cell("headless-demo", {
  state: { label: "live-from-server" },
  methods: { set(s, v: string) { s.label = v; } },
});
`,
    );
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      `import { h } from "${toFileUrl(REPO).href}/src/air/vdom.ts";
import { hstate } from "./cell.ts";
export default function App() {
  return h(
    "div",
    null,
    h("span", null, (hstate as { label?: string }).label ?? ""),
    h("button", { onClick: () => {} }, "Refresh"),
  );
}
`,
    );

    const result = await renderHeadlessSurface(join(dir, "App.tsx"));
    assert(result.ok, `render failed: ${!result.ok ? result.error : ""}`);
    const surf = JSON.stringify(result.roots);
    assert(surf.includes("RefreshButton"), `button not surfaced: ${surf}`);
    assert(surf.includes("App"), `component missing: ${surf}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("renderHeadlessSurface: loud error for a missing/invalid entry", async () => {
  const missing = await renderHeadlessSurface("/nonexistent/App.tsx");
  assert(!missing.ok && missing.error.includes("failed to import"));

  const dir = await Deno.makeTempDir({ prefix: "surface-headless-bad-" });
  try {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export const notDefault = 1;\n",
    );
    const noDefault = await renderHeadlessSurface(join(dir, "App.tsx"));
    assert(
      !noDefault.ok && noDefault.error.includes("default-exported"),
      `wrong error: ${JSON.stringify(noDefault)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("trojan: surface/server routes to the headless renderer", async () => {
  // deno-lint-ignore no-explicit-any
  const deps = (renderServerSurface: any) =>
    ({
      trojan: {
        getState: () => ({}),
        getSchedules: () => [],
        startedAt: Date.now(),
      },
      prod: false,
      authInfo: { mode: "none", expose: false },
      getUIState: () => ({}),
      getWsClients: () => [],
      sendToWsClient: () => ({ found: false as const }),
      getRecentErrors: () => [],
      renderServerSurface,
      // deno-lint-ignore no-explicit-any
    }) as any;

  // ok path
  const okResp = await handleTrojan(
    "/__aio/trojan/surface/server",
    undefined,
    deps(() => Promise.resolve({ ok: true, roots: [{ component: "App" }] })),
  );
  assertEquals(okResp!.status, 200);
  const body = await okResp!.json();
  assertEquals(body[0].component, "App");

  // error path is surfaced, not swallowed
  const errResp = await handleTrojan(
    "/__aio/trojan/surface/server",
    undefined,
    deps(() => Promise.resolve({ ok: false, error: "boom" })),
  );
  assertEquals(errResp!.status, 500);

  // absent dep → 404 with a reason
  const noneResp = await handleTrojan(
    "/__aio/trojan/surface/server",
    undefined,
    deps(undefined),
  );
  assertEquals(noneResp!.status, 404);
});
