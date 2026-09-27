// `useAio()` (the `aio/air` adapter hook) under testUI hands the component the
// CLIENT's view — the same `visible` projection `cell.field` reads through.
//
// testUI holds the SERVER's state in the hook's signal (it runs the standalone
// loop), and the hook read that signal raw: a component calling
// `useAio().state.vault.secretKey` got the secret in the test while the same
// component over a socket got nothing — a UI test green over a view no user
// can have. Standalone's own `useAio` export: standalone-useaio-visible.test.ts.
import { assert, assertEquals } from "@std/assert";
import { cell } from "aio";
import { useAio } from "aio/air";
import { testUI } from "aio/testing";

const vault = cell("uavtVault", {
  state: { hasKey: true, secretKey: "sk-live-456" },
  visible: { exclude: ["secretKey"] },
  methods: {},
});
const hidden = cell("uavtHidden", {
  state: { token: "t0ps3cret" },
  visible: "none",
  methods: {},
});

function VaultView() {
  // Name both cells so the harness boots them.
  void vault.hasKey;
  void hidden;
  const { state } = useAio<Record<string, Record<string, unknown>>>();
  return (
    <div>
      <div t="vault">{JSON.stringify(state.uavtVault ?? null)}</div>
      <div t="cells">{Object.keys(state).sort().join(",")}</div>
      <div t="hiddenIn">{String("uavtHidden" in state)}</div>
    </div>
  );
}

testUI(
  VaultView,
  "testUI useAio(): the component sees the client's view, not the server's",
  (ui) => {
    assertEquals(ui.vault.text, '{"hasKey":true}');
    assertEquals(ui.hiddenIn.text, "false");
    assert(!ui.cells.text.includes("uavtHidden"), ui.cells.text);
    assert(ui.cells.text.includes("uavtVault"), ui.cells.text);
    // The server read is untouched.
    assertEquals(
      (ui.serverState() as Record<string, Record<string, unknown>>).uavtVault
        ?.secretKey,
      "sk-live-456",
    );
  },
);
