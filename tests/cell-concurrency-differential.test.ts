// Differential fuzzer, CONCURRENCY axis: many calls from several callers at
// once vs a sequential model.
//
// tests/proxy-differential.test.ts, await-split-differential and
// transaction-differential each run ONE call at a time. The lost-update and
// reordering bugs the write batcher has shipped (round-1 hunt: pending async
// writes invisible to other actions; round-5: an async write-set reaching the
// hooks as `user: undefined`) live only BETWEEN calls, so this axis drives
// them together: sync and async methods from two WS users and the server
// itself, awaits of every kind, `s.$call`, queued self-calls, `$do(schedule.*)`
// follow-ups, `validate` refusals and throws mid-method — on a plain cell and
// on `transaction: true` / `{ serialize: true }` cells.
//
// The model needs no scheduler of its own. Every method body records what it
// does, as it does it, into a trace; the contract is that a segment (the code
// between two awaits) is ATOMIC and lands in the order it ran — so folding the
// trace in order must give every read the value it saw and the store the
// state it ends in. On top: each call's outcome (a throw or a refused write
// rejects it), each write's author as `beforeReduce`/`onAction` saw it, and
// the timeline's diffs folding to the same final state. A transactional
// call's segments read its entry snapshot plus its own writes; its write-set
// lands at the commit the hooks see, and only if nothing it derived a write
// from moved since (docs/state/transactional-methods.md §4) — so a commit
// over a moved key is a lost update, and a conflict refusal must reject.
//
// Sweep: `FUZZ_SEED=<n> FUZZ_ROUNDS=<n>`; `FUZZ_TRACE=1` prints each round's
// trace, which is what a divergence has to be read against.
import { assert, assertEquals } from "@std/assert";
import { cell, schedule, self, serverUser } from "../mod.ts";
import { composeCells } from "../src/state/cell.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { testServer } from "../src/testing/server-test.ts";
import { testCell } from "../src/testing/cell-test.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { mulberry32 } from "./sync/properties/_prop.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const SEED = fuzzEnvInt("FUZZ_SEED", 0x0c0ffee5) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 40, 1);

type Op =
  | { k: "inc"; v: number }
  | { k: "push" }
  | { k: "read" }
  | { k: "call"; v: number }
  | { k: "poison" }
  // A foreign array move (sync methods only), and a row proxy one async call
  // holds across an await: it must throw `stale reference` once the row
  // slid, never write into whatever row took its slot.
  | { k: "unshift" }
  | { k: "hold" }
  | { k: "touch" }
  | { k: "throw" }
  // A transactional call's commit marker: a blind write the hooks can see.
  | { k: "mark" }
  // `s.$commit()` mid-method (a transactional cell only).
  | { k: "commit" }
  // Child calls — always last in a segment.
  | { k: "self"; cid: string; m: "sy" | "as"; segs: Seg[] }
  | { k: "next"; cid: string; segs: Seg[] }
  | { k: "after"; cid: string; ms: number; segs: Seg[] };
type Seg = { ops: Op[]; gap: "micro" | "tick" | "sleep" };

type Ev =
  | { e: "begin"; cid: string; i: number; user?: string; m: "sy" | "as" }
  | { e: "inc"; v: number }
  | { e: "push"; tag: string }
  | { e: "read"; v: number }
  | { e: "poison" }
  | { e: "unshift"; id: string }
  | { e: "hold"; cid: string }
  | { e: "touch"; cid: string; ok: boolean }
  | { e: "throw"; cid: string; i: number }
  | { e: "end"; cid: string; i: number }
  // A transaction called `s.$commit()` — its guard runs here.
  | { e: "flush"; cid: string }
  // Pushed by `onAction` when a transactional write-set reaches the reducer.
  | { e: "commit"; cid: string };

