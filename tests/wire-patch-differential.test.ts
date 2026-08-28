// Randomized DIFFERENTIAL for the client half of state delivery.
//
// The server produces Immer patches, narrows them (narrowPatches — arrays as
// adds/removes, grown strings as `append`),
// compacts them (compactPatches), filters them by the client's subscriptions,
// decides patch-vs-full against the size threshold, and writes JSON. The client
// (state-message.ts → state-signals.ts) applies whatever lands. Every one of
// those steps is a chance for the two sides to disagree, and a disagreement is
// invisible: nothing on either side ever compares them.
//
// So this does. It drives the REAL production functions on both sides —
// `produceWithPatches` + `narrowPatches` + `compactPatches` +
// `filterPatchesBySubs` + `filterStateBySubs` on the server, `handleMessage` on
// the client — over randomized mutation programs, and asserts after EVERY frame
// that the client's root state and every per-cell signal equal the server's
// (subscription-filtered) state. Seeded: a failure replays with
// AIO_WIRE_SEED=<n>.
//
// Sibling fuzzers: tests/patch-compact.test.ts (narrowing in isolation),
// tests/proxy-differential.test.ts (sync/async method parity),
// tests/transport-chaos-fuzz.test.ts (frame-level chaos).
import { assert, assertEquals } from "@std/assert";
import {
  applyPatches,
  enablePatches,
  type Patch,
  produceWithPatches,
} from "immer";
import { compactPatches, narrowPatches } from "../src/state/patch-compact.ts";
import { applyWirePatches, type WirePatch } from "../src/protocol/patch-ops.ts";
import {
  filterPatchesBySubs,
  filterStateBySubs,
} from "../src/protocol/broadcast-utils.ts";
import { _getState, _reset, handleMessage } from "../src/state-core.ts";
import { _cellSignals } from "../src/state/state-signals.ts";
import { _resetInitialStateFlag } from "../src/state/state-message.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

enablePatches();

// ── Deterministic RNG ───────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rng>;

// ── The model server ────────────────────────────────────────────────

type Slice = Record<string, unknown>;
type State = Record<string, Slice>;

const CELLS = ["alpha", "beta", "gamma"] as const;

function slice(label: string): Slice {
  return {
    n: 0,
    label,
    items: [] as unknown[],
    // `rows` is a NESTED array (an array of arrays): index paths two levels
    // deep are where an index-shifting op and a positional write can collide
    // without either one being visible in the other's path.
    meta: { deep: { k: 0 }, rows: [] as unknown[][] },
    // An OPTIONAL key: `delete s.opt` emits a `remove` on an object (not an
    // array), and deleting-then-re-adding within one broadcast window is the
    // object-side twin of the array shapes below.
    opt: 0 as unknown,
    // A STREAMED string — the shape `narrowStringPatches` rewrites to
    // `append`. Seeded above the append floor so growth is rewritten from the
    // first round, and edited/truncated/reset often enough that the
    // non-suffix cases (which must stay a `replace`) share every frame with
    // the suffix ones.
    text: "t".repeat(300),
  };
}

function initialState(): State {
  return { alpha: slice("a"), beta: slice("b"), gamma: slice("c") };
}

/** One random mutation of a cell slice — the ops a real method body performs.
 *  Deliberately includes the whole-array REPLACEMENT forms (spread / filter /
 *  slice / reverse), because those are what `narrowArrayPatches` rewrites and
 *  therefore the only place a rewrite can be wrong. */
/** An index biased LOW. Two ops collide on the same index only if both pick it,
 *  and a uniform pick over a growing array makes that vanishingly rare — which
 *  is exactly how a compaction bug at a shared index stays unreachable for
 *  half a million rounds. Real lists are edited at their head far more than
 *  uniformly, so this is also the truer distribution. */
function lowIdx(r: Rng, len: number): number {
  return r.int(Math.min(len, 3));
}

