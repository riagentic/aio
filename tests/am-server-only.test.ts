// machine Broken-2 / M2 — `am state` and `am surface` must work for
// `--client=server-only` apps (headless: NO browser/electron client ever
// connects). The server owns the authoritative state and the UI entry:
//   - `am state`   → trojan `state` serves the SERVER's live store
//   - `am surface` → trojan `surface/server` renders the UI entry in-process
//     against live cell state (the alpha27 headless fallback)
// These go through the exact client functions the am CLI uses (trojanGet).
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { trojanGet } from "../src/am/am-http.ts";
import { aio } from "../src/server/aio.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("Broken-2: am state serves the SERVER's live store with zero clients", async () => {
  _resetAioRuntime();
  const { cell } = await import("../src/state/cell-create.ts");
  const machine = cell("am-headless-state", {
    state: { cpu: 0 },
    methods: {
      poll(s: { cpu: number }, v: number) {
        s.cpu = v;
      },
    },
  });

  const app = await aio.run({
    cells: [machine],
    appId: "am-headless-state-app",
    libraryMode: true,
    persist: false,
    client: "server-only",
    baseDir: await Deno.makeTempDir(),
  });
  try {
    await (machine as unknown as { poll: (v: number) => Promise<void> }).poll(
      87,
    );
    // Exactly what `am state --json` does (am-cmd-state.ts → trojanGet).
    const result = await trojanGet(app.port!, "state");
    assert(result.ok, `am state failed: ${!result.ok ? result.error : ""}`);
    assertEquals(
      (result.data as Record<string, { cpu: number }>)["am-headless-state"],
      { cpu: 87 },
      "server-authoritative state — no browser client required",
    );
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

Deno.test("M2: am surface renders headlessly against LIVE state (server-only app)", async () => {
  _resetAioRuntime();
  const dir = await Deno.makeTempDir({ prefix: "am-headless-surface-" });
  // A real minimal app on disk: the cell module + a UI entry reading it. The
  // headless render imports App.tsx; Deno's module cache resolves cell.ts to
  // the SAME instance the server boots below — so the surface shows live state.
  await Deno.writeTextFile(
    join(dir, "cell.ts"),
    `import { cell } from "${toFileUrl(REPO).href}/src/state/cell-create.ts";
export const hw = cell("am-headless-surface", {
  state: { label: "initial" },
  methods: { set(s, v: string) { s.label = v; } },
});
`,
  );
  await Deno.writeTextFile(
    join(dir, "App.tsx"),
    `import { h } from "${toFileUrl(REPO).href}/src/air/vdom.ts";
import { hw } from "./cell.ts";
export default function App() {
  return h(
    "div",
    null,
    h("span", null, (hw as { label?: string }).label ?? ""),
    h("button", { onClick: () => {} }, "Refresh"),
  );
}
`,
  );

  const mod = await import(toFileUrl(join(dir, "cell.ts")).href) as {
    hw: import("../src/state/cell.ts").CellDef;
  };
  const app = await aio.run({
    cells: [mod.hw],
    appId: "am-headless-surface-app",
    libraryMode: true,
    persist: false,
    client: "server-only",
    baseDir: dir,
  });
  try {
    await (mod.hw as unknown as { set: (v: string) => Promise<void> }).set(
      "live-from-server",
    );
    // The am CLI fallback path: no client connected → `surface/server`.
    const result = await trojanGet(
      app.port!,
      "surface/server",
      undefined,
      10_000,
    );
    assert(result.ok, `am surface failed: ${!result.ok ? result.error : ""}`);
    const surf = JSON.stringify(result.data);
    assert(
      surf.includes("live-from-server"),
      `surface must show LIVE state, not initial: ${surf}`,
    );
    assert(surf.includes("RefreshButton"), `elements surfaced: ${surf}`);
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});
