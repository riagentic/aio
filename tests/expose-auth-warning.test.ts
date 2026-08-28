// The "--expose with no authentication" warning must tell the truth.
//
// It fired on `expose && !users && !token` — TRUE for `auth: true` apps and
// `resolveUser` apps, because neither of the two correctly-secured per-user
// configs sets `users` or a shared key. The strongest security warning crying
// wolf on exactly the configs that did the right thing teaches operators to
// ignore it — which is worse than not warning at all. The condition now reads
// the same `_perUserAuth` decider the rest of auth uses (users / resolveUser /
// auth:true), so only a genuinely open exposed app warns.
import { assert } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";

const WARNING = "no authentication configured";

/** Boot an EXPOSED app in-process (libraryMode, temp dirs, free port) with the
 *  given auth config, capturing everything the boot prints. `logging: false`
 *  routes log.warn through the console fallback, so the capture is exact. */
async function bootExposedCapture(
  extra: Record<string, unknown>,
): Promise<string> {
  const { cell, aio } = await import("../mod.ts");
  const c = cell(`wexp-${crypto.randomUUID().slice(0, 8)}`, {
    state: { n: 0 },
    visible: "all",
    methods: {},
  });
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    const app = await aio.run({
      cells: [c],
      appId: `warnexp-${crypto.randomUUID().slice(0, 8)}`,
      appVersion: "0.0.0",
      client: "server-only",
      persist: false,
      libraryMode: true,
      logging: false,
      singleton: false,
      port: freePort(),
      baseDir: await Deno.makeTempDir(),
      appDir: await Deno.makeTempDir(),
      expose: true,
      ...extra,
    });
    await app.close();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  return lines.join("\n");
}

Deno.test({
  name: "expose warning: silent for auth: true (per-user auth IS configured)",
  async fn() {
    const out = await bootExposedCapture({ auth: true });
    assert(
      !out.includes(WARNING),
      `an exposed app with auth: true is secured — the no-auth warning must ` +
        `not fire (cry-wolf false positive). Boot output:\n${out}`,
    );
  },
});

Deno.test({
  name: "expose warning: silent for resolveUser (per-user auth IS configured)",
  async fn() {
    const out = await bootExposedCapture({
      resolveUser: (tok: string) =>
        tok === "s3cret" ? { id: "u1", role: "admin" } : undefined,
    });
    assert(
      !out.includes(WARNING),
      `an exposed app with resolveUser is secured — the no-auth warning must ` +
        `not fire (cry-wolf false positive). Boot output:\n${out}`,
    );
  },
});

Deno.test({
  name:
    "expose warning: exposed + nothing is NO LONGER open — a key is generated (alpha52), so no no-auth warning",
  async fn() {
    const out = await bootExposedCapture({});
    assert(
      out.includes("generated a shared app key"),
      `exposed with no auth story now defaults to a generated key. Boot output:\n${out}`,
    );
    assert(
      !out.includes(WARNING),
      `with the generated key the app is NOT open — the no-auth warning would ` +
        `be a false positive. Boot output:\n${out}`,
    );
  },
});

Deno.test({
  name:
    "expose warning: still fires for a genuinely open exposed app (key: false)",
  async fn() {
    const out = await bootExposedCapture({ key: false });
    assert(
      out.includes(WARNING),
      `an exposed app that OPTED OUT (key: false) is genuinely open — the ` +
        `warning must keep firing. Boot output:\n${out}`,
    );
  },
});
