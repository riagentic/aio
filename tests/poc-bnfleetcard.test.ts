// PoC: BnFleetCard-equivalent component rendered under AIO renderer.
// Proves the component pattern works without React — same JSX, no memo wrapper.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { computed, signal } from "../src/signal.ts";
import { h } from "../src/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";

// ── Mock types (mirrors bn-types.ts) ─────────────────────────────────

type FleetMember = {
  pair: string;
  status: "running" | "warming_up" | "error" | "stopped";
  snap: { posDir: number } | null;
};
type FleetState = {
  members: FleetMember[];
  stream: { state: "connected" | "reconnecting" | "disconnected" };
  uds: { state: "connected" | "disconnected" };
  equity: { current: number; peak: number };
};

// ── Components (same JSX as production, no memo wrapper) ─────────────

const streamDot = (state: FleetState["stream"]["state"]): string => {
  switch (state) {
    case "connected":
      return "var(--green)";
    case "reconnecting":
      return "var(--yellow)";
    default:
      return "var(--red)";
  }
};

const Stat = (
  { label, value, color }: { label: string; value: string; color: string },
) => (
  h(
    "div",
    { style: { textAlign: "center" } },
    h("div", { style: { fontSize: "18px", fontWeight: 700, color } }, value),
    h("div", {
      style: {
        fontSize: "10px",
        color: "var(--text-dim)",
        textTransform: "uppercase",
      },
    }, label),
  )
);

// BnFleetCard — NO memo wrapper, plain function
function BnFleetCard(
  { state, onNavigate }: { state: FleetState; onNavigate: () => void },
) {
  const { members, stream, uds, equity } = state;
  const running = members.filter((m) => m.status === "running").length;
  const hasPos = members.filter((m) => m.snap && m.snap.posDir !== 0).length;
  const errored = members.filter((m) => m.status === "error").length;
  const pnl = equity.current - equity.peak;

  return h(
    "div",
    {
      onClick: onNavigate,
      style: {
        border: "1px solid var(--border)",
        borderRadius: "6px",
        padding: "12px 16px",
        cursor: "pointer",
        background: "var(--bg-card)",
      },
    },
    h(
      "div",
      {
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "8px",
        },
      },
      h(
        "span",
        { style: { fontWeight: 600, color: "var(--text)" } },
        "Binance Fleet",
      ),
      h(
        "span",
        { style: { fontSize: "11px", color: "var(--text-dim)" } },
        h("span", {
          style: {
            display: "inline-block",
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: streamDot(stream.state),
            marginRight: "4px",
          },
        }),
        `WS ${stream.state}`,
      ),
    ),
    h(
      "div",
      {
        style: {
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "8px",
        },
      },
      h(Stat, {
        label: "Running",
        value: `${running}/${members.length}`,
        color: running > 0 ? "var(--green)" : "var(--text-dim)",
      }),
      h(Stat, {
        label: "Positions",
        value: String(hasPos),
        color: hasPos > 0 ? "var(--blue)" : "var(--text-dim)",
      }),
      h(Stat, {
        label: "Errors",
        value: String(errored),
        color: errored > 0 ? "var(--red)" : "var(--text-dim)",
      }),
    ),
    h(
      "div",
      {
        style: {
          marginTop: "8px",
          display: "flex",
          justifyContent: "space-between",
          fontSize: "11px",
        },
      },
      h(
        "span",
        { style: { color: "var(--text-dim)" } },
        "Equity: ",
        h(
          "span",
          { style: { color: "var(--text)" } },
          `${equity.current.toFixed(1)}%`,
        ),
      ),
      h(
        "span",
        { style: { color: pnl >= 0 ? "var(--green)" : "var(--red)" } },
        `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`,
      ),
      h(
        "span",
        { style: { color: "var(--text-dim)" } },
        "UDS: ",
        h("span", {
          style: {
            color: uds.state === "connected" ? "var(--green)" : "var(--red)",
          },
        }, uds.state),
      ),
    ),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

function setup() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _setDocument(doc);
  return { root, cleanup: () => win.close() };
}

Deno.test({
  name: "PoC: BnFleetCard renders under AIO renderer",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { root, cleanup } = setup();
    const fleetState = signal<FleetState>({
      members: [
        { pair: "BTCUSDT", status: "running", snap: { posDir: 1 } },
        { pair: "ETHUSDT", status: "running", snap: { posDir: 0 } },
        { pair: "SOLUSDT", status: "error", snap: null },
      ],
      stream: { state: "connected" },
      uds: { state: "connected" },
      equity: { current: 98.5, peak: 100 },
    });

    let navigated = false;
    const App = () =>
      h(BnFleetCard, {
        state: fleetState.value,
        onNavigate: () => {
          navigated = true;
        },
      });
    const handle = mount(root, App);

    // Verify structure
    assertEquals(root.querySelector("span")?.textContent, "Binance Fleet");
    assertEquals(root.innerHTML.includes("2/3"), true); // 2 running / 3 total
    assertEquals(root.innerHTML.includes("98.5%"), true); // equity
    assertEquals(root.innerHTML.includes("-1.50%"), true); // pnl

    // Signal reactivity: update fleet state
    fleetState.set({
      ...fleetState.peek(),
      equity: { current: 101.2, peak: 100 },
      members: [
        { pair: "BTCUSDT", status: "running", snap: { posDir: 1 } },
        { pair: "ETHUSDT", status: "running", snap: { posDir: -1 } },
        { pair: "SOLUSDT", status: "running", snap: null },
      ],
    });
    handle._flush();

    assertEquals(root.innerHTML.includes("3/3"), true); // all running now
    assertEquals(root.innerHTML.includes("101.2%"), true); // updated equity
    assertEquals(root.innerHTML.includes("+1.20%"), true); // positive pnl

    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "PoC: BnFleetCard click handler works",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { root, cleanup } = setup();
    let navigated = false;
    const state: FleetState = {
      members: [],
      stream: { state: "disconnected" },
      uds: { state: "disconnected" },
      equity: { current: 100, peak: 100 },
    };
    const App = () =>
      h(BnFleetCard, {
        state,
        onNavigate: () => {
          navigated = true;
        },
      });
    const handle = mount(root, App);

    (root.firstChild as HTMLElement).click();
    assertEquals(navigated, true);

    _unmount(handle);
    cleanup();
  },
});
