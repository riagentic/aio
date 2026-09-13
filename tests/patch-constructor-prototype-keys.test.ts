// `constructor` and `prototype` are ordinary STATE KEYS, and a delta touching
// one must apply — while no crafted patch may ever pollute a prototype.
//
// The browser used to refuse any patch path containing `__proto__`,
// `constructor` or `prototype`. The last two are words a dictionary, a glossary
// or a word-count cell holds as plain data, and the server's own Immer writes
// them without complaint — so every delta touching one was a dropped frame plus
// a full-state resync (4 of 4 updates on a real socket; 3672 of 17073 frames in
// a fuzzer). And a NESTED write under an own `constructor` key
// (`s.words.constructor.n++`) could not apply anywhere downstream: Immer's
// `applyPatches` refuses a non-final `constructor` even when it is the
// object's own data, which also broke the worker-cell host.
//
// The refusal is now exactly as wide as the danger (see RESERVED_PATH_SEGMENT
// in protocol/patch-ops.ts), and the second half of this file is the proof
// that narrowing it opened nothing: an exhaustive sweep of crafted paths over
// every reserved word, at every position, through every op, never reaches
// `Object.prototype`, `Array.prototype` or `Function.prototype`.
import { assert, assertEquals } from "@std/assert";
import { enablePatches, type Patch, produceWithPatches } from "immer";
import { compactPatches, narrowPatches } from "../src/state/patch-compact.ts";
import { applyWirePatches, type WirePatch } from "../src/protocol/patch-ops.ts";
import { _getState, _reset, handleMessage } from "../src/state-core.ts";
import { setTransport } from "../src/state/state-transport.ts";
import { _cellSignals } from "../src/state/state-signals.ts";
import { dec } from "../src/protocol/envelope.ts";
import { cell } from "../src/state/cell.ts";
import { testServer } from "../src/testing/server-test.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";

enablePatches();

/** A transport that only counts what the client asked the server for. */
function recordResyncs(): { count: () => number } {
  const sent: string[] = [];
  setTransport(
    {
      send: (d: string) => sent.push(d),
      close: () => {},
    } as unknown as Parameters<typeof setTransport>[0],
  );
  return { count: () => sent.filter((s) => s.includes("resync")).length };
}

type Words = { words: Record<string, unknown> };
// Indexed through a `string`, so TypeScript does not read the key as
// `Object.prototype.constructor` — at runtime they are plain own keys.
const CTOR: string = "constructor";
const PROTO: string = "prototype";

/** Server side exactly as a dispatch produces it: Immer → narrow → compact →
 *  JSON. Returns the new server state and the frame's JSON-decoded ops. */
function serverCommit(
  before: Words,
  mutate: (d: Words) => void,
): { next: Words; frame: WirePatch[] } {
  const [next, ops] = produceWithPatches(before, mutate);
  const narrowed = narrowPatches(before, ops as Patch[]).map((p) => ({
    ...p,
    path: ["c", ...p.path],
  })) as WirePatch[];
  return {
    next,
    frame: JSON.parse(JSON.stringify(compactPatches(narrowed))),
  };
}

Deno.test("reserved words: deltas under `constructor`/`prototype` keys apply without a resync", () => {
  _reset();
  const resyncs = recordResyncs();
  let server: Words = { words: { apple: 1 } };
  handleMessage({ c: structuredClone(server) });

  const programs: [string, (d: Words) => void][] = [
    ["add final constructor", (d) => void (d.words[CTOR] = 1)],
    ["add final prototype", (d) => void (d.words[PROTO] = 1)],
    ["bump final constructor", (d) => {
      d.words[CTOR] = (d.words[CTOR] as number) + 1;
    }],
    ["constructor becomes an object", (d) => {
      d.words[CTOR] = { n: 1, deep: { k: [1] } };
    }],
    // The nested half — Immer's applier refuses these outright.
    ["nested write under own constructor", (d) => {
      (d.words[CTOR] as { n: number }).n++;
    }],
    ["deep push under own constructor", (d) => {
      (d.words[CTOR] as { deep: { k: number[] } }).deep.k.push(2);
    }],
    ["prototype becomes an object, then a nested write", (d) => {
      d.words[PROTO] = { constructor: { x: 1 } };
    }],
    ["constructor.prototype.constructor — all own data", (d) => {
      ((d.words[PROTO] as Record<string, unknown>)[CTOR] as { x: number }).x =
        9;
    }],
    ["a streamed string under own constructor (append)", (d) => {
      (d.words[CTOR] as { s?: string }).s = "x".repeat(400);
    }],
    ["…and it grows", (d) => {
      (d.words[CTOR] as { s: string }).s += "y".repeat(10);
    }],
    ["remove both", (d) => {
      delete d.words[CTOR];
      delete d.words[PROTO];
    }],
  ];

  let deltas = 0;
  for (const [label, mutate] of programs) {
    const { next, frame } = serverCommit(server, mutate);
    server = next;
    if (frame.length === 0) continue;
    const res = handleMessage({ $patches: frame });
    assertEquals(res, "delta", `${label}: ${JSON.stringify(frame)}`);
    deltas++;
    assertEquals(_getState(), { c: server }, label);
    assertEquals(_cellSignals.get("c")?.peek(), server, `${label} (signal)`);
  }
  assert(deltas >= programs.length - 1, `only ${deltas} frames were applied`);
  assertEquals(resyncs.count(), 0, "no delta may have been refused");
  _reset();
});