let TRACE: Ev[] = [];
type Row = { id: string; v: number };
type S = { n: number; log: string[]; bad: boolean; who: string; rows: Row[] };
const ROWS: Row[] = [{ id: "r0", v: 0 }, { id: "r1", v: 0 }];
const HELD = new Map<string, Row>();
type Kind = "plain" | "tx" | "ser";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runSeg(
  c: Any,
  s: Any,
  cid: string,
  i: number,
  seg: Seg,
  m: "sy" | "as",
) {
  TRACE.push({ e: "begin", cid, i, user: serverUser()?.id, m });
  seg.ops.forEach((op, j) => {
    switch (op.k) {
      case "inc":
        s.n += op.v;
        TRACE.push({ e: "inc", v: op.v });
        break;
      case "push": {
        const tag = `${cid}.${i}.${j}`;
        s.log.push(tag);
        TRACE.push({ e: "push", tag });
        break;
      }
      case "read":
        TRACE.push({ e: "read", v: s.n });
        break;
      case "call":
        s.$call.bump(op.v);
        break;
      case "unshift": {
        const id = `${cid}.${i}.${j}u`;
        s.rows.unshift({ id, v: 0 });
        TRACE.push({ e: "unshift", id });
        break;
      }
      case "hold":
        HELD.set(cid, s.rows[0]);
        TRACE.push({ e: "hold", cid });
        break;
      case "touch":
        try {
          HELD.get(cid)!.v += 1;
          TRACE.push({ e: "touch", cid, ok: true });
        } catch (e) {
          if (!String((e as Error).message).includes("stale reference")) {
            throw e;
          }
          TRACE.push({ e: "touch", cid, ok: false });
        }
        break;
      case "poison":
        s.bad = true;
        TRACE.push({ e: "poison" });
        break;
      case "throw":
        TRACE.push({ e: "throw", cid, i });
        throw new Error(`boom ${cid}`);
      case "mark":
        s.who = cid;
        break;
      case "commit":
        TRACE.push({ e: "flush", cid });
        try {
          s.$commit();
        } catch (e) {
          // TX_CONFLICT: the call aborts here.
          TRACE.push({ e: "throw", cid, i });
          throw e;
        }
        s.who = cid; // names the next write-set too
        break;
      case "self":
        c[op.m](op.cid, op.segs).catch(() => {});
        break;
      case "next":
        s.$do(schedule.next(`n-${op.cid}`, self("sy", op.cid, op.segs)));
        break;
      case "after":
        s.$do(
          schedule.after(`a-${op.cid}`, op.ms, self("as", op.cid, op.segs)),
        );
        break;
    }
  });
  TRACE.push({ e: "end", cid, i });
}

const mkCell = (id: string, kind: Kind) => {
  const c: Any = cell(id, {
    state: { n: 0, log: [], bad: false, who: "", rows: ROWS } as S,
    visible: "all",
    validate: (s: S) => s.bad ? "poisoned" : true,
    ...(kind === "tx" ? { transaction: true } : {}),
    ...(kind === "ser" ? { transaction: { serialize: true } } : {}),
    methods: {
      reset(s: S) {
        s.n = 0;
        s.log = [];
        s.who = "";
        s.rows = structuredClone(ROWS);
      },
      bump(s: S, v: number) {
        s.n += v;
        TRACE.push({ e: "inc", v });
      },
      sy(s: S, cid: string, segs: Seg[]) {
        runSeg(c, s, cid, 0, segs[0]!, "sy");
      },
      async as(s: S, cid: string, segs: Seg[]) {
        for (let i = 0; i < segs.length; i++) {
          if (i > 0) {
            const g = segs[i - 1]!.gap;
            if (g === "micro") await null;
            else if (g === "tick") await sleep(0);
            else await sleep(1 + (i % 3));
          }
          runSeg(c, s, cid, i, segs[i]!, "as");
        }
      },
    },
  });
  return c;
};
const CELLS = {
  plain: mkCell("fz", "plain"),
  tx: mkCell("fzt", "tx"),
  ser: mkCell("fzs", "ser"),
};
const ID: Record<Kind, string> = { plain: "fz", tx: "fzt", ser: "fzs" };

