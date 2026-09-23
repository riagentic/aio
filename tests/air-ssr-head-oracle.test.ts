// collectHead() against a reference model of its contract.
//
// The no-argument `collectHead()` has to guess whose head is being asked for,
// and three rounds of improving on 1.0.9's guess each produced a new defect —
// the last one handing one visitor's head to another — that only a
// differential fuzzer found. So the rule lives here twice: once in src/air
// (flags) and once below as a plain model over the history of renders, next
// to a model of 1.0.9's rule, the yardstick. A seeded generator plays random
// servers — streams and string renders, keyed and unkeyed asks, asks from a
// component mid-render, pages that throw, clients that leave — one request at
// a time and interleaved, and every answer is checked four ways:
//
//   1. the implementation says exactly what the model says (head or refusal);
//   2. it refuses exactly where 1.0.9 refused — never anywhere new;
//   3. an answer that is NOT the asker's own head is the very answer 1.0.9
//      gave silently, or an EMPTY one where 1.0.9 handed out the head of a
//      closed tab — never another page's head that 1.0.9 did not hand out;
//   4. aio never says a word (no warnings) — in either mode.
//
// Each mode runs twice: fresh (a reset per round) and LONG-RUNNING (one
// process-long history, never reset, like a server) — state that leaks
// across requests can only show in the second.
//
// `FUZZ_SEED` / `FUZZ_ROUNDS` as in tests/fuzz-seed.ts; a failure prints the
// seed, the round and its whole trace, which replays exactly.

import { assert, assertEquals } from "@std/assert";
import { collectHead, h, useHead } from "../src/air.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import { _resetHead } from "../src/air/head.ts";
import type { VNode } from "../src/air/vdom-types.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x0ac1e) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 2000, 1);

function rng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

// ── the model ─────────────────────────────────────────────────────────

/** One render, as the model sees it. */
interface Page {
  id: number;
  kind: "stream" | "string";
  head: boolean;
  aborted: boolean;
  /** Its head was handed out — by key, as an answer, mid-render — or refused
   *  to the one caller who asked. */
  collected: boolean;
  /** The neighbour rule held when it finished (see `finish`). */
  superseded: boolean;
  /** How many renders had been SET UP when this one was (its own included):
   *  a stream at its call, a string render at its start. */
  epoch: number;
}

/** The contract, declaratively: 1.0.9's neighbour rule, unchanged, and one
 *  difference — a closed tab's head is nobody's answer once another render
 *  has been set up since it. */
class Model {
  ended: Page[] = []; // finish order, aborted ones included
  started: Page[] = [];
  /** Page ids, unique over the whole (possibly long-running) history. */
  nextId = 0;
  /** 1.0.9 on the same history. */
  old?: Model109;
  /** Renders set up so far. */
  setUps = 0;
  /** A render is set up — `renderToStream()` called, `renderToString()`
   *  started. */
  setUp(p: Page): void {
    p.epoch = ++this.setUps;
  }
  start(p: Page): void {
    this.started.push(p);
    this.old?.start(p);
  }
  /** A handed-out head (by key, or mid-render) — in both rules. */
  collect(p: Page): void {
    p.collected = true;
    this.old?.collect(p);
  }
  /** A page finishes (or is returned by its consumer: `aborted`). */
  finish(p: Page): void {
    const prev = this.ended.at(-1) ?? null;
    // The neighbour rule: the page that finished just before is a
    // head-bearing stream nobody has asked for, and this page bears a head —
    // one answer, two possible callers.
    p.superseded = prev !== null && prev.kind === "stream" &&
      !prev.collected && prev.head && p.head;
    this.ended.push(p);
    this.old?.finish(p);
  }
  /** What a no-argument ask gets right now: a page, a refusal, or nothing. */
  ask(): { page: Page | null; refused: boolean; withheld?: boolean } {
    const page = this.ended.at(-1) ?? this.started.at(-1) ?? null;
    if (page) page.collected = true;
    if (page && page.kind === "stream" && page.superseded) {
      return { page, refused: true };
    }
    // A closed tab's caller is gone, once another render was set up after it:
    // its head is nobody's — the answer is empty. With nothing set up since,
    // the asker may be the code that stopped reading it: 1.0.9's answer.
    if (page && page.aborted && page.epoch !== this.setUps) {
      return { page: null, refused: false, withheld: true };
    }
    return { page, refused: false };
  }
}

