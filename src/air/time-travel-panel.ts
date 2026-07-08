// deno-lint-ignore-file
// Browser-side time-travel panel — dev mode only.
// Receives __tt: messages from server, renders a floating DOM panel.
// React/AIR hooks live in time-travel-react.ts and time-travel-air.ts.
import { Listeners } from "../state/listeners.ts";

// ── Types ──────────────────────────────────────────────────────────────
export type TTMeta = {
  entries: {
    id: number;
    type: string;
    ts: number;
    perf?: {
      reduce: number;
      effects: number;
      budget: { reduce: number; effect: number };
    };
  }[];
  index: number;
  paused: boolean;
};

// ── Module-level state ─────────────────────────────────────────────────
let _ttState: TTMeta | null = null;
const _ttListeners = new Listeners<TTMeta>();
let _ttPanel: HTMLElement | null = null;
let _ttPanelVisible = false;
let _ttKeyBound = false;
let _ttKeyHandler: ((e: KeyboardEvent) => void) | null = null;

// ── Send function (injected by browser.ts) ─────────────────────────────
let _sendFn: ((msg: string) => void) | null = null;

/** Provide the WS/IPC send function. browser.ts calls this on connect. */
export function setSendFn(fn: ((msg: string) => void) | null): void {
  _sendFn = fn;
}

export function _sendTTCmd(cmd: string): void {
  if (_sendFn) _sendFn(cmd);
}

/** Get current time-travel state. */
export function getTTState(): TTMeta | null {
  return _ttState;
}

/** Subscribe to TT state changes. Returns unsubscribe function. */
export function subscribeTT(fn: (t: TTMeta) => void): () => void {
  return _ttListeners.add(fn);
}

