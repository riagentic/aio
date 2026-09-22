// `memory.maxHeap` is declared in deno.json — does a REAL boot know?
//
// A field report: an app set `"memory": { "maxHeap": "12GB" }`, hit the
// ceiling, and found three surfaces giving three different answers. The build
// honoured the key; the boot warning compared the process against the
// automatic 25% share and never mentioned it; and putting `memory` at the top
// level of deno.json earned a SECOND warning saying it was doing nothing. The
// one number the author had chosen was invisible to the process that needed it.
//
// The unit tests in heap-policy.test.ts pin the SENTENCE. This pins the WIRING,
// which is the half that cannot be reasoned about: the boot path has to read
// the key from the app's own deno.json and hand it to the reporter. A spawned
// `deno run` is the only instrument that proves it — in-process, `appDenoJson()`
// resolves against this repo, not against an app.
import { assert } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { dirname, fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const DENO_JSON = join(REPO, "deno.json");

/** Boot a one-cell app from a temp dir whose deno.json is `denoJson`, and
 *  return everything it said on the way up. No `--v8-flags`, so the process
 *  gets V8's ~4 GB default — the case a declared 12 GB does not reach. */
async function bootAndCollect(
  denoJson: Record<string, unknown>,
): Promise<string> {
  const dir = await tempDir("aio-heap-declared-");
  try {
    const appId = `heapdecl-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ appId, ...denoJson }, null, 2),
    );
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio, cell } from "${REPO}/mod.ts";
const c = cell("c", { state: { n: 1 }, methods: {} });
await aio.run({
  cells: [c], persist: false, client: "server-only",
  appDir: ${JSON.stringify(join(dir, "home"))},
});
Deno.exit(0);
`,
    );
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        DENO_JSON,
        join(dir, "app.ts"),
        `--port=${freePort()}`,
      ],
      cwd: dir,
      env: { ...Deno.env.toObject(), AIO_APPS_DIR: join(dir, "apps") },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "boot: a declared memory.maxHeap this process did not get is named at boot",
  async fn() {
    const said = await bootAndCollect({ memory: { maxHeap: "12GB" } });
    assert(
      said.includes("maxHeap"),
      `the boot must name the key the author wrote:\n${said}`,
    );
    assert(
      said.includes("12.0 GB"),
      `…and the number they wrote:\n${said}`,
    );
    assert(
      /did NOT get it/.test(said),
      `…and that this process does not have it:\n${said}`,
    );
    assert(
      said.includes("am start"),
      `…and the launcher that does apply it:\n${said}`,
    );
    // …and it must be the ONLY thing the boot says about the key. The same
    // boot used to also print "deno.json has aio config at the TOP LEVEL …
    // \"memory\" is silently doing nothing. Move it into aio.run({ memory })"
    // — which is false (the build and `am start` read it from there) and whose
    // advice throws (`aio.run({ memory: { maxHeap } })` is refused by name).
    assert(
      !said.includes("silently doing nothing"),
      `one key, one answer — not two that contradict:\n${said}`,
    );
  },
});

Deno.test({
  name: "boot: an app that declares nothing is never told about maxHeap",
  async fn() {
    // The cry-wolf pin, end to end. Whatever else this boot says, it must not
    // invent a config key the author never wrote.
    const said = await bootAndCollect({});
    assert(
      !said.includes("did NOT get it"),
      `no declaration, no declaration warning:\n${said}`,
    );
    assert(
      !/maxHeap" \) = /.test(said),
      `no declared number can be quoted back:\n${said}`,
    );
  },
});
