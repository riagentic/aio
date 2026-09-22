// Client-context / sync-method browser-replay differential.
//
// `tests/transport-differential.test.ts` pins in-process vs raw WebSocket for
// method payloads and returns. The remaining named gap (todo.md "Known gap:
// the harness cannot cross a transport boundary"; comment at the bottom of
// that file) is the SAME sync method invoked from a real browser UI vs
// in-process — client-context replay. Parts of the ack path live in
// `e2e-dispatch-ack.test.ts` / `return-value-transport.test.ts`; this file is
// the differential shape: one scenario both ways, compare, pin JSON losses
// with `wireBecomes`. Uses existing `withE2E` — no second runner.
//
// Skips cleanly when Chromium is absent (`BROWSER === null`) or `AIO_E2E=0`.
//
// Success criterion: for each case, in-process `show(state.got)` / return
// either equals the browser-side result, or matches a pinned `wireBecomes`
// that still diverges from in-process (JSON fact, not an aio defect).
import { assertEquals, assertNotEquals } from "@std/assert";
import { BROWSER, waitFor, withE2E } from "./e2e-harness.ts";

const ignore = BROWSER === null;

/** Same seam-visibilty contract as transport-differential.test.ts `show`. */
function show(v: unknown): string {
  if (v === undefined) return '"<undefined>"';
  if (typeof v === "bigint") return JSON.stringify(`<bigint:${v}>`);
  if (v instanceof Date) return JSON.stringify(`<Date:${v.toISOString()}>`);
  if (v instanceof RegExp) return JSON.stringify(`<RegExp:${v}>`);
  if (v instanceof Map) {
    return JSON.stringify(`<Map:${JSON.stringify([...v])}>`);
  }
  if (v instanceof Set) {
    return JSON.stringify(`<Set:${JSON.stringify([...v])}>`);
  }
  return JSON.stringify(v, (_k, val) => {
    if (val === undefined) return "<undefined>";
    if (typeof val === "number" && Object.is(val, -0)) return "<-0>";
    if (typeof val === "bigint") return `<bigint:${val}>`;
    if (val instanceof Map) return `<Map:${JSON.stringify([...val])}>`;
    if (val instanceof Set) return `<Set:${JSON.stringify([...val])}>`;
    if (typeof val === "number" && !Number.isFinite(val)) {
      return `<${String(val)}>`;
    }
    return val;
  });
}

type Case = {
  name: string;
  /** Button `t=` name in the App. */
  btn: string;
  /** In-process payload (must match the literal the App button sends). */
  payload: unknown;
  /** What the browser→server JSON hop makes of the payload in cell state. */
  wireBecomes?: string;
};

const WHEN = new Date("2026-09-15T10:00:00.000Z");

const CASES: Case[] = [
  {
    name: "primitives",
    btn: "primitives",
    payload: { n: 1, s: "x", b: true, nil: null },
  },
  {
    name: "nested arrays",
    btn: "nested",
    payload: { rows: [[1, 2], [3, [4, 5]]] },
  },
  // Key vanishes over JSON — `"gone" in state` is true in-process, false from
  // a browser dispatch. Same pin as transport-differential's wire path.
  {
    name: "undefined member",
    btn: "undef",
    payload: { a: 1, gone: undefined },
    wireBecomes: '{"a":1}',
  },
  {
    name: "NaN and Infinity",
    btn: "nan",
    payload: { n: NaN, i: Infinity, ni: -Infinity },
    wireBecomes: '{"n":null,"i":null,"ni":null}',
  },
];

const CELLS = `import { cell } from "aio";
export const probe = cell("probe", {
  state: { got: null, tag: "" },
  methods: {
    // SYNC: store the arg and echo it — state pins the inbound hop; the await
    // return pins the outbound ack path for the same call.
    take(s, v, tag) { s.got = v; s.tag = tag; return v; },
    clear(s) { s.got = null; s.tag = ""; },
  },
});`;

// Each button is one Case. Payload literals MUST stay in lockstep with CASES.
const APP = `import { useLocal } from "aio/air";
import { probe } from "./cells.ts";
export default function App() {
  const { local: out, set } = useLocal("idle");
  const run = async (tag, payload) => {
    const r = await probe.take(payload, tag);
    // Browser already saw JSON on the ack; stringify is the wire return shape.
    // undefined top-level would vanish — name it so the DOM always changes.
    set(() => JSON.stringify(r === undefined ? "<undefined>" : r));
  };
  return (
    <div>
      <span t="out">{out}</span>
      <span t="tag">{String(probe.tag)}</span>
      <button t="primitives" onClick={() => run("primitives", { n: 1, s: "x", b: true, nil: null })}>p</button>
      <button t="nested" onClick={() => run("nested arrays", { rows: [[1, 2], [3, [4, 5]]] })}>n</button>
      <button t="undef" onClick={() => run("undefined member", { a: 1, gone: undefined })}>u</button>
      <button t="date" onClick={() => run("date", { when: new Date("2026-09-15T10:00:00.000Z") })}>d</button>
      <button t="nan" onClick={() => run("NaN and Infinity", { n: NaN, i: Infinity, ni: -Infinity })}>z</button>
      <button t="clear" onClick={async () => { await probe.clear(); set(() => "idle"); }}>c</button>
    </div>
  );
}`;

