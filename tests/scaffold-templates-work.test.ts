// Two `am create` templates shipped an app whose own feature did not work.
//
//   --template=assets   404s the file it exists to demonstrate, in dev AND in
//                       the compiled binary. The scaffold wrote `assets` only
//                       to deno.json — which the BUILD reads (it embedded the
//                       directory) and the SERVER does not, because deno.json
//                       carries identity and build facts only and aio says so
//                       at boot. The template's own Load button prints
//                       "404 — is the media/ directory there?", and it is.
//
//   --css=tailwind      renders completely unstyled under `deno task dev` and
//                       correct after a build. `_runAppCssStep` read the
//                       deno.json from `absBaseDir` — the APP dir, which for
//                       every scaffold is `<project>/src` — one level below
//                       the file that declares the step. Green in dev,
//                       different in prod, from the one flag a Tailwind user
//                       reaches for, and the scaffold's own comment on that
//                       key says "Runs before every dev reload and every
//                       build".
//
// Every gate said both apps were fine: `check`, `lint`, `doctor` (15/15) and
// `am fix` all passed. Only the runtime differed from the promise.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("scaffold: the assets template MOUNTS what the build embeds", async () => {
  const { appEntryFor, denoJsonFor } = await import(
    "../src/am/am-cmd-create.ts"
  ) as unknown as {
    appEntryFor?: (t: string) => string;
    denoJsonFor?: (...a: unknown[]) => string;
  };
  void appEntryFor;
  void denoJsonFor;
  // The template text is the artifact — read it from the module source, which
  // is what `am create` writes verbatim.
  const src = await Deno.readTextFile(
    new URL("../src/am/am-cmd-create.ts", import.meta.url),
  );
  const entry = /const ASSETS_APP = `([\s\S]*?)`;/.exec(src)?.[1];
  assert(entry, "the assets entry template must be findable");
  assertStringIncludes(
    entry,
    "assets:",
    "the entry must pass `assets` to aio.run() — deno.json is not where the " +
      "SERVER reads mounts from, and the app 404'd its own feature",
  );
  assertStringIncludes(entry, "/media");
});

Deno.test("scaffold: deno.json's `assets` is a recognised BUILD key", async () => {
  const { misplacedDenoJsonKeys } = await import("../src/server/config.ts");
  assertEquals(
    misplacedDenoJsonKeys({ assets: { "/media": "./media" } }),
    [],
    "`compile` reads this key to decide what to embed — scolding it sent the " +
      "scaffold chasing a warning about the one line that was right",
  );
  // …and a key aio really does not read is still reported.
  assert(
    misplacedDenoJsonKeys({ ui: { theme: "auto" } }).length > 0,
    "a genuinely misplaced key must still be named",
  );
});

Deno.test("css step: the declared step is found from the APP dir, not just the root", async () => {
  const { _runAppCssStep } = await import(
    "../src/server/server-css-step.ts"
  ) as unknown as {
    _runAppCssStep: (dir: string) => Promise<readonly string[]>;
  };
  const { tempDir } = await import("../src/testing/temp-dir.ts");
  const root = await tempDir("aio-cssstep-");
  try {
    await Deno.mkdir(`${root}/src`, { recursive: true });
    // A step that writes a file, declared where a scaffold declares it.
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({
        build: {
          css: "deno eval Deno.writeTextFileSync('src/style.css','ok')",
        },
      }),
    );
    // Called with the APP dir — what the dev server passes.
    const written = await _runAppCssStep(`${root}/src`);
    const made = await Deno.readTextFile(`${root}/src/style.css`).catch(() =>
      ""
    );
    assertEquals(
      made,
      "ok",
      `the dev server must run the step the app declared — it read the ` +
        `deno.json from the app dir and found none, so the step ran only in ` +
        `\`build\` (wrote: ${JSON.stringify(written)})`,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("css step: an app that declares no step still does no I/O", async () => {
  // The control — the walk must not turn "nobody asked for this" into a
  // directory read on every boot and every save. That cost eight tests a
  // sanitizer failure once already.
  const { _runAppCssStep } = await import(
    "../src/server/server-css-step.ts"
  ) as unknown as {
    _runAppCssStep: (dir: string) => Promise<readonly string[]>;
  };
  const { tempDir } = await import("../src/testing/temp-dir.ts");
  const root = await tempDir("aio-cssnone-");
  try {
    await Deno.mkdir(`${root}/src`, { recursive: true });
    await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({}));
    assertEquals(await _runAppCssStep(`${root}/src`), []);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