// ── program generator ────────────────────────────────────────────────────
/** One call's segments; `depth` > 0 lets a segment end in a child call. */
function genSegs(
  rnd: () => number,
  m: "sy" | "as",
  cid: string,
  depth: number,
  kind: Kind,
  // testCell owns no clock, so it refuses a schedule by design.
  sched = kind === "plain",
): Seg[] {
  const pick = (n: number) => Math.floor(rnd() * n);
  let kids = 0;
  const seg = (): Seg => {
    const ops: Op[] = [];
    for (let j = 0, n = 1 + pick(4); j < n; j++) {
      const r = pick(100);
      if (r < 30) ops.push({ k: "inc", v: 1 + pick(9) });
      else if (r < 55) {
        ops.push(
          m === "sy" && pick(2) === 0 ? { k: "unshift" } : { k: "push" },
        );
      } else if (r < 80) ops.push({ k: "read" });
      else if (r < 90) {
        ops.push(
          kind !== "plain" && m === "as" && pick(2)
            ? { k: "commit" }
            : { k: "call", v: 10 + pick(9) },
        );
      } else if (r < 94) ops.push({ k: "poison" });
      else ops.push({ k: "throw" });
    }
    // A sync method may queue TWO calls — the shape where the first one's
    // first frame runs inside the drain right before the second reduces.
    const nk = depth === 0 ? 0 : m === "sy" && pick(2) ? 2 : pick(3) ? 0 : 1;
    for (let k = 0; k < nk; k++) {
      const kid = `${cid}k${kids++}`;
      // A transaction holds its `$do` effects until it commits — whether it
      // does is decided at run time, so only a plain cell schedules here.
      const r = sched ? pick(3) : 0;
      if (r === 0) {
        // The second of two is sync: it may move the rows the first holds.
        const km = k === 1 || pick(2) ? "sy" : "as";
        ops.push({
          k: "self",
          cid: kid,
          m: km,
          segs: genSegs(rnd, km, kid, depth - 1, kind, sched),
        });
      } else if (r === 1) {
        ops.push({
          k: "next",
          cid: kid,
          segs: genSegs(rnd, "sy", kid, depth - 1, kind, sched),
        });
      } else {
        ops.push({
          k: "after",
          cid: kid,
          ms: pick(3),
          segs: genSegs(rnd, "as", kid, depth - 1, kind, sched),
        });
      }
    }
    const gaps = ["micro", "tick", "sleep"] as const;
    return { ops, gap: gaps[pick(3)]! };
  };
  const segs = Array.from({ length: m === "sy" ? 1 : 1 + pick(4) }, seg);
  if (kind !== "plain" && m === "as") {
    segs[0]!.ops.unshift({ k: "mark" });
    // A refused `$commit` re-bases on state without its write-set — a model
    // of its own; poison is left to transactions that commit once.
    const commits = segs.some((g) => g.ops.some((o) => o.k === "commit"));
    if (commits) {
      for (const g of segs) g.ops = g.ops.filter((o) => o.k !== "poison");
    }
  }
  // A queued call (a child) holds, so a sibling queued behind it can move
  // the rows inside the same drain — where the guard was once blinded.
  return kind === "plain" && m === "as" && cid.includes("k")
    ? holdOnce(segs)
    : segs;
}

/** One plain async child per round may hold `s.rows[0]` across its awaits
 *  (one holder, so no other write ever touches that row). */
let holderTaken = false;
function holdOnce(segs: Seg[]): Seg[] {
  if (holderTaken || segs.length < 2) return segs;
  holderTaken = true;
  segs[0]!.ops.unshift({ k: "hold" });
  segs.at(-1)!.ops.unshift({ k: "touch" });
  return segs;
}

// What a call's segments decide about the call: rejected iff a segment threw
// or poisoned (a refused write-set fails the call that made it). Async
// segments after a throw never run.
function runnable(m: "sy" | "as", segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const t = s.ops.findIndex((o) => o.k === "throw");
    out.push(t < 0 ? s : { ...s, ops: s.ops.slice(0, t + 1) });
    if (t >= 0 || m === "sy") break;
  }
  return out;
}
const rejects = (m: "sy" | "as", segs: Seg[]) =>
  runnable(m, segs).some((s) =>
    s.ops.some((o) => o.k === "throw" || o.k === "poison")
  );

/** Every child call the contract says MUST run, and every one it says must
 *  NOT: a queued self-call survives its caller (docs: methods.md `s.$call`),
 *  a sync `$do` effect rides with the commit (dropped on throw/refusal), an
 *  async `$do` dispatches immediately. */
function children(
  m: "sy" | "as",
  segs: Seg[],
  must: Map<string, { m: "sy" | "as"; segs: Seg[] }>,
  mustNot: Set<string>,
) {
  const ran = runnable(m, segs);
  // Past a `$commit()` the call may have aborted (a conflict decided at run
  // time): what follows it is neither owed nor forbidden.
  let maybe = false;
  segs.forEach((s, i) => {
    for (const o of s.ops) {
      if (o.k === "commit") maybe = true;
      if (maybe) return;
      if (o.k !== "self" && o.k !== "next" && o.k !== "after") continue;
      const cm = o.k === "self" ? o.m : o.k === "next" ? "sy" : "as";
      const reached = i < ran.length &&
        ran[i]!.ops.length === s.ops.length;
      const dropped = m === "sy" && o.k !== "self" &&
        s.ops.some((x) => x.k === "throw" || x.k === "poison");
      if (reached && !dropped) {
        must.set(o.cid, { m: cm, segs: o.segs });
        children(cm, o.segs, must, mustNot);
      } else mustNot.add(o.cid);
    }
  });
}

// ── the sequential model ─────────────────────────────────────────────────
type Tx = {
  snap: S; // the entry snapshot its reads are pinned to
  view: S; // snap + its own writes
  own: Ev[]; // its writes since the last commit point
  chunks: { own: Ev[]; at: string }[]; // `$commit`ted, not yet reduced
  readsN: boolean;
  writesN: boolean;
  writesLog: boolean;
  bad: boolean;
  committed: boolean;
};

/** The commit is unsound when a path the transaction wrote FROM its own read
 *  moved since entry (`conflictPath`); serializable validates every read. */
