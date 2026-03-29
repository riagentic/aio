// deno-lint-ignore-file
// React-specific useTimeTravel hook
import { useEffect, useState } from "react";
import {
  _sendTTCmd,
  getTTState,
  subscribeTT,
  type TTMeta,
} from "./time-travel-panel.ts";

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
  const [tt, setTT] = useState<TTMeta | null>(getTTState());
  useEffect(() => {
    const unsub = subscribeTT((t) => setTT({ ...t }));
    const current = getTTState();
    if (current) setTT({ ...current });
    return unsub;
  }, []);
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
