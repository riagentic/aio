// Differential gate: the STANDALONE runtime and the SERVER runtime run the
// same cell program and must be indistinguishable from the app's side.
//
// `src/standalone-air.ts` is not a test double — it is what ships inside the
// Android APK (and what `bootCells` / `testUI` compose on). The server runtime
// (`aio.run()` → `server/aio.ts`) is what every other target runs. They are two
// implementations of ONE documented contract, and every divergence between
// them is a bug that only one target has — found, so far, one field report at
// a time: standalone `close()` never cancelled schedules or disposed `own`
// resources (an `every` kept firing into a dead dispatch on Android), and a
// `scope: "client"` cell's failing method threw SYNCHRONOUSLY where a server
// cell's call rejects (AIO6: every bound method returns a Promise).
//
// So the class is pinned by construction. A small op vocabulary — sync writes
// with return values, a write-then-throw (rollback), object returns, async
// methods whose writes straddle awaits (and one parked on a gate the test
// holds, so the commit AT the await gap is observed mid-flight), an async throw
// after a committed gap, `s.$do` schedules (`after`, a self-cancelling `every`,
// a forever `every`), an `own` resource, and a cross-cell write — is drawn into
// random programs over a cell with a random `visible` filter (exclude, dotted
// exclude, include) — or a `scope: "client"` cell — and a peer cell a
// deps-form selector reads.
// Each program runs on both runtimes; what is compared is what the APP sees:
//
//   - every call's outcome: resolved value, or rejection message — and HOW it
//     failed (a synchronous throw is not a rejection);
//   - CLIENT reads, mid-flight and at the end: every state field (a hidden one
//     is "HIDDEN" — a throwing read on the client seam, an absent key on the
//     wire), plain / parameterized / deps-form / `createSelector` selectors;
//   - `close()`: the `own` resource disposed, and no schedule firing after.
//
// On the server runtime the client is a real WebSocket peer
// (`testMultiClient`) — what it received IS what a browser holds — and its
// selectors are the cell's own selector functions run over that slice, with a
// read of a field the wire withheld throwing, as the client seam documents
// ("reading a hidden field throws — dev and prod alike"). On standalone there
// is no wire: `cell.field` and the bound selectors ARE the client reads.
//
// Schedules run on REAL time on both sides: the server runtime has no virtual
// clock (only standalone's harness hook does), and a differential needs one
// clock for both. The programs only use outcomes that are deterministic under
// real time (a one-shot `after`, an `every` that cancels itself on its 3rd
// step, a forever `every` whose only observable is "did it stop at close()").
//
// Seeds: `AIO_PARITY_SEED` / `AIO_PARITY_N` (through `fuzzEnvInt`). A failure
// names the seed and round and prints the program.
import { assert, assertEquals } from "@std/assert";
import { cell, createSelector, own } from "../mod.ts";
import { schedule } from "../src/state/schedule.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { testMultiClient } from "../src/testing/multi-client-test.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { type Rng, rngOf } from "./sync/properties/_prop.ts";

const SEED = fuzzEnvInt("AIO_PARITY_SEED", 0x9a41) >>> 0;
const N = fuzzEnvInt("AIO_PARITY_N", 8, 1);

// ── programs ─────────────────────────────────────────────────────────────

type Op =
  | { op: "inc"; k: number }
  | { op: "push"; v: string }
  | { op: "name"; v: string }
  | { op: "boom"; v: string }
  | { op: "boomStr" }
  | { op: "ret" }
  | { op: "aw"; k: number }
  | { op: "gate"; k: number }
  | { op: "awBoom"; k: number }
  | { op: "after" }
  | { op: "every" }
  | { op: "beatOn" }
  | { op: "own" }
  | { op: "rate"; r: number };
type Program = { vis: number; client: boolean; ops: Op[] };

/** `visible` filters for the main cell — include and exclude, plain and
 *  dotted. (A dotted INCLUDE is refused by `cell()` itself, identically on
 *  every runtime — cell-helpers.ts — so it is not a runtime difference.) */