function conflicts(t: Tx, live: S, kind: Kind): boolean {
  const nMoved = live.n !== t.snap.n;
  const logMoved = JSON.stringify(live.log) !== JSON.stringify(t.snap.log);
  return (nMoved && (kind === "ser" ? t.readsN : t.writesN)) ||
    (logMoved && t.writesLog);
}

function fold(trace: Ev[], start: S, kind: Kind, repro: string) {
  let model = structuredClone(start);
  type Open = { cid: string; m: "sy" | "as"; bad: boolean; snap: S };
  // A stack, because an async segment that calls a method mid-frame runs it
  // INLINE (outside a drain a call dispatches at once): its writes so far
  // commit first, the callee runs as its own atomic segment, then it resumes.
  const stack: Open[] = [];
  const txs = new Map<string, Tx>();
  const txOf = (o: Open | undefined) =>
    o && o.m === "as" && kind !== "plain" ? txs.get(o.cid) : undefined;
  const close = (threw: boolean) => {
    const o = stack.pop()!;
    if (txOf(o)) return; // a transaction's writes wait for its commit
    // A sync method is one Immer recipe: a throw or a refusal discards it.
    // An async segment is one write-set: a refusal discards it, a throw
    // keeps what it wrote (methods.md "Error handling").
    if (o.bad || (threw && o.m === "sy")) model = o.snap;
  };
  const holds = new Map<string, string>();
  const apply = (st: S, ev: Ev) => {
    if (ev.e === "unshift") st.rows.unshift({ id: ev.id, v: 0 });
    if (ev.e === "inc") st.n += ev.v;
    else if (ev.e === "push") st.log.push(ev.tag);
  };
  trace.forEach((ev, at) => {
    const where = `trace[${at}] ${JSON.stringify(ev)} — ${repro}`;
    const top = stack.at(-1);
    const tx = txOf(top);
    switch (ev.e) {
      case "begin":
        if (top && !tx) {
          assert(top.m === "as", `segment not atomic: ${where}`);
          // The caller's write-set so far commits before the call runs.
          if (top.bad) model = top.snap;
          top.bad = false;
        }
        stack.push({
          cid: ev.cid,
          m: ev.m,
          bad: false,
          snap: structuredClone(model),
        });
        if (kind !== "plain" && ev.m === "as" && ev.i === 0) {
          txs.set(ev.cid, {
            snap: structuredClone(model),
            view: structuredClone(model),
            own: [],
            chunks: [],
            readsN: false,
            writesN: false,
            writesLog: false,
            bad: false,
            committed: false,
          });
        }
        break;
      case "inc":
      case "push":
        if (tx) {
          apply(tx.view, ev);
          tx.own.push(ev);
          if (ev.e === "inc") tx.readsN = tx.writesN = true;
          else tx.writesLog = true;
        } else apply(model, ev);
        break;
      case "read":
        if (tx) tx.readsN = true;
        assertEquals(
          ev.v,
          (tx ? tx.view : model).n,
          `read saw the wrong state: ${where}`,
        );
        break;
      case "unshift":
        apply(model, ev); // sync methods only — never a transaction's
        break;
      case "hold":
        holds.set(ev.cid, model.rows[0]!.id);
        break;
      case "touch": {
        const id = holds.get(ev.cid)!;
        assertEquals(
          ev.ok,
          model.rows[0]!.id === id,
          ev.ok
            ? `a held row wrote after its row slid: ${where}`
            : `stale reference thrown for a row that never moved: ${where}`,
        );
        if (ev.ok) model.rows.find((r) => r.id === id)!.v += 1;
        break;
      }
      case "poison":
        if (tx) tx.bad = true;
        else top!.bad = true;
        break;
      case "throw":
      case "end":
        assertEquals(top?.cid, ev.cid, `segments interleaved: ${where}`);
        close(ev.e === "throw");
        // The resumed caller's next write-set starts here.
        if (stack.length) stack.at(-1)!.snap = structuredClone(model);
        break;
      case "flush": {
        // `$commit()`: guarded now; a conflict throws next. Reads after it
        // see the state it committed — a new epoch. "Now" includes its own
        // earlier `$commit`s still queued ahead of it.
        const t = txs.get(ev.cid)!;
        const lands = structuredClone(model);
        for (const c of t.chunks) {
          for (const w of c.own) apply(lands, w);
          lands.who = ev.cid;
        }
        if (conflicts(t, lands, kind)) {
          const next = trace[at + 1];
          assert(
            next?.e === "throw" && next.cid === ev.cid,
            `$commit over a moved read did not abort: ${where}`,
          );
          break;
        }
        t.chunks.push({ own: t.own, at: JSON.stringify(lands) });
        const epoch = lands;
        for (const w of t.own) apply(epoch, w);
        epoch.who = ev.cid;
        t.snap = epoch;
        t.view = structuredClone(epoch);
        t.own = [];
        t.readsN = t.writesN = t.writesLog = false;
        break;
      }
      case "commit": {
        const t = txs.get(ev.cid);
        assert(t && !t.committed, `stray commit: ${where}`);
        const chunk = t.chunks.shift();
        if (chunk) {
          // Nothing may reduce between a `$commit()` and its write-set — it
          // was guarded against the state of that moment.
          assertEquals(
            JSON.stringify(model),
            chunk.at,
            `a $commit write-set landed after other writes (lost update): ${where}`,
          );
          for (const w of chunk.own) apply(model, w);
          model.who = ev.cid;
          break;
        }
        assert(
          !conflicts(t, model, kind),
          `a transaction committed over a moved read (lost update): ${where}`,
        );
        t.committed = true;
        if (!t.bad) {
          for (const w of t.own) apply(model, w);
          model.who = ev.cid;
        }
        break;
      }
    }
  });
  assertEquals(stack.length, 0, `trace ends inside a segment — ${repro}`);
  return { model, txs };
}

