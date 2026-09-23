// SSR soak — many server renders in flight at once, some of them ABORTED
// mid-stream, and every response must still be only its own.
//
// `air-ssr-concurrent-render-state.test.ts` pins each isolation defect with
// two hand-interleaved streams. That proves the shapes someone thought of. A
// server sees thousands of interleavings nobody wrote down: a stream pulled
// three chunks ahead of its neighbour, a client that closes the tab after the
// first `<tr>`, a `renderToString` for an error page landing between two
// chunks of somebody else's page, a head asked for twenty steps after its body
// ended. Every one of those went wrong at least once in the 1.0.7/1.0.8 cycle
// (a shared id counter, a shared head, a head answered by start order, a
// liveness set that one abandoned stream poisoned), and each was found by a
// user, not by a test.
//
// So this file draws the schedule instead of writing it. Per round, a seeded
// PRNG opens a set of pages and then, step by step, pulls a chunk of one of
// them, aborts one (`return()` — what a closed connection does to the
// generator), abandons one outright, serves a synchronous `renderToString`
// in the gap, or collects a finished page's head now or much later. The
// oracle is the SAME page rendered alone: whatever the interleaving, a
// response must be byte-identical to its solo render, an aborted one a
// prefix of it, and a head exactly its own.
//
// Three phases, three doors:
//   1. in-process concurrent — keyed heads, ids, context, <select> scopes,
//      ErrorBoundary, lazy/Suspense, nested renderToString, server hooks;
//   2. in-process sequential — the no-argument `collectHead()` an app serving
//      one request at a time uses, with aborted and thrown renders between;
//   3. hydration — the streamed markup adopted by the client, then re-rendered
//      and unmounted, so a hook-slot defect (onUnmount on a neighbour's slot)
//      has somewhere to show;
// and one more Deno.test drives the REAL server path: `Deno.serve` on a
// `freePort()`, the documented ReadableStream shapes, clients that disconnect
// mid-body — and asserts every server render ran its `finally`.
//
// The seed is FIXED by default (CI must explore the same schedules every run —
// the fuzzer convention in tests/fuzz-seed.ts); `FUZZ_SEED` / `FUZZ_ROUNDS`
// widen a sweep, and `deno task test:ssr-soak` runs the long lane. Every
// failure names `FUZZ_SEED=… round …`, which replays it exactly: the in-process
// phases involve no timers, so a seed is the whole schedule.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { freePort } from "../src/testing/server-test.ts";
import {
  collectHead,
  createContext,
  ErrorBoundary,
  h,
  lazy,
  onCleanup,
  onMount,
  onUnmount,
  Route,
  routePath,
  routeSearch,
  Suspense,
  useContext,
  useHead,
  useId,
  useRef,
  useRoute,
} from "../src/air.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { _isSsrRendering, renderToString } from "../src/air/vdom-ssr.ts";
import { _ssrRenderCurrent } from "../src/air/ssr-render.ts";
import { _resetHead } from "../src/air/head.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import type { VNode } from "../src/air/vdom-types.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x55a0c4) & 0x7fffffff;
/** Default sized for the ordinary suite (~2 s); the soak lane raises it. */
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 40, 1);

/** Seeded PRNG (mulberry32) — one per round, so a round replays on its own. */
function rng(seed: number): { f: () => number; n: (k: number) => number } {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { f, n: (k) => Math.floor(f() * k) };
}

// ── the page ──────────────────────────────────────────────────────────

/** One request's page, fully described — the oracle renders the same spec. */
interface Spec {
  tok: string;
  /** Asks for a `<head>`. Pages without one exercise the "no head" branches. */
  headed: boolean;
  rows: number;
  pick: number;
  /** A row throws inside an ErrorBoundary (fallback carries the token). */
  boom: boolean;
  /** A component calls `renderToString` for part of the page. */
  nested: boolean;
  /** 0 none · 1 a lazy that never loads (fallback) · 2 a loaded lazy. */
  lazy: 0 | 1 | 2;
  /** A component throws OUTSIDE every boundary — the whole render fails. */
  explode: boolean;
  /** Rows call `onUnmount` behind an `if` on the client (hydration phase). */
  conditional: boolean;
  /** The whole page under a Provider — which used to make the stream buffer
   *  the entire page in one pull (see air-ssr-stream-fragment-streams). */
  rootProvider: boolean;
}

const Req = createContext("<no provider>");
/** Every server-side hook callback lands here — a server render must never
 *  run one, and must never let one reach a later client root. */
const hookLog: string[] = [];
/** Client re-render trigger for the hydration phase. */
const phase = signal(0);

const Row = (p: { i: number; spec: Spec }) => {
  const tok = p.spec.tok;
  const id = useId();
  if (p.i === 0 && p.spec.headed) {
    useHead({ meta: [{ name: "row", content: tok }] });
  }
  // The shape the 1.0.8 onUnmount fix is about: a conditional call right
  // above a `useRef` that holds the component's own object.
  // Every row reads the phase, so every row re-renders when it moves (a row
  // that read no signal would never re-render, and dev says so).
  const ph = phase.value;
  if (p.spec.conditional && ph > 0) {
    onUnmount(() => hookLog.push(`release ${tok} ${p.i}`));
  }
  const own = useRef<{ n: number } | null>(null);
  own.current ??= { n: p.i };
  if (!p.spec.conditional) {
    onUnmount(() => hookLog.push(`release ${tok} ${p.i}`));
  }
  return h(
    "li",
    null,
    h("label", { for: id }, `${tok}/${own.current.n}`),
    h("input", { id, value: tok }),
  );
};

const Boom = () => {
  throw new Error(`boom ${useContext(Req)}`);
};

const Explode = (p: { tok: string }) => {
  throw new Error(`explode ${p.tok}`);
};

/** Reads the request's token through CONTEXT, not props. */
const Echo = () => h("output", { id: useId() }, useContext(Req));

const Inner = () => {
  const tok = useContext(Req);
  useHead({ meta: [{ name: "nested", content: tok }] });
  return h("em", { id: useId() }, `inner ${tok}`);
};

/** Part of the page rendered by a nested `renderToString` — one document,
 *  so one id sequence and one head with its parent. */
const Nested = () =>
  h("section", {
    dangerouslySetInnerHTML: { __html: renderToString(h(Inner, null)) },
  });

const Never = lazy(() => new Promise<never>(() => {}));
const ReadyInner = () => h("b", null, `ready ${useContext(Req)}`);
const Ready = lazy(() => Promise.resolve({ default: ReadyInner }));
/** Load `Ready` before any oracle runs, so every render of it is the same. */
async function loadReady(): Promise<void> {
  renderToString(h(Suspense, { fallback: "" }, h(Ready, null)));
  await new Promise((res) => setTimeout(res, 0));
}

