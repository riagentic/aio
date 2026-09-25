// A `*.server.ts` change does not hot-reload, and the reload event must say so.
//
// A cell method reaches one with `await import()`, and Deno's module registry
// hands back the copy it already has. The browser reloads, the page looks new,
// and the server is still running the old function.
//
// A report lost real time to exactly this (report 4 §6): a fix to a
// `.server.ts` module "did not take", so the author verified state twice,
// concluded the fix was wrong, and went back to re-reading correct code.
// Nothing was wrong with the code, and nothing said so — which is the defect.
// The reload is the moment the question is being asked, so it is where the
// answer belongs.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  createFileWatcher,
  DEBOUNCE_MS,
} from "../src/server/server-watcher.ts";

async function captured(
  fn: () => Promise<void>,
): Promise<{ info: string[]; warn: string[] }> {
  const info: string[] = [], warn: string[] = [];
  const o = { log: console.log, info: console.info, warn: console.warn };
  console.log = (...a: unknown[]) => info.push(a.join(" "));
  console.info = (...a: unknown[]) => info.push(a.join(" "));
  console.warn = (...a: unknown[]) => warn.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = o.log;
    console.info = o.info;
    console.warn = o.warn;
  }
  return { info, warn };
}

async function touchAndReload(
  name: string,
  body: string,
): Promise<{ info: string[]; warn: string[] }> {
  const tmp = await tempDir("aio-watch-server-");
  try {
    const file = join(tmp, name);
    await Deno.writeTextFile(file, body);
    let watcher: ReturnType<typeof createFileWatcher> | undefined;
    const out = await captured(async () => {
      watcher = createFileWatcher({
        absBaseDir: tmp,
        importMapObj: {},
        debug: () => {},
        broadcastWs: () => {},
        graphTimeoutMs: 0,
        // deno-lint-ignore no-explicit-any
      } as any);
      watcher!.scheduleReload(file);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 300));
    });
    watcher?.shutdown();
    return out;
  } finally {
    await dropTempDir(tmp);
  }
}

Deno.test({
  name: "a changed *.server.ts says it did NOT reload, and what to do",
  sanitizeOps: false, // aio-ok: esbuild's service child — exit not awaitable
  sanitizeResources: false, // aio-ok: same esbuild child
  fn: async () => {
    const out = await touchAndReload(
      "io.server.ts",
      "export const read = () => 1;\n",
    );
    const line = out.warn.find((l) => l.includes("io.server.ts"));
    assert(line, `nothing named the file. warn=${JSON.stringify(out.warn)}`);
    // The three things the author needed and did not have.
    assert(line.includes("cached"), `WHY it did not take: ${line}`);
    assert(
      line.includes("The browser reloaded; this file did not"),
      `the mismatch, stated: ${line}`,
    );
    assert(line.includes("Restart"), `what to do: ${line}`);
    assert(line.includes("am where"), `how to check any file: ${line}`);
  },
});

Deno.test({
  name: "a .server.tsx counts too — the convention is not .ts-only",
  sanitizeOps: false, // aio-ok: esbuild's service child
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const out = await touchAndReload(
      "panel.server.tsx",
      "export const x = 1;\n",
    );
    assert(
      out.warn.some((l) => l.includes("panel.server.tsx")),
      `a .server.tsx is a server module as much as a .server.ts is: ${
        JSON.stringify(out.warn)
      }`,
    );
  },
});

Deno.test({
  name: "an ORDINARY module says nothing — the warning must stay rare",
  sanitizeOps: false, // aio-ok: esbuild's service child
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const out = await touchAndReload(
      "helpers.ts",
      "export const add = (a: number, b: number) => a + b;\n",
    );
    assertEquals(
      out.warn.filter((l) => l.includes("cached by the module registry")),
      [],
      "a client-reachable module DOES hot-reload; saying otherwise is noise",
    );
  },
});

