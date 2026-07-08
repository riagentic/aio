// dom-inspector-types.ts — Shared types for DOM inspector and UI interaction.
// Used by both client (dom-inspector.ts) and server (am.ts, server.ts).

/** Semantic representation of a DOM element for UI snapshots. */
export interface UINode {
  tag: string;
  id?: string;
  testId?: string;
  component?: string;
  selector: string;
  role?: string;
  text?: string;
  visible: boolean;
  disabled?: boolean;
  checked?: boolean;
  value?: string;
  href?: string;
  src?: string;
  placeholder?: string;
  classes?: string[];
  aria?: Record<string, string>;
  dataset?: Record<string, string>;
  children?: UINode[];
}

/** Command to interact with a UI element. */
export interface InteractCommand {
  action: "click" | "type" | "select" | "focus" | "blur" | "scroll" | "hover";
  selector: string;
  value?: string;
  options?: {
    clear?: boolean;
    delay?: number;
  };
}

/** Result of a UI interaction. */
export interface InteractResult {
  ok: boolean;
  selector: string;
  action: string;
  element?: string;
  error?: string;
}

/** Client log entry forwarded from browser/Electron. */
export interface ClientLogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  ts: number;
  source?: string;
}
