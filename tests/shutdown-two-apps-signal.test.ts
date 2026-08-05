// Ctrl-C on a process that hosts TWO apps must stop BOTH of them.
//
// `tests/shutdown-two-apps.test.ts` pins that one app closing is invisible to
// the other. This pins the other half — the one only a real process can show:
// what happens when the PROCESS is told to end.
//
// Every exit path used to be written per-app —
// `Deno.addSignalListener(sig, () => shutdown().then(() => Deno.exit(0)))`,
// registered once by each `aio.run()` — so on SIGTERM both handlers started
// and the FIRST app to finish exited the process through the second app's
// final persist. The app that lost was the one with more state to write, which
// is the app with more to lose: measured, a second app holding an 8 MB
// snapshot came back from a plain SIGTERM with NO stored state at all, and the
// only trace was that its "stopped" line never appeared.
//
// Ending the process is a decision about the PROCESS (`shutdownAllRuntimes`),
// and the same rule covers `am stop` and the Electron window closing, which
// both call `Deno.exit` too.
import { assert, assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";

// deno-lint-ignore no-explicit-any
type Any = any;

const APP = `
import { aio, cell } from "${new URL("../mod.ts", import.meta.url).href}";
const D = Deno.env.get("D");
const small = cell("small", { state: { n: 0 }, methods: { bump(s) { s.n++; } } });
const big = cell("big", {
  state: { n: 0, blob: "" },
  methods: { bump(s) { s.n++; }, fill(s, v) { s.blob = v; } },
});
// Two apps, one process — supported (D2), and the default (non-library) mode,
// so each installs its own signal handler.
await aio.run({
  cells: [small], appId: "sig-small", appVersion: "0.0.0",
  client: "server-only", persist: true, port: Number(Deno.env.get("PORT_A")),
  appDir: D + "/a", persistDebounceMs: 100000,
});
await aio.run({
  cells: [big], appId: "sig-big", appVersion: "0.0.0",
  client: "server-only", persist: true, port: Number(Deno.env.get("PORT_B")),
  appDir: D + "/b", persistDebounceMs: 100000,
});
// A snapshot big enough that the second app's final write takes real time.
await big.fill("y".repeat(8_000_000));
await small.bump();
await big.bump();     // BOTH calls have RESOLVED — both writes must survive
// The debounce is effectively infinite, so ONLY the shutdown flush can save
// them: this measures the shutdown, not the timer.
Deno.writeTextFileSync(D + "/ready", "1");
await new Promise(() => {});
`;

/** The `n` this app stored, or null when it stored nothing at all. */
function storedN(dir: string, cell: string): number | null {
  const db = new DatabaseSync(`${dir}/data/state.db`, { readOnly: true });
  const rows = db.prepare("SELECT k, v FROM aio_kv").all() as {
    k: string;
    v: string;
  }[];
  db.close();
  for (const r of rows) {
    const doc = JSON.parse(r.v) as Any;
    if (doc && typeof doc === "object" && doc[cell]) {
      return doc[cell].n as number;
    }
    if (doc && typeof doc === "object" && typeof doc.n === "number") {
      return doc.n;
    }
  }
  return null;
}

Deno.test("SIGTERM stops EVERY app in the process, not just the quickest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-sig-two-apps-" });
  await Deno.mkdir(`${dir}/a`, { recursive: true });
  await Deno.mkdir(`${dir}/b`, { recursive: true });
  await Deno.writeTextFile(`${dir}/app.ts`, APP);

  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      new URL("../deno.json", import.meta.url).pathname,
      `${dir}/app.ts`,
    ],
    env: {
      D: dir,
      PORT_A: String(freePort()),
      PORT_B: String(freePort()),
      AIO_APPS_DIR: dir,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        await Deno.stat(`${dir}/ready`);
        break;
      } catch { /* still booting */ }
      await new Promise((r) => setTimeout(r, 20));
    }
    proc.kill("SIGTERM");
    const out = await proc.output();
    const said = new TextDecoder().decode(out.stderr) +
      new TextDecoder().decode(out.stdout);

    assertEquals(
      storedN(`${dir}/a`, "small"),
      1,
      `the first app's write must survive — log:\n${said.slice(-1500)}`,
    );
    const bigN = storedN(`${dir}/b`, "big");
    assert(
      bigN !== null,
      "the SECOND app stored NOTHING: the process exited as soon as the " +
        "first app's shutdown finished, straight through the second app's " +
        `final snapshot. Log:\n${said.slice(-1500)}`,
    );
    assertEquals(
      bigN,
      1,
      "the second app's resolved write must survive the same signal",
    );
  } finally {
    try {
      proc.kill("SIGKILL");
    } catch { /* already gone */ }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
