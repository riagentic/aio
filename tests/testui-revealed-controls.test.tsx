// Two field reports about the same promise, from opposite directions: "acting
// on UI a previous action creates just works".
//
// fezor F-4: a row click dispatches a method that itself dispatches another,
// and the second one is not drained — so the test has to bypass the UI and call
// the cell directly, with a comment explaining why.
// GOT #9b: a control that only exists after a previous queued action — revealed
// by `useLocal`-driven conditional rendering, not by cell state — was not found
// until an explicit `await ui.settle()` was inserted between the two clicks.
//
// Both are "the queue must leave the DOM in the state the next action assumes".
// The nested-CELL-dispatch half is pinned in testui-nested-dispatch.test.tsx;
// this file pins the two shapes those reports actually used: a chain THREE
// dispatches deep, and a purely LOCAL signal with no cell involved at all (the
// case a `_pendingCallPromises()` drain cannot see, because there is no call to
// wait for).
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { useLocal } from "../src/air.ts";
import { testUI } from "../src/testing/ui-test.ts";

// ── F-4: click → method → method → method ───────────────────────────────────

type Vault = { open: boolean; files: string[]; log: string[] };

const vault = cell("rev-vault", {
  state: { open: false, files: [], log: [] } as Vault,
  methods: {
    async load(s: Vault) {
      await new Promise((r) => setTimeout(r, 30));
      s.files = ["notes.md", "keys.gpg"];
      s.log.push("load");
    },
    async openVault(s: Vault) {
      await new Promise((r) => setTimeout(r, 30));
      s.open = true;
      s.log.push("open");
      // Fire-and-forget, one level deeper than the report's own case.
      void vault.load();
    },
  },
});

const rows = cell("rev-rows", {
  state: { clicked: 0 },
  methods: {
    pick(s: { clicked: number }) {
      s.clicked += 1;
      void vault.openVault(); // the row click does not await the chain
    },
  },
});

function VaultApp() {
  return (
    <div>
      <div class="button" onClick={() => rows.pick()}>Row</div>
      {vault.open
        ? (
          <ul>
            {vault.files.map((f) => <li>{f}</li>)}
          </ul>
        )
        : <p>locked</p>}
    </div>
  );
}

Deno.test("testUI: a click that starts a THREE-deep dispatch chain settles", async () => {
  await using ui = await testUI(VaultApp);
  ui.RowButton.click();
  // No explicit settle, no sleep, no direct cell call — the report had to do
  // all three.
  await ui.expectCell(vault, (s: Vault) => s.open === true);
  assertEquals(vault.log, ["open", "load"], "the whole chain ran");
  assertStringIncludes(ui.html(), "keys.gpg");
});

// ── GOT #9b: a control revealed by a LOCAL signal ───────────────────────────
//
// No cell, no dispatch, nothing pending for the harness to await — the reveal
// is a local signal write inside an event handler, and the next action in the
// queue addresses the element it revealed.

function LocalRevealApp() {
  const s = useLocal({ shown: false, count: 0 });
  return (
    <div>
      <div
        class="button"
        t="new-count"
        onClick={() => s.patch({ shown: true })}
      >
        New count
      </div>
      {s.local.shown
        ? (
          <div
            class="button"
            t="new-target-up"
            onClick={() => s.patch({ count: s.local.count + 1 })}
          >
            Up
          </div>
        )
        : null}
      <span t="count">{s.local.count}</span>
    </div>
  );
}

Deno.test("testUI: a control revealed by a local signal is addressable next", async () => {
  await using ui = await testUI(LocalRevealApp);
  // The documented promise, exactly as written: queue both, await neither.
  ui["new-count"].click();
  ui["new-target-up"].click();
  await ui.waitFor(() => ui.count.text === "1");
  assertEquals(ui.count.text, "1");
});

Deno.test("testUI: the same reveal, three actions deep", async () => {
  await using ui = await testUI(LocalRevealApp);
  ui["new-count"].click();
  ui["new-target-up"].click();
  ui["new-target-up"].click();
  ui["new-target-up"].click();
  await ui.waitFor(() => ui.count.text === "3");
});
