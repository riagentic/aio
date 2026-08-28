// The sync engine is loaded ON DEMAND: `browser-protocol.ts` reaches
// `browser-sync.ts` (and through it src/sync/*) only through a dynamic import
// that runs when a booted cell declares `sync`. An app with no sync cell never
// asks for it. Two halves, both pinned:
//   1. runtime — the loader is not invoked for a plain app, and is invoked
//      exactly once for a sync app (the boot-window buffer race is covered in
//      sync-boot-race.test.ts; this is the "never" half);
//   2. source — nothing in the browser module graph imports the engine
//      statically, which is what would put it back into every page.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { cell } from "aio";
import { _resetCellRegistry } from "../src/state/cell-reactive.ts";
import { _resetSignals } from "../src/state/state-signals.ts";
import {
  _registerSyncTransport,
  _resetEnsured,
  _setClientSend,
  _setSyncLoaderForTest,
  ensureConnected,
} from "../src/browser/browser-protocol.ts";
import * as browserSync from "../src/browser/browser-sync.ts";
import { _resetBrowserSync } from "../src/browser/browser-sync.ts";

function fresh(): void {
  _resetEnsured();
  _resetBrowserSync();
  _resetCellRegistry();
  _resetSignals();
  _setClientSend(() => {});
  _registerSyncTransport(() => {}, () => {});
}

Deno.test("sync lazy: a plain app never loads the engine", async () => {
  fresh();
  new Window({ url: "https://localhost" });
  let loads = 0;
  _setSyncLoaderForTest(() => {
    loads++;
    return Promise.resolve(browserSync);
  });
  try {
    cell("plain-a", {
      state: { n: 0 },
      methods: {
        inc(s) {
          s.n++;
        },
      },
    });
    cell("plain-b", { state: { m: "" }, methods: {} });
    ensureConnected();
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(loads, 0, "no sync cell → the engine import never runs");
  } finally {
    _setSyncLoaderForTest(null);
    fresh();
  }
});

Deno.test("sync lazy: a sync app loads the engine exactly once", async () => {
  fresh();
  new Window({ url: "https://localhost" });
  let loads = 0;
  _setSyncLoaderForTest(() => {
    loads++;
    return Promise.resolve(browserSync);
  });
  try {
    cell("board-l", {
      state: { notes: [] as string[] },
      sync: true,
      methods: {
        add(s: { notes: string[] }, t: string) {
          s.notes.push(t);
        },
      },
    });
    cell("plain-c", { state: { n: 0 }, methods: {} });
    ensureConnected();
    ensureConnected(); // re-entrant: still one load
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(loads, 1, "one sync cell → one engine import");
  } finally {
    _setSyncLoaderForTest(null);
    fresh();
  }
});

Deno.test("sync lazy: no static import of the engine in the browser graph", async () => {
  // A static import anywhere under src/browser (or the entries that bundle
  // it) would inline the engine into every page. Only `sync/types.ts` — the
  // config normaliser, a few lines — may be reached statically.
  const offenders: string[] = [];
  const roots = ["src/browser", "src/air", "src/state", "src/protocol"];
  for (const root of roots) {
    for await (const e of Deno.readDir(root)) {
      if (!e.isFile || !e.name.endsWith(".ts")) continue;
      const path = `${root}/${e.name}`;
      if (path === "src/browser/browser-sync.ts") continue;
      const src = await Deno.readTextFile(path);
      for (const m of src.matchAll(/^import[^;]*from\s+"([^"]+)";/gm)) {
        const spec = m[1]!;
        if (
          (spec.includes("/sync/") || spec.endsWith("browser-sync.ts")) &&
          !spec.endsWith("/sync/types.ts")
        ) {
          offenders.push(`${path} → ${spec}`);
        }
      }
    }
  }
  for (
    const entry of ["src/browser-air.ts", "src/air.ts", "src/state-core.ts"]
  ) {
    const src = await Deno.readTextFile(entry);
    for (
      const m of src.matchAll(/^(?:import|export)[^;]*from\s+"([^"]+)";/gm)
    ) {
      const spec = m[1]!;
      if (spec.includes("/sync/") || spec.endsWith("browser-sync.ts")) {
        offenders.push(`${entry} → ${spec}`);
      }
    }
  }
  assert(
    offenders.length === 0,
    "the sync engine must stay a dynamic import (browser-protocol's " +
      "_syncLoader) — these static imports would ship it to every page:\n  " +
      offenders.join("\n  "),
  );
});
