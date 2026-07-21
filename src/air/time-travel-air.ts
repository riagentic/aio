// deno-lint-ignore-file
// AIR-specific useTimeTravel hook — signal-based
import { signal } from "../state/signal.ts";
import { enc } from "../protocol/envelope.ts";
import {
  _sendTTCmd,
  getTTState,
  subscribeTT,
  type TTMeta,
} from "./time-travel-panel.ts";

const _ttSig = signal<TTMeta | null>(null);
let _ttSubbed = false;

function _ensureTTSub(): void {
  if (_ttSubbed) return;
  _ttSubbed = true;
  subscribeTT((t) => _ttSig.set({ ...t }));
  const current = getTTState();
  if (current) _ttSig.set({ ...current });
}

/**
 * Signal-based hook exposing the time-travel debugger: action history plus
 * undo/redo/goto/pause controls. Returns `null` until time travel is active.
 */
export function useTimeTravel(): {
  entries: { id: number; type: string; ts: number }[];
  index: number;
  paused: boolean;
  undo: () => void;
  redo: () => void;
  goto: (id: number) => void;
  pause: () => void;
  resume: () => void;
} | null {
  _ensureTTSub();
  const tt = _ttSig.value; // auto-tracked by AIR renderer
  if (!tt) return null;
  return {
    entries: tt.entries,
    index: tt.index,
    paused: tt.paused,
    undo: () => _sendTTCmd(enc("tt-cmd", { cmd: "undo" })),
    redo: () => _sendTTCmd(enc("tt-cmd", { cmd: "redo" })),
    goto: (id: number) => _sendTTCmd(enc("tt-cmd", { cmd: "goto:" + id })),
    pause: () => _sendTTCmd(enc("tt-cmd", { cmd: "pause" })),
    resume: () => _sendTTCmd(enc("tt-cmd", { cmd: "resume" })),
  };
}
