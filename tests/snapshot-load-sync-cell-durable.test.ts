// A snapshot load reaches a `sync: true` cell's durable store, not only its
// live state.
//
// `loadSnapshot` (the `app.loadSnapshot()` API, `POST /__aio/snapshot` and
// `am snapshot load` via trojan — all three call it) replaced live state and
// scheduled a KV persist. A sync cell is not in the KV snapshot: its durable
// record is its op-log plus the CRDT snapshot a server write is folded into,
// and the load wrote neither. So the load answered "loaded", every tab showed
// the loaded state, and `am persist` + a restart (clean stop or SIGKILL,
// journal on or off) brought back the writes the load had undone — while the
// plain cell beside it stayed loaded. Time travel makes the same kind of
// wholesale swap durable with `_jumpSyncCells`; the load now does too.
import { assertEquals } from "@std/assert";
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
const DOOR = Deno.env.get("DOOR");
const methods = { add(s, v) { s.log.push(v); } };
const plain = cell("plain", { state: { log: [] }, methods });
const shared = cell("shared", { sync: true, state: { log: [] }, methods });
const app = await aio.run({
  cells: [plain, shared],
  appId: "snapshot-sync-probe",
  client: "server-only",
  journal: Deno.env.get("JOURNAL") === "1",
  port: PORT,
  appDir: DIR,
});
const post = async (route, body) => {
  const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/" + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body,
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(route + " " + res.status + " " + text);
};
const call = (type, v) =>
  post("dispatch", JSON.stringify({ type, payload: { args: [v] } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (PHASE === "run") {
  await call("plain:add", "keep");
  await call("shared:add", "keep");
  await sleep(800); // the sync write folded: the op-log is past "keep"
  const snap = app.snapshot();
  await call("plain:add", "UNDO-ME");
  await call("shared:add", "UNDO-ME");
  await sleep(800);
  if (DOOR === "route") await post("snapshot", snap);
  else app.loadSnapshot(snap);
  const END = Deno.env.get("END");
  if (END === "crash-now") Deno.kill(Deno.pid, "SIGKILL");
  await post("persist", "{}"); // am persist: "on disk"
  if (END === "crash") Deno.kill(Deno.pid, "SIGKILL");
  await app.close();
  Deno.exit(0);
} else {
  Deno.writeTextFileSync(
    DIR + "/recovered.json",
    JSON.stringify({ plain: plain.log, shared: shared.log }),
  );
  await app.close();
  Deno.exit(0);
}
`;

async function runChild(
  dir: string,
  env: Record<string, string>,
): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (env.PHASE === "read" && !out.success) {
    throw new Error(`read child failed:\n${text}`);
  }
  return text;
}

const CASES = [
  { journal: "0", end: "close", door: "api" },
  { journal: "0", end: "crash", door: "api" },
  { journal: "1", end: "close", door: "api" },
  { journal: "1", end: "crash", door: "route" },
  // No persist at all: the journal alone must carry the load.
  { journal: "1", end: "crash-now", door: "api" },
] as const;

for (const c of CASES) {
  Deno.test(`snapshot load: a sync:true cell's loaded state survives a restart (journal ${c.journal === "1" ? "on" : "off"}, ${c.end}, ${c.door})`, async () => {
    const dir = await tempDir("aio-snapshot-sync-");
    try {
      await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
      const env = { JOURNAL: c.journal, END: c.end, DOOR: c.door };
      const runLog = await runChild(dir, { ...env, PHASE: "run" });
      const bootLog = await runChild(dir, { ...env, PHASE: "read" });
      const recovered = JSON.parse(
        await Deno.readTextFile(join(dir, "recovered.json")),
      );
      assertEquals(
        recovered,
        { plain: ["keep"], shared: ["keep"] },
        `the load undid "UNDO-ME" in both cells — a restart must not bring ` +
          `it back in the sync one.\n--- run:\n${runLog}\n--- boot:\n${bootLog}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  });
}

Deno.test(`snapshot load --force without a sync cell: the cell is wiped to its initial state live, a restart agrees, and nothing reports a hidden cell`, async () => {
  const dir = await tempDir("aio-snapshot-force-sync-");
  const { aio, cell } = await import("../mod.ts");
  const boot = async () => {
    const methods = {
      add(s: { log: string[] }, v: string) {
        s.log.push(v);
      },
    };
    const plain = cell("forcePlain", {
      state: { log: [] as string[] },
      methods,
    });
    const shared = cell("forceShared", {
      sync: true,
      state: { log: [] as string[] },
      methods,
    });
    const app = await aio.run({
      cells: [plain, shared],
      appId: "snapshot-force-sync",
      client: "server-only",
      persist: true,
      libraryMode: true,
      port: freePort(),
      appDir: dir,
    });
    return { app, plain, shared };
  };
  const lines: string[] = [];
  const orig = { error: console.error, warn: console.warn };
  console.error = console.warn = (...a: unknown[]) =>
    void lines.push(a.map(String).join(" "));
  try {
    {
      const { app, plain, shared } = await boot();
      await plain.add("keep");
      await shared.add("keep");
      await new Promise((r) => setTimeout(r, 700)); // folded
      app.loadSnapshot!(JSON.stringify({ forcePlain: { log: ["loaded"] } }), {
        force: true,
      });
      // Wiped means wiped to what a restart gives: the declared state — not
      // a missing slice every method then throws on.
      assertEquals(
        (app.getState() as Record<string, unknown>).forceShared,
        { log: [] },
      );
      await shared.add("after");
      await app.close();
    }
    {
      const { app } = await boot();
      assertEquals(
        (app.getState() as Record<string, unknown>).forceShared,
        { log: ["after"] },
      );
      await app.close();
    }
    const hidden = lines.filter((l) => /cannot be pushed|REDUCE_ERROR/.test(l));
    assertEquals(hidden, [], lines.join("\n"));
  } finally {
    Object.assign(console, orig);
    await dropTempDir(dir);
  }
});
