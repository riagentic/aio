// Random schedule PROGRAMS against an independent event model.
//
// The manager's behaviour is a conversation between four mechanisms —
// setTimeout/setInterval, same-id replace, `skipIfRunning`, and the failed
// one-shot's 5s retry — and the bugs live where they meet: a retry that
// re-armed a schedule `cancelAll()` had already cancelled, a `skipIfRunning`
// guard that outlived the timer it belonged to. Single-case tests cannot cover
// the crossings; this generates them.
//
// The model is written from the DOCUMENTED semantics and is structured
// differently from the implementation: it computes fire times arithmetically
// from each entry's arm time and keeps an explicit per-id liveness/in-flight
// state, instead of chaining callbacks. Both sides are then compared as a full
// ordered list of (time, id) dispatches — not a count, so an extra fire, a
// missing fire and a mis-timed fire are all failures.
//
// Knobs: SCHED_FUZZ_PROGRAMS (default 400), SCHED_FUZZ_SEED.
import { assertEquals } from "@std/assert";
import {
  createScheduleManager,
  createVirtualTimers,
  schedule,
  type ScheduleEffect,
} from "../src/state/schedule.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const PROGRAMS = fuzzEnvInt("SCHED_FUZZ_PROGRAMS", 400, 1);
const SEED = fuzzEnvInt("SCHED_FUZZ_SEED", 480421, 1);

const STEP = 250; // virtual ms per round
const ROUNDS = 40; // 10s of virtual time — past the 5s retry cadence
const SLOW = 600; // a "slow" tick settles this long after it fired
const RETRY_MS = 5000; // the manager's one-shot retry backoff
const MAX_RETRIES = 3;
const IDS = ["a", "b", "c"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Behavior = { ok: boolean; slow: boolean };
type Op =
  | { op: "after"; id: string; ms: number }
  | { op: "every"; id: string; ms: number; skip: boolean }
  | { op: "cancel"; id: string };
/** `pre` runs before the round's time advances; `mid` runs after the timers
 *  have fired but before their promises settle — the window where a cancel
 *  races an in-flight tick, which is exactly where the resurrection bug was. */
type Phase = "pre" | "mid";
type Program = { behavior: Record<string, Behavior>; rounds: [Op, Phase][][] };

function genProgram(rnd: () => number): Program {
  const behavior: Record<string, Behavior> = {};
  for (const id of IDS) {
    behavior[id] = { ok: rnd() < 0.55, slow: rnd() < 0.4 };
  }
  const rounds: [Op, Phase][][] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const ops: [Op, Phase][] = [];
    const n = rnd() < 0.55 ? 0 : 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      const id = IDS[Math.floor(rnd() * IDS.length)]!;
      const phase: Phase = rnd() < 0.3 ? "mid" : "pre";
      const k = rnd();
      if (k < 0.4) {
        ops.push([{
          op: "after",
          id,
          ms: [1, 100, 300, 700, 1500, 5000][Math.floor(rnd() * 6)]!,
        }, phase]);
      } else if (k < 0.8) {
        ops.push([{
          op: "every",
          id,
          ms: [100, 250, 400, 1000][Math.floor(rnd() * 4)]!,
          skip: rnd() < 0.5,
        }, phase]);
      } else {
        ops.push([{ op: "cancel", id }, phase]);
      }
    }
    rounds.push(ops);
  }
  return { behavior, rounds };
}

const effect = (op: Op): ScheduleEffect => {
  const action = { type: "Fire", payload: { id: op.id } };
  if (op.op === "after") return schedule.after(op.id, op.ms, action);
  if (op.op === "every") {
    return schedule.every(op.id, op.ms, action, { skipIfRunning: op.skip });
  }
  return schedule.cancel(op.id);
};

type Ev = { t: number; id: string };
const key = (e: Ev) => `${e.t}:${e.id}`;
const norm = (evs: Ev[]) =>
  [...evs].sort((x, y) => x.t - y.t || (x.id < y.id ? -1 : 1)).map(key);

// ── The real manager on a virtual clock ─────────────────────────────

