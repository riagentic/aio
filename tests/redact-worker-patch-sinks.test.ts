// A `worker: true` cell's writes reach the main thread as ONE internal action,
// `__aioWorkerPatch` `{ cell, ops }` — its type names no cell and no method,
// and its ops ARE the values the method stored. The journal and the timeline
// already redact it by the payload's cell (journal.ts `redactsWorkerPatch`);
// `logs/actions.jsonl` and debug.log matched only the type, so with
// `redactActions: ["vault:*"]` the passphrase a worker `unlockWith` stored was
// written to both in cleartext.
import { assert, assertEquals, assertExists } from "@std/assert";
import { initDiagnostics } from "../src/diagnostics/mod.ts";
import { makeRedactor } from "../src/diagnostics/redact.ts";
import { observeAction } from "../src/diagnostics/logger-observe.ts";
import { WORKER_PATCH_ACTION } from "../src/state/cell-compose-reduce.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const SECRET = "worker-held-passphrase-XYZ";
const patch = (cell: string) => ({
  type: WORKER_PATCH_ACTION,
  payload: { cell, ops: [{ op: "replace", path: ["key"], value: SECRET }] },
});

Deno.test("redact: a worker cell's patch batch stays out of actions.jsonl", async () => {
  const dir = await tempDir("aio-redact-worker-actionlog-");
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
      false,
      makeRedactor(["vault:*"]),
    );
    assertExists(hooks);
    hooks!.afterAction(
      { vault: { key: "" } },
      { vault: { key: SECRET } },
      patch("vault"),
    );
    // The control: an unredacted worker cell's batch IS recorded.
    hooks!.afterAction({ notes: { key: "" } }, { notes: { key: "kept" } }, {
      type: WORKER_PATCH_ACTION,
      payload: {
        cell: "notes",
        ops: [{ op: "replace", path: ["key"], value: "kept" }],
      },
    });
    await hooks!.onStop();
    const text = await Deno.readTextFile(`${dir}/actions.jsonl`);
    const lines = text.trim().split("\n");
    assertEquals(lines.length, 2, text);
    assert(!text.includes(SECRET), `the passphrase is on disk:\n${text}`);
    assert(
      text.includes("kept"),
      `an unredacted cell lost its payload:\n${text}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("redact: a worker cell's patch batch stays out of debug.log", () => {
  const out: unknown[] = [];
  const ctx = {
    suppressTypes: [],
    stats: { dispatched: 0, errors: 0 },
    lastStatus: new Map<string, string>(),
    redact: makeRedactor(["vault:*"]),
    emit: (_l: string, _c: string, _m: string, data?: unknown) => {
      out.push(data);
    },
  };
  observeAction(ctx, patch("vault"), {});
  observeAction(ctx, patch("notes"), {});
  assertEquals(out.length, 2);
  assert(!JSON.stringify(out[0]).includes(SECRET), JSON.stringify(out[0]));
  assert(
    JSON.stringify(out[1]).includes(SECRET),
    "control: unredacted cell kept",
  );
});