const VISIBLE: unknown[] = [
  "all",
  { exclude: ["hid"] },
  { exclude: ["prof.secret"] },
  { include: ["n", "list", "prof", "steps", "ticks"] },
  { include: ["n", "prof", "hid"] },
  { exclude: ["hid", "prof.secret", "list"] },
];

/** Ops a `scope: "client"` cell can run: SYNC methods, no effect runtime. */
const CLIENT_OPS = ["inc", "push", "name", "boom", "boomStr", "ret"] as const;
const ALL_OPS = [
  ...CLIENT_OPS,
  "aw",
  "gate",
  "awBoom",
  "after",
  "every",
  "beatOn",
  "own",
  "rate",
] as const;

function genProgram(r: Rng): Program {
  const client = r.chance(0.25);
  const n = 3 + r.int(6);
  const ops: Op[] = [];
  const once = new Set<string>();
  for (let i = 0; i < n; i++) {
    const name = r.pick(client ? CLIENT_OPS : ALL_OPS);
    // One of each effect per program: a second `every`/`own` on the same id
    // is a REPLACE — a different (and separately specified) contract.
    if (["after", "every", "beatOn", "own"].includes(name)) {
      if (once.has(name)) continue;
      once.add(name);
    }
    const k = 1 + r.int(5);
    const v = r.pick(["x", "y", "zz"]);
    switch (name) {
      case "push":
      case "name":
      case "boom":
        ops.push({ op: name, v });
        break;
      case "rate":
        ops.push({ op: name, r: k });
        break;
      case "ret":
      case "boomStr":
      case "after":
      case "every":
      case "beatOn":
      case "own":
        ops.push({ op: name });
        break;
      default:
        ops.push({ op: name, k });
    }
  }
  // A `scope: "client"` cell is EXEMPT from `visible` — its state never
  // leaves the tab (docs/state/cell-contexts.md) — so it gets "all".
  return { vis: client ? 0 : r.int(VISIBLE.length), client, ops };
}

// ── the cells a program runs on ──────────────────────────────────────────

/** Gates an async method parks on — released by the test after it has read
 *  the state committed at the await gap. */
const gates = new Map<string, () => void>();
const gateWait = (key: string) =>
  new Promise<void>((res) => gates.set(key, res));
/** What `n` was at a gate's await gap — the value a mid-flight read must see
 *  once the gap's batch has committed. */
const gateN = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `cond` until it holds. Real-clock schedules are judged by what they
 *  DID, never by how long they had: a fixed sleep splits the two runtimes on
 *  a loaded machine. The deadline only turns a hang into a named failure. */
async function until(
  cond: () => boolean | Promise<boolean>,
  what: string,
  ms = 20_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1);
  }
}

/** Per-runtime observations the state cannot carry. `steps`/`ticks` count
 *  the schedule-driven reducers, whatever `visible` hides from a read. */
type Side = { events: string[]; beats: number; steps: number; ticks: number };

type MainState = {
  n: number;
  list: string[];
  prof: { name: string; secret: string; tags: number[] };
  hid: string;
  steps: number;
  ticks: number;
};
const INITIAL: MainState = {
  n: 0,
  list: [],
  prof: { name: "p", secret: "s", tags: [] },
  hid: "h",
  steps: 0,
  ticks: 0,
};
const FIELDS = Object.keys(INITIAL) as (keyof MainState)[];

// deno-lint-ignore no-explicit-any
type Any = any;

/** The selector FUNCTIONS, shared by both sides: bound on the cell, and run
 *  over the wire slice to model the browser's read. */
function selectorsFor(peerId: string) {
  const memoLen = createSelector(
    (s: MainState) => s.list,
    (l: string[]) => l.length * 10,
  );
  return {
    total: (s: MainState) => s.n + s.list.length,
    at: (s: MainState, i: number) => s.list[i] ?? null,
    memo: (s: MainState) => memoLen(s),
    scaled: {
      deps: [peerId],
      fn: (s: MainState, [p]: [{ rate: number }]) => s.n * p.rate,
    },
  };
}

/** `clientScope`: build the main cell as `scope: "client"`. Only the
 *  standalone side does — a server never hosts a client cell (it skips them,
 *  aio-composition.ts) — so a `client` program compares a client cell on
 *  standalone with the same methods on a server cell: AIO6 says a bound
 *  method's outcome does not depend on where it runs. */