function mutate(r: Rng, s: Slice): void {
  const items = s.items as unknown[];
  // A fresh element — sometimes a PRIMITIVE, because primitives are how an
  // array acquires duplicate identities, and duplicate identities are the case
  // narrowArrayPatches must decline rather than guess at.
  const elem = () =>
    r.chance(0.4)
      ? r.int(4)
      : r.chance(0.5)
      ? `s${r.int(3)}`
      : { id: r.int(1e6) };
  switch (r.int(23)) {
    case 20: // STREAM: the string grows by a chunk — an `append` on the wire.
      s.text = (s.text as string) +
        `c${r.int(1e6)}`.padEnd(1 + r.int(200), "x");
      break;
    case 21: // the string is EDITED, truncated or reset — never an append.
      s.text = r.chance(0.5)
        ? (s.text as string).slice(
          0,
          Math.max(0, (s.text as string).length - 1 - r.int(50)),
        )
        : r.chance(0.5)
        ? `r${r.int(1e6)}`.padEnd(300 + r.int(100), "y")
        : "";
      break;
    case 22: // grows TWICE in one method — one op, still one append.
      s.text = (s.text as string) + "a".repeat(1 + r.int(50));
      s.text = (s.text as string) + "b".repeat(1 + r.int(50));
      break;
    case 13: { // WHOLE-ELEMENT assignment — `s.items[k] = x`.
      // The shape the alphabet was missing, and the only one that emits a
      // `replace` at an ARRAY-INDEX path. Every other op writes either the
      // whole array or a field *inside* an element, so a positional replace
      // never met an index-shifting `add`/`remove` in the same frame.
      if (items.length > 0) items[lowIdx(r, items.length)] = elem();
      else items.push(elem());
      break;
    }
    case 14: // unshift — an insert at the FRONT, which shifts every index.
      s.items = [elem(), ...items];
      break;
    case 15: // shift — a removal at the front, same in reverse.
      s.items = items.slice(1);
      break;
    case 16: // splice in the middle: remove some, insert some, one op.
      if (items.length > 1) {
        const at = r.int(items.length - 1);
        s.items = [
          ...items.slice(0, at),
          elem(),
          ...items.slice(at + 1 + r.int(2)),
        ];
      } else items.push(elem());
      break;
    case 17: // length truncation — immer's `replace ["items","length"]`.
      items.length = Math.max(0, items.length - r.int(2));
      break;
    case 18: { // NESTED array — rows[i] is itself an array.
      const rows = (s.meta as { rows: unknown[][] }).rows;
      if (rows.length > 0 && r.chance(0.6)) {
        const i = r.int(rows.length);
        rows[i] = r.chance(0.5) ? [...rows[i]!, elem()] : rows[i]!.slice(1);
      } else rows.push([elem()]);
      break;
    }
    case 19: // object key DELETE / re-add — a `remove` on an object.
      if ("opt" in s && r.chance(0.5)) delete s.opt;
      else s.opt = r.chance(0.5) ? r.int(9) : { v: r.int(9) };
      break;
    case 0:
      s.n = (s.n as number) + 1 + r.int(3);
      break;
    case 1:
      s.label = `l${r.int(1000)}`;
      break;
    case 2: // push (native add op)
      items.push(elem());
      break;
    case 3: // spread-append (whole-array replace → narrowed to adds)
      s.items = [...items, elem(), elem()];
      break;
    case 4: // filter (whole-array replace → narrowed to removes)
      s.items = items.filter((_, i) => i % 2 === 0);
      break;
    case 5: // slice
      s.items = items.slice(0, Math.max(0, items.length - 1 - r.int(2)));
      break;
    case 6: // reverse — a REORDER; narrowing must decline it
      s.items = [...items].reverse();
      break;
    case 7: // map rebuilding elements (identity lost → stays a replace)
      s.items = items.map((el) =>
        el !== null && typeof el === "object" ? { ...(el as object) } : el
      );
      break;
    case 8: { // middle insert
      const at = r.int(items.length + 1);
      s.items = [...items.slice(0, at), elem(), ...items.slice(at)];
      break;
    }
    case 11: // duplicate an existing element — the case diffArray must DECLINE
      // (with repeated identities, "is this element still needed later" has no
      // single answer, so the whole-array replacement has to stand).
      s.items = items.length > 0
        ? [...items, items[r.int(items.length)]]
        : [elem(), elem()];
      break;
    case 9: // nested scalar
      (s.meta as { deep: { k: number } }).deep.k += 1;
      break;
    case 10: // nested object replace (keeps `rows` identity ~half the time, so
      // the nested array is sometimes re-established and sometimes carried)
      s.meta = {
        deep: { k: r.int(100) },
        rows: r.chance(0.5) ? [] : (s.meta as { rows: unknown[][] }).rows,
      };
      break;
    default: { // element field write (patch INSIDE an array element)
      // A RANDOM object element, not the first one: the write has to be able to
      // land at an index that a later shift moves, or the collision between
      // "op wrote at index k" and "index k is replaced later" never happens
      // anywhere but position 0.
      const objIdxs: number[] = [];
      for (let i = 0; i < items.length; i++) {
        const e = items[i];
        if (e !== null && typeof e === "object") objIdxs.push(i);
      }
      if (objIdxs.length > 0) {
        const at = objIdxs[lowIdx(r, objIdxs.length)]!;
        (items[at] as Record<string, unknown>).tag = r.int(50);
      } else {
        items.push({ id: r.int(1e6) });
      }
      break;
    }
  }
}

