// A <webview preload> is a file: URL. The guard stripped "file://" with
// slice(7), so a percent-encoded URL (a space in "/Applications/My App.app"
// is %20 — what pathToFileURL, the correct way to build one, produces) and
// every Windows URL (file:///C:/…) named a path that never existed: the
// preload was REFUSED as ENOENT although it sat inside the app directory.
// Runs the generated fragment with real node fs/path/url.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import { tmplWillNavigate } from "../src/electron/electron-shared.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

type Handler = (...a: unknown[]) => unknown;

Deno.test("electron: a webview preload given as an encoded file: URL inside the app dir is accepted", async () => {
  const base = join(await tempDir("aio-wv-preload-"), "My App");
  await Deno.mkdir(base, { recursive: true });
  const preload = join(base, "bridge.js");
  await Deno.writeTextFile(preload, "");
  const handlers: Record<string, Handler> = {};
  const warnings: string[] = [];
  new Function(
    "win",
    "fs",
    "path",
    "console",
    "BASE_DIR",
    "_appOrigin",
    "require",
    tmplWillNavigate("_appOrigin"),
  )(
    {
      webContents: {
        on(ev: string, fn: Handler) {
          handlers[ev] = fn;
        },
        setWindowOpenHandler() {},
      },
    },
    nodeFs,
    nodePath,
    { warn: (m: unknown) => warnings.push(String(m)), error() {}, log() {} },
    base,
    "aio://app",
    (m: string) => m === "url" ? nodeUrl : { shell: { openExternal() {} } },
  );
  const url = nodeUrl.pathToFileURL(preload).href;
  const wp: Record<string, unknown> = { preload: url };
  handlers["will-attach-webview"]!(null, wp, {});
  assertEquals(warnings, [], "an in-app preload must not be refused");
  assertEquals(wp.preload, nodeFs.realpathSync(preload));
});