function foldTimeline(id: string, start: S, entries: Any[]): S {
  const st: Any = structuredClone({ [id]: start });
  for (const e of entries) {
    for (const d of e.diff ?? []) {
      const keys: string[] = d.segments ?? d.path.split(".");
      if (keys[0] !== id) continue;
      let o = st;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      const last = keys[keys.length - 1]!;
      if (d.after === undefined) {
        if (Array.isArray(o)) o.length = Math.min(o.length, Number(last));
        else delete o[last];
      } else o[last] = structuredClone(d.after);
    }
  }
  return st[id];
}

// ── the run ──────────────────────────────────────────────────────────────
const BOSS = "tok-boss-0123456789abcdefghij";
const ANN = "tok-ann-0123456789abcdefghijk";
const AUTH = { headers: { authorization: `Bearer ${BOSS}` } };

Deno.test({
  name:
    "concurrency differential: interleaved calls equal the trace-order model",
  sanitizeOps: false, // aio-ok: a live server + sockets, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    type Seen = { type: string; user?: string; cid?: string; tags: string[] };
    let seen: Seen[] = [];
    const srv = await testServer<Record<string, S>>({
      cells: Object.values(CELLS),
      // A server-side call refused by `validate` RESOLVES by default (frozen;
      // dev warns once, see cell-compose-reduce.ts `_warnSwallowedRefusal`)
      // while the wire answers ACTION_REFUSED — opt in so every caller here
      // gets the one answer the model predicts.
      refusalsReject: true,
      users: {
        [BOSS]: { id: "boss", role: "admin" },
        [ANN]: { id: "ann", role: "member" },
      },
      onAction: (action, _s, user) => {
        const a = action as Any;
        if (typeof a.type !== "string" || !a.type.startsWith("fz")) return;
        const args = a.payload?.args;
        // A transaction's write-set, named by its `who` marker.
        if (a.type.endsWith(":__setAs")) {
          const mark = (a.payload?.mutations ?? []).find((m: Any) =>
            m.path?.length === 1 && m.path[0] === "who"
          );
          if (mark) TRACE.push({ e: "commit", cid: mark.value });
        }
        seen.push({
          type: a.type,
          user: (user as Any)?.id,
          cid: Array.isArray(args) ? args[0] : undefined,
          tags: [
            ...JSON.stringify(a.payload ?? null).matchAll(
              /"(c\d+[a-z0-9]*\.\d+\.\d+)"/g,
            ),
          ].map((x) => x[1]!),
        });
      },
    });
    const open = (tok: string) =>
      new Promise<{ ws: WebSocket; acks: Map<string, Any> }>((res, rej) => {
        const ws = new WebSocket(
          `${srv.url.replace("http", "ws")}/ws?token=${tok}`,
        );
        const acks = new Map<string, Any>();
        ws.onmessage = (e) => {
          const f = dec(String(e.data));
          if (f?.t === "ack") acks.set((f.d as Any).cid, f.d);
        };
        ws.onopen = () => res({ ws, acks });
        ws.onerror = () => rej(new Error("ws error"));
      });
    const socks = { boss: await open(BOSS), ann: await open(ANN) };
    const rnd = mulberry32(SEED);
    const pick = (n: number) => Math.floor(rnd() * n);
    // What the run actually exercised — a generator that stopped producing a
    // case compares nothing about it.
    const cover = new Set<string>();
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const kind = (["plain", "tx", "ser"] as const)[pick(3)]!;
        const fz = CELLS[kind];
        const id = ID[kind];
        await fz.reset();
        await idle();
        const tl0 =
          await (await srv.fetch("/__aio/trojan/timeline?limit=1", AUTH))
            .json();
        const after = tl0.entries.at(-1)?.seq ?? 0;
        TRACE = [];
        holderTaken = false;
        seen = [];
        const start = structuredClone(srv.state()[id]) as S;

        type Call = {
          cid: string;
          m: "sy" | "as";
          segs: Seg[];
          who: "boss" | "ann" | "srv";
        };
        const calls: Call[] = Array.from({ length: 2 + pick(6) }, (_, c) => {
          const cid = `c${c}`;
          const m = pick(2) ? "sy" : "as";
          return {
            cid,
            m,
            segs: genSegs(rnd, m, cid, 2, kind),
            who: (["boss", "ann", "srv"] as const)[pick(3)]!,
          };
        });
        const repro = `FUZZ_SEED=${SEED} round ${round} (${kind}): ${
          JSON.stringify(calls)
        }`;
        const outcomes = new Map<string, Promise<boolean>>();
        for (const c of calls) {
          if (pick(3) === 0) await sleep(pick(3));
          if (c.who === "srv") {
            outcomes.set(
              c.cid,
              fz[c.m](c.cid, c.segs).then(() => true, () => false),
            );
          } else {
            const s = socks[c.who];
            s.ws.send(enc("action", {
              type: `${id}:${c.m}`,
              payload: { args: [c.cid, c.segs] },
              cid: `${round}:${c.cid}`,
            }));
            outcomes.set(
              c.cid,
              (async () => {
                for (let i = 0; i < 400; i++) {
                  const a = s.acks.get(`${round}:${c.cid}`);
                  if (a) return a.ok === true;
                  await sleep(5);
                }
                throw new Error(`no ack for ${c.cid} — ${repro}`);
              })(),
            );
          }
        }
        const ok = new Map<string, boolean>();
        for (const [cid, p] of outcomes) ok.set(cid, await p);
        await idle();

        // 2. children that must / must not run
        const must = new Map<string, { m: "sy" | "as"; segs: Seg[] }>();
        const mustNot = new Set<string>();
        for (const c of calls) children(c.m, c.segs, must, mustNot);
        const begun = new Set(
          TRACE.flatMap((e) => e.e === "begin" && e.i === 0 ? [e.cid] : []),
        );
        for (const cid of must.keys()) { // aio-ok: per round it may be empty; the `cover` check proves children ran
          assert(begun.has(cid), `child ${cid} never ran — ${repro}`);
        }
        for (const cid of mustNot) { // aio-ok: per round it may be empty; `cover` proves both kinds occur
          assert(!begun.has(cid), `child ${cid} ran — ${repro}`);
        }
        // 3. reads + final state vs the model
        if (Deno.env.get("FUZZ_TRACE")) {
          console.log(
            `TRACE ${round}\n` +
              TRACE.map((e, k) => `${k}: ${JSON.stringify(e)}`).join("\n"),
          );
        }
        const { model, txs } = fold(TRACE, start, kind, repro);
        const fin = structuredClone(srv.state()[id]) as S;
        assertEquals(fin, model, `final state — ${repro}`);
        for (const [cid, t] of txs) {
          if (t.committed) cover.add(`${kind}-commit`);
          else if (!TRACE.some((e) => e.e === "throw" && e.cid === cid)) {
            cover.add(`${kind}-conflict`);
          }
        }
        for (const [at, e] of TRACE.entries()) {
          const prev = TRACE[at - 1];
          if (
            e.e === "begin" && prev && prev.e !== "end" && prev.e !== "throw"
          ) {
            cover.add("inline-call");
          }
          if (e.e === "begin" && e.cid.includes("k")) cover.add("child");
          if (e.e === "touch") cover.add(e.ok ? "held-ok" : "held-stale");
          if (e.e === "flush") {
            const n = TRACE[at + 1];
            cover.add(
              n?.e === "throw" && n.cid === e.cid
                ? "commit-conflict"
                : "commit-mid",
            );
          }
        }
        for (const c of calls) cover.add(`${c.who}-${c.m}-${ok.get(c.cid)}`);
        // 1. outcomes: a transaction is ok iff its write-set committed and
        // was not refused; everything else is decided by its program.
        for (const c of calls) { // aio-ok: 2..7 calls per round, by construction
          const t = txs.get(c.cid);
          assertEquals(
            ok.get(c.cid),
            t ? t.committed && !t.bad : !rejects(c.m, c.segs),
            `${c.cid} outcome — ${repro}`,
          );
        }
        // 4. who wrote what: the identity each segment RAN as, the identity
        // the hooks saw for the commit carrying its writes, and — for a
        // direct call — the caller's.
        const callerOf = new Map(calls.map((c) => [c.cid, c.who]));
        for (const ev of TRACE) { // aio-ok: every call records a begin, so never empty
          if (ev.e !== "begin") continue;
          const direct = callerOf.get(ev.cid);
          if (direct !== undefined && ev.i === 0) {
            assertEquals(
              ev.user,
              direct === "srv" ? undefined : direct,
              `${ev.cid} ran as the wrong user — ${repro}`,
            );
          }
        }
        const begins = new Map(
          TRACE.flatMap((e) => e.e === "begin" ? [[`${e.cid}.${e.i}`, e]] : []),
        );
        for (const tag of fin.log) { // aio-ok: may be empty in a round; across rounds pushes always land
          const [cid, i] = tag.split(".");
          const b = begins.get(`${cid}.${i}`) as Ev & { e: "begin" };
          const carrier = b.m === "sy"
            ? seen.filter((x) => x.type === `${id}:sy` && x.cid === cid)
            : seen.filter((x) => x.tags.includes(tag));
          assertEquals(carrier.length, 1, `${tag} carriers — ${repro}`);
          assertEquals(
            carrier[0]!.user,
            b.user,
            `${tag}: hooks saw ${
              carrier[0]!.user
            }, code ran as ${b.user} — ${repro}`,
          );
        }
        // 5. the timeline tells the same story
        const tl = await (await srv.fetch(
          `/__aio/trojan/timeline?after=${after}`,
          AUTH,
        )).json();
        assertEquals(
          foldTimeline(id, start, tl.entries),
          fin,
          `timeline fold — ${repro}`,
        );
      }
      if (ROUNDS >= 40) {
        const want = [
          ...["plain", "tx", "ser"].map((k) => `${k}-commit`).slice(1),
          "tx-conflict",
          "ser-conflict",
          "inline-call",
          "commit-mid",
          "held-ok",
          "held-stale",
          "commit-conflict",
          "child",
          ...["boss", "ann", "srv"].flatMap((w) =>
            ["sy", "as"].flatMap((m) => [`${w}-${m}-true`, `${w}-${m}-false`])
          ),
        ];
        assertEquals(want.filter((k) => !cover.has(k)), [], "never exercised");
      }
    } finally {
      socks.boss.ws.close();
      socks.ann.ws.close();
      await srv.close();
    }
  },
});

