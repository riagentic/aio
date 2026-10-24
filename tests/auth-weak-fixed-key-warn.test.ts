// A fixed shared `key` is the ONLY credential in front of an exposed app, and
// the failure budget slows a guesser without stopping one (a valid key is
// always served). A short static `users:` token has been announced at boot
// since the weak-token check landed; `key: "abc"` — the same credential with a
// different name — booted exposed without a word. Same bar, same line.
import { assert, assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function bootWarnings(key: string | boolean): Promise<string[]> {
  const { aio, cell } = await import("../mod.ts");
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );
  const c = cell(`wk-${crypto.randomUUID().slice(0, 8)}`, {
    state: { n: 0 },
    visible: "all",
    methods: {},
  });
  const baseDir = await tempDir("aio-weak-key-");
  const appDir = await tempDir("aio-weak-key-");
  const warnings: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") warnings.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    const app = await aio.run({
      cells: [c],
      appId: `weakkey-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      port: freePort(),
      host: "127.0.0.1",
      tls: false,
      expose: true,
      key,
      baseDir,
      appDir,
      watch: false,
    });
    await app.close();
  } finally {
    setLogger(prev);
    await dropTempDir(baseDir);
    await dropTempDir(appDir);
  }
  return warnings.filter((w) => w.includes("weak fixed `key`"));
}

Deno.test("an exposed app with a weak fixed key says so, without the key", async () => {
  const w = await bootWarnings("abc123");
  assertEquals(w.length, 1, "a guessable shared key must be announced");
  assert(!w[0]!.includes("abc123"), "the key itself is never logged");
});

Deno.test("a strong fixed key, or a generated one, says nothing", async () => {
  assertEquals(await bootWarnings(crypto.randomUUID()), []);
  assertEquals(await bootWarnings(true), []);
});