/** 1.0.9's rule, kept alongside as the yardstick: every page counts as a
 *  neighbour (aborted ones too), and the last page to end is the answer. Its
 *  own flags, since the two rules mark pages differently. */
class Model109 {
  #ended: Page[] = [];
  #started: Page[] = [];
  #asked = new Set<Page>();
  #sup = new Set<Page>();
  start(p: Page): void {
    this.#started.push(p);
  }
  finish(p: Page): void {
    const prev = this.#ended.at(-1);
    if (
      prev && prev.kind === "stream" && !this.#asked.has(prev) && prev.head &&
      p.head
    ) this.#sup.add(p);
    this.#ended.push(p);
  }
  collect(p: Page): void {
    this.#asked.add(p);
  }
  ask(): { page: Page | null; refused: boolean } {
    const page = this.#ended.at(-1) ?? this.#started.at(-1) ?? null;
    if (page) this.#asked.add(page);
    return {
      page,
      refused: page !== null && page.kind === "stream" && this.#sup.has(page),
    };
  }
}

// ── the generator ─────────────────────────────────────────────────────

interface Req {
  page: Page;
  key?: object;
  asks: ("k" | "n")[];
  abortAt: number;
  boom: boolean;
  mid: boolean;
  it?: AsyncGenerator<string, void, unknown>;
  pulled: number;
  /** What a component asking mid-render got, not yet checked. */
  midSeen: string[];
  state: "run" | "done" | "threw" | "aborted" | "never";
}

function tree(p: Page, mid: boolean, boom: boolean, midSeen: string[]): VNode {
  // The head is asked for in the page's ROOT, so it exists from the first
  // chunk on — the model needs no knowledge of chunk positions.
  const Root = () => {
    if (p.head) useHead({ title: `T${p.id}` });
    return h(
      "main",
      null,
      h("p", null, "a"),
      mid ? h(Mid, null) : null,
      h("p", null, "b"),
      boom ? h(Boom, null) : null,
      h("p", null, "c"),
    );
  };
  const Mid = () => {
    midSeen.push(collectHead());
    return h("u", null, "m");
  };
  const Boom = () => {
    throw new Error("boom");
  };
  return h(Root, null) as VNode;
}

const bump = (c: Record<string, number>, k: string) => c[k] = (c[k] ?? 0) + 1;

const headOf = (p: Page | null) => p?.head ? `<title>T${p.id}</title>` : "";