function makeCells(
  id: string,
  prog: Program,
  side: Side,
  clientScope: boolean,
) {
  const mainId = `${id}main`, peerId = `${id}peer`;
  const peer = cell(peerId, {
    state: { rate: 1 },
    methods: {
      setRate(s: { rate: number }, r: number) {
        s.rate = r;
        return r;
      },
    },
  }) as Any;
  const sync = {
    inc(s: MainState, k: number) {
      s.n += k;
      return s.n;
    },
    push(s: MainState, v: string) {
      s.list.push(v);
      return s.list.length;
    },
    name(s: MainState, v: string) {
      s.prof.name = v;
      s.prof.secret = `${v}!`;
      s.hid = v;
    },
    boom(s: MainState, v: string) {
      s.n += 100; // must roll back with the throw
      throw new Error(`boom ${v}`);
    },
    boomStr(s: MainState) {
      s.list.push("never");
      // A NON-Error throw: how it reaches the caller is part of the contract.
      throw "plain string";
    },
    ret(s: MainState) {
      return { n: s.n, list: [...s.list] };
    },
  };
  const server = {
    async aw(s: MainState, k: number) {
      s.n += k;
      await Promise.resolve();
      s.list.push(`a${k}`);
      await sleep(1);
      s.prof.tags.push(k);
      return s.n;
    },
    async gate(s: MainState, k: number) {
      s.n += k;
      gateN.set(`${id}:${k}`, s.n);
      await gateWait(`${id}:${k}`);
      s.list.push(`g${k}`);
      return s.list.length;
    },
    async awBoom(s: MainState, k: number) {
      s.n += k; // committed at the await gap — survives the later throw
      await Promise.resolve();
      throw new Error(`late ${k}`);
    },
    after(s: Any) {
      s.$do(schedule.after(`${id}-after`, 15, { type: `${mainId}:tick` }));
    },
    tick(s: MainState) {
      s.ticks += 1;
      side.ticks++;
    },
    every(s: Any) {
      s.$do(schedule.every(`${id}-every`, 12, { type: `${mainId}:step` }));
    },
    step(s: Any) {
      s.steps += 1;
      side.steps++;
      if (s.steps >= 3) s.$do(schedule.cancel(`${id}-every`));
    },
    beatOn(s: Any) {
      s.$do(schedule.every(`${id}-beat`, 10, { type: `${mainId}:beat` }));
    },
    beat() {
      side.beats++;
    },
    own(s: Any) {
      s.$do(own.set("res", () => {
        side.events.push("acquire");
        return () => side.events.push("dispose");
      }));
    },
  };
  const main = cell(mainId, {
    ...(clientScope ? { scope: "client" as const } : {}),
    state: structuredClone(INITIAL),
    methods: (prog.client ? sync : { ...sync, ...server }) as Any,
    selectors: selectorsFor(peerId) as Any,
    visible: VISIBLE[prog.vis] as Any,
  }) as Any;
  return { main, peer, mainId, peerId };
}

// ── observing ────────────────────────────────────────────────────────────

const HIDDEN = "HIDDEN";
const J = (v: unknown) => JSON.stringify(v) ?? "undefined";

/** One runtime's cell ids differ from the other's (`sa3main` / `sv3main`); an
 *  error message that names one must compare equal to the other's. */
const unId = (s: string) => s.replace(/\bs[av]\d+(main|peer)\b/g, "$1");
const msgOf = (e: unknown) => unId(e instanceof Error ? e.message : String(e));

/** How a call came back: resolved value, rejection, or a synchronous throw
 *  (which is NOT a rejection: `c.m().catch(…)` never sees it). */
async function outcome(f: () => unknown): Promise<string> {
  let p: unknown;
  try {
    p = f();
  } catch (e) {
    return `threw-synchronously: ${msgOf(e)}`;
  }
  if (!(p instanceof Promise)) return `returned-a-non-promise: ${J(p)}`;
  try {
    return `ok ${J(await p)}`;
  } catch (e) {
    return `rejected: ${msgOf(e)}`;
  }
}

