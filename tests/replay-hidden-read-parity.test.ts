// field report §3.3 (the dev-stricter half): a `sync`/`localFirst` cell's SYNC
// methods replay on the CLIENT against the ui-filtered draft, and a hidden
// field read there was a silent `undefined` — no throw in dev, no warning in
// prod — while the very same read on `cell.field` / in a selector threw. One
// seam deciding two ways. Now both guards share ONE outcome, in EVERY
// context:
//
//   dev  → throws, naming cell + field + the two fixes
//   prod → throws, the same error (a plausible `undefined` in prod is the
//          "undefined as data" trap the field report hit)
//
// The table is asserted for both paths in the same test so they cannot drift.
import { assert, assertEquals } from "@std/assert";
import { cell as serverCell } from "../src/state/cell-create.ts";
import { cell as browserCell } from "../src/browser/protocol-cell.ts";
import { bindCellReactive } from "../src/state/cell-reactive.ts";
import { getCellSignal } from "../src/state/state-signals.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { _resetSignals } from "../src/state/state-signals.ts";

type Outcome = { threw: string; value: unknown; warns: number };

function reset(): void {
  _resetAioRuntime();
  _resetSignals();
}

function withDev<T>(dev: boolean, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const prev = g.__aioDev;
  g.__aioDev = dev;
  try {
    return fn();
  } finally {
    g.__aioDev = prev;
  }
}

/** Run `read` twice, capturing throw / value / warning count for the cell. */
function observe(name: string, read: () => unknown): Outcome {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  let threw = "";
  let value: unknown = "unread";
  try {
    value = read();
    value = read(); // second read: a throw is a throw every time
  } catch (e) {
    threw = (e as Error).message;
  } finally {
    console.warn = orig;
  }
  return {
    threw,
    value,
    warns: warnings.filter((w) => w.includes(`${name}.secret`)).length,
  };
}

const config = () => ({
  state: { n: 1, secret: "s3cret" },
  visible: { exclude: ["secret"] },
  methods: {
    peek(s: { n: number; secret?: string; seen?: unknown }) {
      s.n++;
      return s.secret; // the hidden read under test
    },
  },
});

/** Client read of `cell.secret` through bindCellReactive (the existing guard). */
function clientRead(dev: boolean): Outcome {
  const name = `parity-read-${dev ? "dev" : "prod"}`;
  // deno-lint-ignore no-explicit-any
  const def = serverCell(name, config() as any);
  bindCellReactive(def);
  getCellSignal(name, def.__aio.state).set({ n: 1, secret: "s3cret" });
  return withDev(
    dev,
    () => observe(name, () => (def as Record<string, unknown>).secret),
  );
}

/** Client-side REPLAY of the sync method on the filtered draft (the new guard). */
function replayRead(dev: boolean): Outcome {
  const name = `parity-replay-${dev ? "dev" : "prod"}`;
  // deno-lint-ignore no-explicit-any
  const def = browserCell(name, config() as any);
  const io = def.__aio as {
    enableSync: (s: true) => void;
    reduce: (
      d: Record<string, unknown>,
      m: { type: string; payload: unknown },
    ) => void;
  };
  io.enableSync(true);
  const draft: Record<string, unknown> = { n: 1 }; // filtered: no `secret`
  let ret: unknown;
  const out = withDev(
    dev,
    () =>
      observe(name, () => {
        // `peek` returns the hidden read; the reducer discards returns, so
        // capture it by wrapping the method the reducer will call.
        io.reduce(draft, { type: `${name}:peek`, payload: { args: [] } });
        return ret;
      }),
  );
  void ret;
  return out;
}

Deno.test("replay guard parity: dev throws naming cell + field on BOTH paths", () => {
  reset();
  try {
    const a = clientRead(true);
    const b = replayRead(true);
    assert(
      a.threw.includes("parity-read-dev.secret"),
      `client read: ${a.threw}`,
    );
    assert(
      b.threw.includes("parity-replay-dev.secret"),
      `replay must fail loud in dev, got ${
        b.threw === "" ? "a silent undefined" : b.threw
      }`,
    );
    assert(
      b.threw.includes("sync methods replay on the client"),
      `replay names ITS context: ${b.threw}`,
    );
    // The fix, by its actionable form — the fact-field NAME the message
    // generates — rather than by a phrase that a rewording can drop.
    assert(b.threw.includes("hasSecret: boolean"), `names the fix: ${b.threw}`);
    assertEquals([a.warns, b.warns], [0, 0], "dev throws, never warns");
  } finally {
    reset();
  }
});

Deno.test("replay guard parity: prod THROWS the same error on BOTH paths (no warn, no undefined)", () => {
  reset();
  try {
    const a = clientRead(false);
    const b = replayRead(false);
    assert(
      a.threw.includes("parity-read-prod.secret"),
      `prod client read must throw, got ${a.threw || "a silent undefined"}`,
    );
    assert(
      b.threw.includes("parity-replay-prod.secret"),
      `prod replay must throw, got ${b.threw || "a silent undefined"}`,
    );
    assertEquals(a.value, "unread", "the read never produced a value");
    assert(a.threw.includes("hasSecret: boolean"), "names the fact-field fix");
    assert(a.threw.includes("server-side/async"), "names the server-side fix");
    assertEquals([a.warns, b.warns], [0, 0], "a throw, never a warning");
  } finally {
    reset();
  }
});

Deno.test("replay guard: writes and visible reads pass through to the draft", () => {
  reset();
  try {
    const name = "parity-replay-writes";
    // deno-lint-ignore no-explicit-any
    const def = browserCell(name, config() as any);
    const io = def.__aio as {
      enableSync: (s: true) => void;
      reduce: (
        d: Record<string, unknown>,
        m: { type: string; payload: unknown },
      ) => void;
    };
    io.enableSync(true);
    const draft: Record<string, unknown> = { n: 1 };
    withDev(false, () => {
      // `peek` writes `s.n++` BEFORE its hidden read throws — the write must
      // have landed on the real draft, not on a copy the guard made.
      try {
        io.reduce(draft, { type: `${name}:peek`, payload: { args: [] } });
      } catch {
        // the hidden read — asserted in the parity tests above
      }
    });
    assertEquals(
      draft.n,
      2,
      "s.n++ landed on the real draft through the guard",
    );
  } finally {
    reset();
  }
});