Deno.test("reserved words: the nested-constructor frame the server really emits", () => {
  // Pinned literally, so the test does not depend on how narrowing shapes it.
  const base = { c: { words: { constructor: { n: 1 } } } };
  const next = applyWirePatches(base, [
    { op: "replace", path: ["c", "words", "constructor", "n"], value: 2 },
  ]);
  assertEquals(next, { c: { words: { constructor: { n: 2 } } } });
  assertEquals(base.c.words.constructor.n, 1, "base not mutated");
});

Deno.test("reserved words: a real server and socket — no dropped frames, no resyncs", async () => {
  const dict = cell("rwords", {
    // `pad` keeps a one-key delta well under the patch-vs-full threshold, so
    // the updates travel as patches — the path under test.
    state: {
      words: { apple: 1 } as Record<string, unknown>,
      n: 0,
      pad: "p".repeat(5000),
    },
    methods: {
      bump(s, k: string) {
        s.words[k] = (Object.hasOwn(s.words, k) ? s.words[k] as number : 0) +
          1;
        s.n++;
      },
      nest(s) {
        const c = s.words[CTOR];
        if (c !== null && typeof c === "object") (c as { n: number }).n++;
        else s.words[CTOR] = { n: 1 };
        s.n++;
      },
    },
  });
  await using srv = await testServer({ cells: [dict] });
  _reset();
  let resyncs = 0;
  const results: string[] = [];
  const ws = new WebSocket(srv.url.replace(/^http/, "ws") + "/ws");
  ws.addEventListener("message", (e) => {
    const f = dec(String((e as MessageEvent).data));
    if (f?.t === "state") results.push(handleMessage(f.d));
    if (f?.t === "patches") results.push(handleMessage({ $patches: f.d }));
  });
  await new Promise<void>((r) => ws.addEventListener("open", () => r()));
  setTransport(
    {
      send: (m: string) => {
        if (m.includes("resync")) resyncs++;
        ws.send(m);
      },
      close: () => {},
    } as unknown as Parameters<typeof setTransport>[0],
  );
  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(pred(), `timed out; results=${results.join(",")}`);
  };
  const clientN = () => (_getState() as { rwords?: { n: number } }).rwords?.n;
  await waitFor(() => clientN() === 0);
  let n = 0;
  for (const k of ["constructor", "prototype", "constructor", "prototype"]) {
    await dict.bump(k);
    n++;
    await waitFor(() => clientN() === n);
  }
  await dict.nest(); // `constructor` turns from a number into an object
  n++;
  await waitFor(() => clientN() === n);
  await dict.nest(); // …and a nested write under it
  n++;
  await waitFor(() => clientN() === n);

  ws.close();
  await new Promise((r) => setTimeout(r, 30));
  const client = (_getState() as { rwords: unknown }).rwords;
  assertEquals(client, {
    words: { apple: 1, constructor: { n: 2 }, prototype: 2 },
    n,
    pad: "p".repeat(5000),
  });
  assertEquals(resyncs, 0, `results: ${results.join(",")}`);
  assert(
    results.filter((r) => r === "delta").length >= 6,
    `the updates must have arrived as deltas: ${results.join(",")}`,
  );
  assert(!results.includes("dropped"), results.join(","));
  _reset();
});

// ── The security property: no crafted patch pollutes a prototype ──────

// The constructors too, not only their prototypes: walking an INHERITED
// `constructor` lands on the global `Object` function itself, and a write there
// is a static property every realm-mate sees (`Object.polluted`). A mutant
// that skipped the own-key check did exactly that, with every prototype clean.
const SHARED = [
  Object.prototype,
  Array.prototype,
  Function.prototype,
  Object,
  Array,
  Function,
];