const Pick = (p: { value: string }) =>
  h(
    "select",
    { value: p.value },
    h("option", { value: "o0" }, "zero"),
    h("option", { value: "o1" }, "one"),
    h("option", { value: "o2" }, "two"),
  );

const Page = (p: { spec: Spec }) => {
  const s = p.spec;
  if (s.headed) {
    useHead({
      title: `T ${s.tok}`,
      meta: [{ name: "req", content: s.tok }],
      link: [{ rel: "canonical", href: `https://x.test/${s.tok}` }],
    });
  }
  onMount(() => hookLog.push(`mount ${s.tok}`));
  onCleanup(() => hookLog.push(`cleanup ${s.tok}`));
  const rows = [];
  for (let i = 0; i < s.rows; i++) rows.push(h(Row, { i, spec: s }));
  // Sometimes under a ROOT Provider. A Provider renders a Fragment, and the
  // stream writer used to buffer a Fragment whole — so a page wrapped that
  // way was computed in ONE pull and never interleaved with anything: the
  // first version of this soak did exactly that, and a shared <select> stack
  // went green through 40 rounds. Fragments stream now; both shapes are
  // drawn so both stay honest.
  const main = h(
    "main",
    { "data-req": s.tok },
    h("h1", { id: useId() }, s.tok),
    h("ul", null, ...rows),
    h(Pick, { value: `o${s.pick}` }),
    h(
      Req.Provider,
      { value: s.tok },
      h(Echo, null),
      h(
        ErrorBoundary,
        { fallback: (e: Error) => h("p", null, `caught ${e.message}`) },
        s.boom ? h(Boom, null) : h("p", null, "fine"),
      ),
      s.nested ? h(Nested, null) : null,
      s.lazy === 1
        ? h(
          Suspense,
          { fallback: h("i", null, `wait ${s.tok}`) },
          h(Never, null),
        )
        : s.lazy === 2
        ? h(Suspense, { fallback: h("i", null, "wait") }, h(Ready, null))
        : null,
    ),
    h("footer", null, h(Pick, { value: `o${(s.pick + 1) % 3}` })),
    s.explode ? h(Explode, { tok: s.tok }) : null,
  );
  return s.rootProvider ? h(Req.Provider, { value: s.tok }, main) : main;
};

const page = (spec: Spec) => h(Page, { spec }) as VNode;

/** Every stream the in-process soak opens, so a failing round cannot leave
 *  one suspended mid-render for the NEXT test to trip over (the SSR flag is
 *  process-wide). Emptied after each clean round. */
const opened: AsyncGenerator<string, void, unknown>[] = [];
function stream(
  spec: Spec,
  key?: object,
): AsyncGenerator<string, void, unknown> {
  const g = renderToStream(page(spec), key);
  opened.push(g);
  return g;
}

function drawSpec(
  r: ReturnType<typeof rng>,
  tok: string,
  opts: { explode?: boolean; client?: boolean } = {},
): Spec {
  return {
    tok,
    headed: r.f() < 0.8,
    rows: 1 + r.n(5),
    pick: r.n(3),
    boom: r.f() < 0.25,
    // Nested and lazy pages are not hydrated: a client-side renderToString is
    // a fresh top-level render by design, and a never-loading lazy keeps its
    // boundary waiting. Both are server-render shapes; the soak keeps them
    // on the server.
    nested: !opts.client && r.f() < 0.3,
    lazy: opts.client ? 0 : (r.n(3) as 0 | 1 | 2),
    explode: opts.explode === true && r.f() < 0.5,
    conditional: opts.client === true && r.f() < 0.5,
    rootProvider: r.f() < 0.3,
  };
}

/** What the page is, rendered ALONE: the body, the head, or the throw. */
interface Oracle {
  html: string;
  head: string;
  error: string | null;
}

function solo(spec: Spec): Oracle {
  let html: string;
  try {
    html = renderToString(page(spec));
  } catch (e) {
    return { html: "", head: "", error: (e as Error).message };
  }
  // Outside the try: `renderToString` then `collectHead()` on the next line
  // is the one pairing that is always exact, so a throw here is a finding,
  // not an oracle.
  return { html, head: collectHead(), error: null };
}

/** Every token that is NOT this spec's must be absent from its output. */
function assertOnlyOwn(
  text: string,
  own: string,
  all: readonly string[],
  what: string,
): void {
  for (const t of all) {
    if (t !== own) {
      assert(!text.includes(t), `${what} of ${own} carries ${t}'s data`);
    }
  }
}

// ── console capture: the soak must be SILENT ──────────────────────────

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const w = console.warn;
  const e = console.error;
  console.warn = (...a: unknown[]) => void lines.push(`warn: ${a.join(" ")}`);
  console.error = (...a: unknown[]) =>
    void lines.push(`error: ${a.map(String).join(" ")}`);
  return {
    lines,
    restore: () => {
      console.warn = w;
      console.error = e;
    },
  };
}

// ── phase 1: concurrent streams, keyed heads ──────────────────────────

interface Live {
  spec: Spec;
  want: Oracle;
  gen: AsyncGenerator<string, void, unknown>;
  req: object;
  out: string;
  pulled: number;
  /** The chunk at which this response's client goes away (-1: never), and
   *  whether it goes by `return()` — a closed connection — or by being
   *  dropped with nobody ever resuming it. Drawn per stream, not per step: a
   *  per-step coin aborts nearly every page long before its end. */
  stopAt: number;
  abandon: boolean;
}

/** What the soak actually did, so a green run can prove it was not vacuous. */
interface Stats {
  steps: number;
  finished: number;
  aborted: number;
  abandoned: number;
  threw: number;
  sync: number;
  keyed: number;
  unkeyedChecked: number;
  refused: number;
  /** No-argument answers that were somebody else's head — the documented
   *  price of the no-argument form under concurrency, pinned shape by shape
   *  against a model in air-ssr-head-oracle.test.ts. Counted here. */
  wrongAnswered: number;
}

const REFUSAL = "collectHead() cannot tell";

