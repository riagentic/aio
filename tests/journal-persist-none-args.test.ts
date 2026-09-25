// `persist: "none"` promises the cell's value never reaches disk — and under
// `journal: true` its METHOD ARGUMENTS did: `vault:setTok("SECRET")` was
// journalled as `{"type":"vault:setTok","payload":{"args":["SECRET"]}}` in
// cleartext, and every `am backup` taken before the next compaction kept it.
// The arguments of a method on a cell that stores nothing ARE its state.
//
// The line exists for replay, and a `persist: "none"` cell's state is never
// restored — so its own calls need not be replayed (replaying them put the
// secret back in memory after a crash, which a clean restart never does).
// What a call does to PERSISTED cells must stay durable: a `listensTo`
// reaction to it is journalled as data (the reaction-line format sync
// reactions already use), never as the raw call. The call's own line keeps
// its seq and type, with its payload withheld (`unstored`).
//
// Real disk, real SIGKILL inside the persist debounce.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const vault = cell("vault", {
  persist: "none",
  state: { tok: "", n: 0 },
  methods: {
    setTok(s, t) { s.tok = t; s.n++; },
    async setTokLater(s, t) { await Promise.resolve(); s.tok = t; s.n++; },
  },
});
const audit = cell("audit", {
  state: { seen: 0 },
  methods: { onTok(s) { s.seen++; } },
  listensTo: { onTok: vault.setTok },
});
const plain = cell("plain", {
  state: { n: 0 },
  methods: { inc(s) { s.n++; } },
});
const app = await aio.run({
  cells: [vault, audit, plain],
  appId: "journal-none-args-probe",
  client: "server-only",
  journal: true,
  persistDebounceMs: 5000,
  port: PORT,
  appDir: DIR,
});
const call = async (type, args) => {
  const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify({ type, payload: { args } }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(type + " " + res.status + " " + text);
};
if (PHASE === "run") {
  await call("plain:inc", []);
  await call("vault:setTok", ["SECRET-SYNC-ARG"]);
  await call("plain:inc", []);
  await call("vault:setTok", ["SECRET-SYNC-ARG-2"]);
  await vault.setTokLater("SECRET-ASYNC-ARG");
  Deno.kill(Deno.pid, "SIGKILL"); // inside the 5 s debounce
} else {
  Deno.writeTextFileSync(
    DIR + "/recovered.json",
    JSON.stringify({ vault: vault.tok, audit: audit.seen, plain: plain.n }),
  );
  await app.close();
  Deno.exit(0);
}
`;

async function runChild(dir: string, phase: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase === "read" && !out.success) {
    throw new Error(`read child failed:\n${text}`);
  }
  return text;
}

Deno.test(`journal: a persist:"none" cell's method arguments never reach the journal — its listensTo reactions on persisted cells still survive a SIGKILL`, async () => {
  const dir = await tempDir("aio-journal-none-args-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const runLog = await runChild(dir, "run");
    const journal = await Deno.readTextFile(join(dir, "data", "journal"));
    assert(
      /"type":"plain:inc"/.test(journal),
      `the crash left no journal tail — nothing below is a check\n${runLog}`,
    );
    for (const secret of ["SECRET-SYNC-ARG", "SECRET-ASYNC-ARG"]) {
      assert(
        !journal.includes(secret),
        `a persist:"none" method's argument is on disk in the journal:\n${journal}`,
      );
    }
    const bootLog = await runChild(dir, "read");
    const recovered = JSON.parse(
      await Deno.readTextFile(join(dir, "recovered.json")),
    );
    assertEquals(
      recovered,
      // vault: never restored — a crash must not bring it back either.
      // audit: both reactions durable. plain: both calls replayed.
      { vault: "", audit: 2, plain: 2 },
      `--- run:\n${runLog}\n--- boot:\n${bootLog}\n--- journal:\n${journal}`,
    );
    // Withheld by design, not lost: no "could not be replayed" alarm.
    assert(
      !/redactActions|could not be replayed|COULD NOT/i.test(bootLog),
      bootLog,
    );
  } finally {
    await dropTempDir(dir);
  }
});