/** `append` ops the narrowing pass emitted across every program — asserted
 *  non-zero so the alphabet provably reaches the op it was extended for. */
let APPENDS = 0;

/** Produce one broadcast round exactly as the server does. */
function serverRound(
  r: Rng,
  state: State,
  hot: string | null,
): { next: State; entries: { cell: string; ops: WirePatch[] }[] } {
  const next: State = { ...state };
  const entries: { cell: string; ops: WirePatch[] }[] = [];
  // 1..3 cells change per round — a real dispatch can touch several. `hot`
  // pins the whole frame to ONE cell, which is what an app under load actually
  // looks like and the only way several dispatches' ops for the same paths end
  // up in one coalesced list often enough to collide.
  const touched = hot ? [hot] : CELLS.filter(() => r.chance(0.5));
  if (touched.length === 0) touched.push(r.pick(CELLS));
  for (const cell of touched) {
    const before = state[cell]!;
    const [after, ops] = produceWithPatches(before, (d: Slice) => {
      const n = 1 + r.int(3);
      for (let i = 0; i < n; i++) mutate(r, d);
    });
    // The exact call cell-compose-reduce.ts makes, at the same moment: the
    // PREVIOUS slice is the base.
    const narrowed = narrowPatches(before, ops as Patch[]);
    for (const op of narrowed) if (op.op === "append") APPENDS++;
    next[cell] = after as Slice;
    if (narrowed.length > 0) entries.push({ cell, ops: narrowed });
  }
  return { next, entries };
}

/** The wire decision server-broadcast.ts makes, and the frame it writes.
 *
 *  `meta` carries the per-client `lastFullJson` the real broadcaster keeps: a
 *  full state identical to the one the client already holds is NOT re-sent, so
 *  "no frame at all" is a production outcome and the client has to be right
 *  after it too. Leaving that out of the model would have made every silent-skip
 *  round look like a delivered frame.
 *
 *  It also carries `stale`, and that flag is the whole point of modelling this
 *  at all: the real memo is refreshed ONLY when a full state is serialized, so
 *  after any patch round it describes an older state than the client actually
 *  holds. This model used to stamp it on every patch frame — an always-fresh
 *  memo — which is precisely the property that made a real dropped-round bug
 *  (state returning to a value equal to the last full send, mid-patch-stream,
 *  is silently not sent and the client freezes) invisible to 150 rounds of
 *  fuzzing. Model what the code does, not what it should have done. */
