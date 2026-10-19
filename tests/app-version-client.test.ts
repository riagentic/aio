// A page reads the app's version (field report: a standalone APK's About page
// had no way to show "App version 0.2.5" — `appVersion()` was server-only,
// and the bundle got no constant, so the app re-derived aio's rule by hand
// and drifted). Every shell aio writes now carries it; `aio/air` reads it.
import { assert, assertEquals } from "@std/assert";
import { appVersion } from "../src/air.ts";
import { appVersion as standaloneAppVersion } from "../src/standalone-air.ts";
import {
  androidLocalHTML,
  generateHTML,
} from "../src/server/server-html-gen.ts";
import { udsProdHTML } from "../src/electron/electron-shared.ts";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";

type G = { __aioConfig?: Record<string, unknown> };
const config = (html: string) => {
  const m = /window\.__aioConfig=(\{.*?\})<\/script>/.exec(html);
  return m ? JSON.parse(m[1]!) as Record<string, unknown> : {};
};

Deno.test("appVersion(): the shell's version, else null — the same function on the standalone runtime", () => {
  const g = globalThis as G;
  const was = g.__aioConfig;
  try {
    g.__aioConfig = { appVersion: "0.2.5" };
    assertEquals(appVersion(), "0.2.5");
    assertEquals(standaloneAppVersion, appVersion);
    g.__aioConfig = {};
    assertEquals(appVersion(), null);
  } finally {
    g.__aioConfig = was;
  }
});

Deno.test("appVersion(): the server's own on the server, the hello only in a browser, never a sentence", () => {
  const g = globalThis as Record<string, unknown>;
  const was = {
    cfg: g.__aioConfig,
    aio: g.__aioAppVersion,
    hello: g.__aioPeerHello,
    doc: g.document,
  };
  try {
    delete g.__aioConfig;
    delete g.document;
    // On the server (SSR renders the page there): what the server runs.
    g.__aioAppVersion = "1.2.345";
    assertEquals(appVersion(), "1.2.345");
    // An unresolved version is a sentence, not a version.
    g.__aioAppVersion = 'unknown (no "version" could be derived — see the log)';
    assertEquals(appVersion(), null);
    // A peer's hello is a CLIENT fact: a process with no page (a CLI client
    // of another app) does not take its server's version as its own…
    delete g.__aioAppVersion;
    g.__aioPeerHello = { v: 3, min: 3, app: "2.0.7" };
    assertEquals(appVersion(), null);
    // …a page does.
    g.document = {};
    assertEquals(appVersion(), "2.0.7");
    g.__aioConfig = { appVersion: "1.2.346-dirty.0c7e11aa" };
    assertEquals(appVersion(), "1.2.346-dirty.0c7e11aa");
  } finally {
    for (
      const [k, v] of Object.entries({
        __aioConfig: was.cfg,
        __aioAppVersion: was.aio,
        __aioPeerHello: was.hello,
        document: was.doc,
      })
    ) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
});

Deno.test("appVersion: every shell generator carries it, and none invents one", () => {
  assertEquals(
    config(androidLocalHTML("t", false, { appVersion: "0.2.5" })).appVersion,
    "0.2.5",
  );
  assertEquals(
    config(udsProdHTML("t", false, { appVersion: "0.2.5" })).appVersion,
    "0.2.5",
  );
  assertEquals(
    config(
      generateHTML({
        title: "t",
        prod: true,
        hasCSS: false,
        importMap: "",
        appVersion: "1.2.3",
      }),
    ).appVersion,
    "1.2.3",
  );
  assertEquals(config(androidLocalHTML("t", false, {})).appVersion, undefined);
});

Deno.test("appVersion: the server's shell carries the version /__aio/health reports", async () => {
  const c = cell("appver-cell", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({ cells: [c], appId: "appver" });
  const shell = config(await (await srv.fetch("/")).text());
  const health = await (await srv.fetch("/__aio/health")).json();
  assert(
    typeof shell.appVersion === "string" && shell.appVersion,
    JSON.stringify(shell),
  );
  assertEquals(shell.appVersion, health.appVersion);
});