async function inProcess(c: Case): Promise<{ state: string; ret: string }> {
  const { cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");
  _resetAioRuntime();
  // Unique name per call — bootCells reuses the process registry, and a fixed
  // "probe" warns "duplicate cell name" on every Case after the first.
  const a = cell(`xbr-${c.btn}`, {
    state: { got: null as unknown, tag: "" },
    methods: {
      take(s: { got: unknown; tag: string }, v: unknown, tag: string) {
        s.got = v;
        s.tag = tag;
        return v;
      },
    },
  });
  await bootCells([a] as never);
  // Cell proxies always return a Promise — same as returnBothWays in
  // transport-differential.test.ts — so await even for a SYNC method.
  const ret = await (a as unknown as {
    take: (v: unknown, tag: string) => Promise<unknown>;
  }).take(c.payload, c.name);
  await new Promise((r) => setTimeout(r, 20));
  return {
    state: show((a as unknown as { got: unknown }).got),
    ret: show(ret),
  };
}

Deno.test({
  name:
    "browser-replay differential: sync take — state + return match in-process (JSON losses pinned)",
  ignore,
  async fn() {
    // In-process side first — cheap, and fails loud if a Case payload is wrong
    // before we pay for Chromium.
    const direct = new Map<string, { state: string; ret: string }>();
    for (const c of CASES) {
      direct.set(c.name, await inProcess(c));
    }

    await withE2E({ cells: CELLS, app: APP }, async ({ server, tab }) => {
      await waitFor("mount", () => tab.text("out"));

      for (const c of CASES) {
        await tab.trigger("App:clear", "click");
        await waitFor(`cleared before ${c.name}`, async () => {
          return (await tab.text("out")) === "idle" ? true : null;
        }, 15_000);

        await tab.trigger(`App:${c.btn}`, "click");
        await waitFor(`tag ${c.name}`, async () => {
          return (await tab.text("tag")) === c.name ? true : null;
        }, 15_000);
        await waitFor(`return ${c.name}`, async () => {
          const o = await tab.text("out");
          return o && o !== "idle" ? true : null;
        }, 15_000);

        const st = await server.state() as {
          probe?: { got?: unknown; tag?: string };
        };
        assertEquals(
          st.probe?.tag,
          c.name,
          `server tag for ${c.name}`,
        );
        const wireState = show(st.probe?.got);
        const wireRet = await tab.text("out");
        const d = direct.get(c.name)!;

        if (c.wireBecomes !== undefined) {
          assertEquals(
            wireState,
            c.wireBecomes,
            `browser→server state treatment of ${c.name} CHANGED\n` +
              `  in-process: ${d.state}\n  browser   : ${wireState}\n  pinned    : ${c.wireBecomes}`,
          );
          assertNotEquals(
            wireState,
            d.state,
            `${c.name} state no longer diverges — wire carries it now. ` +
              `Drop wireBecomes and assert equality.`,
          );
          // Return travels the other way through the same JSON rules.
          assertEquals(
            wireRet,
            c.wireBecomes,
            `browser ack return for ${c.name} must match the pinned wire shape\n` +
              `  in-process: ${d.ret}\n  browser   : ${wireRet}\n  pinned    : ${c.wireBecomes}`,
          );
        } else {
          assertEquals(
            wireState,
            d.state,
            `sync take state diverged in-process vs browser for ${c.name}\n` +
              `  in-process: ${d.state}\n  browser   : ${wireState}`,
          );
          assertEquals(
            wireRet,
            d.ret,
            `sync take return diverged in-process vs browser for ${c.name}\n` +
              `  in-process: ${d.ret}\n  browser   : ${wireRet}`,
          );
        }
      }
    });
  },
});

Deno.test({
  name:
    "browser-replay differential: Date payload is instance in-process, string from browser",
  ignore,
  async fn() {
    // show() JSON-ifies both sides to the same ISO string and HIDES the seam —
    // same reason transport-differential.test.ts gives Date its own case.
    const { cell } = await import("../mod.ts");
    const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
    const { bootCells } = await import("../src/testing/cell-test.ts");
    _resetAioRuntime();
    const a = cell("xbr-date-direct", {
      state: { got: null as unknown, tag: "" },
      methods: {
        take(s: { got: unknown; tag: string }, v: unknown, tag: string) {
          s.got = v;
          s.tag = tag;
          return v;
        },
      },
    });
    await bootCells([a] as never);
    await (a as unknown as {
      take: (v: unknown, tag: string) => Promise<unknown>;
    }).take({ when: WHEN }, "date");
    const directWhen = (a as unknown as { got: { when: unknown } }).got?.when;
    assertEquals(directWhen instanceof Date, true, "in-process must keep Date");

    await withE2E({ cells: CELLS, app: APP }, async ({ server, tab }) => {
      await waitFor("mount", () => tab.text("out"));
      await tab.trigger("App:date", "click");
      await waitFor("tag date", async () => {
        return (await tab.text("tag")) === "date" ? true : null;
      }, 15_000);
      const st = await server.state() as {
        probe?: { got?: { when?: unknown } };
      };
      const wireWhen = st.probe?.got?.when;
      assertEquals(
        typeof wireWhen,
        "string",
        "browser hop must JSON-encode Date",
      );
      assertEquals(wireWhen, WHEN.toISOString());
      const wireRet = await tab.text("out");
      assertEquals(
        wireRet,
        JSON.stringify({ when: WHEN.toISOString() }),
        "browser ack return must carry the ISO string, not a Date",
      );
    });
  },
});
