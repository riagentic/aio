// 50audits §3 + §9: every instrument an operator has said the app was fine
// while nothing reached disk.
//
//   $ curl /__aio/health
//   {"status":"healthy", …, "cells":{"todo":{"status":"active","errors":0,…}}}
//   $ am state todo      {"error":"Internal Server Error"}
//   $ am snapshot        {"error":"500 Internal Server Error"}
//
// `errors: 0` on the very cell whose every write was being refused — there was
// no persistence signal in the health document at all, so an uptime monitor
// stayed green through unbounded data loss. And the two operator doors that
// COULD have diagnosed it answered a bare 500, while the persist log one
// screen away named the field exactly.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

type Health = {
  status: string;
  persist?: { ok: boolean; error?: string };
  cells?: Record<string, unknown>;
};

Deno.test("health + state + snapshot tell the truth about a refused write", async () => {
  const dir = await tempDir("health-durability-");
  const port = freePort();
  _resetAioRuntime();
  const c = cell("hd_todo", {
    state: { items: [] as number[], scratch: null as unknown },
    methods: {
      add(s: { items: number[] }, n: number) {
        s.items.push(n);
      },
      // What a real app produces: a value JSON refuses outright.
      poison(s: { scratch: unknown }) {
        s.scratch = 1n;
      },
    },
  });
  const app = await aio.run({
    cells: [c],
    appId: "health-durability",
    dbPath: join(dir, "state.db"),
    port,
    persistDebounceMs: 999999, // only a forced flush writes
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  });
  const api = c as unknown as {
    add: (n: number) => Promise<void>;
    poison: () => Promise<void>;
  };
  const get = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "X-AIO": "1" },
    });
    return { status: r.status, text: await r.text() };
  };
  const persist = () =>
    fetch(`http://127.0.0.1:${port}/__aio/trojan/persist`, {
      method: "POST",
      headers: { "X-AIO": "1" },
    });
  try {
    // ── healthy, and it says so positively ────────────────────────────
    await api.add(1);
    assertEquals((await persist()).status, 200);
    const well = JSON.parse((await get("/__aio/health")).text) as Health;
    assertEquals(well.status, "healthy");
    assertEquals(well.persist, { ok: true }, JSON.stringify(well.persist));

    // ── one unserializable value, and every door changes its answer ───
    await api.poison();
    await api.add(2);
    assertEquals((await persist()).status, 500, "a refused write is a 500");

    const sick = JSON.parse((await get("/__aio/health")).text) as Health;
    assertEquals(sick.status, "degraded", JSON.stringify(sick));
    assertEquals(sick.persist?.ok, false);
    assertStringIncludes(String(sick.persist?.error), "hd_todo");
    // One line, not the multi-line remediation hint — an alert renders this.
    assert(
      !String(sick.persist?.error).includes("\n"),
      "the health field must be one line",
    );

    // `am state` — the diagnosis, not `Internal Server Error`.
    const state = await get("/__aio/trojan/state");
    assertEquals(state.status, 500);
    assertStringIncludes(state.text, "hd_todo.scratch");
    assertStringIncludes(state.text, "BigInt");

    // `am snapshot` — the same, at the other door.
    const snap = await get("/__aio/snapshot");
    assertEquals(snap.status, 500);
    assertStringIncludes(snap.text, "hd_todo.scratch");

    // `am status` / `am top` / `am cost` read this one.
    const metrics = JSON.parse((await get("/__aio/trojan/metrics")).text) as {
      cells: Record<string, number>;
      unserializable?: string[];
    };
    assertEquals(metrics.cells.hd_todo, -1);
    assertEquals(metrics.unserializable, ["hd_todo"]);

    // ── and it CLEARS: a stuck "degraded" is the same defect inverted ─
    app.loadSnapshot!(
      JSON.stringify({ hd_todo: { items: [1, 2], scratch: null } }),
    );
    assertEquals((await persist()).status, 200);
    const cured = JSON.parse((await get("/__aio/health")).text) as Health;
    assertEquals(cured.status, "healthy", JSON.stringify(cured));
    assertEquals(cured.persist, { ok: true });
  } finally {
    await app.close();
    _resetAioRuntime();
    await dropTempDir(dir);
  }
});