// The server ENTRY (the file that calls `aio.run()`) holds the routes,
// schedules and auth config and runs in THIS process — it cannot hot-reload
// any more than a cell can. It declares no `cell(`, so the watcher used to
// send a browser reload and print "reloaded src/app.ts" while the server kept
// the old config: a route added in dev answered with the SPA shell.
Deno.test({
  name:
    "an edited server entry restarts the app like a cell file, even mid-edit; a plain module does not",
  sanitizeOps: false, // aio-ok: esbuild's service child — exit not awaitable
  sanitizeResources: false, // aio-ok: same esbuild child
  fn: async () => {
    const tmp = await tempDir("aio-watch-entry-");
    try {
      const entry = join(tmp, "app.ts");
      const helper = join(tmp, "helpers.ts");
      // Mid-edit: the save that matters most does not even parse yet, so no
      // import graph can be walked from it — the entry is known by NAME.
      await Deno.writeTextFile(
        entry,
        'import { aio } from "aio";\nawait aio.run({ routes: { "/x": ( });\n',
      );
      await Deno.writeTextFile(helper, "export const x = 1;\n");
      const restarted: string[] = [];
      let watcher: ReturnType<typeof createFileWatcher> | undefined;
      await captured(async () => {
        watcher = createFileWatcher({
          absBaseDir: tmp,
          importMapObj: {},
          debug: () => {},
          broadcastWs: () => {},
          graphTimeoutMs: 0,
          serverEntry: entry,
          onCellChange: (p: string) => restarted.push(p),
          // deno-lint-ignore no-explicit-any
        } as any);
        watcher!.scheduleReload(helper);
        watcher!.scheduleReload(entry);
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 300));
      });
      watcher?.shutdown();
      assertEquals(restarted, [entry]);
    } finally {
      await dropTempDir(tmp);
    }
  },
});

// …and so is a plain module the SERVER imports. `cell.ts` importing a
// `pricing.ts` helper that a method calls: editing the helper printed
// "reloaded src/pricing.ts" while every server call kept the old function (a
// live app charged the old fee after the save). A module only the UI reaches
// still hot-reloads without a restart.
Deno.test({
  name:
    "an edited module in the server entry's import graph restarts; a UI-only module does not",
  sanitizeOps: false, // aio-ok: esbuild's service child — exit not awaitable
  sanitizeResources: false, // aio-ok: same esbuild child
  fn: async () => {
    const tmp = await tempDir("aio-watch-graph-");
    try {
      const entry = join(tmp, "app.ts");
      const cellFile = join(tmp, "cell.ts");
      const pricing = join(tmp, "pricing.ts");
      const widget = join(tmp, "widget.ts");
      await Deno.writeTextFile(
        entry,
        'import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run();\n',
      );
      await Deno.writeTextFile(
        cellFile,
        'import { fee } from "./pricing.ts";\nexport const f = fee;\n',
      );
      await Deno.writeTextFile(
        pricing,
        "export const fee = (n: number) => n + 1;\n",
      );
      await Deno.writeTextFile(widget, "export const w = 1;\n");
      const restarted: string[] = [];
      let watcher: ReturnType<typeof createFileWatcher> | undefined;
      await captured(async () => {
        watcher = createFileWatcher({
          absBaseDir: tmp,
          importMapObj: { aio: "/__aio/ui.js" },
          debug: () => {},
          broadcastWs: () => {},
          graphTimeoutMs: 0,
          serverEntry: entry,
          onCellChange: (p: string) => restarted.push(p),
          // deno-lint-ignore no-explicit-any
        } as any);
        watcher!.scheduleReload(widget);
        watcher!.scheduleReload(pricing);
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 500));
      });
      watcher?.shutdown();
      assertEquals(restarted.map((p) => p.split("/").pop()), ["pricing.ts"]);
    } finally {
      await dropTempDir(tmp);
    }
  },
});
