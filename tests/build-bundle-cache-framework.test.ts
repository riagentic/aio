// The bundle freshness record did not say WHICH framework built the bundle.
// Two frameworks of the same VERSION (a JSR install and a pinned checkout
// carrying a client fix — `am pin` writes .aio/pin.local, not deno.json — or
// a repointed `aio` symlink) share every stamp, so switching between them
// reused the other one's client code as "cached".
import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  frameworkIdentity,
  isBundleFresh,
  versionStamp,
} from "../src/build/build-bundle.ts";
import type { BuildConfig } from "../src/build/build-config.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { VERSION } from "../src/server/aio-cli.ts";

const write = async (p: string, t: string) => {
  await Deno.mkdir(dirname(p), { recursive: true });
  await Deno.writeTextFile(p, t);
};

async function scenario(ws: string) {
  const root = join(ws, "app");
  const fwA = join(ws, "aio-A", "src");
  const fwB = join(ws, "aio-B", "src");
  await write(join(root, "deno.json"), "{}");
  await write(join(root, "App.tsx"), "// app\n");
  await write(join(fwA, "air", "renderer.ts"), "// A\n");
  await write(join(fwB, "air", "renderer.ts"), "// B (the fix)\n");
  await new Promise((r) => setTimeout(r, 15));
  const out = join(root, "dist", "app.js");
  await write(
    out,
    versionStamp(VERSION) + 'globalThis.__aioBundleTarget = "browser";\n',
  );
  const cfg = (fw: string, remote?: string) =>
    ({
      root,
      appDir: root,
      out,
      dist: join(root, "dist"),
      doForce: false,
      standalone: false,
      isRemote: remote !== undefined,
      frameworkSrcDir: remote === undefined ? fw : "",
      frameworkBase: new URL(remote ?? `file://${fw}/../`),
    }) as unknown as BuildConfig;
  const record = (fields: Record<string, unknown>) =>
    write(
      join(root, ".aio", "bundle-inputs.json"),
      JSON.stringify({
        v: 2,
        out,
        app: root,
        inputs: [join(root, "App.tsx"), join(fwA, "air", "renderer.ts")],
        ...fields,
      }),
    );
  return { root, fwA, fwB, cfg, record };
}

Deno.test("bundle cache: a bundle built by framework A is not fresh for a build by framework B", async () => {
  const ws = await tempDir("aio-fw-switch-");
  try {
    const { fwA, fwB, cfg, record } = await scenario(ws);
    await record({ framework: frameworkIdentity(cfg(fwA)), serverOnly: {} });
    assertEquals(
      await isBundleFresh(cfg(fwA)),
      true,
      "control: same framework",
    );
    assertEquals(
      await isBundleFresh(cfg(fwB)),
      false,
      "another framework's bundle reused",
    );
  } finally {
    await dropTempDir(ws);
  }
});

Deno.test("bundle cache: a repointed framework symlink is another framework", async () => {
  const ws = await tempDir("aio-fw-link-");
  try {
    const { fwA, fwB, cfg, record } = await scenario(ws);
    const link = join(ws, "dep-aio");
    await Deno.symlink(fwA, link);
    await record({ framework: frameworkIdentity(cfg(link)), serverOnly: {} });
    assertEquals(await isBundleFresh(cfg(link)), true, "control: same target");
    await Deno.remove(link);
    await Deno.symlink(fwB, link);
    assertEquals(await isBundleFresh(cfg(link)), false, "repointed link");
  } finally {
    await dropTempDir(ws);
  }
});

Deno.test("bundle cache: a remote framework is named by its URL", async () => {
  const ws = await tempDir("aio-fw-remote-");
  try {
    const { fwA, cfg, record } = await scenario(ws);
    const jsr = "https://jsr.io/@aio/aio/1.0.0/src/";
    await record({
      framework: frameworkIdentity(cfg("", jsr)),
      serverOnly: {},
    });
    assertEquals(await isBundleFresh(cfg("", jsr)), true, "control");
    assertEquals(
      await isBundleFresh(cfg("", "https://jsr.io/@aio/aio/1.0.1/src/")),
      false,
      "another remote framework",
    );
    assertEquals(await isBundleFresh(cfg(fwA)), false, "remote → local");
  } finally {
    await dropTempDir(ws);
  }
});

Deno.test("bundle cache: a record missing the framework or the server-only findings is not fresh", async () => {
  const ws = await tempDir("aio-fw-old-");
  try {
    const { fwA, cfg, record } = await scenario(ws);
    const framework = frameworkIdentity(cfg(fwA));
    await record({ framework, serverOnly: {} });
    assertEquals(await isBundleFresh(cfg(fwA)), true, "control: full record");
    await record({ serverOnly: {} });
    assertEquals(await isBundleFresh(cfg(fwA)), false, "no framework");
    // Never read as "no findings": the cached path would then skip the
    // standalone server-only refusal.
    await record({ framework });
    assertEquals(await isBundleFresh(cfg(fwA)), false, "no serverOnly");
    await record({ framework, serverOnly: { "node:fs": "x" } });
    assertEquals(await isBundleFresh(cfg(fwA)), false, "malformed serverOnly");
  } finally {
    await dropTempDir(ws);
  }
});