function encodeFrame(
  state: State,
  entries: { cell: string; ops: WirePatch[] }[],
  subs: Set<string> | null,
  threshold: number,
  meta: { lastFullJson?: string; stale?: boolean },
): { kind: "patches" | "state" | "none"; json: string; rawOps: WirePatch[] } {
  const fullJson = JSON.stringify(filterStateBySubs(state, subs));
  const clientEntries = filterPatchesBySubs(entries, subs);
  const rawOps = clientEntries.flatMap((p) =>
    p.ops.map((op) => ({ ...op, path: [p.cell, ...op.path] }))
  ) as WirePatch[];
  const allOps = compactPatches(rawOps);
  const sendFull = (): { kind: "state" | "none"; json: string } => {
    // A STALE memo is not proof the client already holds this state.
    if (!meta.stale && fullJson === meta.lastFullJson) {
      return { kind: "none", json: fullJson };
    }
    meta.lastFullJson = fullJson;
    meta.stale = false;
    return { kind: "state", json: fullJson };
  };
  if (allOps.length === 0) return { ...sendFull(), rawOps };
  const patchJson = JSON.stringify(allOps);
  if (patchJson.length > fullJson.length * threshold) {
    return { ...sendFull(), rawOps };
  }
  // A patch moves the client on WITHOUT re-serializing the full state, which
  // is exactly how the memo goes stale in production.
  meta.stale = true;
  return { kind: "patches", json: patchJson, rawOps };
}

/** Compaction is a THRIFT step layered on top of the patch pipeline, so its one
 *  hard obligation is that it changes NOTHING: the compacted list must do to
 *  the client's actual base exactly what the raw list would have done.
 *
 *  Checked on every frame, against the client's real state, BEFORE the
 *  patch-vs-full decision — otherwise a compaction bug is only visible on
 *  frames that happen to travel as deltas, and a threshold that favours full
 *  state hides it completely. */
function assertCompactionPreservesEffect(
  base: unknown,
  rawOps: WirePatch[],
  seed: number,
  round: number,
): void {
  if (rawOps.length === 0) return;
  let raw: unknown;
  let compacted: unknown;
  try {
    raw = applyWirePatches(base, rawOps);
  } catch {
    return; // the uncompacted list itself does not apply — not a compaction bug
  }
  try {
    compacted = applyWirePatches(base, compactPatches(rawOps));
  } catch (e) {
    throw new Error(
      `compaction made the frame UNAPPLIABLE (seed=${seed} round=${round}): ` +
        `${e}\nops=${JSON.stringify(rawOps)}`,
    );
  }
  assertEquals(
    compacted,
    raw,
    `compaction changed what the frame does (seed=${seed} round=${round}) — ` +
      `ops=${JSON.stringify(rawOps)}`,
  );
}

// ── The client ──────────────────────────────────────────────────────

function deliver(kind: "patches" | "state", json: string): string {
  // JSON round-trip is the point: everything the client sees has been through
  // the wire, so a non-serializable value or an index/key coercion shows up.
  const d = JSON.parse(json);
  return handleMessage(kind === "patches" ? { $patches: d } : d);
}

function assertClientMatches(
  expected: unknown,
  seed: number,
  round: number,
  note: string,
): void {
  const actual = _getState();
  assertEquals(
    actual,
    expected,
    `client root state diverged (seed=${seed} round=${round} ${note}) — ` +
      `replay with AIO_WIRE_SEED=${seed}`,
  );
  // Per-cell signals are what components read; the root signal being right is
  // not enough. Only cells the client has actually been sent are checked — an
  // unsubscribed cell keeps its last value by design (state-signals.ts).
  for (const [cell, slice] of Object.entries(expected as State)) {
    const sig = _cellSignals.get(cell);
    assert(sig !== undefined, `no signal for cell '${cell}' (seed=${seed})`);
    assertEquals(
      sig!.peek(),
      slice,
      `cell signal '${cell}' diverged from the root state (seed=${seed} ` +
        `round=${round} ${note})`,
    );
  }
}

// ── The differential ────────────────────────────────────────────────

