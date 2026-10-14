// A cell file saved while the app is still STARTING must not be dropped.
//
// The dev watcher starts with the server — after the module graph is loaded,
// the lock taken and the store opened. A save in that stretch has no watcher
// event: the process had loaded the old file and nothing restarted it. The
// lock names the app and its port from early in that stretch, so a tool that
// waits for the lock and then saves hit it every time.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  RESTART_SAVED_ENV,
  RESTART_STORM_LIMIT,
  savedCarry,
  savedStamps,
  savedWhileStarting,
  supervisorEnv,
} from "../src/server/dev-restart.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { childEnv, freePort, kill } from "./e2e-app-harness.ts";
import { spec } from "./module-spec-helper.ts";

const cellSource = (mark: string) =>
  `import { cell } from "aio";
export const probe = cell("probe", {
  state: { mark: "${mark}" },
  methods: { set(s: { mark: string }, m: string) { s.mark = m; } },
});
`;
/** The entry SAVES the cell file after it was loaded and before `aio.run()`
 *  — the gap, by construction — and writes `gen.ts` (a cell file, the same
 *  bytes) on every start, as an app's own codegen does. */
const appSource = (port: number) =>
  `import { aio } from "aio";
import { probe } from "./cell.ts";
const at = (f: string) => new URL(f, import.meta.url);
Deno.writeTextFileSync(at("./gen.ts"), 'export const made = () => cell("made");\\n');
const src = Deno.readTextFileSync(at("./cell.ts"));
if (src.includes('"v1"')) {
  Deno.writeTextFileSync(at("./cell.ts"), src.replace('"v1"', '"v2"'));
}
await aio.run({
  appId: "dev-restart-saved-before-watch-e2e",
  cells: [probe],
  client: "server-only",
  persist: false,
  port: ${port},
  routes: { "/mark": () => new Response(probe.mark) },
});
`;

async function served(url: string, want: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/mark`);
      if ((await res.text()).trim() === want) return true;
    } catch {
      // not up (yet, or between two restarts) — asked again below
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

Deno.test({
  name:
    "dev-restart e2e: a cell file saved before the watcher was up restarts the app; a file the start itself writes does not",
  async fn() {
    const dir = await tempDir("dev-restart-gap-");
    const port = freePort();
    const url = `http://127.0.0.1:${port}`;
    const repo = fromFileUrl(new URL("../", import.meta.url));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${spec(repo)}mod.ts`,
          "aio/": `${spec(repo)}src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "app.ts"), appSource(port));
    await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v1"));
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts")],
      cwd: dir,
      env: childEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let text = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) text += new TextDecoder().decode(c);
    };
    const drained = Promise.allSettled([
      drain(child.stdout),
      drain(child.stderr),
    ]);
    try {
      assert(
        await served(url, "v2", 45_000),
        `the cell saved while the app was starting was never applied:\n${text}`,
      );
      // An edit the watcher sees, so two more starts have run by the count.
      await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v3"));
      assert(await served(url, "v3", 45_000), `v3 never served:\n${text}`);
      assertEquals(
        text.match(/restarting the app/g)?.length,
        2,
        `one restart for the save in the gap, one for the edit — gen.ts, ` +
          `which every start writes, restarts nothing:\n${text}`,
      );
    } finally {
      await kill(child);
      await drained;
      await dropTempDir(dir);
    }
  },
});

Deno.test("savedWhileStarting: fresh saves are named; the carry's are not; the streak ends it; the carry is a supervised child's only", async () => {
  const dir = await tempDir("dev-restart-saved-");
  try {
    const a = join(dir, "a.ts");
    const b = join(dir, "sub", "b.tsx");
    await Deno.mkdir(join(dir, "sub"));
    await Deno.writeTextFile(a, "1");
    await Deno.writeTextFile(b, "1");
    await Deno.writeTextFile(join(dir, "notes.txt"), "not source");
    const since = Date.now() - 60_000;
    const env = (saved: string, child = "1") => (k: string) =>
      ({ AIO_DEV_SUPERVISED: child, [RESTART_SAVED_ENV]: saved })[k];
    const none = () => undefined;
    assertEquals(savedWhileStarting([dir], since, none).sort(), [a, b]);
    assertEquals(savedWhileStarting([dir], Date.now() + 60_000, none), []);
    // What the last start found, byte for byte, is the start's own writing.
    const carry = savedCarry(1, savedStamps([a, b]));
    assertEquals(savedWhileStarting([dir], since, env(carry)), []);
    await Deno.writeTextFile(a, "2");
    assertEquals(savedWhileStarting([dir], since, env(carry)), [a]);
    // …and is no word at all outside a supervised child.
    assertEquals(
      savedWhileStarting([dir], since, env(carry, "")).sort(),
      [a, b],
    );
    assertEquals(
      savedWhileStarting([dir], since, env(`${RESTART_STORM_LIMIT - 1}:`))
        .sort(),
      [a, b],
    );
    assertEquals(
      savedWhileStarting([dir], since, env(`${RESTART_STORM_LIMIT}:`)),
      [],
    );
    assertEquals(
      supervisorEnv(7, undefined, carry)[RESTART_SAVED_ENV],
      carry,
    );
    assertEquals(RESTART_SAVED_ENV in supervisorEnv(7, undefined), false);
  } finally {
    await dropTempDir(dir);
  }
});
