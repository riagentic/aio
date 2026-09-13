// A `sync-req` whose `cells` map holds a junk entry was the SERVER's error.
//
// The catch-up loop destructured `{ lastHlc, lastServerTs }` straight off each
// value, so `cells: { notes: null }` — three bytes on the wire — threw
// `TypeError: Cannot read properties of null (reading 'lastHlc')` out of the
// async body. That became an ERROR line blaming the server for a client's
// malformed frame, and the raw TypeError was shipped BACK to the client in
// `sync-err`. A non-null junk shape was worse still: `lastServerTs: "9"`
// compared as a string against numbers and never threw at all.
//
// The envelope check already refuses a `cells` that is not an object; the fix
// is that it now refuses the ENTRIES too, in the same place, naming the cell.
// (audit a2/W7, 2026-09-02)
import { assert, assertEquals } from "@std/assert";
import { createServerSyncHandler } from "../../src/sync/server-handler.ts";
import { createTestDb } from "./_test-db.ts";

const CELL = "notes";

function rig() {
  const { db, close } = createTestDb();
  const sent: string[] = [];
  const socket = { send: (m: string) => sent.push(m) } as unknown as WebSocket;
  const warns: string[] = [];
  const errors: string[] = [];
  const handler = createServerSyncHandler({
    dispatch: () => {},
    db,
    syncCellIds: [CELL],
    getCellState: () => ({ items: [] }),
    getClientCellState: () => ({ items: [] }),
    broadcastRaw: { fn: () => {} },
    log: {
      debug: () => {},
      warn: (m) => warns.push(m),
      error: (m) => errors.push(m),
    },
  });
  return { handler, socket, sent, warns, errors, close };
}

const macro = () => new Promise<void>((r) => setTimeout(r, 20));

const JUNK: Array<[string, unknown]> = [
  ["null", null],
  ["a number", 7],
  ["a string", "9"],
  ["an array", [1, 2, 3]],
  ["a bad lastHlc", { lastHlc: "not-an-hlc" }],
  ["a short lastHlc", { lastHlc: [1, 2] }],
  ["a string lastServerTs", { lastHlc: null, lastServerTs: "9" }],
  ["a NaN lastServerTs", { lastHlc: null, lastServerTs: NaN }],
];

for (const [label, value] of JUNK) {
  Deno.test(`sync-req: a cell cursor that is ${label} is the CLIENT's error`, async () => {
    const r = rig();
    try {
      r.handler.handleSync(
        { clientId: "c1", cells: { [CELL]: value }, pendingOps: [] },
        { id: "c1" },
        r.socket,
      );
      await macro();

      assertEquals(
        r.errors,
        [],
        `a malformed client frame must never be logged as a server error: ${
          JSON.stringify(r.errors)
        }`,
      );
      assertEquals(
        r.sent.filter((m) => m.includes("Cannot read properties")).length,
        0,
        `a raw TypeError must never be shipped to the client: ${
          JSON.stringify(r.sent)
        }`,
      );
      assert(
        r.warns.some((w) => w.includes(`invalid cursor for cell "${CELL}"`)),
        `the refusal must name the cell it refused: ${JSON.stringify(r.warns)}`,
      );
    } finally {
      r.close();
    }
  });
}

Deno.test("sync-req: a well-formed cursor still answers", async () => {
  const r = rig();
  try {
    r.handler.handleSync(
      { clientId: "c1", cells: { [CELL]: { lastHlc: null } }, pendingOps: [] },
      { id: "c1" },
      r.socket,
    );
    await macro();
    assertEquals(r.errors, []);
    assert(
      r.sent.some((m) => m.includes("sync-res")),
      `the shape check must not refuse a valid request: ${
        JSON.stringify(r.sent)
      }`,
    );
  } finally {
    r.close();
  }
});

// ── a refused request must be ANSWERED, or the client freezes forever ────────
//
// `handleSync`'s own `.catch` states the contract — "Notify client so it can
// back off and retry instead of hanging in 'syncing'" — and only that exit
// honoured it. A request refused AT THE DOOR sent nothing back at all.
//
// That matters because the client's catch-up gate has no timeout and only
// three things reopened it: engine boot, going offline→online, and a
// `sync-err` frame. On a still-open connection none of those happens, so the
// cell stopped receiving peer changes and stopped confirming its own ops,
// permanently and silently: status stuck at "syncing", the pending buffer
// growing toward `pendingCap`, and past it the user's own mutations throw.
//
// Measured before the fix: `frames the server sent back: []`.
Deno.test("sync server: a refused envelope is answered with sync-err", async () => {
  const r = rig();
  try {
    // No clientId — refused by the envelope check.
    r.handler.handleSync(
      { cells: {}, pendingOps: [] },
      { id: "c1" } as never,
      r.socket,
    );
    await macro();
    const kinds = r.sent.map((f) => (JSON.parse(f) as { t: string }).t);
    assertEquals(
      kinds,
      ["sync-err"],
      `a refused request must be answered; the client is waiting: ` +
        JSON.stringify(r.sent),
    );
    assert(
      JSON.parse(r.sent[0]!).d.reason.includes("clientId"),
      "…and it must say what was wrong: " + r.sent[0],
    );
  } finally {
    r.close();
  }
});

Deno.test("sync server: a refused cell cursor is answered with sync-err", async () => {
  const r = rig();
  try {
    r.handler.handleSync(
      { clientId: "c1", cells: { [CELL]: null }, pendingOps: [] },
      { id: "c1" } as never,
      r.socket,
    );
    await macro();
    const kinds = r.sent.map((f) => (JSON.parse(f) as { t: string }).t);
    assertEquals(
      kinds,
      ["sync-err"],
      `a refused cursor must be answered too: ${JSON.stringify(r.sent)}`,
    );
    assert(
      JSON.parse(r.sent[0]!).d.reason.includes(CELL),
      "…naming the cell whose cursor was wrong: " + r.sent[0],
    );
  } finally {
    r.close();
  }
});