function runProgram(
  seed: number,
  rounds: number,
  opts: { subs: boolean; threshold: number; reconnects: boolean },
): { patchFrames: number; fullFrames: number } {
  const r = rng(seed);
  _reset();
  let state = initialState();
  let subs: Set<string> | null = null;
  // The server's per-client dedup memo (ClientMeta.lastFullJson). Every place
  // server-ws.ts sends a full state stamps it, so the model does too.
  const meta: { lastFullJson?: string; stale?: boolean } = {};

  // Connect: the client's first frame is always a full state.
  meta.lastFullJson = JSON.stringify(filterStateBySubs(state, subs));
  assertEquals(deliver("state", meta.lastFullJson), "full");
  assertClientMatches(filterStateBySubs(state, subs), seed, -1, "connect");

  let patchFrames = 0;
  let fullFrames = 0;
  for (let round = 0; round < rounds; round++) {
    // A subscription change is a real event mid-stream: the client narrows or
    // widens what it wants, and the server answers with a full state for the
    // new set (server-ws.ts) before any further delta.
    if (opts.subs && r.chance(0.15)) {
      const wanted = CELLS.filter(() => r.chance(0.6));
      subs = wanted.length === 0 || r.chance(0.2)
        ? null
        // Dotted paths exercise the `feat` prefix split on both filters.
        : new Set(wanted.map((c) => (r.chance(0.4) ? `${c}.n` : c)));
      meta.lastFullJson = JSON.stringify(filterStateBySubs(state, subs));
      deliver("state", meta.lastFullJson);
      assertClientMatches(
        filterStateBySubs(state, subs),
        seed,
        round,
        "after subs change",
      );
    }

    // A reconnect: the transport resets the initial-state flag (AIO-183), so a
    // delta arriving before the fresh snapshot must be DROPPED, never applied
    // to a stale base.
    if (opts.reconnects && r.chance(0.08)) {
      const staleRound = serverRound(r, state, null);
      state = staleRound.next;
      _resetInitialStateFlag();
      const stale = encodeFrame(
        state,
        staleRound.entries,
        subs,
        opts.threshold,
        meta,
      );
      if (stale.kind === "patches") {
        assertEquals(
          deliver("patches", stale.json),
          "dropped",
          `a delta arriving before the post-reconnect snapshot must be ` +
            `dropped, not applied to a stale base (seed=${seed})`,
        );
      }
      meta.lastFullJson = JSON.stringify(filterStateBySubs(state, subs));
      deliver("state", meta.lastFullJson);
      assertClientMatches(
        filterStateBySubs(state, subs),
        seed,
        round,
        "after reconnect",
      );
      continue;
    }

    // COALESCING is production behaviour, not an exotic case: the broadcast is
    // throttled, so one frame routinely carries the patches of SEVERAL
    // dispatches — which is the only way two ops for the same path end up in
    // one list, and therefore the only way `compactPatches` matters at all.
    const entries: { cell: string; ops: WirePatch[] }[] = [];
    const hot = r.chance(0.6) ? r.pick(CELLS) : null;
    const dispatches = 1 + r.int(4);
    for (let d = 0; d < dispatches; d++) {
      const round2 = serverRound(r, state, hot);
      state = round2.next;
      entries.push(...round2.entries);
    }
    const frame = encodeFrame(state, entries, subs, opts.threshold, meta);
    assertCompactionPreservesEffect(_getState(), frame.rawOps, seed, round);
    if (frame.kind === "none") {
      // The server decided nothing needed to go out. That is a CLAIM about the
      // client — it must already hold this state — so it is checked, not
      // assumed. A wrong dedup would otherwise be perfectly silent.
      assertClientMatches(
        filterStateBySubs(state, subs),
        seed,
        round,
        "no frame sent (lastFullJson dedup)",
      );
      continue;
    }
    const res = deliver(frame.kind, frame.json);
    if (frame.kind === "patches") patchFrames++;
    else fullFrames++;
    assert(
      res !== "dropped",
      `frame dropped by the client (seed=${seed} round=${round} ` +
        `kind=${frame.kind}) — a dropped frame is a permanent divergence`,
    );
    assertClientMatches(
      filterStateBySubs(state, subs),
      seed,
      round,
      `kind=${frame.kind}`,
    );
  }
  _reset();
  return { patchFrames, fullFrames };
}

