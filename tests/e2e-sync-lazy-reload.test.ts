// The sync engine is a LAZY import in the browser runtime (browser-protocol's
// `_syncLoader`): a sync cell's first boot awaits it, a non-sync app never
// requests it. This is the real-browser half of that contract — after a
// "reload" (a fresh tab: new page, new module graph, the engine fetched again
// on demand), a sync app converges with what the previous tab wrote, and keeps
// working: the lazily booted engine replays and routes new ops.
import { assert } from "@std/assert";
import { BROWSER, waitFor, withE2E } from "./e2e-harness.ts";

const ignore = BROWSER === null;

const CELLS = `import { cell } from "aio";
export const board = cell("board", {
  state: { notes: [] as string[] },
  sync: true,
  methods: {
    add(s, text: string) { s.notes.push(text); },
  },
});`;

const APP = `import { board } from "./cells.ts";
export default function App() {
  return (
    <div>
      <button t="add" onClick={() => board.add("note-" + board.notes.length)}>
        Add
      </button>
      <span t="count">{String(board.notes.length)}</span>
    </div>
  );
}`;

Deno.test({
  name:
    "e2e sync lazy: a sync app converges after a reload and keeps syncing (engine loaded on demand)",
  ignore,
  async fn() {
    await withE2E(
      { cells: CELLS, app: APP },
      async ({ server, tab, openTab }) => {
        await waitFor("mount", () => tab.text("count"));
        await tab.trigger("App:add", "click");
        await waitFor("tab 1 shows 1", async () => {
          return (await tab.text("count")) === "1" ? true : null;
        }, 15_000);
        await waitFor("server converged to 1", async () => {
          const st = await server.state() as { board?: { notes?: string[] } };
          return st.board?.notes?.length === 1 ? true : null;
        }, 15_000);

        // "Reload": the page goes away and a fresh one loads — the engine is
        // fetched again through the dynamic import, boots, and must show the
        // converged state.
        await tab.close();
        const tab2 = await openTab();
        await waitFor("tab 2 converged to 1", async () => {
          return (await tab2.text("count")) === "1" ? true : null;
        }, 20_000);

        // …and the lazily booted engine routes NEW ops.
        await tab2.trigger("App:add", "click");
        await waitFor("server converged to 2", async () => {
          const st = await server.state() as { board?: { notes?: string[] } };
          return st.board?.notes?.length === 2 ? true : null;
        }, 15_000);
        const st = await server.state() as { board: { notes: string[] } };
        assert(
          st.board.notes[0] === "note-0" && st.board.notes[1] === "note-1",
          JSON.stringify(st.board),
        );
      },
    );
  },
});