type View = {
  fields: Record<string, string>;
  sels: Record<string, string>;
  /** `useAio().state` — this cell's slice of the whole state a component
   *  gets. On the server runtime that is the state the client RECEIVED. */
  useAio: string;
};

/** Key-order-independent JSON: two runtimes may build the same object in a
 *  different key order, which no reader can observe through a field. */
function canon(v: unknown): string {
  return JSON.stringify(
    v,
    (_k, val) =>
      val && typeof val === "object" && !Array.isArray(val)
        ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : 1
          ),
        )
        : val,
  ) ?? "undefined";
}

function read(f: () => unknown): string {
  try {
    return J(f());
  } catch {
    return HIDDEN; // the client seam throws on a hidden read
  }
}

/** Standalone: `cell.field` and the bound selectors ARE the client reads. */
function viewStandalone(c: Any, aioSlice: unknown): View {
  const fields: Record<string, string> = {};
  for (const k of FIELDS) fields[k] = read(() => c[k]);
  return {
    fields,
    sels: {
      total: read(() => c.total()),
      at0: read(() => c.at(0)),
      memo: read(() => c.memo()),
      scaled: read(() => c.scaled()),
    },
    useAio: canon(aioSlice),
  };
}

/** A wire slice as the browser's seam reads it: a field the server withheld
 *  (in the cell's declared state, absent from the slice) throws. */
function guarded(slice: Record<string, unknown> | undefined, keys: string[]) {
  const s = slice ?? {};
  return new Proxy(s, {
    get(t, p) {
      if (typeof p === "string" && keys.includes(p) && !(p in t)) {
        throw new Error(`hidden ${p}`);
      }
      return (t as Record<string | symbol, unknown>)[p];
    },
  }) as Any;
}

/** Server: what the WebSocket client holds. */
function viewWire(
  wire: Record<string, unknown> | undefined,
  peerWire: Record<string, unknown> | undefined,
  sel: ReturnType<typeof selectorsFor>,
): View {
  const fields: Record<string, string> = {};
  for (const k of FIELDS) {
    fields[k] = wire && k in wire ? J(wire[k]) : HIDDEN;
  }
  const s = guarded(wire, FIELDS);
  const p = guarded(peerWire, ["rate"]);
  return {
    fields,
    sels: {
      total: read(() => sel.total(s)),
      at0: read(() => sel.at(s, 0)),
      memo: read(() => sel.memo(s)),
      scaled: read(() => sel.scaled.fn(s, [p])),
    },
    useAio: canon(wire),
  };
}

type Trace = {
  outcomes: string[];
  mids: View[];
  final: View;
  events: string[];
  /** Did a schedule still fire after close()? — the `beat` method running,
   *  or its tick reaching a closed dispatch (which refuses it, loudly). */
  afterClose: string;
};

/** Run one op, in the same way on both sides. `mid` reads the client view. */
async function runOp(
  op: Op,
  id: string,
  main: Any,
  peer: Any,
  mid: () => Promise<View>,
  mids: View[],
): Promise<string> {
  switch (op.op) {
    case "inc":
    case "aw":
    case "awBoom":
      return await outcome(() => main[op.op](op.k));
    case "push":
    case "name":
    case "boom":
      return await outcome(() => main[op.op](op.v));
    case "ret":
    case "boomStr":
    case "after":
    case "every":
    case "beatOn":
    case "own":
      return await outcome(() => main[op.op]());
    case "rate":
      return await outcome(() => peer.setRate(op.r));
    case "gate": {
      const done = outcome(() => main.gate(op.k));
      // Parked on the gate: what committed at the await gap is visible once
      // the gap's batch has committed (both runtimes flush it after the
      // method yields) — polled for, not slept on. `steps`/`ticks` are
      // masked: they move on the schedules' REAL clock, and the server side's
      // read waits for the socket, so a timer may land before one read and
      // after the other. Their final values are compared below, where it
      // cannot.
      const key = `${id}:${op.k}`;
      await until(() => gates.has(key), `${op.op} ${op.k} to park`);
      let v!: View;
      await until(async () => {
        v = await mid();
        return v.fields.n === J(gateN.get(key));
      }, `the await gap of ${op.op} ${op.k} to commit`);
      mids.push({
        ...v,
        fields: { ...v.fields, steps: "-", ticks: "-" },
        useAio: v.useAio.replace(/"(steps|ticks)":\d+/g, '"$1":"-"'),
      });
      gates.get(`${id}:${op.k}`)?.();
      gates.delete(`${id}:${op.k}`);
      return await done;
    }
  }
}