async function concurrentPhase(
  r: ReturnType<typeof rng>,
  round: number,
  abandoned: AsyncGenerator<string, void, unknown>[],
  st: Stats,
  repro: string,
): Promise<void> {
  const count = 4 + r.n(9);
  const specs: Spec[] = [];
  for (let i = 0; i < count; i++) {
    specs.push(drawSpec(r, `c${round}q${i}z`, { explode: true }));
  }
  const toks = specs.map((s) => s.tok);
  // Every oracle before the first stream opens (see sequentialPhase).
  const wants = specs.map(solo);
  const queue = specs.map((spec, i) => ({ spec, want: wants[i]! }));
  const live: Live[] = [];
  /** Finished, and its caller has not asked for its head yet. */
  const waiting: Live[] = [];
  const maxLive = 2 + r.n(7);

  const keyed = (x: Live) => {
    const head = collectHead(x.req);
    assertEquals(head, x.want.head, `${repro}: keyed head of ${x.spec.tok}`);
    assertOnlyOwn(head, x.spec.tok, toks, `${repro}: head`);
    st.keyed++;
  };
  /** The no-argument ask, from `x`'s caller: its own head, a REFUSAL, or —
   *  the documented price under concurrency, whose every shape the head
   *  oracle test names — another page's head, counted. */
  const unkeyed = (x: Live) => {
    let head: string;
    try {
      head = collectHead();
    } catch (e) {
      if (!(e as Error).message.includes(REFUSAL)) throw e;
      st.refused++;
      return;
    }
    st.unkeyedChecked++;
    if (head !== x.want.head) st.wrongAnswered++;
  };

  while (queue.length || live.length || waiting.length) {
    st.steps++;
    const roll = r.f();
    const canOpen = queue.length > 0 && live.length < maxLive;
    if (canOpen && (live.length === 0 || roll < 0.25)) {
      const { spec, want } = queue.shift()!;
      const req = {};
      const cut = r.f();
      live.push({
        spec,
        want,
        req,
        out: "",
        pulled: 0,
        stopAt: cut < 0.3 ? r.n(40) : -1,
        abandon: cut < 0.03,
        gen: stream(spec, req),
      });
    } else if (live.length && roll < 0.85) {
      const i = r.n(live.length);
      const x = live[i]!;
      if (x.pulled === x.stopAt) {
        live.splice(i, 1);
        if (x.abandon) {
          // Pulled and then dropped for good — never returned, never ended.
          abandoned.push(x.gen);
          st.abandoned++;
        } else {
          // The client went away: the server returns the generator.
          await x.gen.return();
          assertOnlyOwn(x.out, x.spec.tok, toks, `${repro}: aborted body`);
          st.aborted++;
        }
        continue;
      }
      x.pulled++;
      let step: IteratorResult<string, void>;
      try {
        step = await x.gen.next();
      } catch (e) {
        // A render that throws outside every boundary fails ITS request —
        // with its own error, never a neighbour's.
        assert(x.want.error, `${repro}: ${x.spec.tok} threw ${e}`);
        assertEquals(
          (e as Error).message,
          x.want.error,
          `${repro}: ${x.spec.tok} failed with another error`,
        );
        live.splice(i, 1);
        st.threw++;
        // Half the time an error handler asks for what the page had.
        if (r.f() < 0.5) {
          try {
            collectHead();
          } catch (e) {
            if (!(e as Error).message.includes(REFUSAL)) throw e;
          }
        }
        continue;
      }
      if (!step.done) {
        x.out += step.value;
        assert(
          x.want.error !== null || x.want.html.startsWith(x.out),
          `${repro}: ${x.spec.tok} streamed a chunk that is not its own page`,
        );
        continue;
      }
      assert(!x.want.error, `${repro}: ${x.spec.tok} should have thrown`);
      live.splice(i, 1);
      assertEquals(x.out, x.want.html, `${repro}: body of ${x.spec.tok}`);
      assertOnlyOwn(x.out, x.spec.tok, toks, `${repro}: body`);
      st.finished++;
      // Its caller asks at once by key, at once without one, or later.
      const how = r.f();
      if (how < 0.35) keyed(x);
      else if (how < 0.55) unkeyed(x);
      else waiting.push(x);
    } else if (roll < 0.9) {
      // A synchronous render served in the gap — an error page, a fragment —
      // whose caller asks for its head on the next line, as the docs show.
      const spec = drawSpec(r, `s${round}q${st.steps}z`);
      const want = solo(spec);
      assertEquals(
        renderToString(page(spec)),
        want.html,
        `${repro}: sync body`,
      );
      assertEquals(collectHead(), want.head, `${repro}: sync head`);
      st.sync++;
    } else if (waiting.length) {
      const x = waiting.splice(r.n(waiting.length), 1)[0]!;
      if (r.f() < 0.5) keyed(x);
      else unkeyed(x);
    }
    // Between steps no component body is running, whatever is open.
    assertEquals(
      _ssrRenderCurrent(),
      null,
      `${repro}: a render stayed current`,
    );
  }
}

// ── phase 2: one request at a time, the no-argument head ──────────────