const SEED = fuzzEnvInt("AIO_WIRE_SEED", 0x5eed_1234 >>> 0);
const PROGRAMS = fuzzEnvInt("AIO_WIRE_PROGRAMS", 120, 1);
// 150 rounds, not 50: at 50 the fuzzer never reached the frame that
// catches a compaction dropping an op an index shift had moved. The floor
// is set by what the program has to REACH, not by what runs fast.
const ROUNDS = fuzzEnvInt("AIO_WIRE_ROUNDS", 150, 1);

// ── The minimal shape the fuzzer found ──────────────────────────────

Deno.test("compactPatches: a collapsed replace never orphans an op under it", () => {
  // Found by the differential (seed 777007). Three DISPATCHES coalesced into
  // one broadcast window — assign a whole array, mutate an element, assign the
  // whole array again — which is ordinary app code:
  //
  //   s.items = [...]           → replace ["c","items"]
  //   s.items[0].tag = 7        → replace ["c","items",0,"tag"]
  //   s.items = [...]           → replace ["c","items"]
  //
  // `compactPatches` kept only the LAST replace for a path. Dropping the first
  // one left the middle op describing a position that no longer exists in the
  // base the client holds, so `applyPatches` threw
  // "Cannot apply patch, path doesn't resolve" — the whole frame was discarded
  // and the client had to be resynced with a full state.
  const base = { c: { items: [] as unknown[] } };
  const ops: Patch[] = [
    { op: "replace", path: ["c", "items"], value: [{ id: 1 }] },
    { op: "replace", path: ["c", "items", 0, "tag"], value: 7 },
    {
      op: "replace",
      path: ["c", "items"],
      value: [{ id: 1, tag: 7 }, { id: 2 }],
    },
  ];
  const expected = applyPatches(base, ops);
  const compacted = compactPatches(ops);
  assertEquals(
    applyWirePatches(base, compacted),
    expected,
    "compacting a patch list must never change — or invalidate — what it does",
  );
});

Deno.test("compactPatches: a later replace at the SAME index never cancels a shift", () => {
  // Found by the differential once the op alphabet learned `s.items[k] = x`.
  //
  // `add` and `remove` are POSITIONAL: they move every sibling after them. A
  // later `replace` at the same index overwrites one slot — it does not undo
  // the move. Treating "a later replace at this path" as "this op is
  // redundant" therefore drops an op whose effect nothing else reproduces, and
  // the compacted list applies CLEANLY to a state one element off.
  //
  // Two ordinary dispatches, coalesced into one broadcast window:
  //   s.items = s.items.filter(i => i.id !== "P")   → remove ["items", 0]
  //   s.items[0] = { id: "Q2" }                     → replace ["items", 0]
  const base = { todo: { items: [{ id: "P" }, { id: "Q" }, { id: "R" }] } };
  const ops: Patch[] = [
    { op: "remove", path: ["todo", "items", 0] },
    { op: "replace", path: ["todo", "items", 0], value: { id: "Q2" } },
  ];
  assertEquals(
    applyWirePatches(base, compactPatches(ops)),
    applyPatches(base, ops),
    "compaction deleted the removal — the client keeps a row the server deleted",
  );

  // The mirror case: an insert cancelled by a later replace at that index.
  const base2 = { todo: { items: [{ id: "P" }] } };
  const ops2: Patch[] = [
    { op: "add", path: ["todo", "items", 0], value: { id: "Z" } },
    { op: "replace", path: ["todo", "items", 0], value: { id: "B" } },
  ];
  assertEquals(
    applyWirePatches(base2, compactPatches(ops2)),
    applyPatches(base2, ops2),
    "compaction deleted the insert — the client is one row short",
  );

  // And the ANCESTOR half: a shift between an op and the replace that is
  // supposed to supersede it means the replace lands on a DIFFERENT element,
  // so the earlier op is not superseded at all.
  const base3 = { todo: { items: [{ id: "A" }, { id: "B" }] } };
  const ops3: Patch[] = [
    { op: "replace", path: ["todo", "items", 1, "tag"], value: 7 },
    { op: "add", path: ["todo", "items", 0], value: { id: "Z" } },
    { op: "replace", path: ["todo", "items", 1], value: { id: "X" } },
  ];
  assertEquals(
    applyWirePatches(base3, compactPatches(ops3)),
    applyPatches(base3, ops3),
    "an index-shifting op between the two made the supersede unsound",
  );
});

