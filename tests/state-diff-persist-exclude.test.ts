// The `state-diff` debug log honours a field-level `persist` declaration.
//
// debug.log is on disk. The state-diff writer withheld the values of a
// `redactActions` cell and of a whole `persist: "none"` cell, but a field the
// app keeps off disk with `persist: { exclude: ["token"] }` ("not written to
// disk", docs/auth/secrets-and-observability.md) was printed in cleartext:
//
//   auth: user ""→"ann", token ""→"TOPSECRET-…"
//
// — while the checkpoint beside it, reading the same view, dropped it. The
// writer now asks that view per changed key.
import { assert, assertEquals, assertExists } from "@std/assert";
import { initDiagnostics } from "../src/diagnostics/mod.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { applyCellFieldFilter } from "../src/state/state-filter.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const TOKEN = "TOPSECRET-session-token";

Deno.test("state-diff: a persist-excluded field's values stay out of debug.log", async () => {
  const dir = await tempDir("aio-state-diff-persist-");
  const lines: string[] = [];
  const sink = {
    logDir: dir,
    pub: (_l: string, cat: string, msg: string) => {
      if (cat === "state-diff") lines.push(msg);
    },
    perf: () => {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink;
  setLogger(sink);
  try {
    const hooks = initDiagnostics(
      {
        dev: {
          stateDiffs: true,
          checkpoint: false,
          actionLog: false,
          crashHandler: false,
          diagnosticBus: false,
        },
      },
      false,
      dir,
    );
    assertExists(hooks);
    // The view boot installs: each cell narrowed by its persist filter.
    hooks!.setCheckpointView?.((s) => {
      const a = s.auth as Record<string, unknown> | undefined;
      if (!a) return s;
      return { ...s, auth: applyCellFieldFilter({ exclude: ["token"] }, a) };
    });
    hooks!.afterAction(
      { auth: { user: "", token: "" } },
      { auth: { user: "ann", token: TOKEN } },
      { type: "auth:login" },
    );
    await hooks!.onStop();
  } finally {
    setLogger(null);
    await dropTempDir(dir);
  }
  assertEquals(lines.length, 1, JSON.stringify(lines));
  assert(!lines[0]!.includes(TOKEN), lines[0]);
  assert(lines[0]!.includes(`user ""→"ann"`), "a kept key stays: " + lines[0]);
  assert(lines[0]!.includes("token"), "the changed key is still named");
});

/** The view boot installs for a `persist: "none"` cell: `restorableSlices`
 *  filters the cell OUT (it is declared and does not persist), so the result
 *  has no own key for it. */
function dropsCell(
  cell: string,
): (s: Record<string, unknown>) => Record<string, unknown> {
  return (s) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) if (k !== cell) out[k] = v;
    return out;
  };
}

Deno.test("state-diff: an excluded field named after a prototype member is redacted, not the native", async () => {
  const dir = await tempDir("aio-state-diff-proto-field-");
  const lines: string[] = [];
  const sink = {
    logDir: dir,
    pub: (_l: string, cat: string, msg: string) => {
      if (cat === "state-diff") lines.push(msg);
    },
    perf: () => {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink;
  setLogger(sink);
  try {
    const hooks = initDiagnostics(
      {
        dev: {
          stateDiffs: true,
          checkpoint: false,
          actionLog: false,
          crashHandler: false,
          diagnosticBus: false,
        },
      },
      false,
      dir,
    );
    assertExists(hooks);
    // A KEPT cell whose persist filter drops the field named `toString`: the
    // view keeps the cell but not that field. `key in slice` was true via
    // Object.prototype, so the ask returned the inherited native function
    // instead of REDACTED and debug.log printed it.
    hooks!.setCheckpointView?.((s) => {
      const cell = s.keeper as Record<string, unknown> | undefined;
      if (!cell) return s;
      const kept: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cell)) {
        if (k !== "toString") kept[k] = v;
      }
      return { ...s, keeper: kept };
    });
    hooks!.afterAction(
      { keeper: { toString: "" } },
      { keeper: { toString: TOKEN } },
      { type: "keeper:set" },
    );
    await hooks!.onStop();
  } finally {
    setLogger(null);
    await dropTempDir(dir);
  }
  assertEquals(lines.length, 1, JSON.stringify(lines));
  assert(lines[0]!.includes("[redacted]"), lines[0]);
  assert(
    !lines[0]!.includes("[native code]"),
    "the inherited native function was printed: " + lines[0],
  );
  assert(!lines[0]!.includes(TOKEN), lines[0]);
});

Deno.test("action-log: a persist:none cell named after a prototype member is redacted", async () => {
  const dir = await tempDir("aio-action-log-proto-");
  try {
    const hooks = initDiagnostics(
      {
        dev: {
          stateDiffs: false,
          checkpoint: false,
          actionLog: true,
          crashHandler: false,
          diagnosticBus: false,
        },
      },
      false,
      dir,
    );
    assertExists(hooks);
    hooks!.setCheckpointView?.(dropsCell("toString"));
    hooks!.afterAction(
      { toString: { secret: "" } },
      { toString: { secret: TOKEN } },
      { type: "toString:setSecret", payload: { secret: TOKEN } },
    );
    await hooks!.onStop();
    const text = await Deno.readTextFile(`${dir}/actions.jsonl`);
    assert(!text.includes(TOKEN), "the secret reached actions.jsonl:\n" + text);
  } finally {
    await dropTempDir(dir);
  }
});
