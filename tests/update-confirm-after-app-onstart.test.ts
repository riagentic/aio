// A pending update is confirmed only once the APP's `onStart` has come
// through. It was confirmed inside the boot, before `aio.run()` fired the
// app's hook — so a new build that died in `onStart` was recorded "confirmed
// healthy" first and never rolled back (a real AppImage update: 2.0.0 → a
// 3.0.0 that exits in onStart, and the installed app never started again).
// Child processes, because the failure is the process ending.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  bakedClient,
  pendingPath,
  readPending,
  RELAUNCH_FLAG,
  relaunchOptions,
  replayArgs,
} from "../src/server/updates-apply.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

async function bootWithPending(hook: string, exit = 7, bootAgain?: string) {
  const dir = await tempDir("aio-confirm-onstart-");
  try {
    const home = join(dir, "home");
    const data = join(home, "data");
    await Deno.mkdir(data, { recursive: true });
    const artifact = join(dir, "app-bin");
    await Deno.writeTextFile(artifact, "new");
    await Deno.writeTextFile(`${artifact}.old-1.0.0`, "old");
    await Deno.writeTextFile(
      pendingPath(data),
      JSON.stringify({
        from: "1.0.0",
        to: "2.0.0",
        previous: `${artifact}.old-1.0.0`,
        artifact,
        attempts: 0,
        startedAt: new Date().toISOString(),
      }),
    );
    const app = join(dir, "app.ts");
    const source = (hook: string, exit: number) =>
      `import { aio, cell } from ${JSON.stringify(MOD)};
const c = cell("confirmstart", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
const app = await aio.run({
  appId: "confirm-start-test", cells: [c], client: "server-only",
  appDir: ${JSON.stringify(home)}, dbPath: ":memory:",
  ${hook}
});
setTimeout(async () => { await app.close(); Deno.exit(${exit}); }, 1500);
`;
    await Deno.writeTextFile(app, source(hook, exit));
    const boot = async () => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", CONFIG, app, "--port=0"],
        env: {
          ...Deno.env.toObject(),
          NO_COLOR: "1",
          AIO_TEST_PENDING: pendingPath(data),
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      return {
        code: out.code,
        text: d.decode(out.stdout) + d.decode(out.stderr),
        pending: readPending(data),
      };
    };
    const first = await boot();
    if (bootAgain === undefined) return { ...first, again: null };
    // The next launch.
    await Deno.writeTextFile(app, source(bootAgain, 7));
    return { ...first, again: await boot() };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("update confirm: a build that exits in the app's onStart is NOT confirmed", async () => {
  const r = await bootWithPending(`onStart() { Deno.exit(3); },`);
  assertEquals(r.code, 3, r.text);
  assert(!r.text.includes("confirmed healthy"), r.text);
  assertEquals(r.pending?.attempts, 1, "the boot attempt was not left counted");
});

Deno.test("update confirm: a build whose async onStart exits after an await is NOT confirmed", async () => {
  const r = await bootWithPending(
    `async onStart() { await new Promise((r) => setTimeout(r, 50)); Deno.exit(3); },`,
  );
  assertEquals(r.code, 3, r.text);
  assert(!r.text.includes("confirmed healthy"), r.text);
  assertEquals(r.pending?.attempts, 1);
});

Deno.test("update confirm: a fatal onStart failure is NOT confirmed", async () => {
  const r = await bootWithPending(
    `fatalOnStart: true, onStart() { throw new Error("seed failed"); },`,
  );
  assertEquals(r.code, 1, r.text);
  assert(!r.text.includes("confirmed healthy"), r.text);
  assertEquals(r.pending?.attempts, 1);
});

for (
  const [what, hook] of [
    ["no onStart", ""],
    ["a sync onStart", `onStart() {},`],
    ["an async onStart", `async onStart() { await Promise.resolve(); },`],
    ["a non-fatal failing onStart", `onStart() { throw new Error("x"); },`],
  ] as const
) {
  Deno.test(`update confirm: a build with ${what} that keeps running IS confirmed`, async () => {
    const r = await bootWithPending(hook);
    assertEquals(r.code, 7, r.text);
    assert(r.text.includes("update 1.0.0 → 2.0.0 confirmed healthy"), r.text);
    assertEquals(r.pending, null);
  });
}

/** A next boot that dies in its own `onStart`: it can confirm nothing
 *  itself, so a confirmation there came from the stamp left at exit. */
const DIE = `onStart() { Deno.exit(3); },`;

Deno.test("update confirm: a build whose onStart ends the process CLEANLY (exit 0) IS confirmed", async () => {
  // The next boot dies in its own onStart: only the stamp can confirm it.
  const r = await bootWithPending(`onStart() { Deno.exit(0); },`, 7, DIE);
  assertEquals(r.code, 0, r.text);
  // Stamped at exit; the next boot confirms it — with its log line and prune.
  assert(r.pending?.confirmedAt, `not stamped at exit: ${r.text}`);
  assertEquals(r.again?.code, 3, r.again?.text);
  assert(
    r.again?.text.includes("update 1.0.0 → 2.0.0 confirmed healthy"),
    r.again?.text,
  );
  assertEquals(r.again?.pending, null);
});

Deno.test("update confirm: a quit (exit 0) while an async onStart still runs IS confirmed — two quick quits no longer roll a healthy build back", async () => {
  const r = await bootWithPending(
    `async onStart() { await new Promise(() => {}); },`,
    0,
    DIE,
  );
  assertEquals(r.code, 0, r.text);
  assert(r.pending?.confirmedAt, `not stamped at exit: ${r.text}`);
  assertEquals(r.pending?.attempts, 1, "the quit counted as a failed boot");
  assert(
    r.again?.text.includes("update 1.0.0 → 2.0.0 confirmed healthy"),
    r.again?.text,
  );
  assertEquals(r.again?.pending, null);
});

Deno.test("update confirm: a late confirm leaves the NEXT update's marker alone (an install this build ran)", async () => {
  // The hook plays an install that finished while `onStart` was still
  // running: the marker on disk is now 2.0.0 → 3.0.0, which never booted.
  const r = await bootWithPending(
    `async onStart() {
      const p = Deno.env.get("AIO_TEST_PENDING");
      const m = JSON.parse(Deno.readTextFileSync(p));
      Deno.writeTextFileSync(p, JSON.stringify({ ...m, from: "2.0.0", to: "3.0.0", startedAt: new Date(Date.now() + 1000).toISOString() }));
    },`,
  );
  assertEquals(r.code, 7, r.text);
  assert(!r.text.includes("confirmed healthy"), r.text);
  assertEquals(r.pending?.to, "3.0.0", "the next update lost its rollback");
});

// The successor's argv. A compiled binary gets its baked `--client=` in front
// of its argv and the successor bakes its own again: replayed whole, every
// update added one more `--client=electron` (measured on a real AppImage).
Deno.test("replayArgs: keeps only the last --client= and drops the relaunch flag", () => {
  assertEquals(
    replayArgs([
      "--client=electron",
      "--port=0",
      "--client=electron",
      `${RELAUNCH_FLAG}=42`,
      "--x",
    ]),
    ["--port=0", "--client=electron", "--x"],
  );
  // The one the parser obeys is the last: an operator's later choice stays.
  assertEquals(replayArgs(["--client=electron", "--client=browser"]), [
    "--client=browser",
  ]);
  assertEquals(replayArgs(["--port=0"]), ["--port=0"]);
});

Deno.test("replayArgs: a compiled binary's own bake is dropped — the NEW build bakes its own, a user's --client= still wins", () => {
  // The old build baked electron, the new one bakes something else: the
  // successor must not be forced back onto the old build's choice.
  assertEquals(replayArgs(["--client=electron", "--port=0"], true), [
    "--port=0",
  ]);
  assertEquals(
    replayArgs(["--client=electron", "--client=browser"], true),
    ["--client=browser"],
  );
  // Not compiled (or a "client": "cli" binary, which bakes nothing): the
  // first --client= is the user's.
  assertEquals(replayArgs(["--client=browser"], false), ["--client=browser"]);
  // A relaunch flag an older aio appended past `--` is still aio's.
  assertEquals(replayArgs(["--port=0", "--", "a", `${RELAUNCH_FLAG}=9`]), [
    "--port=0",
    "--",
    "a",
  ]);
  // Past a bare `--` the argv is the app's own: untouched.
  assertEquals(
    replayArgs(["--client=electron", "--", "--client=x", "--client=y"], true),
    ["--", "--client=x", "--client=y"],
  );
});

Deno.test("relaunchOptions: the relaunch flag goes before a bare --", () => {
  assertEquals(
    relaunchOptions(["--port=0", "--", "a"], "null", "linux", 42).args,
    ["--port=0", `${RELAUNCH_FLAG}=42`, "--", "a"],
  );
  assertEquals(relaunchOptions(["--port=0"], "null", "linux", 42).args, [
    "--port=0",
    `${RELAUNCH_FLAG}=42`,
  ]);
});

Deno.test("bakedClient: only an aio-built (stamped), non-cli compiled binary carries a baked --client=", () => {
  const dir = new URL("file:///app/");
  const at = (client?: string) => ({ config: client ? { client } : {}, dir });
  assertEquals(bakedClient(true, at("electron"), () => true), true);
  assertEquals(bakedClient(true, at(), () => true), true);
  // A "client": "cli" binary gets nothing baked (build-compile.ts).
  assertEquals(bakedClient(true, at("cli"), () => true), false);
  // A hand-run `deno compile`: no stamp, nothing baked.
  assertEquals(bakedClient(true, at("electron"), () => false), false);
  // From source, or no deno.json found.
  assertEquals(bakedClient(false, at("electron"), () => true), false);
  assertEquals(bakedClient(true, undefined, () => true), false);
});