async function sequentialPhase(
  r: ReturnType<typeof rng>,
  round: number,
  repro: string,
): Promise<void> {
  const n = 3 + r.n(4);
  const specs: Spec[] = [];
  for (let i = 0; i < n; i++) {
    specs.push(drawSpec(r, `q${round}s${i}z`, { explode: true }));
  }
  // Every oracle BEFORE the first request: an oracle render between two
  // requests is a render of its own, and it would stand between them — the
  // measured way this phase first went green over the very bug it hunts.
  const wants = specs.map(solo);
  /** Whether a page MAY register a head: a failed render's oracle has none,
   *  yet it may have called useHead before it threw — so ask the quiet twin. */
  const mayHead = specs.map((sp) =>
    solo({ ...sp, explode: false }).head !== ""
  );
  // Other requests of the same one-at-a-time app, served BETWEEN the pages —
  // the shapes an independent review checked against 1.0.9. Each is drawn and
  // its oracle taken up front, too.
  const noise = specs.map((_, i) => {
    const spec = drawSpec(r, `q${round}n${i}z`);
    spec.explode = true;
    return { kind: r.n(6), spec, want: solo({ ...spec, explode: false }) };
  });
  /** 1.0.9's neighbour rule, which this phase may never WIDEN: the last render
   *  to end (aborted ones included) was a stream that may have a head and that
   *  nobody asked about. Then, and only then, the next head-bearing stream is
   *  one whose no-argument ask MAY be refused — its caller could be either.
   *  (Exactly, against a model of 1.0.9: air-ssr-head-oracle.test.ts.)
   *  Every other refusal in
   *  this phase fails the round. "May have a head" over-approximates with the
   *  full spec's head, so this allowance is never narrower than 1.0.9's. */
  // Unknown after the concurrent phase — whatever it ended with stands first.
  let neighbour = true;
  const refusal = (e: unknown) => (e as Error).message.includes(REFUSAL);
  const serveNoise = async (nz: (typeof noise)[number]) => {
    const quietSpec = { ...nz.spec, explode: false };
    const headed = nz.want.head !== "";
    switch (nz.kind) {
      case 0: // a fragment endpoint that uses useHead and never asks
        for await (const _ of stream(quietSpec)) { /**/ }
        neighbour = headed;
        return;
      case 1: // a headless fragment nobody asks about
        for await (const _ of renderToStream(h("p", null, "frag"))) { /**/ }
        neighbour = false;
        return;
      case 2: { // a page whose layout collects the head MID-render
        let mid = "";
        const Probe = () => {
          mid = collectHead();
          return null;
        };
        const tree = h("div", null, page(quietSpec), h(Probe, null));
        for await (const _ of renderToStream(tree as VNode)) { /**/ }
        assertEquals(mid, nz.want.head, `${repro}: mid-render head`);
        neighbour = false;
        return;
      }
      case 3: { // a page that throws, and an error handler that asks
        const may = neighbour && headed;
        try {
          for await (const _ of stream(nz.spec)) { /**/ }
        } catch { /* the handler */ }
        try {
          collectHead();
        } catch (e) {
          if (!(may && refusal(e))) throw e;
        }
        neighbour = false;
        return;
      }
      case 4: // a renderToString page whose handler asks twice
        assertEquals(renderToString(page(quietSpec)), nz.want.html, repro);
        assertEquals(collectHead(), nz.want.head, `${repro}: string head`);
        assertEquals(collectHead(), nz.want.head, `${repro}: asked again`);
        neighbour = false;
        return;
      default: // nothing in between
        return;
    }
  };
  /** The next request, when it already STARTED before this one's caller
   *  asked for its head — the window 1.0.8 closed (start order vs end order). */
  let early:
    | { gen: AsyncGenerator<string, void, unknown>; out: string }
    | null = null;
  for (let i = 0; i < n; i++) {
    const spec = specs[i]!;
    const want = wants[i]!;
    const headed = mayHead[i]!;
    if (!early) {
      try {
        await serveNoise(noise[i]!);
      } catch (e) {
        throw new Error(
          `${repro}: a sequential request between the pages (shape ${
            noise[i]!.kind
          }) failed — ` +
            (e as Error).message,
        );
      }
    }
    const gen = early?.gen ?? stream(spec);
    let out = early?.out ?? "";
    let pulled = early ? 1 : 0;
    early = null;
    const abortAfter = r.f() < 0.35 ? r.n(6) : -1;
    let threw = false;
    try {
      for (;;) {
        if (pulled === abortAfter) {
          await gen.return();
          break;
        }
        const s = await gen.next();
        if (s.done) break;
        out += s.value;
        pulled++;
      }
    } catch (e) {
      threw = true;
      assertEquals(
        (e as Error).message,
        want.error,
        `${repro}: ${spec.tok} failed with another error`,
      );
    }
    // Decided when this render ended: whether 1.0.9 would refuse its ask.
    let may = neighbour && headed;
    // A failed page nobody asks about, or a closed tab: it ended unasked —
    // unless the tab closed before the first read, when it never started.
    if (threw || pulled === abortAfter) {
      if (pulled > 0 || threw) neighbour = headed;
      continue;
    }
    assertEquals(out, want.html, `${repro}: sequential body ${spec.tok}`);
    // The next request arrives between this body's last chunk and this
    // caller's head: a render that STARTED after mine ended is not mine.
    /** Set when the next request ENDED before this caller asked — a render
     *  finished in between, so the answer may be its head or a refusal. */
    let endedBetween = false;
    /** Set when the next request's client left before this caller asked: a
     *  closed tab ended last, with nothing set up since — 1.0.9's answer. */
    let closedAfter = false;
    if (i + 1 < n && r.f() < 0.4) {
      const g = stream(specs[i + 1]!);
      const nextHeaded = mayHead[i + 1]!;
      try {
        const first = await g.next();
        if (r.f() < 0.3) {
          // …and its client leaves at once: an aborted neighbour after mine.
          await g.return();
          may ||= nextHeaded;
          closedAfter = true;
          i++;
        } else early = { gen: g, out: first.done ? "" : first.value };
      } catch (e) {
        // It failed on its first chunk: that request is over.
        assertEquals(
          (e as Error).message,
          wants[i + 1]!.error,
          `${repro}: early start failed with another error`,
        );
        endedBetween = true;
        may ||= nextHeaded;
        i++;
      }
    }
    let head: string;
    try {
      head = collectHead();
    } catch (e) {
      if (may && refusal(e)) {
        neighbour = false; // a refusal marks the one it could not tell asked
        continue;
      }
      throw new Error(
        `${repro}: the no-argument collectHead() of a request that overlapped ` +
          `nothing was REFUSED where 1.0.9 answered ` +
          `(${(e as Error).message.slice(0, 60)}…)`,
      );
    }
    // Answered: whichever render the answer was for counts as asked — this
    // page, the one that failed in between, or the closed tab.
    neighbour = false;
    // A request that FAILED between this body and this ask is a render that
    // ended in between, and a failed render's head is the documented limit
    // (see the concurrent phase). A closed tab after mine, with nothing set
    // up since it: 1.0.9's answer (the tab's own head — its code may be the
    // one asking), pinned against a model of 1.0.9 by the head oracle.
    if (endedBetween || closedAfter) continue;
    assertEquals(head, want.head, `${repro}: sequential head ${spec.tok}`);
  }
}

// ── phase 3: hydrate what was streamed, re-render, unmount ────────────

async function hydratePhase(
  r: ReturnType<typeof rng>,
  round: number,
  doc: Document,
  console_: { lines: string[] },
  repro: string,
): Promise<void> {
  const spec = drawSpec(r, `h${round}z`, { client: true });
  let html = "";
  const req = {};
  for await (const c of stream(spec, req)) html += c;
  // A page's caller asks for its head — one that never does is a render
  // still WAITING, and the next no-argument ask would rightly be refused.
  collectHead(req);
  assertEquals(hookLog, [], `${repro}: a server render ran a lifecycle hook`);

  const host = doc.createElement("div");
  doc.body.appendChild(host);
  host.innerHTML = html;
  const adopted = host.firstElementChild;
  phase.set(0);
  const handle = hydrate(host, () => page(spec));
  // Only what the client half said — the server phases assert their own.
  const mark = console_.lines.length;
  try {
    // The server's ids are the client's: the markup was adopted, not rebuilt.
    assert(
      host.firstElementChild === adopted,
      `${repro}: hydration discarded the streamed markup of ${spec.tok}`,
    );
    phase.set(1);
    await new Promise((res) => setTimeout(res, 0));
    _unmount(handle);
    await new Promise((res) => setTimeout(res, 0));
  } finally {
    host.remove();
  }
  const errors = console_.lines.splice(mark);
  const released = hookLog.filter((l) => l.startsWith("release")).length;
  if (spec.conditional) {
    // A conditional onUnmount must either hold AND release, or be NAMED — a
    // hold that silently never releases is the one outcome not allowed.
    const named = errors.filter((e) => e.includes("onUnmount() landed on"))
      .length;
    assert(
      released + named >= spec.rows,
      `${repro}: ${spec.rows - released - named} conditional onUnmount ` +
        `hold(s) leaked in silence (released ${released}, named ${named})`,
    );
  } else {
    assertEquals(errors, [], `${repro}: hydrate/unmount was not silent`);
    assertEquals(
      released,
      spec.rows,
      `${repro}: every row's hold releases exactly once at unmount`,
    );
  }
  hookLog.length = 0;
}

