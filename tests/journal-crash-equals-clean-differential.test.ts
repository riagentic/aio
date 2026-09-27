// DIFFERENTIAL: a restart after SIGKILL restores exactly what a restart after a
// clean stop restores, for random write programs.
//
// A clean stop persists the state and the next boot restores it through
// `deepMerge(declared, stored)` (+ `persist.exclude` read-back); a SIGKILL
// leaves the tail in the journal and the next boot REPLAYS it. Two roads to
// one state — and every time they have disagreed it was a bug of the same
// class, found one shape at a time: persist.exclude, onPersist, a deleted
// declared key, an undeclared key, an undeclared cell. This drives the shapes
// at random so the class stays closed.
//
// `AIO_CRASH_DIFF_N` widens it, `AIO_CRASH_DIFF_SEED` replays one program.
import { assert, assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { mulberry32 } from "./sync/properties/_prop.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

type Op = [
  kind: "set" | "del" | "push" | "splice",
  path: string[],
  v?: unknown,
];

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const d = cell("d", {
  state: {
    m: { a: 1, b: { c: 2 } },
    list: [] as unknown[],
    tags: {} as Record<string, unknown>,
    n: 0,
    secret: "",
  },
  persist: { exclude: ["secret"] },
  methods: {
    op(s, kind, path, v) {
      let o = s;
      for (const seg of path.slice(0, -1)) {
        if (o[seg] === null || typeof o[seg] !== "object") o[seg] = {};
        o = o[seg];
      }
      const last = path[path.length - 1];
      if (kind === "set") o[last] = v;
      else if (kind === "del") delete o[last];
      else if (kind === "push") {
        if (!Array.isArray(o[last])) o[last] = [];
        o[last].push(v);
      } else if (kind === "splice" && Array.isArray(o[last])) {
        o[last].splice(v, 1);
      }
      s.n++;
    },
  },
});
const app = await aio.run({
  cells: [d],
  appId: "journal-crash-equals-clean",
  client: "server-only",
  journal: true,
  persistDebounceMs: 50,
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
const phase = Deno.env.get("PHASE");
if (phase === "read") {
  const { secret: _s, ...rest } = JSON.parse(JSON.stringify(app.getState().d));
  Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify(rest));
  await app.close();
  Deno.exit(0);
}
const ops = JSON.parse(Deno.env.get("OPS"));
const half = Number(Deno.env.get("SAVE_AT"));
let threw = 0;
for (let i = 0; i < ops.length; i++) {
  // A save mid-program: the tail after it is what the kill leaves to replay.
  if (i === half) await new Promise((r) => setTimeout(r, 300));
  try {
    await d.op(...ops[i]);
  } catch {
    threw++; // aio-ok: the same op fails the same way in both runs; counted
  }
}
// Counted so the parent can prove the program ADVANCED: an op that throws is
// rolled back, and a program whose every op threw compares two empty states.
Deno.writeTextFileSync(DIR + "/threw.txt", String(threw));
if (phase === "kill") Deno.kill(Deno.pid, "SIGKILL");
await app.close();
Deno.exit(0);
`.replace(" as unknown[]", "").replace(" as Record<string, unknown>", "");

function program(seed: number): { ops: Op[]; saveAt: number } {
  const r = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const val = () =>
    pick<unknown>([
      Math.floor(r() * 100),
      `s${Math.floor(r() * 9)}`,
      null,
      { deep: Math.floor(r() * 9) },
      [1, 2],
      true,
    ]);
  const ops: Op[] = [];
  const len = 3 + Math.floor(r() * 8);
  for (let i = 0; i < len; i++) {
    const path = pick([
      ["m", "a"], // declared
      ["m", "b", "c"], // declared, nested
      ["m", "b"], // declared container
      ["m", `x${Math.floor(r() * 3)}`], // undeclared nested
      [`top${Math.floor(r() * 2)}`], // undeclared top-level
      ["tags", `id${Math.floor(r() * 3)}`], // records-by-id
      ["secret"], // persist.exclude
      ["list"],
    ]);
    const kind = path[0] === "list"
      ? pick<Op[0]>(["push", "push", "splice"])
      : pick<Op[0]>(["set", "set", "del"]);
    ops.push([kind, path, kind === "splice" ? Math.floor(r() * 3) : val()]);
  }
  return { ops, saveAt: Math.floor(r() * (len + 1)) };
}

async function run(dir: string, phase: string, env: Record<string, string>) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: {
      ...env,
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (phase !== "kill" && !out.success) {
    throw new Error(`${phase}: ${new TextDecoder().decode(out.stderr)}`);
  }
}

async function restartAfter(
  stop: "kill" | "clean",
  p: { ops: Op[]; saveAt: number },
) {
  const dir = await tempDir(`journal-crash-diff-${stop}-`);
  try {
    await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
    const env = { OPS: JSON.stringify(p.ops), SAVE_AT: String(p.saveAt) };
    await run(dir, stop, env);
    const threw = Number(await Deno.readTextFile(`${dir}/threw.txt`));
    await run(dir, "read", env);
    return {
      state: JSON.parse(await Deno.readTextFile(`${dir}/out.json`)),
      threw,
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("journal: a SIGKILL restart restores what a clean restart restores (random programs)", async () => {
  const one = fuzzEnvInt("AIO_CRASH_DIFF_SEED", 0);
  const n = fuzzEnvInt("AIO_CRASH_DIFF_N", 6, 1);
  const seeds = one ? [one] : Array.from({ length: n }, (_, i) => 7 + i * 31);
  let compared = 0;
  for (const seed of seeds) {
    const p = program(seed);
    const clean = await restartAfter("clean", p);
    const killed = await restartAfter("kill", p);
    const why = `seed ${seed} (AIO_CRASH_DIFF_SEED=${seed}): ` +
      `n=${clean.state.n} threw=${clean.threw} ${JSON.stringify(p)}`;
    assertEquals(killed, clean, why);
    // The program ran: every op that did not throw committed (`s.n++`), and
    // at least one did — a program of failures compares nothing.
    assertEquals(clean.state.n, p.ops.length - clean.threw, why);
    assert(clean.threw < p.ops.length, why);
    compared++;
  }
  assertEquals(compared, seeds.length);
});
