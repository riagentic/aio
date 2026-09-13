// tests/sync/server-write-max-wait.test.ts — a sync cell written faster than
// the debounce still settles.
//
// Server-origin writes to a sync cell are folded into its snapshot (their only
// durability) and pushed to live clients on a 100ms debounce. A pure debounce
// restarts on every write, so a cell written more often than that — a price
// feed, a 50ms cron, a progress counter — never settled at all while the writes
// kept coming: no compaction (a restart rewound all of them) and no push
// (measured: the server at price 40, the tab still at 0). The first unsettled
// write now starts a clock later writes cannot reset.
import { assert } from "@std/assert";
import { createNet, type State } from "./_net.ts";
import { hasSyncSnapshot } from "../../src/sync/server-store.ts";

const CELL = "ticker";
const apply = (s: State, action: string, payload: unknown): State =>
  action === "tick" ? { ...s, price: payload } : s;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("server writes every 20ms reach the tab and the snapshot while they keep coming", async () => {
  const net = createNet({
    cell: CELL,
    initial: () => ({ price: 0 }),
    apply,
  });
  let n = 0;
  const feed = setInterval(
    () => net.serverWrite((s) => apply(s, "tick", ++n)),
    20,
  );
  try {
    const tab = net.addClient("tab");
    await tab.engine.requestSync();
    await net.pump();

    // Well past the max wait (500ms), with the writes still arriving.
    await sleep(1200);
    await net.pump(40);
    const seen = tab.confirmed().price as number;
    assert(
      seen > 0,
      `the tab holds price ${seen} while the server is at ${net.live().price} — the push never settled`,
    );
    assert(
      await hasSyncSnapshot(net.db, CELL),
      "the writes were never folded into the cell's snapshot — a restart " +
        "would rewind every one of them",
    );
  } finally {
    clearInterval(feed);
    await net.close();
  }
});
