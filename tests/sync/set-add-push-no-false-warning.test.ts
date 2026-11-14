// A set merge orders members older-side-first; the rebase keeps the server's
// order. Same members, other order, is not a view-only loss: a correct push
// onto a set-add field warned "this method replaces the whole value".
// deno-lint-ignore-file no-explicit-any
// set-add field + a PUSH method (the documented-correct shape): a concurrent
// remote add makes the engine warn "this method replaces the whole value".
import { produce } from "immer";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
Deno.test({
  name: "set-add + push: no 'replaces the whole value' warning",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const warns: string[] = [];
    const ow = console.warn, ol = console.log, oe = console.error;
    const cap = (...a: unknown[]) => warns.push(a.map(String).join(" "));
    console.warn = cap;
    console.log = cap;
    console.error = cap;
    const confirmed: Record<string, Record<string, unknown>> = {
      notes: { items: [{ id: "x" }] },
    };
    const engine = createSyncEngine({
      clientId: "A",
      cells: {
        notes: {
          merge: { items: "set-add" },
          identity: { items: "id" },
        } as never,
      },
      buffer: createOpBuffer(createMemoryStorage(), {}),
      send: () => {},
      reducer: (st: any, action: string, payload: unknown) =>
        produce(st, (d: any) => {
          if (action === "add") {
            d.items.push({ id: (payload as { args: string[] }).args[0] });
          }
        }),
      getConfirmedState: () => confirmed,
      setConfirmedState: (c: string, s: any) => {
        confirmed[c] = s;
      },
      onStateUpdate: () => {},
      log: { warn: (m: string) => warns.push(m) },
    } as never);
    engine.setOnline(true);
    await engine.handleLocalAction("notes", "add", { args: ["a"] });
    await engine.handleRemoteOp(
      {
        id: "B-1",
        hlc: [Date.now() + 5, 0, "B"],
        cell: "notes",
        action: "add",
        payload: { args: ["b"] },
      } as never,
    );
    engine.dispose();
    await new Promise((r) => setTimeout(r, 50));
    console.warn = ow;
    console.log = ol;
    console.error = oe;

    if (warns.some((w) => /replaces the whole value/.test(w))) {
      throw new Error(
        "false-positive warning: " +
          warns.find((w) => /replaces/.test(w))!.slice(0, 200),
      );
    }
  },
});
