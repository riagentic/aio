// `own` under churn — random acquire/replace/dispose traffic against a model.
//
// `own.set` is the keyed-slot API cells hold subprocesses, watchers and FFI
// handles with, and its contract is entirely about ORDER and EXACTLY-ONCE: the
// previous disposer runs before the new factory, every disposer runs exactly
// once, a disposer that throws (or an async one that rejects) is contained and
// still frees the slot, and a replayed effect must never re-acquire or kill a
// live resource. Those are the properties a leaked subprocess violates, so
// they are fuzzed rather than sampled.
//
// Knobs: OWN_FUZZ_ROUNDS (default 400 programs), OWN_FUZZ_SEED.
import { assert, assertEquals } from "@std/assert";
import {
  _resetPendingFactories,
  createOwnManager,
  own,
  type OwnEffect,
  type OwnResource,
} from "../src/state/own.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const PROGRAMS = fuzzEnvInt("OWN_FUZZ_ROUNDS", 400, 1);
const OPS_PER_PROGRAM = 60;
const SEED = fuzzEnvInt("OWN_FUZZ_SEED", 3820382, 1);

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

const IDS = [
  "cellA",
  "cellA:sock",
  "cellA:proc",
  "cellB",
  "cellB:sock",
  "solo",
];
const KINDS = [
  "fn", // a plain disposer function
  "close", // { close() }
  "dispose", // { dispose() }
  "void", // acquires nothing — the slot stays empty
  "throwFactory", // the factory itself throws
  "throwDisposer", // teardown throws
  "asyncReject", // teardown returns a rejecting promise
] as const;
type Kind = typeof KINDS[number];

/** Does a resource of this kind end up occupying its slot? */
const occupies = (k: Kind) => k !== "void" && k !== "throwFactory";

Deno.test("fuzz: own survives acquire/replace/dispose churn", () => {
  const rnd = mulberry32(SEED);
  let ops = 0, disposals = 0;

  for (let program = 0; program < PROGRAMS; program++) {
    _resetPendingFactories();
    const log: string[] = [];
    const errors: string[] = [];
    const mgr = createOwnManager({
      info: () => {},
      debug: () => {},
      warn: (m) => log.push(`WARN ${m}`),
      error: (m) => errors.push(m),
    });

    // Model: which id holds which resource instance, and how many times each
    // instance's disposer has run.
    const live = new Map<string, number>(); // id → instance number
    const disposeCount = new Map<number, number>(); // instance → times disposed
    let instances = 0;
    const spent: OwnEffect[] = []; // effects already handled — replay candidates

    const acquire = (id: string, kind: Kind): void => {
      const n = ++instances;
      const factory = (): OwnResource => {
        log.push(`acquire:${n}`);
        if (kind === "throwFactory") throw new Error(`factory ${n} exploded`);
        const bump = () => {
          log.push(`dispose:${n}`);
          disposeCount.set(n, (disposeCount.get(n) ?? 0) + 1);
        };
        if (kind === "void") return undefined;
        if (kind === "close") return { close: bump };
        if (kind === "dispose") return { dispose: bump };
        if (kind === "throwDisposer") {
          return () => {
            bump();
            throw new Error(`disposer ${n} threw`);
          };
        }
        if (kind === "asyncReject") {
          return () => {
            bump();
            return Promise.reject(new Error(`async disposer ${n} failed`));
          };
        }
        return bump;
      };
      const effect = own.set(id, factory);
      const previous = live.get(id);
      const before = log.length;
      mgr.handle(effect);
      spent.push(effect);
      // ORDER: the previous resource is torn down BEFORE the new one exists.
      if (previous !== undefined) {
        const iDispose = log.indexOf(`dispose:${previous}`, before);
        const iAcquire = log.indexOf(`acquire:${n}`, before);
        assert(
          iDispose >= 0 && iDispose < iAcquire,
          `replace must dispose #${previous} before acquiring #${n}: ${
            log.slice(before).join(",")
          }`,
        );
      }
      if (occupies(kind)) live.set(id, n);
      else live.delete(id); // nothing to hold — the slot is empty, not stale
    };

    for (let i = 0; i < OPS_PER_PROGRAM; i++) {
      ops++;
      const r = rnd();
      const id = IDS[Math.floor(rnd() * IDS.length)]!;
      if (r < 0.45) {
        acquire(id, KINDS[Math.floor(rnd() * KINDS.length)]!);
      } else if (r < 0.62) {
        mgr.handle(own.dispose(id));
        live.delete(id);
      } else if (r < 0.74) {
        const prefix = rnd() < 0.5 ? "cellA" : "cellB";
        mgr.handle({ type: "__own", kind: "dispose", id: "x" }); // no-op probe
        live.delete("x");
        mgr.disposeByPrefix(prefix);
        // The delimiter rule, spelled out here rather than borrowed: the bare
        // prefix AND `prefix:` children go, nothing else. `own` used to miss
        // the bare id while schedule.cancelByPrefix took it.
        for (const k of [...live.keys()]) {
          if (k === prefix || k.startsWith(prefix + ":")) live.delete(k);
        }
      } else if (r < 0.80) {
        mgr.disposeAll();
        live.clear();
      } else if (r < 0.92 && spent.length > 0) {
        // Replay: a time-travel/duplicate delivery of an already-handled
        // effect. Its one-shot factory is gone, so it must be a NO-OP — never
        // a re-acquire, and never a teardown of the live resource.
        const e = spent[Math.floor(rnd() * spent.length)]!;
        const beforeLive = new Map(live);
        const before = log.length;
        mgr.handle(e);
        if (e.kind === "set") {
          assertEquals(
            log.slice(before).filter((l) => l.startsWith("acquire")).length,
            0,
            "a replayed own.set must not re-acquire",
          );
          assertEquals(
            log.slice(before).filter((l) => l.startsWith("dispose")).length,
            0,
            "a replayed own.set must not dispose the live resource",
          );
          assertEquals([...live.keys()].sort(), [...beforeLive.keys()].sort());
        } else {
          live.delete(e.id);
        }
      } else {
        // An id that was never acquired — dispose must be a silent no-op.
        mgr.handle(own.dispose("never-held"));
      }

      assertEquals(
        mgr.active().sort(),
        [...live.keys()].sort(),
        `after op ${i} of program ${program}: live slots diverged`,
      );
    }

    mgr.disposeAll();
    assertEquals(mgr.active(), [], "disposeAll leaves nothing behind");

    // EXACTLY ONCE: no resource is torn down twice, and every resource that
    // was ever acquired (and holds a disposer) is torn down by the end.
    for (const [instance, n] of disposeCount) {
      assertEquals(n, 1, `resource #${instance} was disposed ${n} times`);
      disposals++;
    }
    // A throwing/rejecting disposer is reported, never swallowed and never
    // allowed to take the process down.
    for (const e of errors) {
      assert(
        /threw|failed/.test(e),
        `unexpected own error: ${e}`,
      );
    }
  }

  console.log(
    `[own-fuzz] seed=${SEED} programs=${PROGRAMS} ops=${ops} disposals=${disposals}`,
  );
});

Deno.test("own: disposeByPrefix takes the bare id, like schedule.cancelByPrefix", () => {
  const disposed: string[] = [];
  const mgr = createOwnManager({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  });
  for (const id of ["mycell", "mycell:sock", "mycellOther"]) {
    mgr.handle(own.set(id, () => () => disposed.push(id)));
  }
  mgr.disposeByPrefix("mycell");
  assertEquals(disposed.sort(), ["mycell", "mycell:sock"]);
  assertEquals(mgr.active(), ["mycellOther"], "a longer name is not a child");
});