async function round(
  rnd: (n: number) => number,
  mode: "seq" | "conc",
  repro: string,
  counts: Record<string, number>,
  /** The long-running history to extend; none: a fresh one (and a reset). */
  shared?: Model,
): Promise<void> {
  if (!shared) _resetHead();
  const model = shared ?? new Model();
  const old = (model.old ??= new Model109());
  const trace: string[] = [];
  const fail = (msg: string): never => {
    throw new Error(`${repro} (${mode}): ${msg}\n  ${trace.join("\n  ")}`);
  };
  const reqs: Req[] = Array.from({ length: 2 + rnd(5) }, () => {
    const id = model.nextId++;
    const kind = rnd(3) === 0 ? "string" : "stream";
    const key = kind === "stream" && rnd(2) ? {} : undefined;
    const asks: ("k" | "n")[] = [];
    for (let a = [0, 1, 1, 1, 2][rnd(5)]!; a > 0; a--) {
      asks.push(key && rnd(2) ? "k" : "n");
    }
    const head = rnd(3) !== 0;
    return {
      page: {
        id,
        kind,
        head,
        aborted: false,
        collected: false,
        superseded: false,
        epoch: 0,
      },
      key,
      asks,
      abortAt: kind === "stream" && rnd(3) === 0 ? rnd(6) : -1,
      boom: rnd(8) === 0,
      mid: rnd(6) === 0,
      pulled: 0,
      midSeen: [],
      state: "run",
    };
  });

  const ask = (r: Req, how: "k" | "n") => {
    let got: string;
    try {
      got = how === "k" ? collectHead(r.key!) : collectHead();
    } catch (e) {
      if (!(e as Error).message.includes("collectHead() cannot tell")) throw e;
      got = "REFUSED";
    }
    trace.push(`ask ${how} by #${r.page.id} -> ${got}`);
    if (how === "k") {
      // A key is exact, always.
      if (got !== headOf(r.page)) fail(`keyed head of #${r.page.id}`);
      model.collect(r.page);
      bump(counts, "keyed");
      return;
    }
    const want = model.ask();
    if (want.withheld) bump(counts, "closed-tab-asked-past");
    else if (want.page?.aborted) bump(counts, "stopped-stream-answered");
    const then = old.ask();
    const wantText = want.refused ? "REFUSED" : headOf(want.page);
    const thenText = then.refused ? "REFUSED" : headOf(then.page);
    if (got !== wantText) {
      fail(`#${r.page.id} got ${got}, the model says ${wantText}`);
    }
    const own = headOf(r.page);
    if (want.refused) {
      // 2. refused exactly where 1.0.9 refused — nowhere new
      if (!then.refused) {
        fail(`#${r.page.id} refused; 1.0.9 answered ${thenText || '""'}`);
      }
      bump(counts, "refused");
      return;
    }
    if (then.refused) fail(`#${r.page.id} answered where 1.0.9 refused`);
    if (got === own) {
      bump(counts, thenText === own ? "own" : "own-where-1.0.9-was-wrong");
      if (thenText !== own) bump(counts, "own");
      return;
    }
    // 3. an answer that is not the asker's head: exactly the answer 1.0.9 gave
    //    silently, or an EMPTY one where 1.0.9 handed out a closed tab's head —
    //    never another page's head that 1.0.9 did not hand out too
    if (got === thenText) {
      bump(counts, "wrong-as-in-1.0.9");
      return;
    }
    if (got === "" && then.page?.aborted) {
      bump(counts, "closed-tab-head-withheld");
      return;
    }
    fail(
      `#${r.page.id} got ${got || '""'}, not its own ${own || '""'} — and ` +
        `1.0.9 said ${thenText || '""'}`,
    );
  };

  /** One step of a request; true when it is over. */
  const step = async (r: Req): Promise<boolean> => {
    const midSeen = r.midSeen;
    if (r.page.kind === "string") {
      model.setUp(r.page);
      model.start(r.page);
      try {
        renderToString(tree(r.page, r.mid, r.boom, midSeen));
        r.state = "done";
      } catch {
        r.state = "threw";
      }
      midCheck(r, midSeen);
      model.finish(r.page);
      return true;
    }
    if (!r.it) {
      r.it = renderToStream(tree(r.page, r.mid, r.boom, midSeen), r.key);
      model.setUp(r.page);
    }
    if (r.pulled === r.abortAt) {
      await r.it.return();
      if (r.pulled === 0) {
        r.state = "never"; // returned before it ever started
      } else {
        r.state = "aborted";
        r.page.aborted = true;
        model.finish(r.page);
      }
      return true;
    }
    if (r.pulled === 0) model.start(r.page);
    r.pulled++;
    try {
      const x = await r.it.next();
      midCheck(r, midSeen);
      if (!x.done) return false;
      r.state = "done";
    } catch {
      r.state = "threw";
    }
    model.finish(r.page);
    return true;
  };
  const midCheck = (r: Req, midSeen: string[]) => {
    for (const m of midSeen.splice(0)) {
      // A component asking mid-render gets its own page, and that caller
      // now has its head.
      if (m !== headOf(r.page)) fail(`mid-render head of #${r.page.id}`);
      model.collect(r.page);
      bump(counts, "mid");
    }
  };

  trace.push(
    reqs.map((r) =>
      `#${r.page.id}:${r.page.kind}${r.page.head ? "+head" : ""}` +
      `${r.key ? "+key" : ""}${r.mid ? "+mid" : ""}${r.boom ? "+boom" : ""}` +
      `${r.abortAt >= 0 ? `+abort@${r.abortAt}` : ""} asks=${r.asks.join("")}`
    ).join(" "),
  );
  if (mode === "seq") {
    for (const r of reqs) {
      while (!(await step(r)));
      trace.push(`end #${r.page.id} ${r.state}`);
      // An aborted stream's own code may ask too: it `break`s out of its
      // loop and then asks (a closed tab never does, but the model cannot
      // tell them apart — neither can aio).
      if (r.state !== "never") {
        for (const a of r.asks) ask(r, a);
      }
    }
    return;
  }
  const live = [...reqs];
  const pending: [Req, "k" | "n"][] = [];
  while (live.length || pending.length) {
    if (live.length && (rnd(3) < 2 || !pending.length)) {
      const r = live[rnd(live.length)]!;
      if (!(await step(r))) continue;
      live.splice(live.indexOf(r), 1);
      trace.push(`end #${r.page.id} ${r.state}`);
      if (r.state === "never") continue;
      // A string render's caller asks on the next line; a stream's, later.
      for (const a of r.asks) {
        if (r.page.kind === "string") ask(r, a);
        else pending.push([r, a]);
      }
    } else {
      const [r, a] = pending.splice(rnd(pending.length), 1)[0]!;
      ask(r, a);
    }
  }
}