/** Quiet: the trace has not grown for 30 ms (the longest gap a program
 *  sleeps is 3 ms; a follow-up timer is at most 2 ms). */
async function idle() {
  let last = -1;
  let still = 0;
  for (let i = 0; i < 400 && still < 6; i++) {
    await sleep(5);
    if (TRACE.length === last) still++;
    else still = 0;
    last = TRACE.length;
  }
}

// ── the testCell door ────────────────────────────────────────────────────
// testCell runs its own dispatch, not the server's loop — a harness more
// lenient than production here manufactures green tests over lost updates.
// Same programs, same model; no hooks, so the plain cell only (a transaction's
// commit is observed through `onAction`).
const TC = mkCell("fzc", "plain");
testCell(
  TC,
  "concurrency differential: same programs, same model",
  async (t) => {
    const rnd = mulberry32(SEED ^ 0x7c);
    const pick = (n: number) => Math.floor(rnd() * n);
    for (let round = 0; round < ROUNDS; round++) {
      await (t.send as Any).reset();
      await t.settle();
      TRACE = [];
      holderTaken = false;
      const start = structuredClone(t.state) as S;
      const calls = Array.from({ length: 2 + pick(6) }, (_, c) => {
        const m: "sy" | "as" = pick(2) ? "sy" : "as";
        const who = (["boss", "ann", undefined] as const)[pick(3)];
        return {
          cid: `c${c}`,
          m,
          who,
          segs: genSegs(rnd, m, `c${c}`, 2, "plain", false),
        };
      });
      const repro = `FUZZ_SEED=${SEED} testCell round ${round}: ${
        JSON.stringify(calls)
      }`;
      const outcomes: Promise<boolean>[] = [];
      for (const c of calls) {
        if (pick(3) === 0) await sleep(pick(3));
        outcomes.push(
          t.as(
            c.who ? { id: c.who, role: "member" } : undefined,
            () => (t.send as Any)[c.m](c.cid, c.segs),
          ).then(() => true, () => false),
        );
      }
      const ok = await Promise.all(outcomes);
      await t.settle();
      await idle();
      calls.forEach((c, i) =>
        assertEquals(
          ok[i],
          !rejects(c.m, c.segs),
          `${c.cid} outcome — ${repro}`,
        )
      );
      const { model } = fold(TRACE, start, "plain", repro);
      assertEquals(structuredClone(t.state), model, `final state — ${repro}`);
      for (const ev of TRACE) {
        const c = calls.find((x) => x.cid === (ev as { cid?: string }).cid);
        if (ev.e === "begin" && c && ev.i === 0) {
          assertEquals(ev.user, c.who, `${c.cid} ran as — ${repro}`);
        }
      }
    }
  },
);

