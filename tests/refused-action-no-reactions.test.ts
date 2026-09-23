// tests/refused-action-no-reactions.test.ts — what `listensTo` listeners see
// of an action its owner REFUSED (validate, a disabled cell).
//
// A plain action (a call, a trojan POST): the listeners run, exactly as in
// 1.0.9 — the surface is frozen, and a replay re-runs the same decision, so
// live and reboot agree.
//
// A SYNC OP: its refusal is answered `op-rejected` and the op is deleted from
// the op-log. 1.0.9 still ran its listeners, so a `tally` counted an add that,
// for the origin and every peer, never happened — and the next boot (whose
// op-log no longer holds the op) silently took it back: live ≠ reboot. A
// refused sync op has no reactions.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import { createDispatch } from "../src/state/dispatch.ts";
import type { Msg } from "../src/state/cell-types.ts";
import { createServerSyncHandler } from "../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../src/sync/server-store.ts";
import { createTestDb, recordingSocket } from "./sync/_test-db.ts";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const PROBE = new URL("./fixtures/refused-probe/app.js", import.meta.url)
  .pathname;
const TREE = new URL("..", import.meta.url).pathname;

const noop = { debug: () => {}, warn: () => {}, error: () => {} };

function makeCells() {
  const notes = cell("notes", {
    state: { items: [] as string[] },
    methods: {
      add(s, t: string) {
        s.items.push(t);
      },
    },
    validate: (s) => s.items.includes("bad") ? "no bad" : true as const,
  });
  const tally = cell("tally", {
    state: { n: 0 },
    methods: {
      onAdd(s) {
        s.n += 1;
      },
    },
    listensTo: { onAdd: "notes:add" },
  });
  return [notes, tally];
}

type S = { notes: { items: string[] }; tally: { n: number } };

Deno.test("refused action: a plain action's listeners run after the owner refused — as in 1.0.9", () => {
  const composed = composeCells(makeCells());
  let state = composed.initialState as unknown as S;
  const run = (t: string, extra: Record<string, unknown> = {}) => {
    state = composed.reduce(
      state as never,
      { type: "notes:add", payload: { args: [t] }, ...extra } as never,
    ).state as unknown as S;
  };
  run("ok");
  assertEquals([state.notes.items, state.tally.n], [["ok"], 1]);
  run("bad");
  assertEquals(state.notes.items, ["ok"], "validate refused the owner");
  assertEquals(state.tally.n, 2, "…and the listener ran, as it always did");
  // The same refusal on a sync op: no reaction.
  run("bad", { _syncOp: true });
  assertEquals([state.notes.items, state.tally.n], [["ok"], 2]);
  run("ok2", { _syncOp: true });
  assertEquals([state.notes.items, state.tally.n], [["ok", "ok2"], 3]);
});

Deno.test("refused action: a disabled owner — a plain action's listeners run, a sync op's do not", () => {
  const composed = composeCells(makeCells());
  let state = composed.initialState as Record<string, unknown>;
  const app = {
    dispatch: (a: Msg) => {
      state = composed.reduce(state as never, a as never).state as never;
    },
    getState: () => state,
  };
  composed.registry.disable("notes", app);
  const run = (extra: Record<string, unknown> = {}) => {
    state = composed.reduce(
      state as never,
      { type: "notes:add", payload: { args: ["x"] }, ...extra } as never,
    ).state as never;
  };
  run();
  const s1 = state as unknown as S;
  assertEquals([s1.notes.items, s1.tally.n], [[], 1]);
  run({ _syncOp: true });
  const s2 = state as unknown as S;
  assertEquals([s2.notes.items, s2.tally.n], [[], 1]);
});

Deno.test("refused action: a sync op validate refuses is rejected AND leaves no reaction", async () => {
  _resetServerTsForTest();
  const composed = composeCells(makeCells());
  let state = composed.initialState as Record<string, unknown>;
  const app = { dispatch: (a: Msg) => dispatch(a), getState: () => state };
  const dispatch = createDispatch<Record<string, unknown>, Msg, Msg>({
    reduce: composed.reduce as never,
    execute: (e) => composed.execute(app, e as Msg),
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
  });
  const { db, close } = createTestDb();
  const handler = createServerSyncHandler({
    dispatch: (a) => dispatch(a as unknown as Msg),
    db,
    syncCellIds: ["notes"],
    getCellState: (c) => (state as Record<string, never>)[c] ?? {},
    getClientCellState: (c) => (state as Record<string, never>)[c] ?? {},
    broadcastRaw: { fn: () => {} },
    log: noop,
  });
  try {
    const sock = recordingSocket();
    const T0 = Date.now();
    await handler.handleOp(
      {
        id: "op-bad",
        hlc: [T0 + 1, 0, "c1"],
        cell: "notes",
        action: "add",
        payload: { args: ["bad"] },
      },
      { id: "c1" },
      sock.socket,
    );
    assertEquals(sock.frames.some((f) => f.t === "op-rejected"), true);
    assertEquals(sock.frames.some((f) => f.t === "sync-ack"), false);
    const s = state as unknown as S;
    assertEquals(s.notes.items, []);
    assertEquals(
      s.tally.n,
      0,
      "the op was rejected and removed from the log — a reaction to it is a " +
        "change no replay can re-derive and no peer shares",
    );
  } finally {
    close();
  }
});

Deno.test("refused action: live and after a kill agree — a refused call's listener ran, a refused op's did not", async () => {
  const dir = await tempDir("aio-refused-probe-");
  try {
    const run = async (phase: string) => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(TREE, "deno.json"), PROBE],
        env: {
          DIR: dir,
          PORT: String(freePort()),
          AIO_APPS_DIR: dir,
          XDG_RUNTIME_DIR: dir,
          PHASE: phase,
          MOD: new URL(`file://${join(TREE, "mod.ts")}`).href,
          AIO_NO_OPEN: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
    };
    const log = await run("go");
    const live = JSON.parse(
      await Deno.readTextFile(join(dir, "live.json")).catch(() => {
        throw new Error(log);
      }),
    );
    assertEquals(live, {
      src: 2,
      ssrc: 2,
      audit: { inc: 4, sinc: 2 },
      frames: ["op-rejected", "op-rejected", "sync-ack", "sync-ack"],
    }, log);
    for (let boot = 1; boot <= 2; boot++) {
      const b = await run("read");
      const got = JSON.parse(
        await Deno.readTextFile(join(dir, "recovered.json")),
      );
      assertEquals(got, { src: 2, ssrc: 2, audit: { inc: 4, sinc: 2 } }, b);
    }
  } finally {
    await dropTempDir(dir);
  }
});