Deno.test("SSR soak: overlapping, aborted and abandoned renders stay per-request", async () => {
  // Tests are the strictest environment: every dev tripwire is live.
  setDevMode(true);
  _resetHead();
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const abandoned: AsyncGenerator<string, void, unknown>[] = [];
  const cap = captureConsole();
  const st: Stats = {
    steps: 0,
    finished: 0,
    aborted: 0,
    abandoned: 0,
    threw: 0,
    sync: 0,
    keyed: 0,
    unkeyedChecked: 0,
    refused: 0,
    wrongAnswered: 0,
  };
  try {
    await loadReady();
    for (let round = 0; round < ROUNDS; round++) {
      const repro = `FUZZ_SEED=${SEED} round ${round}`;
      const r = rng(SEED * 7919 + round);
      // A fresh "said once per call site" each round, so every round that
      // hands out a wrong head must say so itself.
      _resetHead();
      await concurrentPhase(r, round, abandoned, st, repro);
      assertEquals(
        _isSsrRendering(),
        abandoned.length > 0,
        `${repro}: a returned or finished stream left the SSR flag raised`,
      );
      assertEquals(
        cap.lines,
        [],
        `${repro}: the concurrent phase was not silent`,
      );
      await sequentialPhase(r, round, repro);
      assertEquals(hookLog, [], `${repro}: a server render ran a hook`);
      // Nothing in aio warns about the no-argument head: silence, always.
      assertEquals(
        cap.lines,
        [],
        `${repro}: the sequential phase was not silent`,
      );
      await hydratePhase(r, round, doc, cap, repro);
      // Everything this round opened has ended, or is in `abandoned`.
      opened.length = 0;
    }
  } finally {
    // An abandoned generator is still suspended inside its render; closing it
    // runs its `finally`, which must drop the SSR flag for good.
    for (const g of [...abandoned, ...opened]) await g.return();
    opened.length = 0;
    cap.restore();
    setDevMode(false);
    _resetHead();
    phase.set(0);
    await closeWindow(win);
  }
  assertEquals(_isSsrRendering(), false, "every server render ended");
  // A soak that never aborted, never refused or never checked an unkeyed
  // head proved nothing about those paths — say so instead of going green.
  // The wrong-answer path is rare — a few rounds in a thousand — so it is
  // demanded of the long lane only; the fixed cases in
  // air-ssr-concurrent-render-state.test.ts pin it on every run.
  const rare = new Set(["wrongAnswered"]);
  for (const [k, v] of Object.entries(st)) {
    if (ROUNDS >= (rare.has(k) ? 1000 : 20)) {
      assert(v > 0, `FUZZ_SEED=${SEED}: the soak never exercised ${k}`);
    }
  }
});

// ── the real server path ──────────────────────────────────────────────
//
// Everything above drives the generator by hand. A server does not: the
// generator sits behind a `ReadableStream` that `Deno.serve` drains into a
// socket, and a client that goes away reaches the render only as a
// `cancel()` on that stream (the pull shape) or as an `enqueue` that throws
// (the `start` shape `docs/ui/air-advanced.md` shows). If either failed to
// reach the generator, the render would never run its `finally`: the SSR
// flag would stay raised and the render's head would be waiting forever. So
// this counts renders in and renders out, across real disconnects.
//
// The seed fixes WHICH requests abort and after how many chunks; the network
// fixes the interleaving, so this part replays the plan, not the schedule.

/** Serve on a `freePort()`, retrying a port another process took first. */
function serveOnFreePort(
  handler: (req: Request) => Response | Promise<Response>,
): { server: Deno.HttpServer; port: number } {
  for (let attempt = 0;; attempt++) {
    const port = freePort();
    try {
      const server = Deno.serve(
        { port, hostname: "127.0.0.1", onListen: () => {} },
        handler,
      );
      return { server, port };
    } catch (e) {
      if (!(e instanceof Deno.errors.AddrInUse) || attempt >= 4) throw e;
    }
  }
}

