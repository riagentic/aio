// The dev watcher's honesty about two things it used to get wrong:
//   1. deleting the root component printed a SUCCESS line ("reloaded App.tsx")
//      and the browser overlay blamed a sub-import that never existed;
//   2. an unparseable deno.json was announced as "harmless" while every
//      subsequent `deno task` died on a deserialization error.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createFileWatcher,
  DEBOUNCE_MS,
} from "../src/server/server-watcher.ts";
import {
  classifyBrowserError,
  setUiRootProbe,
} from "../src/server/server-html-classify.ts";

/** Run `fn` with the console captured, tagged by level. `log.info` goes to
 *  `console.info` (the level decides the method — logger-format.ts), so a
 *  helper that only watched console.log saw none of it. */
async function captured(
  fn: () => Promise<void>,
): Promise<{ info: string[]; warn: string[]; error: string[] }> {
  const info: string[] = [], warn: string[] = [], error: string[] = [];
  const o = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...a: unknown[]) => info.push(a.join(" "));
  console.info = (...a: unknown[]) => info.push(a.join(" "));
  console.warn = (...a: unknown[]) => warn.push(a.join(" "));
  console.error = (...a: unknown[]) => error.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = o.log;
    console.info = o.info;
    console.warn = o.warn;
    console.error = o.error;
  }
  return { info, warn, error };
}

