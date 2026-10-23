// Two dev-loop outcomes the watcher got wrong:
//   1. CREATING `style.css` (the documented way to make `ui.theme: "auto"`
//      step aside) was sent as a css swap — which re-fetches the `<link>`s the
//      page already has, and it had none — so nothing changed on screen while
//      the terminal said "restyled". Its existence flipping is a reload.
//   2. A red import graph going green printed nothing: the terminal's last
//      word on a fixed app was the ERROR.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  createFileWatcher,
  DEBOUNCE_MS,
} from "../src/server/server-watcher.ts";
import { stopEsbuild } from "../src/server/server-transpile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE_MS + 400));

async function capturedInfo(fn: () => Promise<void>): Promise<string[]> {
  const info: string[] = [];
  const o = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = (...a: unknown[]) => info.push(a.join(" "));
  console.warn = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, o);
  }
  return info;
}

Deno.test("watcher: style.css appearing or disappearing reloads; editing it restyles", async () => {
  const tmp = await tempDir("aio-watch-css-");
  const css = join(tmp, "style.css");
  const sent: string[] = [];
  const w = createFileWatcher({
    absBaseDir: tmp,
    importMapObj: {},
    debug: () => {},
    broadcastWs: (m) => sent.push(m),
    graphTimeoutMs: 0,
  });
  try {
    await capturedInfo(async () => {
      await Deno.writeTextFile(css, "body{color:red}");
      w.scheduleReload(css);
      await settle();
      await Deno.writeTextFile(css, "body{color:blue}");
      w.scheduleReload(css);
      await settle();
      await Deno.remove(css);
      w.scheduleReload(css);
      await settle();
    });
    assertEquals(
      sent.map((m) => JSON.parse(m).t),
      ["reload", "css", "reload"],
    );
  } finally {
    w.shutdown();
    await dropTempDir(tmp);
  }
});

Deno.test("watcher: a red graph going green says so", async () => {
  const tmp = await tempDir("aio-watch-green-");
  const entry = join(tmp, "App.tsx");
  await Deno.writeTextFile(entry, "export default () => <div>hi</div;\n");
  const sent: string[] = [];
  const w = createFileWatcher({
    absBaseDir: tmp,
    importMapObj: {},
    debug: () => {},
    broadcastWs: (m) => sent.push(m),
  });
  try {
    const info = await capturedInfo(async () => {
      w.scheduleReload(entry);
      await settle();
      await Deno.writeTextFile(entry, "export default () => <div>hi</div>;\n");
      w.scheduleReload(entry);
      await settle();
    });
    assertEquals(
      sent.map((m) => JSON.parse(m).t),
      ["graph-error", "graph-clear"],
    );
    assert(
      info.some((l) => l.includes("fixed") && l.includes("App.tsx")),
      `red → green must print a line. Got: ${JSON.stringify(info)}`,
    );
  } finally {
    w.shutdown();
    await stopEsbuild();
    await dropTempDir(tmp);
  }
});