// ── L87: two async bodies started back to back ───────────────────────────
// A first frame's write-set goes AHEAD of the queue (`_dispatchWriteSet`), so
// a body started after it reads it. The one shape that would escape that is
// two bodies started by ONE reduce, from the same effects loop: the second
// would run before the loop reaches the first's write-set. A reduce has ONE
// owner (≤ 1 `__exec`) and its listeners must be SYNC — composing an async
// `listensTo` target throws — so that shape cannot be built. Every shape that
// CAN start two bodies at once is pinned here: the second reads the first's
// pre-await write.
const l87: Any = cell("l87", {
  state: { n: 0, seen: -1 },
  methods: {
    reset(s: Any) {
      s.n = 0;
      s.seen = -1;
    },
    async a1(s: Any) {
      s.n += 1;
      await sleep(2);
    },
    async a2(s: Any) {
      s.seen = s.n;
      await sleep(2);
    },
    fanCall() {
      l87.a1();
      l87.a2();
    },
    async fanAsync() {
      l87.a1();
      l87.a2();
      await sleep(1);
    },
    fanNext(s: Any) {
      s.$do(schedule.next("l87-1", self("a1")));
      s.$do(schedule.next("l87-2", self("a2")));
    },
  },
} as Any);

Deno.test("concurrency differential L87: a body started right after another reads its first frame", async () => {
  const srv = await testServer<Any>({ cells: [l87] });
  try {
    for (const m of ["fanCall", "fanAsync", "fanNext"]) {
      await l87.reset();
      await l87[m]();
      for (let i = 0; i < 50 && srv.state().l87.seen === -1; i++) {
        await sleep(5);
      }
      assertEquals(srv.state().l87.seen, 1, `${m}: a2 read without a1's write`);
    }
  } finally {
    await srv.close();
  }
});