for (const mode of ["seq", "conc"] as const) {
  for (const long of [false, true]) {
    const name = `${mode === "seq" ? "one request at a time" : "interleaved"}${
      long ? ", long-running (never reset)" : ""
    }`;
    Deno.test(`collectHead() follows its contract model — ${name}`, async () => {
      const said: string[] = [];
      const orig = console.warn;
      console.warn = (...a: unknown[]) => void said.push(a.join(" "));
      const counts: Record<string, number> = {
        own: 0,
        keyed: 0,
        mid: 0,
        refused: 0,
      };
      try {
        const shared = long ? new Model() : undefined;
        if (long) _resetHead();
        for (let i = 0; i < ROUNDS; i++) {
          const rnd = rng(
            SEED * 31 + i * 4 + (mode === "seq" ? 0 : 1) + (long ? 2 : 0),
          );
          await round(
            rnd,
            mode,
            `FUZZ_SEED=${SEED} round ${i}`,
            counts,
            shared,
          );
        }
      } finally {
        console.warn = orig;
        _resetHead();
      }
      // 4. not a word, in either mode
      assertEquals(said.filter((s) => s.includes("[aio")), [], "aio warned");
      // Not vacuous: every kind of answer actually happened.
      if (ROUNDS >= 100) {
        for (const k of ["own", "keyed", "mid", "refused"]) {
          assert(counts[k]! > 0, `FUZZ_SEED=${SEED}: never exercised ${k}`);
        }
        if (mode === "conc") {
          // The one place the rule differs from 1.0.9's, proven reached (one
          // request at a time asks before any other page can end).
          assert(
            (counts["closed-tab-asked-past"] ?? 0) > 0 &&
              (counts["stopped-stream-answered"] ?? 0) > 0,
            `FUZZ_SEED=${SEED}: no closed tab's head was ever withheld`,
          );
          assert(
            (counts["wrong-as-in-1.0.9"] ?? 0) > 0,
            `FUZZ_SEED=${SEED}: no answer was ever somebody else's — the ` +
              "comparison with 1.0.9 is unproven",
          );
        }
      }
    });
  }
}