function assertUnpolluted(label: string): void {
  for (const shared of SHARED) {
    assert(
      !Object.hasOwn(shared, "polluted"),
      `${label}: a shared built-in was polluted`,
    );
  }
  assertEquals(({} as Record<string, unknown>).polluted, undefined, label);
  assertEquals(Object.getPrototypeOf({}), Object.prototype, label);
}

/** Everything reachable from the applier's result is plain data: no object in
 *  it has had its prototype swapped. */
function assertPlain(v: unknown, label: string, depth = 0): void {
  if (v === null || typeof v !== "object" || depth > 20) return;
  const proto = Object.getPrototypeOf(v);
  assert(
    proto === Object.prototype || proto === Array.prototype || proto === null,
    `${label}: an object in the result was re-prototyped`,
  );
  for (const k of Object.keys(v)) {
    assertPlain((v as Record<string, unknown>)[k], label, depth + 1);
  }
}

/** Does `path` walk a non-final `constructor` its container does not OWN? */
function inheritedConstructor(
  root: unknown,
  path: (string | number)[],
): boolean {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur === null || typeof cur !== "object") return false;
    if (path[i] === "constructor" && !Object.hasOwn(cur, "constructor")) {
      return true;
    }
    cur = (cur as Record<string | number, unknown>)[path[i]!];
  }
  return false;
}

Deno.test("reserved words: an exhaustive sweep of crafted paths never pollutes a prototype", () => {
  const SEGS = ["__proto__", "constructor", "prototype", "obj", "arr", 0];
  const OPS = ["add", "replace", "remove", "append"] as const;
  // Base shapes an attacker could aim at: plain objects, arrays, an own
  // `constructor`/`prototype` holding an object, and a function-free tree.
  const base = () => ({
    obj: { constructor: { prototype: {} }, prototype: {} },
    arr: [{ constructor: {} }],
    constructor: { prototype: { constructor: {} } },
    prototype: {},
  });
  const values: unknown[] = [
    1,
    "polluted",
    { polluted: true },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ];
  // Thousands of refusals each log a resync warning; keep them off the console.
  setLogger(
    { pub: () => {}, perf: () => {} } as unknown as Parameters<
      typeof setLogger
    >[0],
  );
  let tried = 0;
  let applied = 0;
  const paths: (string | number)[][] = [];
  const grow = (prefix: (string | number)[], depth: number) => {
    paths.push([...prefix, "polluted"]);
    if (depth === 3) return;
    for (const s of SEGS) grow([...prefix, s], depth + 1);
  };
  grow([], 0);
  assert(paths.length > 50, "the sweep is not empty");
  for (const path of paths) {
    for (const op of OPS) {
      const vs = op === "remove" ? [undefined] : values;
      assert(vs.length >= 1);
      for (const value of vs) {
        const patch = (op === "append"
          ? { op, path, value: "x" }
          : { op, path, value }) as WirePatch;
        tried++;
        const label = JSON.stringify(patch);
        // Through the shared applier every consumer uses…
        let refusal: string | null = null;
        try {
          assertPlain(applyWirePatches(base(), [patch]), label);
          applied++;
        } catch (e) {
          refusal = String(e); // refused — fine, as long as nothing leaked
        }
        // aio's OWN layer must refuse the two dangerous shapes — not merely
        // Immer's guard underneath it, which is a dependency's detail.
        if (path.includes("__proto__")) {
          assert(
            refusal?.includes(`"__proto__" is never a state key`),
            `${label}: not refused by applyWirePatches itself: ${refusal}`,
          );
        } else if (inheritedConstructor(base(), path)) {
          assert(
            refusal?.includes("inherited constructor"),
            `${label}: not refused by applyWirePatches itself: ${refusal}`,
          );
        }
        assertUnpolluted(label);
        // …and through the browser's front door, with a warm-up op first so a
        // frame that mixes a legal op with a hostile one is covered too.
        _reset();
        recordResyncs();
        handleMessage({ c: base() });
        handleMessage({
          $patches: [
            { op: "replace", path: ["c", "prototype", "ok"], value: 1 },
            { ...patch, path: ["c", ...patch.path] },
          ],
        });
        assertPlain(_getState(), label);
        assertUnpolluted(label);
      }
    }
  }
  // Vacuity guards: the sweep is big, and SOME of it is legitimate data that
  // must apply (writes into own `constructor`/`prototype` objects).
  setLogger(null);
  assert(tried > 3000, `only ${tried} crafted patches`);
  assert(
    applied > 100,
    `only ${applied} applied — the sweep refused everything`,
  );
  _reset();
});
