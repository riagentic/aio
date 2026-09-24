// The standalone runtime's two state-size messages end the way every other
// size message does (cellSizeFix, state/budgets.ts): the size, ONE "Fix:" line,
// and the chapter (LARGE_STATE_DOC). They used to stop at what went wrong — a
// slow durable save said "keep less of it", and a full localStorage quota was a
// bare DOMException after "THIS CHANGE IS NOT SAVED", with no size and no way
// out.
import { assert, assertStringIncludes } from "@std/assert";
import { _reset, initStandalone } from "../src/standalone-air.ts";
import { LARGE_STATE_DOC } from "../src/state/large-state-doc.ts";

type S = { blob: string };
type A = { type: string };
const reduce = (s: S, a: A) => ({
  state: a.type === "GROW" ? { blob: s.blob + "x".repeat(200_000) } : s,
  effects: [] as never[],
});

function defineGlobal(name: string, value: unknown): () => void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
  return () => {
    if (had) Object.defineProperty(globalThis, name, had);
    else delete (globalThis as Record<string, unknown>)[name];
  };
}

function capture(kind: "warn" | "error"): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const orig = console[kind];
  console[kind] = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => (console[kind] = orig) };
}

function assertFixLine(msg: string, where: string): void {
  assert(/\d+(\.\d)? (KB|MB)/.test(msg), `${where}: no size in: ${msg}`);
  assertStringIncludes(msg, 'Fix: `persist: "none"`', where);
  assertStringIncludes(msg, `see ${LARGE_STATE_DOC}`, where);
}

Deno.test("standalone large state: a slow durable save names its size, the Fix and the chapter", () => {
  const files = new Map<string, string>();
  const undo = defineGlobal("AioNativeStore", {
    get: (k: string) => files.get(k) ?? null,
    set: (k: string, v: string) => {
      const until = Date.now() + 40; // > the 32 ms (two-frame) line
      while (Date.now() < until) { /* an fsync that costs */ }
      files.set(k, v);
      return true;
    },
    describe: () => "/data/aio-store",
  });
  const warns = capture("warn");
  try {
    _reset();
    const app = initStandalone<S, A, never>({ blob: "" }, {
      reduce,
      execute: () => {},
      persistKey: "aio:big",
    });
    app.dispatch({ type: "GROW" });
    const slow = warns.lines.filter((l) => l.includes("durable save took"));
    assert(slow.length === 1, `expected one slow-save warning: ${warns.lines}`);
    assertFixLine(slow[0]!, "slow durable save");
  } finally {
    warns.restore();
    undo();
    _reset();
  }
});

Deno.test("standalone large state: a full localStorage quota names its size, the Fix and the chapter", async () => {
  const undoNative = defineGlobal("AioNativeStore", undefined);
  const undoLs = defineGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new DOMException(
        "Setting the value of 'aio:big' exceeded the quota.",
        "QuotaExceededError",
      );
    },
  });
  const errors = capture("error");
  try {
    _reset();
    const app = initStandalone<S, A, never>({ blob: "" }, {
      reduce,
      execute: () => {},
      persistKey: "aio:big",
      persistDebounceMs: 1,
    });
    app.dispatch({ type: "GROW" });
    await new Promise((r) => setTimeout(r, 30));
    const failed = errors.lines.filter((l) => l.includes("NOT SAVED"));
    assert(failed.length >= 1, `no failed-save error: ${errors.lines}`);
    assertStringIncludes(failed[0]!, "quota", "quota failure");
    assertFixLine(failed[0]!, "quota failure");
  } finally {
    errors.restore();
    undoLs();
    undoNative();
    _reset();
  }
});

Deno.test("standalone large state: a save that failed for another reason does not claim a quota", async () => {
  const undoNative = defineGlobal("AioNativeStore", undefined);
  const undoLs = defineGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
  });
  const errors = capture("error");
  try {
    _reset();
    const app = initStandalone<S, A, never>({ blob: "" }, {
      reduce,
      execute: () => {},
      persistKey: "aio:big",
      persistDebounceMs: 1,
    });
    app.dispatch({ type: "GROW" });
    await new Promise((r) => setTimeout(r, 30));
    const failed = errors.lines.filter((l) => l.includes("NOT SAVED"));
    assert(failed.length >= 1, `no failed-save error: ${errors.lines}`);
    assert(!failed[0]!.includes("quota"), failed[0]);
  } finally {
    errors.restore();
    undoLs();
    undoNative();
    _reset();
  }
});