function runReal(p: Program): Ev[] {
  const clock = createVirtualTimers(0);
  const evs: Ev[] = [];
  type Pending = { due: number; settle: () => void };
  let pending: Pending[] = [];
  const mgr = createScheduleManager(
    ((a: { payload: { id: string } }) => {
      const id = a.payload.id;
      const t = clock.now();
      evs.push({ t, id });
      const b = p.behavior[id]!;
      if (!b.slow) {
        return b.ok
          ? Promise.resolve()
          : Promise.reject(new Error("tick failed"));
      }
      return new Promise<void>((res, rej) => {
        pending.push({
          due: t + SLOW,
          settle: () => b.ok ? res() : rej(new Error("tick failed")),
        });
      });
    }) as unknown as Parameters<typeof createScheduleManager>[0],
    {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    { timers: clock },
  );

  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return (async () => {
    for (const ops of p.rounds) {
      for (const [op, ph] of ops) if (ph === "pre") mgr.handle(effect(op));
      clock.advance(STEP);
      for (const [op, ph] of ops) if (ph === "mid") mgr.handle(effect(op));
      const now = clock.now();
      const due = pending.filter((x) => x.due <= now);
      pending = pending.filter((x) => x.due > now);
      for (const d of due) d.settle();
      await flush();
    }
    return evs;
  })() as unknown as Ev[];
}

// ── The independent model ───────────────────────────────────────────

type Entry =
  | { kind: "every"; due: number; ms: number; skip: boolean }
  | { kind: "after"; due: number }
  | { kind: "retry"; due: number; count: number };

function runModel(p: Program): Ev[] {
  const evs: Ev[] = [];
  const entries = new Map<string, Entry>();
  // Per id: until when a started tick is still considered in flight, and a
  // generation that every cancel/replace bumps (a retry armed for an older
  // generation is dead — that is what "cancelled stays cancelled" means).
  const inFlightUntil = new Map<string, number>();
  const gen = new Map<string, number>();
  const bump = (id: string) => gen.set(id, (gen.get(id) ?? 0) + 1);
  type Settle = {
    id: string;
    at: number;
    reject: boolean;
    retryCount: number;
    gen: number;
    fromAfter: boolean;
  };
  let settles: Settle[] = [];

  /** The step boundary a tick that fired at `t` settles on. */
  const boundary = (t: number, extra: number) =>
    Math.ceil((t + extra) / STEP) * STEP;

  const apply = (op: Op): void => {
    if (op.op === "cancel") {
      entries.delete(op.id);
      inFlightUntil.delete(op.id);
      bump(op.id);
      return;
    }
    bump(op.id); // replace semantics: the previous timer, guard and retry die
    inFlightUntil.delete(op.id);
    entries.set(
      op.id,
      op.op === "after"
        ? { kind: "after", due: NaN }
        : { kind: "every", due: NaN, ms: op.ms, skip: op.skip },
    );
    const e = entries.get(op.id)!;
    e.due = curTime + op.ms;
  };

  let curTime = 0;
  for (let r = 0; r < p.rounds.length; r++) {
    const start = r * STEP, end = start + STEP;
    curTime = start;
    for (const [op, ph] of p.rounds[r]!) if (ph === "pre") apply(op);

    // Fire everything due in (start, end], earliest first.
    for (;;) {
      let pickId: string | null = null, pick: Entry | null = null;
      for (const [id, e] of entries) {
        if (e.due <= end && (!pick || e.due < pick.due)) {
          pick = e;
          pickId = id;
        }
      }
      if (!pick || !pickId) break;
      const t = pick.due;
      const b = p.behavior[pickId]!;
      const settleAt = boundary(t, b.slow ? SLOW : 0);
      if (pick.kind === "every") {
        pick.due = t + pick.ms;
        if (pick.skip && t <= (inFlightUntil.get(pickId) ?? -1)) continue; // skipped
        evs.push({ t, id: pickId });
        if (pick.skip) inFlightUntil.set(pickId, settleAt);
        settles.push({
          id: pickId,
          at: settleAt,
          reject: !b.ok,
          retryCount: 0,
          gen: gen.get(pickId) ?? 0,
          fromAfter: false,
        });
      } else {
        const count = pick.kind === "retry" ? pick.count : 0;
        entries.delete(pickId); // a one-shot's entry is spent when it fires
        evs.push({ t, id: pickId });
        settles.push({
          id: pickId,
          at: settleAt,
          reject: !b.ok,
          retryCount: count,
          gen: gen.get(pickId) ?? 0,
          fromAfter: true,
        });
      }
    }

    curTime = end; // a mid-phase op is issued once the clock has advanced
    for (const [op, ph] of p.rounds[r]!) if (ph === "mid") apply(op);

    // Settle: a rejected ONE-SHOT re-arms once, 5s out, unless its schedule
    // was cancelled or replaced while the tick was in flight.
    const dueNow = settles.filter((s) => s.at <= end);
    settles = settles.filter((s) => s.at > end);
    for (const s of dueNow) {
      if ((gen.get(s.id) ?? 0) !== s.gen) continue; // cancelled/replaced: dead
      if (inFlightUntil.get(s.id) === s.at) inFlightUntil.delete(s.id);
      if (!s.reject || !s.fromAfter) continue;
      if (s.retryCount >= MAX_RETRIES) continue;
      entries.set(s.id, {
        kind: "retry",
        due: end + RETRY_MS,
        count: s.retryCount + 1,
      });
    }
  }
  return evs;
}

Deno.test("fuzz: random schedule programs match an independent event model", async () => {
  const rnd = mulberry32(SEED);
  let fires = 0, retries = 0;
  for (let n = 0; n < PROGRAMS; n++) {
    const p = genProgram(rnd);
    const real = await (runReal(p) as unknown as Promise<Ev[]>);
    const model = runModel(p);
    const a = norm(real), b = norm(model);
    if (a.join("|") !== b.join("|")) {
      throw new Error(
        `program ${n} (seed ${SEED}) diverged\n` +
          `  real : ${a.join(" ")}\n  model: ${b.join(" ")}\n` +
          `  behavior: ${JSON.stringify(p.behavior)}\n` +
          `  program: ${
            JSON.stringify(
              p.rounds.map((r, i) => [i, r]).filter(([, r]) =>
                (r as unknown[]).length
              ),
            )
          }`,
      );
    }
    fires += real.length;
    // Programs that reach the retry cadence are the point — count them so a
    // generator change that stops producing them is visible.
    retries += real.filter((e) => e.t % STEP !== 0).length;
  }
  assertEquals(true, fires > 0);
  console.log(
    `[sched-fuzz] seed=${SEED} programs=${PROGRAMS} dispatches=${fires} off-step=${retries}`,
  );
});
