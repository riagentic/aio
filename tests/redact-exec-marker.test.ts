// An async method is scheduled as `cell:__exec` `{ _method, _args }` — the
// call's arguments again, under a type that is not the call's. With
// `--verbose` the dispatch loop logs every effect (`effect → execute: …`), and
// an EXACT `redactActions: ["vault:unlockWith"]` did not resolve `__exec` to
// its method, so the passphrase reached debug.log:
//
//   effect → execute: vault:__exec {"_method":"unlockWith","_args":["hunter2"]}
//
// Pinned end to end, in a real `--verbose` process: no sink that retains
// payloads (console, debug.log, app.log, actions.jsonl, the timeline) holds it.
import { assert, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const SECRET = "hunter2-EXEC-MARKER";
const repo = join(import.meta.dirname!, "..");
const root = toFileUrl(repo).href;

const app = (effects: boolean) => `
import { cell } from "${spec(root)}/src/state/cell-create.ts";
import { schedule } from "${spec(root)}/src/state/schedule.ts";
import { self } from "${spec(root)}/src/state/self.ts";
import { testServer } from "${spec(root)}/src/testing/server-test.ts";
const dir = Deno.env.get("T_DIR");
const vault = cell("vault", {
  state: { unlocked: false },
  methods: {
    async unlockWith(s, passphrase) {
      await Promise.resolve();
      s.unlocked = true;
      ${
  effects
    ? 's.$do(schedule.after("relock", 3_600_000, self("lock", passphrase)));'
    : ""
}
    },
    lock(s, _passphrase) {
      s.unlocked = false;
    },
  },
});
const srv = await testServer({
  cells: [vault],
  baseDir: dir,
  appId: "redact-exec",
  redactActions: ["vault:unlockWith", "vault:lock"],
  logging: { level: "debug", dir: dir + "/logs" },
});
await vault.unlockWith("${SECRET}");
const tl = await fetch(srv.url + "/__aio/trojan/timeline");
await Deno.writeTextFile(dir + "/timeline.json", await tl.text());
await srv.close();
`;

async function assertNoLeak(effects: boolean, marker: string): Promise<void> {
  const dir = await tempDir("aio-redact-exec-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), app(effects));
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--no-lock",
        "--config",
        join(repo, "deno.json"),
        join(dir, "app.ts"),
        "--verbose",
      ],
      env: { T_DIR: dir, NO_COLOR: "1" },
      stdin: "null",
    }).output();
    const console = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assert(out.success, console);
    const sinks: Record<string, string> = { console };
    for (const f of ["debug.log", "app.log", "actions.jsonl"]) {
      sinks[f] = await Deno.readTextFile(join(dir, "logs", f));
    }
    // The instrument: the verbose effect line for the marker was written.
    assertStringIncludes(sinks["debug.log"]!, marker);
    sinks.timeline = await Deno.readTextFile(join(dir, "timeline.json"));
    assertStringIncludes(sinks.timeline!, "vault:unlockWith");
    assertStringIncludes(sinks["actions.jsonl"]!, "vault:unlockWith");
    for (const [name, text] of Object.entries(sinks)) {
      assert(!text.includes(SECRET), `${name} holds the passphrase:\n${text}`);
    }
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("redact: an exact pattern covers the async method's __exec marker in every sink", () =>
  assertNoLeak(false, "effect → execute: vault:__exec"));

// The effects an async method hands to `$do` ride `vault:__effects` — the
// secret inside them was logged under a type no exact pattern named.
Deno.test("redact: an exact pattern covers the async method's __effects frame in every sink", () =>
  assertNoLeak(true, "action → reduce: vault:__effects"));
