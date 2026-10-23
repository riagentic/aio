// bootCells' handle reads the server-authoritative state — the one read that
// sees a `visible.exclude`d field (a client-context `cell.x` refuses it).
import { assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";

const vault = cell("bootSrvVault", {
  state: { label: "", note: "" },
  visible: { exclude: ["note"] },
  methods: {
    put(s, v: string) {
      s.label = "set";
      s.note = v;
    },
  },
});

Deno.test("bootCells: handle.serverState reads visible.exclude fields", async () => {
  await using h = await bootCells([vault]);
  await vault.put("k1");
  assertThrows(() => (vault as unknown as { note: string }).note);
  assertEquals(
    h.serverState!<{ note: string }>("bootSrvVault").note,
    "k1",
  );
  assertEquals(
    h.serverState!<{ bootSrvVault: { label: string } }>().bootSrvVault.label,
    "set",
  );
});
