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
