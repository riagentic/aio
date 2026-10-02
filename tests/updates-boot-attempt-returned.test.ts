// A launch that was refused for what was TYPED is not a boot attempt of an
// update.
//
// The new build gets two boots to prove itself; the third start after two
// that did not confirm puts the old version back. The attempt is counted
// early in the boot — after the lock, so "already running" costs none — and a
// launch refused a moment later for a flag its client cannot honour
// (`--keep-server` on a browser client) was counted too: typed three times,
// it rolled a healthy update back. That refusal gives its attempt back. A
// boot that fails on its own still counts — it is what a rollback is for.
// Child processes: the refusal is the process ending.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  pendingPath,
  readPending,
  writePending,
} from "../src/server/updates-apply.ts";
import {
  judgePendingUpdate,
  returnBootAttempt,
} from "../src/server/updates-boot.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** An installed update waiting for its first boots, and an app to boot. */
async function installed(config: string) {
  const dir = await tempDir("aio-attempt-returned-");
  const home = join(dir, "home"), data = join(home, "data");
  await Deno.mkdir(data, { recursive: true });
  const artifact = join(dir, "app-bin");
  await Deno.writeTextFile(artifact, "new");
  await Deno.writeTextFile(`${artifact}.old-1.0.0`, "old");
  writePending(data, {
    from: "1.0.0",
    to: "2.0.0",
    previous: `${artifact}.old-1.0.0`,
    artifact,
    attempts: 0,
    startedAt: new Date().toISOString(),
  });
  const app = join(dir, "app.ts");
  await Deno.writeTextFile(
    app,
    `import { aio, cell } from ${JSON.stringify(MOD)};
const c = cell("attemptreturned", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({
  appId: "attempt-returned-test", cells: [c], client: "server-only",
  appDir: ${JSON.stringify(home)}, dbPath: ":memory:",
  ${config}
});
`,
  );
  const launch = (...flags: string[]) =>
    new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, app, "--port=0", ...flags],
      env: { ...Deno.env.toObject(), NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    });
  return {
    artifact,
    attempts: () => readPending(data)?.attempts,
    launch,
    boot: async (...flags: string[]) => {
      const out = await launch(...flags).output();
      return { code: out.code, said: text(out.stdout) + text(out.stderr) };
    },
    end: () => dropTempDir(dir),
  };
}

Deno.test("boot attempt: a launch refused for a flag its client cannot honour is not counted — however often", async () => {
  const i = await installed("");
  try {
    for (const _ of [1, 2, 3]) {
      const r = await i.boot("--keep-server");
      assert(r.code !== 0, r.said);
      assertMatch(r.said, /--keep-server/);
      assertMatch(r.said, /not counted as a boot attempt of update 1\.0\.0/);
      assertEquals(i.attempts(), 0, r.said);
    }
    assertEquals(await Deno.readTextFile(i.artifact), "new", "rolled back");
  } finally {
    await i.end();
  }
});

Deno.test("boot attempt: a launch refused because the app is already running is not counted", async () => {
  // The first never finishes its onStart: running, counted once, unconfirmed.
  const i = await installed("onStart: () => new Promise(() => {}),");
  const first = i.launch().spawn();
  try {
    const until = Date.now() + 60_000;
    while (i.attempts() !== 1) {
      assert(Date.now() < until, "the first launch never counted its boot");
      await new Promise((r) => setTimeout(r, 50));
    }
    const second = await i.boot();
    assertMatch(second.said, /Already running/);
    assertEquals(i.attempts(), 1, second.said);
  } finally {
    first.kill("SIGKILL");
    await first.output();
    await i.end();
  }
});

Deno.test("boot attempt: a boot that fails on its own before the app is up still counts — and the third start rolls back", async () => {
  // Refused between the count and the point the app's own shutdown exists.
  const i = await installed(`_workerEntry: "nowhere.ts",`);
  try {
    for (const n of [1, 2]) {
      const r = await i.boot();
      assert(r.code !== 0, r.said);
      assertMatch(r.said, /_workerEntry/);
      assertEquals(i.attempts(), n, r.said);
    }
    const third = await i.boot();
    assertMatch(third.said, /rolled back/, third.said);
    assertEquals(await Deno.readTextFile(i.artifact), "old");
  } finally {
    await i.end();
  }
});

Deno.test("boot attempt: only the one this process counted is given back, and only once", async () => {
  const data = await tempDir("aio-attempt-returned-unit-");
  try {
    const said: string[] = [];
    const log = new Proxy({}, {
      get: () => (_tag: string, msg: string) => void said.push(msg),
    }) as unknown as Log;
    const mark = (attempts: number, startedAt: string) =>
      writePending(data, {
        from: "1.0.0",
        to: "2.0.0",
        previous: join(data, "none"),
        attempts,
        startedAt,
      });
    // Counted by an earlier process: not this one's to give back.
    mark(1, "2026-01-01T00:00:00.000Z");
    returnBootAttempt(data, log);
    assertEquals(readPending(data)?.attempts, 1);
    // Counted here.
    mark(0, "2026-01-02T00:00:00.000Z");
    assertEquals(await judgePendingUpdate(data, log, "2.0.0"), false);
    assertEquals(readPending(data)?.attempts, 1);
    returnBootAttempt(data, log);
    assertEquals(readPending(data)?.attempts, 0);
    assertEquals(said.filter((m) => m.includes("not counted")).length, 1);
    // …once: a second call does not take an earlier boot's attempt.
    mark(1, "2026-01-02T00:00:00.000Z");
    returnBootAttempt(data, log);
    assertEquals(readPending(data)?.attempts, 1);
    assertEquals(pendingPath(data).startsWith(data), true);
  } finally {
    await dropTempDir(data);
  }
});
