// component-profile.ts — which components re-render, how often, and for how
// long.
//
// THE REPORT. One page root ran `tuneAll` three times per render at ~14 ms —
// half of "typing is slow while the model answers". It was found by READING
// CODE and then confirmed over CDP (llama.master §16, wallet report §22.3), which is
// the expensive order: the renderer already counts every re-render and already
// times them, and nothing added those numbers up.
//
// So this is not new instrumentation. `_dtRenders`, `_dtLastMs` and `deps.size`
// are already on every component instance; `_componentTree()` already walks
// them. What was missing is the one function that turns a tree into a ranked
// list, which is the shape of the question people actually ask: what is
// rendering most, and what is each render costing.
//
// TIMINGS ARE OPT-IN, and that is a real constraint rather than a preference.
// `performance.now()` twice per render is not free on a page rendering at 60fps,
// so the renderer only takes them when something is watching — a connected
// Redux DevTools, or this. An app that never profiles pays nothing.

import { _componentTree } from "./devtools-tree.ts";
import type { ComponentTreeNode } from "../diagnostics/devtools.ts";

/** One component, summed over every instance of it on the page. */
export type ComponentProfileRow = {
  /** The component function's name. Instances are summed by NAME, because
   *  "`<Row>` rendered 400 times" is the finding; "this particular Row
   *  rendered 4 times" is the same fact in 100 pieces. */
  readonly name: string;
  /** How many times any instance of it has rendered since profiling started. */
  readonly renders: number;
  /** How many instances of it are mounted. */
  readonly instances: number;
  /** Milliseconds of the most recent render, summed across instances — the
   *  cost of ONE pass over all of them. */
  readonly lastMs: number;
  /** Signals the instances subscribe to, summed. A component with a large
   *  count re-renders for a large number of reasons. */
  readonly signals: number;
};

export type ComponentProfile = {
  /** Whether timings were being collected. `false` means every `lastMs` is 0,
   *  which is a different thing from "every render was instant" — said in the
   *  result rather than left to be inferred. */
  readonly timing: boolean;
  /** Busiest first. */
  readonly rows: readonly ComponentProfileRow[];
  readonly totalRenders: number;
  readonly totalComponents: number;
};

let _profiling = false;

/** Is anything asking for render timings? Read by the renderer, which pays
 *  two `performance.now()` calls per render when it is true. @internal */
export function _profilingOn(): boolean {
  return _profiling;
}

/** Start or stop collecting render timings.
 *
 *  Counts (`renders`, `instances`, `signals`) are always available — they cost
 *  an increment. Only the CLOCK is gated. */
export function setProfiling(on: boolean): void {
  _profiling = on;
}

/** Rank the mounted component tree by how much rendering it is doing.
 *
 *  Pure over the tree it is given, so the ranking is testable without a page. */
export function profileTree(
  nodes: readonly ComponentTreeNode[],
  timing: boolean,
): ComponentProfile {
  const byName = new Map<
    string,
    { renders: number; instances: number; lastMs: number; signals: number }
  >();
  const walk = (list: readonly ComponentTreeNode[]) => {
    for (const n of list) {
      const e = byName.get(n.name) ??
        { renders: 0, instances: 0, lastMs: 0, signals: 0 };
      e.renders += n.renderCount ?? 0;
      e.instances += 1;
      e.lastMs += n.lastRenderMs ?? 0;
      e.signals += n.signalCount ?? 0;
      byName.set(n.name, e);
      walk(n.children ?? []);
    }
  };
  walk(nodes);

  const rows = [...byName].map(([name, e]) => ({ name, ...e }))
    // Renders first — the question is "what is rendering most". Ties break on
    // TIME and then on name, so the list is stable between calls and two runs
    // of the same page can be diffed.
    .sort((a, b) =>
      b.renders - a.renders || b.lastMs - a.lastMs ||
      a.name.localeCompare(b.name)
    );

  return {
    timing,
    rows,
    totalRenders: rows.reduce((n, r) => n + r.renders, 0),
    totalComponents: rows.reduce((n, r) => n + r.instances, 0),
  };
}

/** The live page's profile. */
export function componentProfile(): ComponentProfile {
  return profileTree(_componentTree(), _profiling);
}

/** The profile as lines, for a terminal or a console. */
export function formatProfile(p: ComponentProfile, limit = 15): string[] {
  if (p.rows.length === 0) return ["no components mounted"];
  const width = Math.min(40, Math.max(12, ...p.rows.map((r) => r.name.length)));
  const head = `${p.totalComponents} component(s) mounted, ` +
    `${p.totalRenders} re-render(s)` +
    (p.timing
      ? ""
      : " — timings OFF (call setProfiling(true), or open Redux DevTools)");
  const lines = [head, `  ${"component".padEnd(width)}  renders   ms  signals`];
  for (const r of p.rows.slice(0, limit)) {
    lines.push(
      `  ${r.name.padEnd(width).slice(0, width)}  ` +
        `${String(r.renders).padStart(7)}  ` +
        `${(p.timing ? r.lastMs.toFixed(1) : "-").padStart(5)}  ` +
        `${String(r.signals).padStart(7)}` +
        (r.instances > 1 ? `  (${r.instances} instances)` : ""),
    );
  }
  if (p.rows.length > limit) {
    lines.push(`  …and ${p.rows.length - limit} more`);
  }
  return lines;
}

/** Put `__aioProfile()` on the page so `am eval` can ask for it.
 *
 *  A GLOBAL rather than a new `am` command, deliberately. The report's own
 *  author found their problem over CDP — `am eval` is already the documented
 *  tool for "everything `am surface` cannot see" — so what was missing was the
 *  aggregation, not another round-trip to wire through five files. One
 *  function on the page is the whole difference between reading code for an
 *  afternoon and asking a question.
 *
 *  Calling it turns timings ON, because someone asking for a profile wants the
 *  next renders timed; the FIRST answer therefore has `timing: false` and says
 *  so, rather than reporting zeros as though every render were free. */
export function installProfileGlobal(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.__aioProfile === "function") return;
  g.__aioProfile = () => {
    const p = componentProfile();
    // PRINTED as well as returned. `am eval` gets the object, and the readable
    // table goes to the renderer console — which the forwarder ships to
    // `client.log`, so the profile is in the same place as everything else
    // that happened around it. An explicit call, so this is never noise.
    try {
      for (const line of formatProfile(p)) console.info(line);
    } catch {
      // aio-ok: a formatter that throws must not take the data with it — the
      // object is returned either way, and that is the half `am eval` reads.
    }
    setProfiling(true);
    return p;
  };
}