Deno.test("compactPatches: an op under a later whole-value replace is redundant", () => {
  // The same rule, stated as compaction rather than as correctness: everything
  // written under a path that is replaced WHOLESALE later in the same list is
  // overwritten, so it need not travel at all.
  const ops: Patch[] = [
    { op: "add", path: ["c", "items", 0], value: 1 },
    { op: "remove", path: ["c", "items", 0] },
    { op: "replace", path: ["c", "items"], value: [9] },
    { op: "replace", path: ["c", "items", 0], value: 8 },
  ];
  assertEquals(compactPatches(ops), [
    { op: "replace", path: ["c", "items"], value: [9] },
    { op: "replace", path: ["c", "items", 0], value: 8 },
  ]);
  // …and an op AFTER the replace still stands (it is not redundant).
  const base = { c: { items: [] as unknown[] } };
  assertEquals(
    applyWirePatches(base, compactPatches(ops)),
    applyPatches(base, ops),
  );
});

Deno.test("wire differential: client state equals server state after every patch frame", () => {
  let patches = 0;
  let fulls = 0;
  for (let p = 0; p < PROGRAMS; p++) {
    // threshold 1 keeps the patch path dominant — this program is about the
    // patch pipeline itself.
    const c = runProgram(SEED + p, ROUNDS, {
      subs: false,
      threshold: 1,
      reconnects: false,
    });
    patches += c.patchFrames;
    fulls += c.fullFrames;
  }
  assert(
    patches > PROGRAMS * 5,
    `too few patch frames (${patches}) — the fuzzer stopped exercising the ` +
      `delta path, which would make it vacuously green`,
  );
  assert(
    APPENDS > PROGRAMS,
    `only ${APPENDS} append ops were emitted — the string-growth alphabet ` +
      `is not reaching narrowStringPatches, so its every-frame equality is unproven`,
  );
});

/** Every program below must exercise BOTH wire kinds. A run that quietly
 *  stopped producing deltas — or stopped producing full states, so the
 *  crossover it is named for never happens — is green for the wrong reason,
 *  which is how three sibling fuzzers came to report clean numbers over
 *  territory they were not covering. */
function assertBothKinds(
  label: string,
  c: { patchFrames: number; fullFrames: number },
): void {
  assert(
    c.patchFrames > PROGRAMS && c.fullFrames > PROGRAMS,
    `${label}: ${c.patchFrames} patch / ${c.fullFrames} full frames over ` +
      `${PROGRAMS} programs — one of the two wire kinds stopped happening, so ` +
      `this program is vacuously green`,
  );
}

function runAll(
  base: number,
  opts: { subs: boolean; threshold: number; reconnects: boolean },
): { patchFrames: number; fullFrames: number } {
  let patchFrames = 0;
  let fullFrames = 0;
  for (let p = 0; p < PROGRAMS; p++) {
    const c = runProgram(base + p, ROUNDS, opts);
    patchFrames += c.patchFrames;
    fullFrames += c.fullFrames;
  }
  return { patchFrames, fullFrames };
}

Deno.test("wire differential: patch/full threshold crossover never loses state", () => {
  // The default production threshold: patch payload > 50% of full state ⇒
  // send full instead. Crossing back and forth is where a client can end up
  // applying a delta to a base the server never assumed.
  assertBothKinds(
    "threshold crossover",
    runAll(SEED + 1000, { subs: false, threshold: 0.5, reconnects: false }),
  );
});

Deno.test("wire differential: subscription filtering keeps client and server agreed", () => {
  assertBothKinds(
    "subscription filtering",
    runAll(SEED + 2000, { subs: true, threshold: 0.5, reconnects: false }),
  );
});

Deno.test("wire differential: a reconnect resyncs instead of rebasing a stale delta", () => {
  assertBothKinds(
    "reconnect",
    runAll(SEED + 3000, { subs: true, threshold: 0.5, reconnects: true }),
  );
});
