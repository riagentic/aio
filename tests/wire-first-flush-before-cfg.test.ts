// The FIRST flush happens before the `cfg` frame.
//
// A call made before the connection opens waits in the offline queue and is
// flushed by the open handler — synchronously, before any frame from the
// server has been read. `wire.omitTrailingUndefined` used to reach a packaged
// Electron window only in the `cfg` frame (its `aio://` shell carried no
// `__aioConfig`), so that first flush encoded `m("x", undefined)` as
// `["x", null]` in the packaged app and `["x"]` in a browser tab of the same
// app: a default parameter that applied in one and not in the other.
//
// The `aio://` shell is templated at LAUNCH, by the process that ran
// `aio.run()`, so it carries the option itself (`ShellConfig.wire`). The
// other build-templated shells (`androidLocalHTML`: a local APK, the web
// target) run the standalone runtime — no server, no wire, nothing to encode.
//
// Driven through the live transport over a fake preload bridge; no `cfg`
// frame is ever delivered here.
import { _teardownNow } from "../src/browser/protocol-subscription.ts";
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { udsProdHTML } from "../src/electron/electron-shared.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { enc } from "../src/protocol/envelope.ts";

type Fn = (line?: string) => void;
type G = { __aioConfig?: Record<string, unknown> };

/** What the shell's own first `<script>` leaves in `window.__aioConfig`. */
function shellConfig(html: string): Record<string, unknown> | undefined {
  const m = /window\.__aioConfig=(\{.*?\})<\/script>/.exec(html);
  return m ? JSON.parse(m[1]!) : undefined;
}

Deno.test("wire option: the launch-templated aio:// shell carries it, and only when asked", () => {
  const on = udsProdHTML("T", false, { wire: { omitTrailingUndefined: true } });
  assertEquals(shellConfig(on), { wire: { omitTrailingUndefined: true } });
  // Default config: the shell is the one 1.0.19 wrote, byte for byte.
  const off = udsProdHTML("T", false, {});
  assertEquals(off, udsProdHTML("T", false, { wire: undefined }));
  assertEquals(off.includes("__aioConfig"), false);
  // …and it is in the main-process script the window is started from.
  const script = (wire?: { omitTrailingUndefined: boolean }) =>
    electronMainScriptUDS("aio://app/", "/nowhere.sock", {
      title: "T",
      shell: { wire },
    });
  const marker = String.raw`window.__aioConfig={\"wire\":`;
  assertEquals(
    script({ omitTrailingUndefined: true }).includes(marker),
    true,
  );
  assertEquals(script().includes("__aioConfig={"), false);
  assertEquals(script(), script(undefined));
});

Deno.test("wire option: the boot hands `wire` to that shell (a source check — this path boots only with an Electron window)", async () => {
  const run = await Deno.readTextFile("src/server/aio.ts");
  const life = await Deno.readTextFile("src/server/aio-lifecycle.ts");
  const at = life.indexOf("shell: {\n");
  assertEquals(at > 0, true);
  assertEquals(
    life.slice(at, at + 200).includes("wire: deps.wire,") &&
      /security: config\.security,\s+wire: config\.wire,/.test(run),
    true,
    "aio.run({ wire }) no longer reaches the aio:// shell — a packaged " +
      "window's first flush would encode calls the default way",
  );
});

Deno.test("wire option: a call queued before the connection is sent as the app asked — before any cfg frame", async () => {
  const win = new Window({ url: "https://localhost" });
  const opens: Fn[] = [];
  const closes: Fn[] = [];
  const sent: string[] = [];
  (win as unknown as Record<string, unknown>).__aioIPC = {
    send: (json: string) => sent.push(json),
    onOpen: (fn: Fn) => opens.push(fn),
    onMessage: () => {},
    onClose: (fn: Fn) => closes.push(fn),
    ready: () => {},
  };
  const g = globalThis as unknown as Record<string, unknown> & G;
  const prevWindow = g.window;
  const prevLocation = g.location;
  const prevCfg = g.__aioConfig;
  g.window = win;
  g.location = win.location;
  const actions = () =>
    sent.filter((s) => (JSON.parse(s) as { t: string }).t === "action");
  const A = { type: "wff:a", payload: { args: ["x", undefined] } };
  const B = { type: "wff:b", payload: { args: [1] } };
  const C = { type: "wff:c", payload: { args: [undefined, undefined] } };
  try {
    // The page as the DEFAULT shell leaves it: no `__aioConfig` at all.
    delete g.__aioConfig;
    assertEquals(shellConfig(udsProdHTML("T", false, {})), undefined);
    await import(
      `../src/browser/browser-air-transport.ts#${crypto.randomUUID()}`
    );
    const { ensureConnected, client } = await import(
      "../src/browser/browser-protocol.ts"
    );
    ensureConnected();
    for (const a of [A, B, C]) client.send(a);
    assertEquals(actions(), [], "nothing is written before the bridge opens");
    for (const fn of opens) fn();
    // Default config: the frames 1.0.19 sent, in the order it sent them —
    // `undefined` written `null`, nothing held back, nothing reordered.
    const tag = (a: typeof A | typeof B | typeof C) =>
      enc("action", { ...a, _source: "UI" });
    assertEquals(actions(), [A, B, C].map(tag));
    assertEquals(
      actions().map((f) => JSON.parse(f).d.payload.args),
      [["x", null], [1], [null, null]],
    );

    // The same page under the shell of an app that asked for the option.
    for (const fn of closes) fn();
    sent.length = 0;
    g.__aioConfig = shellConfig(
      udsProdHTML("T", false, { wire: { omitTrailingUndefined: true } }),
    );
    for (const a of [A, B, C]) client.send(a);
    assertEquals(actions(), []);
    for (const fn of opens) fn();
    assertEquals(
      actions().map((f) => JSON.parse(f).d.payload.args),
      [["x"], [1], []],
      "the first flush — before any cfg frame — encoded a trailing " +
        "`undefined` the default way",
    );
    assertEquals(
      actions().map((f) => JSON.parse(f).d.type),
      ["wff:a", "wff:b", "wff:c"],
    );
  } finally {
    _teardownNow();
    if (prevCfg === undefined) delete g.__aioConfig;
    else g.__aioConfig = prevCfg;
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    if (prevLocation === undefined) delete g.location;
    else g.location = prevLocation;
    await closeWindow(win);
  }
});
