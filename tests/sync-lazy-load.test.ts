// The sync engine BOOTS on demand: `browser-protocol.ts` starts it (through
// `_syncLoader`) only when a booted cell declares `sync`. An app with no sync
// cell never starts it. Two halves, both pinned:
//   1. runtime — the loader is not invoked for a plain app, and is invoked
//      exactly once for a sync app (the boot-window buffer race is covered in
//      sync-boot-race.test.ts; this is the "never" half);
//   2. graph — no module of the browser graph reaches another IN-BUNDLE
//      module through `import()`. The bundle is one file, so a dynamic import
//      kept nothing off the page — esbuild inlined the engine anyway — and it
//      made esbuild wrap every module the target reaches in a lazy-init
//      closure: 1,119 B gzipped on every page, measured, for nothing. The one
//      dynamic import allowed is the dev chunk, which the bundler leaves
//      EXTERNAL (esbuild-plugin.ts), so it really is not on the page.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { codeMask } from "../src/diagnostics/code-mask.ts";
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
  const win = new Window({ url: "https://localhost" });
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
    await closeWindow(win);
    _setSyncLoaderForTest(null);
    fresh();
  }
});

Deno.test("sync lazy: a sync app loads the engine exactly once", async () => {
  fresh();
  const win = new Window({ url: "https://localhost" });
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
    await closeWindow(win);
    _setSyncLoaderForTest(null);
    fresh();
  }
});

Deno.test("sync lazy: the browser graph has no in-bundle dynamic import", async () => {
  // Every runtime `import("./…")` in the folders the page carries: code only
  // (codeMask), and not a type position (`typeof import(…)`, `: import(…).T`).
  const found: string[] = [];
  for (
    const root of [
      "src/browser",
      "src/air",
      "src/state",
      "src/protocol",
      "src/sync",
      "src/diagnostics",
      "src/vitals",
      "src/ui",
    ]
  ) {
    for await (const e of Deno.readDir(root)) {
      if (!e.isFile || !/\.tsx?$/.test(e.name)) continue;
      const path = `${root}/${e.name}`;
      const src = await Deno.readTextFile(path);
      const mask = codeMask(src, e.name.endsWith(".tsx"));
      for (const m of src.matchAll(/\bimport\(\s*["'](\.[^"']+)["']/g)) {
        if (!mask[m.index!]) continue;
        if (/(?:\btypeof|[:|&<])\s*$/.test(src.slice(0, m.index!))) continue;
        found.push(`${path} → ${m[1]}`);
      }
    }
  }
  assertEquals(
    found,
    ["src/browser/browser-air-commands.ts → ./dev-diagnostics.ts"],
    "an import() of a module the bundle inlines makes nothing lazy and costs " +
      "a lazy-init wrapper on every module it reaches — import it statically " +
      "(behind an async hop if the timing matters, like _syncLoader)",
  );
});
