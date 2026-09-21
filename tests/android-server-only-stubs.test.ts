// Server-only names a cell module imports from "aio" must BUNDLE for ANDROID
// too, and must fail loud if the WebView ever CALLS them.
//
// The android build remaps the public specifier (src/build/esbuild-shared.ts,
// `bundleFrameworkEntries(true)`): `aio` and `aio/air` both resolve to
// src/standalone-air.ts. That entry exported none of serverUser /
// serverRequest / serverAuth / blocking, so docs/auth/auth.md's `serverUser`
// example and docs/debugging/performance.md's `blocking` example — both of
// which put the name in a CELL module, which the UI imports — refused the APK
// bundle outright:
//
//   ✘ [ERROR] No matching export in "src/standalone-air.ts" for import
//     "serverUser"
//
// The browser entry closed exactly this gap (tests/browser-server-only-stubs)
// with facades that throw when called. This is the android half, with the
// refusal naming the runtime it ACTUALLY ran on — "it ran in the browser" is
// the wrong sentence to read out of an APK.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  bundleFrameworkEntries,
  ESBUILD_SPEC,
} from "../src/build/esbuild-shared.ts";
import * as android from "../src/standalone-air.ts";
import * as mod from "../mod.ts";
import { blockingServerOnly } from "../src/state/blocking-reason.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** The first ```ts block after `heading` in a doc — the example itself. */
async function docSnippet(doc: string, heading: string): Promise<string> {
  const text = await Deno.readTextFile(`${ROOT}${doc}`);
  const at = text.indexOf(heading);
  assert(at >= 0, `${doc} lost the "${heading}" section`);
  const m = text.slice(at).match(/```ts\n([\s\S]*?)```/);
  assert(m, `${doc}: no ts block under "${heading}"`);
  return m[1]!;
}

/** Bundle `src` the way a real build bundles it — `aio` aliased to the browser
 *  or the standalone entry, exactly as `bundleFrameworkEntries` decides — and
 *  hand back esbuild's errors plus the module graph it walked. */
async function bundleFor(
  target: "android" | "browser",
  tag: string,
  src: string,
): Promise<{ errors: string[]; inputs: string[] }> {
  const dir = await tempDir(`aio-${target}-stub-${tag}-`);
  // deno-lint-ignore no-explicit-any
  const esbuild = await import(ESBUILD_SPEC) as any;
  try {
    await Deno.writeTextFile(`${dir}/cell.ts`, src);
    const alias = Object.fromEntries(
      Object.entries(bundleFrameworkEntries(target === "android")).map((
        [spec, rel],
      ) => [spec, `${ROOT}${rel}`]),
    );
    const r = await esbuild.build({
      entryPoints: [`${dir}/cell.ts`],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      metafile: true,
      alias,
      absWorkingDir: ROOT,
    });
    return {
      errors: (r.errors as { text: string }[]).map((e) => e.text),
      inputs: Object.keys(r.metafile.inputs as Record<string, unknown>),
    };
  } catch (e) {
    return {
      errors: ((e as { errors?: { text: string }[] }).errors ?? [{
        text: String(e),
      }]).map((x) => x.text),
      inputs: [],
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("android stubs: the docs' serverUser and blocking cell modules bundle for an APK", async () => {
  const auth = await docSnippet(
    "docs/auth/auth.md",
    "### Who is calling? (`serverUser`)",
  );
  assert(auth.includes("serverUser"), "auth snippet no longer uses serverUser");
  const perf = await docSnippet(
    "docs/debugging/performance.md",
    "## Move it off-thread",
  );
  assert(perf.includes("blocking("), "perf snippet no longer uses blocking");
  const other = `import { cell, serverAuth, serverRequest } from "aio";
export const probe = cell("probe", {
  state: { n: 0 },
  methods: {
    async who(s) { s.n = serverRequest() ? 1 : serverAuth() ? 2 : 0; },
  },
});
`;
  const refused: string[] = [];
  try {
    for (
      const [tag, src] of [["auth", auth], ["perf", perf], ["req", other]]
    ) {
      for (const m of (await bundleFor("android", tag!, src!)).errors) {
        refused.push(`${tag}: ${m}`);
      }
    }
  } finally {
    // deno-lint-ignore no-explicit-any
    await (await import(ESBUILD_SPEC) as any).stop();
    await new Promise((r) => setTimeout(r, 50));
  }
  assertEquals(refused, [], "the android bundle refused a docs example");
});

Deno.test("android stubs: calling a server-only name in a standalone build throws a teachable error", () => {
  for (const name of ["serverUser", "serverRequest", "serverAuth"] as const) {
    const stub = (android as Record<string, unknown>)[name];
    assert(
      stub !== (mod as Record<string, unknown>)[name],
      `${name} is no stub`,
    );
    // The runtime it actually ran on — not "the browser", which is what an APK
    // user would otherwise read out of a phone's logcat.
    assertThrows(
      () => (stub as () => unknown)(),
      Error,
      `${name}() is server-only — it ran in a standalone build (the Android ` +
        `WebView)`,
    );
    assertThrows(
      () => (stub as () => unknown)(),
      Error,
      "--android --remote",
    );
  }
});

// The claim the facades rest on, and the one src/server/auth-context.ts's
// header asserts: that module is in NO client bundle. Its header used to say
// the opposite — node:async_hooks stubbed, "the guards below make
// serverUser()/serverRequest() a harmless `undefined` there" — and a client
// that reads `serverUser()` as `undefined` is an authorization check that
// passed because there was nobody to check. The facades are what makes that
// impossible, so the fact that nothing VALUE-imports the real module on the
// way into a bundle is the other half of the same contract. It lives here, on
// the esbuild harness, and covers both client entries.
Deno.test("no client bundle contains the real auth-context (the facades are what a client gets)", async () => {
  const src = `import { serverUser, serverRequest, serverAuth } from "aio";
export const who = () => [serverUser, serverRequest, serverAuth];
`;
  const leaks: string[] = [];
  try {
    for (const target of ["android", "browser"] as const) {
      const { errors, inputs } = await bundleFor(target, "ctx", src);
      // A value-import of auth-context also shows up here: this bare esbuild
      // carries no `node:` stub plugin, so reaching it is an unresolvable
      // `node:async_hooks` rather than an extra input. Either way the gate
      // fires — the leak has nowhere to hide.
      assertEquals(
        errors,
        [],
        `${target}: the bundle was refused (a "node:" specifier here means a ` +
          `client entry now VALUE-imports a server-only module)`,
      );
      for (const i of inputs) {
        if (
          i.includes("server/auth-context") || i.includes("async_hooks")
        ) leaks.push(`${target}: ${i}`);
      }
    }
  } finally {
    // deno-lint-ignore no-explicit-any
    await (await import(ESBUILD_SPEC) as any).stop();
    await new Promise((r) => setTimeout(r, 50));
  }
  assertEquals(
    leaks,
    [],
    "a client bundle reached the REAL auth-context — the throwing facades in " +
      "browser-air.ts/standalone-air.ts are no longer the whole story, and " +
      "`serverUser()` can answer `undefined` on a client again",
  );
});

Deno.test("android stubs: blocking refuses with the sentence the real one uses off Deno", async () => {
  await assertRejects(
    () => android.blocking("x", () => 1),
    Error,
    blockingServerOnly("x"),
  );
  assertEquals(android.blocking.cancel("x"), false);
  assertEquals(android.blocking.disposeIdle(), true);
  await android.blocking.dispose();
});
