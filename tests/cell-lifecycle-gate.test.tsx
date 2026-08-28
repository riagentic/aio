// Lifecycle-parity gate: every runtime path reachable in-process runs the
// cell LIFECYCLE — onInit at boot, onDestroy at teardown — and dev-strict
// stays armed.
//
// The standalone runtime (Android WebView, and the boot path under
// testUI/testCell/bootCells) used to skip `composed.initAll`/`destroyAll`
// entirely, while the server (aio-cells-bridge) and the worker host
// (cell-worker-host) both ran them. Consequences, by its own source comment:
// onInit/onDestroy never fired on standalone, `setCbApp` stayed unset so the
// circuit breaker could not TRIP in-process — and because the harness boots
// through standalone, every test ran MORE permissively than production (the
// one thing CLAUDE.md forbids outright).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { freePort } from "../src/testing/server-test.ts";

const G = globalThis as Record<string, unknown>;

/** A cell that records its lifecycle events. Unique name per call — cells are
 *  module singletons and this file shares a process with every other test. */
function lifecycleCell(): {
  c: ReturnType<typeof cell>;
  events: string[];
} {
  const events: string[] = [];
  const c = cell(`lc-${crypto.randomUUID().slice(0, 8)}`, {
    state: { n: 0 },
    visible: "all",
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
    onInit() {
      events.push("init");
    },
    onDestroy() {
      events.push("destroy");
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  return { c, events };
}

Deno.test("standalone via bootCells: onInit at boot, onDestroy on dispose, dev-strict armed", async () => {
  const { c, events } = lifecycleCell();
  // deno-lint-ignore no-explicit-any
  const h = await bootCells([c as any]);
  assertEquals(
    events,
    ["init"],
    "bootCells boots through the standalone runtime — onInit must fire there " +
      "exactly like the server's initAll (it used to be skipped entirely)",
  );
  assert(
    G.__aioDev === true,
    "dev-strict must stay armed through the lifecycle wiring",
  );
  h.dispose();
  assertEquals(
    events,
    ["init", "destroy"],
    "dispose() resets the standalone runtime — onDestroy must fire (destroyAll)",
  );
});

Deno.test("standalone via testUI: onInit at mount, onDestroy at dispose, dev-strict armed", async () => {
  const { c, events } = lifecycleCell();
  {
    // deno-lint-ignore no-explicit-any
    await using ui = await testUI(() => <div class="app">ok</div>, {
      // deno-lint-ignore no-explicit-any
      cells: [c as any],
    });
    await ui.settle();
    assertEquals(
      events,
      ["init"],
      "testUI boots its cells on the standalone runtime — onInit must fire",
    );
    assert(G.__aioDev === true, "dev-strict must stay armed under testUI");
  }
  assertEquals(
    events,
    ["init", "destroy"],
    "testUI teardown must run onDestroy (destroyAll on runtime reset)",
  );
});

Deno.test({
  name:
    "server via libraryMode aio.run: onInit at boot, onDestroy on app.close()",
  async fn() {
    const { aio } = await import("../mod.ts");
    const { c, events } = lifecycleCell();
    const app = await aio.run({
      // deno-lint-ignore no-explicit-any
      cells: [c as any],
      appId: `lcsrv-${crypto.randomUUID().slice(0, 8)}`,
      appVersion: "0.0.0",
      client: "server-only",
      persist: false,
      libraryMode: true,
      logging: false,
      singleton: false,
      port: freePort(),
      baseDir: await Deno.makeTempDir(),
      appDir: await Deno.makeTempDir(),
    });
    assertEquals(
      events,
      ["init"],
      "server boot must run onInit (bridge onStart)",
    );
    await app.close();
    assertEquals(
      events,
      ["init", "destroy"],
      "app.close() must run onDestroy (bridge onStop destroyAll)",
    );
  },
});

Deno.test("standalone: the circuit breaker can TRIP in-process", async () => {
  let tripped: string | null = null;
  const name = `cb-${crypto.randomUUID().slice(0, 8)}`;
  const c = cell(name, {
    state: { n: 0 },
    methods: {
      async boom() {
        await Promise.resolve();
        throw new Error("kaboom");
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const standalone = await import("../src/standalone-air.ts");
  standalone._resetState();
  await standalone.aio.run({
    appId: "cbtest",
    // deno-lint-ignore no-explicit-any
    cells: [c as any],
    persist: false,
    circuitBreaker: {
      maxErrors: 2,
      onTrip: (n: string) => {
        tripped = n;
      },
    },
  });
  try {
    for (let i = 0; i < 2; i++) {
      // deno-lint-ignore no-explicit-any
      await (c as any).boom().catch(() => {/* the error is the point */});
    }
    assertEquals(
      tripped,
      name,
      "two async-method errors must trip the breaker in-process — before the " +
        "fix, setCbApp was never wired on standalone (initAll was skipped) so " +
        "the breaker could not trip at all",
    );
  } finally {
    standalone._resetState();
  }
});
