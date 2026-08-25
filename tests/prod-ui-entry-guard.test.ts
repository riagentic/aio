// A PROD server must refuse to serve a bundle built from a DIFFERENT UI
// component than its own `ui.entry` (R-2). This is the dev≠prod
// divergence in its purest form: the page renders, just the wrong app, and
// nothing anywhere says so. The bundle carries `__aioBundleUi`; the server
// compares it to the running config and answers with an error the browser
// console and the page both show.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createStaticHandler } from "../src/server/server-static.ts";
import { join } from "@std/path";

async function fixture(stampUi: string | null): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-uientry-" });
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    (stampUi === null
      ? ""
      : `globalThis.__aioBundleUi = ${JSON.stringify(stampUi)};\n`) +
      "export const mount = () => {};\n",
  );
  return dir;
}

function handlerFor(absBaseDir: string, uiEntry?: string) {
  return createStaticHandler({
    prod: true,
    debug: () => {},
    title: "t",
    absBaseDir,
    absDistDir: join(absBaseDir, "dist"),
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    uiEntry,
    getGraphResult: () => null,
    // deno-lint-ignore no-explicit-any
  } as any);
}

Deno.test("prod: a bundle whose UI entry disagrees with the config is refused", async () => {
  const dir = await fixture("Status.tsx");
  try {
    const res = await handlerFor(dir, "App.tsx").serveStatic("/app.js");
    assertEquals(res.status, 500);
    const body = await res.text();
    assertStringIncludes(body, "Status.tsx");
    assertStringIncludes(body, "App.tsx");
    // The message must name the FIX, not just the fact.
    assertStringIncludes(body, "--ui=App.tsx");
    assert(!body.includes("export const mount"), "the wrong bundle was served");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prod: a matching stamp, and the pre-stamp convention, both serve", async () => {
  // exact match
  let dir = await fixture("Status.tsx");
  try {
    const res = await handlerFor(dir, "Status.tsx").serveStatic("/app.js");
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "export const mount");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  // NO stamp (a bundle from an older aio) + no configured entry: the App.tsx
  // convention on both sides. A guard that broke every existing artifact would
  // be worse than the bug it closes.
  dir = await fixture(null);
  try {
    const res = await handlerFor(dir, undefined).serveStatic("/app.js");
    assertEquals(res.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  // …and an unstamped bundle against a CONFIGURED entry is still a mismatch:
  // the stamp's absence means "built from App.tsx", which is not Status.tsx.
  dir = await fixture(null);
  try {
    const res = await handlerFor(dir, "Status.tsx").serveStatic("/app.js");
    assertEquals(res.status, 500);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
