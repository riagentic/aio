// tests/sync/merge-view-only-loss.test.ts — a merge strategy the server will
// not keep must never lose an edit silently.
//
// `merge: { body: "text" }` shapes the CLIENT's view; the server applies each
// op through the cell's method. With an assigning method
// (`setBody(s, text) { s.body = text }`) the change the server gets last
// replaces the whole value — so two peers editing different paragraphs of one
// note offline kept ONE edit, and nothing said so: the catch-up path, where
// offline edits meet, never ran conflict detection at all (onConflict fired
// only for edits made while both were online), and the docs promised "never a
// silent loss".
import { assert, assertEquals } from "@std/assert";
import type { SyncConflict } from "../../src/sync/types.ts";
import { createNet, type State } from "./_net.ts";

const CELL = "docs";
const BASE = "intro\nbody\noutro\n";
const apply = (s: State, action: string, payload: unknown): State =>
  action === "setBody" ? { ...s, body: payload as string } : s;

function capture(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  return { warns, restore: () => void (console.warn = w) };
}

Deno.test("offline edits meeting in a catch-up: onConflict fires and the lost merge is said out loud", async () => {
  const conflicts: SyncConflict[] = [];
  const cap = capture();
  const net = createNet({
    cell: CELL,
    initial: () => ({ body: BASE }),
    apply,
    sync: {
      merge: { body: "text" },
      onConflict: (cs) => void conflicts.push(...cs),
    },
  });
  try {
    const a = net.addClient("a");
    const b = net.addClient("b");
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();

    for (const c of [a, b]) {
      c.online = false;
      c.engine.setOnline(false);
    }
    await a.engine.handleLocalAction(
      CELL,
      "setBody",
      "INTRO EDITED\nbody\noutro\n",
    );
    await b.engine.handleLocalAction(
      CELL,
      "setBody",
      "intro\nbody\nOUTRO EDITED\n",
    );
    a.online = true;
    a.engine.setOnline(true);
    await net.pump();
    b.online = true;
    b.engine.setOnline(true);
    await net.pump();

    // The server keeps the change it got last — that is the method's doing.
    assertEquals(net.live().body, "intro\nbody\nOUTRO EDITED\n");
    assertEquals(conflicts.length, 1, "the collision reached onConflict");
    assertEquals(conflicts[0]!.field, "body");
    assert(
      cap.warns.some((w) =>
        w.includes("docs.body") && /cannot keep both/.test(w)
      ),
      `the loss is named — got:\n${cap.warns.join("\n")}`,
    );
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("an incrementing counter merge the server does keep is not reported as lost", async () => {
  const cap = capture();
  const net = createNet({
    cell: "votes",
    initial: () => ({ n: 0 }),
    apply: (s, action, p) =>
      action === "inc" ? { ...s, n: (s.n as number) + (p as number) } : s,
    sync: { merge: { n: "counter" }, onConflict: () => {} },
  });
  try {
    const a = net.addClient("a");
    const b = net.addClient("b");
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();
    for (const c of [a, b]) {
      c.online = false;
      c.engine.setOnline(false);
    }
    await a.engine.handleLocalAction("votes", "inc", 1);
    await b.engine.handleLocalAction("votes", "inc", 1);
    a.online = true;
    a.engine.setOnline(true);
    await net.pump();
    b.online = true;
    b.engine.setOnline(true);
    await net.pump();
    assertEquals(net.live().n, 2);
    assertEquals(b.view().n, 2);
    assertEquals(cap.warns.filter((w) => /cannot keep both/.test(w)), []);
  } finally {
    cap.restore();
    await net.close();
  }
});