Deno.test("concurrency differential L87: no reduce can start two async bodies (async listensTo is refused)", () => {
  const src: Any = cell("l87src", { state: {}, methods: { go() {} } });
  let threw = false;
  try {
    composeCells([
      src,
      cell("l87dst", {
        state: { n: 0 },
        listensTo: { onGo: src.go },
        methods: {
          async onGo(s: Any) {
            s.n++;
            await sleep(0);
          },
        },
      } as Any),
    ]);
  } catch {
    threw = true;
  }
  assert(threw, "an async listener would let one reduce start two bodies");
});

// ── L88: `$commit` vs writes made just before it ────────────────────────
// `guardCommit` compares against COMMITTED state. The worry: another call's
// write made before the `$commit` but still unflushed (a microtask batch) is
// invisible to it. On a transactional cell no such write exists — its sync
// methods commit inside their reduce and its async ones buffer a write-set of
// their own (checked at ITS commit) — and another cell cannot write this
// cell's slice except by calling its methods. Every interleaving of a foreign
// writer and the commit must therefore end consistent: committed ⇒ the other
// write landed after it (n = 6), refused ⇒ it landed before (n = 5).
let l88open: () => void = () => {};
const l88a: Any = cell("l88a", {
  transaction: true,
  state: { n: 0 },
  methods: {
    reset(s: Any) {
      s.n = 0;
    },
    bump(s: Any) {
      s.n += 5;
    },
    async t(s: Any) {
      const r = s.n;
      await new Promise<void>((g) => l88open = g);
      s.n = r + 1;
      s.$commit();
      await Promise.resolve();
    },
  },
} as Any);
const l88b: Any = cell("l88b", {
  state: { k: 0 },
  methods: {
    async pre(s: Any) {
      s.k++;
      l88a.bump();
      await Promise.resolve();
    },
    async post(s: Any) {
      s.k++;
      await Promise.resolve();
      l88a.bump();
    },
  },
} as Any);

Deno.test("concurrency differential L88: a $commit never loses a write made around it", async () => {
  const srv = await testServer<Any>({ cells: [l88a, l88b] });
  try {
    const go = (x: string) =>
      x === "open" ? l88open() : x === "bump" ? l88a.bump() : l88b[x]();
    for (const w of ["pre", "post", "bump"]) {
      for (const order of [["open", w], [w, "open"]]) {
        await l88a.reset();
        const t = l88a.t().then(() => true, () => false);
        await sleep(5);
        order.forEach(go);
        const ok = await t;
        await sleep(10);
        assertEquals(
          srv.state().l88a.n,
          ok ? 6 : 5,
          `${order.join(" → ")}: committed=${ok}`,
        );
      }
    }
  } finally {
    await srv.close();
  }
});