Deno.test("watcher: deleting the root component is an ERROR, never a 'reloaded' line", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "aio-watch-root-" });
  try {
    const entry = join(tmp, "App.tsx");
    await Deno.writeTextFile(entry, "export default () => <div>hi</div>;\n");
    const sent: string[] = [];
    let watcher: ReturnType<typeof createFileWatcher> | undefined;
    const out = await captured(async () => {
      watcher = createFileWatcher({
        absBaseDir: tmp,
        importMapObj: {},
        debug: () => {},
        broadcastWs: (m) => sent.push(m),
        graphTimeoutMs: 0,
      });
      await Deno.remove(entry);
      watcher.scheduleReload(entry);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 300));
    });
    watcher?.shutdown();
    assert(
      out.error.some((l) => l.includes("is GONE") && l.includes("App.tsx")),
      `the deletion must be an error naming the file. Got: ${
        JSON.stringify(out.error)
      }`,
    );
    assert(
      !out.info.some((l) => l.includes("reloaded")),
      `a deleted root component is not a successful reload. Got: ${
        JSON.stringify(out.info)
      }`,
    );
    assertEquals(sent.length, 1, "the browser still gets told to re-fetch");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("watcher: a removed (non-root) file is 'removed', not 'reloaded'", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "aio-watch-rm-" });
  try {
    await Deno.writeTextFile(
      join(tmp, "App.tsx"),
      "export default () => <div>hi</div>;\n",
    );
    const dead = join(tmp, "Gone.tsx");
    let watcher: ReturnType<typeof createFileWatcher> | undefined;
    const out = await captured(async () => {
      watcher = createFileWatcher({
        absBaseDir: tmp,
        importMapObj: {},
        debug: () => {},
        broadcastWs: () => {},
        graphTimeoutMs: 0,
      });
      watcher.scheduleReload(dead); // never existed = removed
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 300));
    });
    watcher?.shutdown();
    assert(
      out.info.some((l) => l.includes("removed") && l.includes("Gone.tsx")),
      `Got: ${JSON.stringify(out.info)}`,
    );
    assert(
      !out.info.some((l) => l.includes("reloaded")),
      `Got: ${JSON.stringify(out.info)}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("watcher: an unparseable deno.json is an ERROR that names the consequence", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "aio-watch-cfgbad-" });
  try {
    const cfg = join(tmp, "deno.json");
    await Deno.writeTextFile(cfg, '{ "imports": { "a": "b", } ,,, }\n');
    const sent: string[] = [];
    const watcher = createFileWatcher({
      absBaseDir: tmp,
      importMapObj: {},
      debug: () => {},
      broadcastWs: (m) => sent.push(m),
    });
    const out = await captured(async () => {
      watcher.scheduleReload(cfg);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
    });
    // …and it parses again once fixed.
    const fixed = await captured(async () => {
      await Deno.writeTextFile(cfg, "{}\n");
      watcher.scheduleReload(cfg);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
    });
    watcher.shutdown();
    const line = out.error.join("\n");
    assertStringIncludes(line, "does not parse");
    assertStringIncludes(line, "deno.json");
    assert(
      /will now fail/.test(line),
      `the consequence must be named, not called harmless. Got: ${line}`,
    );
    assert(
      !out.warn.some((w) => w.includes("harmless")),
      `a broken config is not a harmless edit. Got: ${
        JSON.stringify(out.warn)
      }`,
    );
    assertEquals(sent, [], "a config edit is never a browser reload");
    assert(
      fixed.info.some((l) => l.includes("parses again")),
      `the recovery must be visible too. Got: ${JSON.stringify(fixed.info)}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("watcher: an entry that was NEVER at the configured path is not a deletion", async () => {
  // A project that keeps its UI somewhere else has no App.tsx under baseDir,
  // and telling its author that their root component was deleted is an
  // invention. It also must not cost hot reload: a css-only burst is still a
  // style swap. (Both were live regressions of the deletion message.)
  const tmp = await Deno.makeTempDir({ prefix: "aio-watch-noroot-" });
  try {
    const css = join(tmp, "style.css");
    await Deno.writeTextFile(css, "body{}\n");
    const sent: string[] = [];
    let watcher: ReturnType<typeof createFileWatcher> | undefined;
    const out = await captured(async () => {
      watcher = createFileWatcher({
        absBaseDir: tmp,
        importMapObj: {},
        debug: () => {},
        broadcastWs: (m) => sent.push(m),
        graphTimeoutMs: 0,
      });
      watcher.scheduleReload(css);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 300));
    });
    watcher?.shutdown();
    assertEquals(
      out.error.filter((l) => l.includes("is GONE")),
      [],
      "nothing was deleted — this project's entry simply lives elsewhere",
    );
    assert(
      sent.some((m) => m.includes("css")),
      `a css-only edit is a style swap, not a full reload. Got: ${
        JSON.stringify(sent)
      }`,
    );
    assert(
      !sent.some((m) => m.includes("reload")),
      `a full reload would blow away the page's state. Got: ${
        JSON.stringify(sent)
      }`,
    );
    // …and the browser-error classifier must not claim the root is missing
    // for a root it has never been able to see.
    assertEquals(
      classifyBrowserError(
        "Failed to fetch dynamically imported module: http://x/src/App.tsx",
      ).classification,
      "dynamic-import-failed",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("classifyBrowserError: a missing App.tsx is never blamed on a sub-import", () => {
  const msg =
    "TypeError: Failed to fetch dynamically imported module: http://localhost:8000/src/App.tsx";
  try {
    setUiRootProbe(() => false);
    const gone = classifyBrowserError(msg);
    assertEquals(gone.classification, "missing-ui-root");
    assertStringIncludes(gone.fix, "does not exist");
    assert(
      !gone.fix.includes("sub-import inside"),
      `no sub-import exists to hunt. Got: ${gone.fix}`,
    );

    setUiRootProbe(() => true);
    const present = classifyBrowserError(msg);
    assertEquals(present.classification, "dynamic-import-failed");
    assertStringIncludes(present.fix, "Network");

    // No probe (prod, no watcher): still never ASSERTS a sub-import.
    setUiRootProbe(undefined);
    const unknown = classifyBrowserError(msg);
    assertEquals(unknown.classification, "dynamic-import-failed");
    assertStringIncludes(unknown.fix, "or a module it imports");

    // A probe that throws must not turn an error report into a second error.
    setUiRootProbe(() => {
      throw new Error("boom");
    });
    assertEquals(
      classifyBrowserError(msg).classification,
      "dynamic-import-failed",
    );
  } finally {
    setUiRootProbe(undefined);
  }
});