/** Watch the app for AFTER_CLOSE_MS after close(): any `beat` — the method
 *  running, or its action reaching the closed dispatch (each such dispatch is
 *  refused with a warning naming it) — means a schedule outlived the app. */
async function afterClose(side: Side, mainId: string): Promise<string> {
  const beats = side.beats;
  const warn = console.warn;
  let refused = 0;
  console.warn = (...a: unknown[]) => {
    if (a.map(String).join(" ").includes(`${mainId}:beat`)) refused++;
    else warn(...a);
  };
  try {
    await timerTicks(AFTER_CLOSE_TICKS);
  } finally {
    console.warn = warn;
  }
  const fired = side.beats - beats + refused;
  return fired > 0 ? "a schedule fired after close()" : "quiet";
}

/** Wait until every schedule the program armed has run its course: the
 *  one-shot `after` ticked once, the self-cancelling `every` stepped 3 times. */
function schedulesDone(prog: Program, side: Side): Promise<void> {
  const has = (o: Op["op"]) => prog.ops.some((x) => x.op === o);
  const ticks = has("after") ? 1 : 0, steps = has("every") ? 3 : 0;
  return until(
    () => side.ticks >= ticks && side.steps >= steps,
    `schedules (ticks ${side.ticks}/${ticks}, steps ${side.steps}/${steps})`,
  );
}
/** "No schedule fires after close()" is watched for this many firings of a
 *  10ms interval — the forever `every`'s own period. Counted on the SAME
 *  timer queue a leaked schedule would fire on, so a loaded machine delays
 *  both alike instead of shortening the watch. */
const AFTER_CLOSE_TICKS = 6;
function timerTicks(n: number): Promise<void> {
  return new Promise((res) => {
    let left = n;
    const t = setInterval(() => {
      if (--left > 0) return;
      clearInterval(t);
      res();
    }, 10);
  });
}

async function runServer(prog: Program, round: number): Promise<Trace> {
  _resetAioRuntime();
  const side: Side = { events: [], beats: 0, steps: 0, ticks: 0 };
  const id = `sv${round}`;
  const { main, peer, mainId, peerId } = makeCells(id, prog, side, false);
  const sel = selectorsFor(peerId);
  const m = await testMultiClient({ cells: [main, peer] }, 1);
  const cli = m.clients[0]!;
  const view = async () => {
    await m.converged();
    const v = viewWire(cli.state(mainId), cli.state(peerId), sel);
    return prog.client ? { ...v, useAio: canon("-") } : v;
  };
  const outcomes: string[] = [], mids: View[] = [];
  let closed = false;
  try {
    for (const op of prog.ops) {
      outcomes.push(await runOp(op, id, main, peer, view, mids));
    }
    await schedulesDone(prog, side);
    const final = await view();
    await m.close();
    closed = true;
    // Snapshot NOW: the harness reset in `finally` disposes whatever close()
    // left behind, into the same array, and would hide the difference.
    const events = [...side.events];
    return {
      outcomes,
      mids,
      final,
      events,
      afterClose: await afterClose(side, mainId),
    };
  } finally {
    if (!closed) await m.close();
    _resetAioRuntime();
  }
}

