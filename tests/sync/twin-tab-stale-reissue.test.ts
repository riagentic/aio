// Probe: two tabs sharing one queue, device clock 3 days behind, an offline
// edit flushed by BOTH tabs. The server refuses it as stale to each; one tab
// re-makes it. Does the other tab report the KEPT change as rejected?
import { assertEquals } from "@std/assert";
import { createNet } from "./_net.ts";
import { createMemoryStorage } from "../../src/sync/op-buffer.ts";

Deno.test("twin tabs: a stale op re-made by one tab is not reported rejected by the other", async () => {
  const rejected: string[] = [];
  const net = createNet({
    cell: "doc",
    initial: () => ({ items: [] }),
    apply: (s, action, p) =>
      action === "add" ? { items: [...(s.items as string[]), p as string] } : s,
    sync: { onRejected: (r) => void rejected.push(r.reason) },
  });
  try {
    const behind = () => Date.now() - 3 * 86_400_000;
    const storage = createMemoryStorage();
    const a = net.addClient("me", storage, { now: behind });
    const b = net.addClient("me", storage, { now: behind });
    a.online = b.online = false;
    a.engine.setOnline(false);
    b.engine.setOnline(false);
    await a.engine.handleLocalAction("doc", "add", "x");
    a.online = b.online = true;
    a.engine.setOnline(true);
    b.engine.setOnline(true);
    await net.pump();
    console.log("server:", net.live(), "A:", a.view(), "B:", b.view());
    console.log("rejected:", rejected, "serverLog:", net.serverLog);
    assertEquals(net.live().items, ["x"], "the change was kept (re-made)");
    assertEquals(rejected, [], "no tab may report the kept change as rejected");
  } finally {
    await net.close();
  }
});