// ── Panel rendering ────────────────────────────────────────────────────
function _renderTTPanel(): void {
  if (!_ttState) return;

  if (!_ttPanel) {
    _ttPanel = document.createElement("div");
    _ttPanel.id = "__aio-tt";
    _ttPanel.style.cssText =
      "position:fixed;bottom:12px;right:12px;z-index:99999;width:280px;max-height:420px;" +
      "background:rgba(240,240,245,.92);color:#333;border:1px solid rgba(0,0,0,.12);border-radius:10px;" +
      "font:12px/1.5 monospace;box-shadow:0 8px 32px rgba(0,0,0,.15);display:none;flex-direction:column;" +
      "overflow:hidden;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);";
    document.body.appendChild(_ttPanel);
  }

  const tt = _ttState;
  const atStart = tt.index <= 0;
  const atEnd = tt.index >= tt.entries.length - 1;

  _ttPanel.innerHTML = "";

  // Header — draggable
  const hdr = document.createElement("div");
  hdr.style.cssText =
    "padding:8px 10px;background:rgba(0,0,0,.05);border-bottom:1px solid rgba(0,0,0,.08);" +
    "display:flex;align-items:center;justify-content:space-between;cursor:grab;";
  hdr.innerHTML =
    `<span style="color:#666;font-weight:600">⏱ time-travel</span>` +
    `<span style="color:#999;font-size:11px">${
      tt.index + 1
    }/${tt.entries.length}${
      tt.paused ? ' <span style="color:#e25">🔒</span>' : ""
    }</span>`;
  _ttPanel.appendChild(hdr);

  // Drag logic
  let dragX = 0, dragY = 0;
  hdr.onmousedown = (e) => {
    e.preventDefault();
    dragX = e.clientX - _ttPanel!.offsetLeft;
    dragY = e.clientY - _ttPanel!.offsetTop;
    hdr.style.cursor = "grabbing";
    const onMove = (ev: MouseEvent) => {
      _ttPanel!.style.left = (ev.clientX - dragX) + "px";
      _ttPanel!.style.top = (ev.clientY - dragY) + "px";
      _ttPanel!.style.right = "auto";
      _ttPanel!.style.bottom = "auto";
    };
    const onUp = () => {
      hdr.style.cursor = "grab";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Buttons
  const bar = document.createElement("div");
  bar.style.cssText =
    "padding:6px 10px;display:flex;gap:4px;border-bottom:1px solid rgba(0,0,0,.08);";
  const btnStyle =
    "padding:3px 8px;border:1px solid rgba(0,0,0,.12);border-radius:5px;background:rgba(0,0,0,.06);" +
    "color:#444;cursor:pointer;font:11px monospace;";
  const btnDisabled = btnStyle +
    "opacity:0.3;cursor:default;pointer-events:none;";

  const mkBtn = (
    label: string,
    onclick: () => void,
    disabled = false,
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = disabled ? btnDisabled : btnStyle;
    if (!disabled) {
      b.onclick = onclick;
      b.onmouseenter = () => {
        b.style.background = "rgba(0,0,0,.1)";
      };
      b.onmouseleave = () => {
        b.style.background = "rgba(0,0,0,.06)";
      };
    }
    return b;
  };

  bar.appendChild(mkBtn("◀ undo", () => _sendTTCmd("__tt:undo"), atStart));
  bar.appendChild(mkBtn("redo ▶", () => _sendTTCmd("__tt:redo"), atEnd));
  bar.appendChild(
    mkBtn(
      tt.paused ? "🔓 unlock" : "🔒 lock",
      () => _sendTTCmd(tt.paused ? "__tt:resume" : "__tt:pause"),
    ),
  );
  _ttPanel.appendChild(bar);

  // Entry list
  const list = document.createElement("div");
  list.style.cssText = "overflow-y:auto;max-height:300px;padding:4px 0;";
  for (let i = tt.entries.length - 1; i >= 0; i--) {
    const e = tt.entries[i]!;
    const row = document.createElement("div");
    const isCurrent = i === tt.index;
    row.style.cssText =
      "padding:3px 10px;cursor:pointer;display:flex;justify-content:space-between;" +
      (isCurrent
        ? "background:rgba(0,0,0,.08);color:#111;font-weight:600;"
        : "color:#555;");
    row.onmouseenter = () => {
      if (!isCurrent) row.style.background = "rgba(0,0,0,.04)";
    };
    row.onmouseleave = () => {
      if (!isCurrent) row.style.background = "transparent";
    };
    row.onclick = () => _sendTTCmd("__tt:goto:" + e.id);

    const name = document.createElement("span");
    name.textContent = (isCurrent ? "▸ " : "  ") + e.type;
    name.style.cssText =
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;";
    row.appendChild(name);

    // Performance timing (dev mode)
    const right = document.createElement("span");
    right.style.cssText =
      "color:#aaa;flex-shrink:0;margin-left:8px;font-size:10px;display:flex;gap:6px;";

    if (e.perf) {
      const reduceColor = e.perf.reduce > e.perf.budget.reduce
        ? "#e25"
        : "#666";
      const effectColor = e.perf.effects > e.perf.budget.effect
        ? "#e25"
        : "#666";
      right.innerHTML =
        `<span style="color:${reduceColor}">${
          Math.round(e.perf.reduce)
        }ms</span>` +
        `<span style="color:${effectColor}">${
          Math.round(e.perf.effects)
        }ms</span>`;
    } else {
      const d = new Date(e.ts);
      right.textContent = `${String(d.getHours()).padStart(2, "0")}:${
        String(d.getMinutes()).padStart(2, "0")
      }:${String(d.getSeconds()).padStart(2, "0")}`;
    }
    row.appendChild(right);

    list.appendChild(row);
  }
  _ttPanel.appendChild(list);

  // Footer
  const foot = document.createElement("div");
  foot.style.cssText =
    "padding:4px 10px;border-top:1px solid rgba(0,0,0,.08);color:#aaa;font-size:10px;text-align:center;";
  foot.textContent = "Ctrl+. to toggle";
  _ttPanel.appendChild(foot);

  _ttPanel.style.display = _ttPanelVisible ? "flex" : "none";
}

function _bindTTKey(): void {
  if (_ttKeyBound) return;
  _ttKeyBound = true;
  console.debug(
    "%c[aio] ⏱ time-travel active — Ctrl+. to toggle panel",
    "color:#e94560;font-weight:bold",
  );
  _ttKeyHandler = (e: KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "Period") {
      e.preventDefault();
      _ttPanelVisible = !_ttPanelVisible;
      if (_ttPanelVisible) _renderTTPanel();
      if (_ttPanel) _ttPanel.style.display = _ttPanelVisible ? "flex" : "none";
    }
  };
  document.addEventListener("keydown", _ttKeyHandler);
}

// ── Public API ─────────────────────────────────────────────────────────

/** Process a `__tt:` message received from the server (payload = JSON after the prefix). */
export function handleTTMessage(json: string): void {
  try {
    _ttState = JSON.parse(json);
    _bindTTKey();
    _ttListeners.notify(_ttState!);
    if (_ttPanelVisible) _renderTTPanel();
  } catch (err) {
    console.warn("[aio] bad __tt: data:", err);
  }
}

/** Reset all time-travel panel state — called from browser.ts _reset() and teardown. */
export function resetTT(): void {
  _ttState = null;
  _ttListeners.clear();
  _ttPanel?.remove();
  _ttPanel = null;
  _ttPanelVisible = false;
  if (_ttKeyHandler) {
    document.removeEventListener("keydown", _ttKeyHandler);
    _ttKeyHandler = null;
    _ttKeyBound = false;
  }
}
