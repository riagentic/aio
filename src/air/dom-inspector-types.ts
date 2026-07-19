// dom-inspector-types.ts — shared client/server diagnostic types.
// (The old UINode/InteractCommand DOM-inspection types were removed with the
//  selector/raw-DOM `am` path — the semantic UI surface in ui-surface.ts is now
//  the single facility for both testUI and `am surface`/`am trigger`.)

/** Client log entry forwarded from browser/Electron. */
export interface ClientLogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  ts: number;
  source?: string;
}