Deno.test("SSR soak over HTTP: a client that disconnects mid-body leaves no render behind", async () => {
  setDevMode(true);
  _resetHead();
  await loadReady();
  const cap = captureConsole();
  const r = rng(SEED ^ 0x48545450);
  const specs = new Map<string, { spec: Spec; want: Oracle }>();
  const draw = (tok: string) => {
    const spec = drawSpec(r, tok);
    specs.set(tok, { spec, want: solo(spec) });
    return tok;
  };
  let started = 0;
  let ended = 0;
  /** Renders whose generator was closed before its last chunk — the
   *  disconnect reached the render itself, not just the socket. */
  let cut = 0;
  const cutToks = new Set<string>();
  const serverErrors: string[] = [];
  let startShapeAborts = 0;
  const enc = new TextEncoder();
  /** Simulated I/O between chunks — what gives a client time to leave. */
  const io = () => new Promise<void>((res) => setTimeout(res, 1));
  /** Count a render out when its generator's `finally` has run. */
  async function* counted(
    tok: string,
    gen: AsyncGenerator<string, void, unknown>,
  ): AsyncGenerator<string, void, unknown> {
    started++;
    let whole = false;
    try {
      yield* gen;
      whole = true;
    } finally {
      ended++;
      if (!whole) {
        cut++;
        cutToks.add(tok);
      }
    }
  }

  const { server, port } = serveOnFreePort((req) => {
    const url = new URL(req.url);
    const tok = url.pathname.slice(1);
    const { spec } = specs.get(tok)!;
    const unkeyed = url.searchParams.has("unkeyed");
    const shape = url.searchParams.get("shape");
    const gen = counted(
      tok,
      renderToStream(page(spec), unkeyed ? undefined : req),
    );
    // The AbortSignal shape: the request's own signal fires when the client
    // goes away, and closes the render whatever the socket has buffered.
    if (shape === "signal") {
      req.signal.addEventListener("abort", () => void gen.return(), {
        once: true,
      });
    }
    /** The head, exactly as a handler asks for it — and if asking throws,
     *  the reason, kept for the client side (the socket only says "broken"). */
    const head = () => {
      try {
        return `<!--head:${unkeyed ? collectHead() : collectHead(req)}-->`;
      } catch (e) {
        // The handler of an unkeyed app that meets the refusal answers with
        // a page of its own — the client side checks it was allowed.
        if (unkeyed && (e as Error).message.includes(REFUSAL)) {
          return "<!--head:REFUSED-->";
        }
        serverErrors.push(`${tok}: ${(e as Error).message}`);
        throw e;
      }
    };
    const body = shape === "start"
      // The documented shape: a disconnect makes `enqueue` throw, and the
      // `for await` returns the generator on its way out.
      ? new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            for await (const chunk of gen) {
              c.enqueue(enc.encode(chunk));
              await io();
            }
            c.enqueue(enc.encode(head()));
            c.close();
          } catch (e) {
            if (!(e instanceof TypeError)) throw e;
            startShapeAborts++;
          }
        },
      })
      // The pull shape: one chunk per read, a disconnect is `cancel()`.
      : new ReadableStream<Uint8Array>({
        async pull(c) {
          await io();
          const s = await gen.next();
          // A page that rendered to its end is asked for its head, even when
          // its client left meanwhile — a finished render nobody asks about
          // stands next to the next one, as in 1.0.9. A `done` from a
          // generator the disconnect RETURNED is no page: nothing to ask.
          const tail = s.done && !cutToks.has(tok) ? head() : null;
          if (req.signal.aborted) return;
          if (s.done) {
            c.enqueue(enc.encode(tail!));
            c.close();
          } else c.enqueue(enc.encode(s.value));
        },
        async cancel() {
          await gen.return();
        },
      }, { highWaterMark: 0 });
    return new Response(body, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  /** Fetch one page; leave after `stopAt` body reads (-1: read it all). */
  const get = async (
    tok: string,
    qs: string,
    stopAt: number,
    byAbort: boolean,
  ): Promise<string | null> => {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/${tok}?${qs}`, {
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    try {
      for (let reads = 0;; reads++) {
        if (reads === stopAt) {
          if (byAbort) ac.abort();
          else await reader.cancel();
          return null;
        }
        const { done, value } = await reader.read();
        if (done) return text + dec.decode();
        text += dec.decode(value, { stream: true });
      }
    } catch (e) {
      if (byAbort && (e as Error).name === "AbortError") return null;
      // A throw on the server surfaces here only as a broken body.
      throw new Error(
        `FUZZ_SEED=${SEED}: the server broke the response for ${tok} ` +
          `mid-body (${(e as Error).message}); server side: ${
            serverErrors.join(" / ") || "no handler error recorded"
          }`,
      );
    } finally {
      reader.releaseLock();
    }
  };
  const settle = async (what: string) => {
    for (let i = 0; i < 1000 && ended < started; i++) await io();
    assertEquals(
      ended,
      started,
      `FUZZ_SEED=${SEED}: ${what}: ${started - ended} server render(s) never ` +
        `ran their finally after the client left`,
    );
    assertEquals(_isSsrRendering(), false, `${what}: the SSR flag stayed up`);
  };
  const expect = (tok: string, got: string | null) => {
    if (got === null) return;
    const { want } = specs.get(tok)!;
    assertEquals(
      got,
      `${want.html}<!--head:${want.head}-->`,
      `FUZZ_SEED=${SEED}: the response for ${tok} is not its own page`,
    );
  };

  let aborted = 0;
  let refusedAfterTab = 0;
  try {
    // Concurrent: keyed heads, both stream shapes, a third of the clients
    // leaving part-way through.
    const plan = Array.from({ length: 48 }, (_, i) => ({
      tok: draw(`w${i}z`),
      shape: ["start", "pull", "signal"][r.n(3)]!,
      stopAt: r.f() < 0.35 ? 1 + r.n(6) : -1,
      byAbort: r.f() < 0.5,
    }));
    assertEquals(plan.length, 48);
    const inFlight = 8;
    for (let i = 0; i < plan.length; i += inFlight) {
      const batch = plan.slice(i, i + inFlight);
      assert(batch.length > 0);
      const got = await Promise.all(
        batch.map((p) => get(p.tok, `shape=${p.shape}`, p.stopAt, p.byAbort)),
      );
      batch.forEach((p, j) => {
        if (got[j] === null) aborted++;
        expect(p.tok, got[j]!);
      });
    }
    await settle("concurrent");

    // One request at a time with the NO-ARGUMENT head: a real disconnect
    // leaves no render behind, never hands the leaver's head to anybody, and
    // is refused next to the page after it exactly where 1.0.9's neighbour
    // rule says (a head-bearing closed tab, then a head-bearing page) —
    // loud, never a wrong head.
    // The signal shape, because a `cancel()` reaches the render only once a
    // write fails — measured, a small page is often already in the socket
    // buffer by then, rendered to the end, and nothing was aborted at all.
    // Every oracle first: an oracle render between two requests would stand
    // between them and hide exactly what this part is looking for.
    const seq = Array.from({ length: 16 }, (_, i) => ({
      tok: draw(`u${i}z`),
      stopAt: r.f() < 0.4 ? 1 + r.n(4) : -1,
      byAbort: r.f() < 0.5,
    }));
    assertEquals(seq.length, 16);
    /** The previous request's client left, and its page may have a head
     *  (`maybe`) or surely registered one (`surely`: the page's own
     *  `useHead`, which runs before its first chunk). */
    let tab = { maybe: false, surely: false };
    for (const { tok, stopAt, byAbort } of seq) {
      const got = await get(tok, "unkeyed&shape=signal", stopAt, byAbort);
      if (got === null) aborted++;
      const { spec, want } = specs.get(tok)!;
      if (got === `${want.html}<!--head:REFUSED-->`) {
        assert(
          tab.maybe && want.head !== "",
          `FUZZ_SEED=${SEED}: ${tok}'s head was refused with no closed tab ` +
            `next to it`,
        );
        refusedAfterTab++;
      } else {
        // …and refused there always: 1.0.9's rule, deterministic.
        assert(
          got === null || !(tab.surely && want.head !== ""),
          `FUZZ_SEED=${SEED}: ${tok} answered next to a closed tab — ` +
            `whose head could that be?`,
        );
        expect(tok, got);
      }
      tab = {
        maybe: got === null && want.head !== "",
        surely: got === null && spec.headed,
      };
      await settle(`sequential ${tok}`);
      // The signal shape reaches the render whatever the socket buffered, so
      // every client that left here really did cut its render short — which
      // is what makes the NEXT request's head a test of the abort.
      if (got === null) {
        assert(cutToks.has(tok), `${tok}: the disconnect never reached it`);
      }
    }
  } finally {
    await server.shutdown();
    cap.restore();
    setDevMode(false);
    _resetHead();
  }
  // Keyed heads, and then one request at a time: nothing here is ambiguous,
  // so aio must have said nothing at all. (Deno's own notices are not ours.)
  assertEquals(
    cap.lines.filter((l) => l.includes("[aio")),
    [],
    "the server path was not silent",
  );
  assertEquals(started, 64, "every planned request reached the server");
  // Floors, not equalities: a `cancel()` or a throwing `enqueue` reaches the
  // render only once the server notices, and a small page may be written to
  // the end before it does (then nothing was cut, and nothing leaked).
  assert(
    aborted > 0,
    "no client ever left mid-body: the abort path is unproven",
  );
  assert(cut > 0, "no disconnect ever reached a render: the abort is unproven");
  assert(
    startShapeAborts > 0,
    "the documented `start` shape never saw a client leave",
  );
});

