// THE matrix: every kind of state change × every sink that claims to record it.
//
// `tests/write-set-observability.test.ts` closed three cells of it — the
// journal, the timeline and time travel all record the `cell:__setMethod`
// write-set an async or transactional method publishes, because that commit is
// the ONLY record of what such a method wrote (the `cell:method` action fires at
// CALL time, before the body has written anything).
//
// Two sinks were left behind, each carrying its own private copy of the
// "framework noise" list — `src/diagnostics/action-log.ts` and the logger's
// action observer (`src/diagnostics/logger-types.ts`) both dropped every type
// CONTAINING `:__set`. So `logs/actions.jsonl` (documented in
// docs/debugging/troubleshooting.md as "replay the action sequence") and
// `debug.log` ("All actions dispatched — action-by-action replay") both showed
// the call and never the writes. Four copies of one fact; two of them stale.
//
// And the write-set travels under its OWN type, so an exact `redactActions`
// pattern does not match it: recording it without checking its ORIGIN would
// have written a redacted method's secret straight back out as a mutation
// value. Same trap `isRedactedAction` exists to close for the journal.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { createActionLog } from "../src/diagnostics/action-log.ts";
import { AioLogger } from "../src/diagnostics/logger-core.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function mkCell(name: string) {
  return cell(name, {
    state: { n: 1, s: "" },
    methods: {
      bump(s: { n: number }, by: number) {
        s.n += by;
      },
      async grow(s: { n: number; s: string }, by: number) {
        await Promise.resolve();
        s.n += by;
        s.s = "async-wrote";
      },
    },
  });
}

async function boot(dir: string, c: unknown, extra: Record<string, Any> = {}) {
  _resetAioRuntime();
  return await aio.run({
    cells: [c],
    appId: "obsmx",
    dbPath: `${dir}/data.db`,
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
    logging: { level: "debug", dir: `${dir}/logs` },
    ...extra,
  } as Any);
}

Deno.test("action log: an ASYNC method's writes are in actions.jsonl", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-obsmx-al-" });
  try {
    const c = mkCell("omx");
    const app = await boot(dir, c);
    (c as Any).bump(5);
    await (c as Any).grow(10);
    assertEquals(
      (app.getState() as Any).omx,
      { n: 16, s: "async-wrote" },
      "control: what the app really did",
    );
    await app.close();
    _resetAioRuntime();

    const text = await Deno.readTextFile(`${dir}/logs/actions.jsonl`);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    assert(
      lines.some((l) => l.type === "omx:bump"),
      `control: a sync method is recorded:\n${text}`,
    );
    const ws = lines.find((l) => String(l.type).includes(":__set"));
    assert(
      ws,
      `the write-set commit is the only record of what grow() wrote, and ` +
        `actions.jsonl — "replay the action sequence" — has no line for ` +
        `it:\n${text}`,
    );
    assertStringIncludes(
      JSON.stringify(ws.payload),
      "async-wrote",
      "the line has to carry WHAT was written, not just that something was",
    );
    assert(
      !lines.some((l) => String(l.type).endsWith(":__exec")),
      "the __exec marker changes nothing and stays out",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("action log: a redacted method's write-set is redacted too", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-obsmx-rd-" });
  try {
    const v = cell("vault", {
      state: { key: "" },
      methods: {
        async unlockWith(s: { key: string }, passphrase: string) {
          await Promise.resolve();
          s.key = passphrase;
        },
      },
    });
    // EXACT pattern: it matches the call and NOT `vault:__setUnlockWith`.
    const app = await boot(dir, v, { redactActions: ["vault:unlockWith"] });
    await (v as Any).unlockWith("hunter2");
    await app.close();
    _resetAioRuntime();

    const text = await Deno.readTextFile(`${dir}/logs/actions.jsonl`);
    assert(
      !text.includes("hunter2"),
      `redactActions dropped the arguments and then the write-set wrote the ` +
        `same secret back out as a mutation value:\n${text}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("logger: debug.log records the write-set, not just the call", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-obsmx-dl-" });
  try {
    const c = mkCell("omxl");
    const app = await boot(dir, c);
    await (c as Any).grow(7);
    await app.close();
    _resetAioRuntime();

    const text = await Deno.readTextFile(`${dir}/logs/debug.log`);
    assertStringIncludes(
      text,
      "grow",
      "control: the CALL is logged",
    );
    assert(
      /__set/i.test(text),
      `debug.log promises "all actions dispatched — action-by-action ` +
        `replay" and holds no line for what the async method wrote:\n${text}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("logger: a redacted action's arguments never reach debug.log", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-obsmx-lr-" });
  try {
    const v = cell("vlt", {
      state: { key: "" },
      methods: {
        unlockWith(s: { key: string }, passphrase: string) {
          s.key = passphrase;
        },
      },
    });
    const app = await boot(dir, v, { redactActions: ["vlt:*"] });
    (v as Any).unlockWith("hunter2");
    await app.close();
    _resetAioRuntime();

    const text = await Deno.readTextFile(`${dir}/logs/debug.log`);
    assertStringIncludes(text, "unlockWith", "the action still shows up");
    assert(
      !text.includes("hunter2"),
      `redactActions is ONE list for every sink that retains payloads. ` +
        `debug.log kept the passphrase in cleartext:\n${text}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("diagnostics: a redacted cell's VALUES never reach the state-diff log", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-obsmx-sd-" });
  try {
    const v = cell("vsd", {
      state: { key: "" },
      methods: {
        unlockWith(s: { key: string }, passphrase: string) {
          s.key = passphrase;
        },
      },
    });
    const app = await boot(dir, v, { redactActions: ["vsd:*"] });
    (v as Any).unlockWith("hunter2");
    await app.close();
    _resetAioRuntime();

    const text = await Deno.readTextFile(`${dir}/logs/debug.log`);
    assert(
      !text.includes("hunter2"),
      `the timeline redacts diff values for exactly this reason — "an unlock ` +
        `that stores its passphrase leaves the same secret in the diff". The ` +
        `state-diff sink printed it:\n${text}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── Unit level: the two sinks agree with the rest about what noise is ──────

Deno.test("action log: __exec is noise, __set is the payload", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-obsmx-u-" });
  try {
    const path = `${dir}/a.jsonl`;
    const alog = createActionLog(path, 100);
    await alog.append("c:__exec", { _method: "grow" });
    await alog.append("c:__setGrow", {
      mutations: [{ path: ["n"], value: 11 }],
      _origin: "grow",
    });
    await alog.append("c:bump", {});
    const lines = (await Deno.readTextFile(path)).trim().split("\n")
      .map((l) => JSON.parse(l));
    assertEquals(
      lines.map((l) => l.type),
      ["c:__setGrow", "c:bump"],
      "the write-set is the only record of an async method's writes",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("logger observe: __exec is noise, __set is the payload", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-obsmx-lo-" });
  try {
    const l = new AioLogger({ dir, level: "debug", console: false });
    await l.init();
    l.observe({ type: "c:__exec", payload: {} }, { c: {} });
    l.observe({
      type: "c:__setGrow",
      payload: { mutations: [{ path: ["n"], value: 11 }], _origin: "grow" },
    }, { c: {} });
    await l.flush();
    const text = await Deno.readTextFile(`${dir}/debug.log`);
    assert(
      text.includes("__setGrow"),
      `the logger's action observer dropped the write-set:\n${text}`,
    );
    assert(!text.includes("__exec"), `__exec is a pure marker:\n${text}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
