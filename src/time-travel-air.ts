// deno-lint-ignore-file
// AIR-specific useTimeTravel hook — signal-based
import { signal } from "./signal.ts";
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
    undo: () => _sendTTCmd("__tt:undo"),
    redo: () => _sendTTCmd("__tt:redo"),
    goto: (id: number) => _sendTTCmd("__tt:goto:" + id),
    pause: () => _sendTTCmd("__tt:pause"),
    resume: () => _sendTTCmd("__tt:resume"),
  };
}