// A handler that sets the route, CREATES the stream, and awaits something
// before it hands the body over (a session read, a log line) — the common
// shape. The request's route, key and nesting are taken when the stream is
// created: as an `async function*`, `renderToStream` took them at the first
// pull, after the other request's `routePath.set()` — measured, 200 of 200
// overlapping pairs served the other visitor's page, keyed head included.
Deno.test("SSR soak over HTTP: a stream keeps the route of the request that created it", async () => {
  _resetHead();
  const r = rng(SEED ^ 0x524f5554);
  const Who = (p: { name: string }) => {
    useHead({ title: p.name });
    return h("p", null, `${p.name}-private`);
  };
  const names = ["alice", "bob", "carol"];
  const App = () =>
    h(
      "main",
      null,
      ...names.map((n) =>
        h(Route, { path: `/${n}`, element: h(Who, { name: n }) })
      ),
    );
  const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));
  /** Seeded delays, drawn up front: the handler's own awaits. */
  const delays: number[][] = [];
  const serverErrors: string[] = [];
  const said: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  const { server, port } = serveOnFreePort(async (req) => {
    const [before, after] = delays.shift() ?? [0, 0];
    await pause(before!);
    routePath.set(new URL(req.url).pathname);
    const gen = renderToStream(h(App, null) as VNode, req);
    await pause(after!); // the await between creating the body and sending it
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            for await (const chunk of gen) c.enqueue(enc.encode(chunk));
            c.enqueue(enc.encode(`<!--head:${collectHead(req)}-->`));
            c.close();
          } catch (e) {
            serverErrors.push(String(e));
            c.error(e);
          }
        },
      }),
    );
  });
  let pairs = 0;
  try {
    for (let i = 0; i < 40; i++) {
      const batch = names.map((n) => ({ n, d: [r.n(4), r.n(4)] }));
      assertEquals(batch.length, 3);
      for (const b of batch) delays.push(b.d);
      const got = await Promise.all(
        batch.map((b) =>
          fetch(`http://127.0.0.1:${port}/${b.n}`).then((res) => res.text())
        ),
      );
      batch.forEach((b, j) => {
        assertEquals(
          got[j],
          `<main>${
            names.map((n) => n === b.n ? `<p>${n}-private</p>` : "<!---->")
              .join("")
          }</main><!--head:<title>${b.n}</title>-->`,
          `FUZZ_SEED=${SEED}: /${b.n} served another request's page or head`,
        );
      });
      pairs++;
    }
  } finally {
    await server.shutdown();
    console.warn = origWarn;
    routePath.set("/");
    _resetHead();
  }
  assertEquals(serverErrors, []);
  assertEquals(pairs, 40);
  // The normal concurrent case — every handler sets its route, then calls —
  // is never warned about.
  assertEquals(said.filter((l) => l.includes("[aio")), [], "warned");
});

// 1.0.9 read the route at the first pull, and code written against it creates
// the stream and THEN sets the route. With nobody else rendering in between,
// that still works: the values are read again, live, at the first pull.
Deno.test("SSR stream: the route set AFTER renderToStream() but before the first pull still counts (1.0.9), and is said", async () => {
  _resetHead(); // also forgets which call sites were already told
  const Path = () => h("main", null, `path=${useRoute().path}`);
  const said: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    routePath.set("/");
    const body = renderToStream(h(Path, null) as VNode);
    routePath.set("/orders/42");
    let out = "";
    for await (const c of body) out += c;
    assertEquals(out, "<main>path=/orders/42</main>");
    routePath.set("/");
    const rs = ReadableStream.from(renderToStream(h(Path, null) as VNode));
    routePath.set("/b");
    let out2 = "";
    for await (const c of rs) out2 += c;
    assertEquals(out2, "<main>path=/b</main>");
    // Honoured — and said, once per call site: no timing can tell this from
    // another request's write (see the next-but-one test).
    assertEquals(said.length, 2, said.join("\n"));
    for (const l of said) assertStringIncludes(l, "set it BEFORE the call");
  } finally {
    console.warn = orig;
    routePath.set("/");
    _resetHead();
  }
});

// …and ONLY in that turn. A request that sets its route and then awaits
// before its own call (a session read — for a reset page, the path carries a
// token) must never reach a stream already created: 1.0.9-style live reads
// after the call's turn are gone. The change is not silent, though — the same
// first-pull read is how 1.0.9 code that awaited and THEN set the route loses
// it, so it is said once per call site (never the "set it BEFORE" line).
Deno.test("SSR stream: a route set by another request after this call's turn never reaches it", async () => {
  _resetHead();
  const Path = () => h("main", null, `path=${useRoute().path}`);
  const said: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    routePath.set("/a");
    const a = renderToStream(h(Path, null) as VNode, {}); // set + call
    await new Promise((res) => setTimeout(res, 1)); // A's session read
    routePath.set("/reset/SECRET-TOKEN-OF-B"); // B: set, then awaits
    let outA = "";
    for await (const c of a) outA += c;
    assertEquals(outA, "<main>path=/a</main>");
    assertEquals(said.length, 1, said.join("\n"));
    assertStringIncludes(said[0]!, "before the stream was first read");
    assertStringIncludes(said[0]!, "air-ssr-soak.test.ts");
  } finally {
    console.warn = orig;
    routePath.set("/");
    _resetHead();
  }
});