async function runStandalone(prog: Program, round: number): Promise<Trace> {
  const sa = await import("../src/standalone-air.ts");
  sa._reset();
  _resetAioRuntime();
  const side: Side = { events: [], beats: 0, steps: 0, ticks: 0 };
  const id = `sa${round}`;
  const { main, peer, mainId } = makeCells(id, prog, side, prog.client);
  const app = await sa.aio.run({
    appId: `parity${round}`,
    cells: [main, peer],
    persist: false,
  } as Any);
  const outcomes: string[] = [], mids: View[] = [];
  let closed = false;
  try {
    // A `scope: "client"` cell's slice is not in the app state `useAio()`
    // returns (it lives on its own signal) — nor on the server side, where it
    // is a server cell — so that one read is not comparable there.
    const aioSlice = () =>
      prog.client
        ? "-"
        : (sa.useAio().state as Record<string, unknown> | null)?.[mainId];
    const view = () => Promise.resolve(viewStandalone(main, aioSlice()));
    for (const op of prog.ops) {
      outcomes.push(await runOp(op, id, main, peer, view, mids));
    }
    await schedulesDone(prog, side);
    const final = viewStandalone(main, aioSlice());
    await app.close();
    closed = true;
    // Snapshot NOW: the harness reset in `finally` disposes whatever close()
    // left behind, into the same array, and would hide the difference.
    const events = [...side.events];
    return {
      outcomes,
      mids,
      final,
      events,
      afterClose: await afterClose(side, mainId),
    };
  } finally {
    if (!closed) await app.close();
    sa._reset();
    _resetAioRuntime();
  }
}

// ── the gate ─────────────────────────────────────────────────────────────

Deno.test({
  name:
    "standalone == server: the same cell program has the same outcomes, client reads and close()",
  async fn() {
    const errs = console.error;
    // Caught method failures are logged by both runtimes; they are the input.
    console.error = () => {};
    const seenOps = new Set<string>();
    const seenVis = new Set<number>();
    let rounds = 0, calls = 0, midReads = 0, clientRounds = 0;
    let useAioCompared = 0;
    try {
      for (let round = 0; round < N; round++) {
        const seed = (SEED + round * 0x9E3779B9) >>> 0;
        const prog = genProgram(rngOf(seed));
        for (const o of prog.ops) seenOps.add(o.op);
        seenVis.add(prog.vis);
        if (prog.client) clientRounds++;
        const where =
          `AIO_PARITY_SEED=${SEED} round ${round} (seed ${seed})\n` +
          `  program: ${J({ ...prog, vis: VISIBLE[prog.vis] })}`;

        const srv = await runServer(prog, round);
        const sa = await runStandalone(prog, round);

        for (let i = 0; i < prog.ops.length; i++) {
          assertEquals(
            sa.outcomes[i],
            srv.outcomes[i],
            `call ${i} (${J(prog.ops[i])}) came back differently — ${where}`,
          );
        }
        assertEquals(sa.outcomes.length, prog.ops.length);
        useAioCompared++;
        assertEquals(
          sa.mids,
          srv.mids,
          `client reads while an async method is parked on an await — ${where}`,
        );
        assertEquals(
          sa.final,
          srv.final,
          `client reads after the program — ${where}`,
        );
        assertEquals(
          sa.events,
          srv.events,
          `own resource lifecycle through close() — ${where}`,
        );
        assertEquals(
          sa.afterClose,
          srv.afterClose,
          `a schedule kept firing after close() — ${where}`,
        );
        calls += prog.ops.length;
        midReads += srv.mids.length;
        rounds++;
      }
    } finally {
      console.error = errs;
    }
    console.log(
      `[parity] ${rounds} programs, ${calls} calls, ${midReads} mid-flight ` +
        `reads, ${clientRounds} scope:"client" programs, useAio compared in ` +
        `${useAioCompared}`,
    );
    assertEquals(rounds, N, "every seeded program must run to its end");
    // VERIFY THE INSTRUMENT (at the default seed/N): every op and every
    // visible filter was actually generated, and the two shapes the recent
    // fixes lived in were among them.
    if (N >= 8) {
      assertEquals(
        ALL_OPS.filter((o) => !seenOps.has(o)),
        [],
        "ops never generated",
      );
      assert(seenVis.size >= 4, `visible filters exercised: ${[...seenVis]}`);
      assert(clientRounds > 0, "no scope:client program was generated");
      assert(midReads > 0, "no mid-flight read was taken");
      assert(useAioCompared > 0, "useAio().state was never compared");
    }
  },
});