// Two calls in ONE turn: the first keeps its own route (the live one may be
// the second's), and a value that is neither is said, once.
Deno.test("SSR stream: two calls in one turn — each keeps its own route, a stray write is said once", async () => {
  _resetHead(); // also lets the once-per-process warning fire again
  const Path = () => h("main", null, `path=${useRoute().path}`);
  const said: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    routePath.set("/a");
    const a = renderToStream(h(Path, null) as VNode);
    routePath.set("/b");
    const b = renderToStream(h(Path, null) as VNode);
    let outA = "", outB = "";
    for await (const x of a) outA += x;
    for await (const x of b) outB += x;
    assertEquals(outA, "<main>path=/a</main>"); // not B's
    assertEquals(outB, "<main>path=/b</main>");
    assertEquals(said, [], "the normal case was warned");
    routePath.set("/c");
    const c = renderToStream(h(Path, null) as VNode);
    routePath.set("/d");
    const d = renderToStream(h(Path, null) as VNode);
    routePath.set("/stray"); // after both calls, same turn
    let outC = "";
    for await (const x of c) outC += x;
    for await (const _ of d) { /* the latest: 1.0.9's create-then-set */ }
    assertEquals(outC, "<main>path=/c</main>");
    // Said for C (kept its own, the stray is neither's) and for D (re-read
    // live, and the value changed after its call).
    assertEquals(said.length, 2, said.join("\n"));
    assertStringIncludes(said[0]!, "routePath before renderToStream()");
    assertStringIncludes(said[1]!, "set it BEFORE the call");
  } finally {
    console.warn = orig;
    routePath.set("/");
    _resetHead();
  }
});

// The case no timing can separate: two requests resumed by ONE shared promise
// (a config or session cache) run in one turn. A sets its route and calls; B
// sets ITS route and awaits before its own call — correct code both. A's
// re-read then sees B's route. That is 1.0.9's behaviour, kept; what is new
// is that it is said, naming A's call site, instead of silent.
Deno.test("SSR stream: a route that changed before the stream settled is said, naming the call site", async () => {
  _resetHead();
  const Two = () =>
    h(
      "div",
      null,
      h(Route, { path: "/a", element: h("i", null, "PAGE-A") }),
      h(Route, { path: "/b", element: h("i", null, "PAGE-B") }),
    );
  const said: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    let release!: () => void;
    const shared = new Promise<void>((r) => release = r);
    const drainAll = async (g: AsyncGenerator<string>) => {
      let out = "";
      for await (const c of g) out += c;
      return out;
    };
    const a = (async () => {
      await shared;
      routePath.set("/a");
      const body = renderToStream(h(Two, null) as VNode); // before: correct
      await Promise.resolve();
      return drainAll(body);
    })();
    const b = (async () => {
      await shared;
      routePath.set("/b");
      await Promise.resolve();
      return drainAll(renderToStream(h(Two, null) as VNode));
    })();
    release();
    const [outA, outB] = await Promise.all([a, b]);
    // What the broken contract costs: B set its route and awaited before its
    // own call, so A — correct on its own — rendered B's page. That is what
    // 1.0.9 did too; the difference is the line below.
    assertEquals(outA, "<div><!----><i>PAGE-B</i></div>");
    assertEquals(outB, "<div><!----><i>PAGE-B</i></div>");
    assertEquals(said.length, 1, said.join("\n"));
    assertStringIncludes(said[0]!, "set it BEFORE the call");
    assertStringIncludes(said[0]!, "air-ssr-soak.test.ts");
  } finally {
    console.warn = orig;
    routePath.set("/");
    _resetHead();
  }
});

/** Capture `console.warn` for one test body; the lines it said. */
async function warnings(fn: () => Promise<void>): Promise<string[]> {
  const said: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
    routePath.set("/");
    routeSearch.set(new URLSearchParams());
    _resetHead();
  }
  return said;
}
const LATE = "set it BEFORE the call";
const SAME_TURN = "in the same turn as another render's call";
async function drainText(g: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const c of g) out += c;
  return out;
}

// Once per CALL SITE: a handler that sets the route after its call is one
// mistake, however many requests run through it.
Deno.test("SSR stream: the late-route warning is said once per call site, not once per request", async () => {
  _resetHead();
  const Path = () => h("main", null, `path=${useRoute().path}`);
  const lateSet = (path: string) => {
    const body = renderToStream(h(Path, null) as VNode); // ONE call site
    routePath.set(path);
    return drainText(body);
  };
  const said = await warnings(async () => {
    assertEquals(await lateSet("/one"), "<main>path=/one</main>");
    assertEquals(await lateSet("/two"), "<main>path=/two</main>");
    assertEquals(await lateSet("/three"), "<main>path=/three</main>");
  });
  assertEquals(said.filter((l) => l.includes(LATE)).length, 1, said.join("\n"));
});

// The search half of the route counts too: a query set after the call is a
// different route, rendered and said like a path.
Deno.test("SSR stream: a query (routeSearch) set after the call is a route change too", async () => {
  _resetHead();
  const Query = () => h("main", null, `q=${useRoute().search.get("q") ?? ""}`);
  const said = await warnings(async () => {
    routePath.set("/s");
    routeSearch.set(new URLSearchParams("q=1"));
    const body = renderToStream(h(Query, null) as VNode);
    routeSearch.set(new URLSearchParams("q=2")); // path unchanged
    assertEquals(await drainText(body), "<main>q=2</main>");
  });
  assertEquals(said.filter((l) => l.includes(LATE)).length, 1, said.join("\n"));
});

// The same-turn warning is once per CALL SITE (per `_resetHead` in a test),
// like the others: a process-wide slot would be burnt by the first site.
Deno.test("SSR stream: the same-turn warning is said once per call site", async () => {
  _resetHead();
  const Path = () => h("main", null, `path=${useRoute().path}`);
  const strayTwice = async () => {
    routePath.set("/c");
    const c = renderToStream(h(Path, null) as VNode);
    routePath.set("/d");
    const d = renderToStream(h(Path, null) as VNode);
    routePath.set("/stray");
    assertEquals(await drainText(c), "<main>path=/c</main>");
    await drainText(d);
  };
  const said = await warnings(async () => {
    await strayTwice();
    await strayTwice();
  });
  assertEquals(
    said.filter((l) => l.includes(SAME_TURN)).length,
    1,
    said.join("\n"),
  );
});
