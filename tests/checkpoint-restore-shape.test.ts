// The dev checkpoint is READ BACK, so it must hold state in the shape state
// has — and never a `persist: "none"` cell.
//
// `onCheckpointRestore` receives the checkpoint and its return is assigned
// into live state at boot, with no `onRestore` in between. Two ways that went
// wrong while the checkpoint was being taught to leave `persist: "none"` cells
// out (both found by review, both pinned here):
//
//   SHAPE     — the checkpoint was written through the store's full filter, so
//               an `onPersist`-shaped cell (`{ tags: ["x"] }` stored as
//               `{ csv: "x" }`) came back as `{ csv: "x", tags: [] }`.
//   SENTINEL  — a throwing `onPersist` made the checkpoint write a `_withheld`
//               marker AS the state, which the restore then installed as a
//               top-level key of live state.
//
// The rule now: the checkpoint drops whole cells outside `persistingCellIds`
// and keeps every other slice exactly as state holds it — a key filter, which
// cannot throw. Driven as a real app in a subprocess that dies without a clean
// stop (`Deno.exit(0)`), because a checkpoint is what a crash leaves behind.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const url = (rel: string) => toFileUrl(join(REPO, rel)).href;

const PROBE = `// deno-lint-ignore-file no-explicit-any
const step = Deno.args[0];
const { cell } = await import(${
  JSON.stringify(url("src/state/cell-create.ts"))
});
const { aio } = await import(${JSON.stringify(url("mod.ts"))});
const { freePort } = await import(${
  JSON.stringify(url("src/testing/server-test.ts"))
});
const bag = cell("bag", {
  state: { tags: [] as string[] },
  onPersist: (s: any) => ({ csv: s.tags.join(",") }),
  onRestore: (s: any) => ({
    tags: typeof s.csv === "string" && s.csv ? s.csv.split(",") : (s.tags ?? []),
  }),
  methods: { add(s: any, t: string) { s.tags.push(t); } },
});
const boom = cell("boom", {
  state: { v: 0 },
  onPersist: (s: any) => {
    if (step === "write" && s.v > 0) throw new Error("onPersist bug");
    return s;
  },
  methods: { bump(s: any) { s.v++; } },
});
const secret = cell("secret", {
  state: { token: "" },
  persist: "none",
  methods: { set(s: any, v: string) { s.token = v; } },
});
const app: any = await aio.run({
  cells: [bag, boom, secret], appId: "cp-shape", appDir: Deno.env.get("DIR"),
  client: "server-only", libraryMode: true, port: freePort(),
  diagnostics: { dev: { actionLog: false, checkpoint: { debounce: 0 } } },
  onCheckpointRestore: (cp: any) => cp.state,
} as any);
if (step === "write") {
  await (bag as any).add("x");
  await (boom as any).bump();
  await (secret as any).set("CP-SECRET-7731");
  await new Promise((r) => setTimeout(r, 300));
}
console.log("STATE " + JSON.stringify(app.getState()));
Deno.exit(0);
`;

async function run(
  probe: string,
  dir: string,
  step: string,
): Promise<Record<string, unknown>> {
  const out = await new Deno.Command("deno", {
    args: ["run", "-A", "--config", join(REPO, "deno.json"), probe, step],
    env: { DIR: dir, AIO_APPS_DIR: dir, AIO_NO_OPEN: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  const line = text.split("\n").find((l) => l.startsWith("STATE "));
  assert(
    line,
    `${step}: no state line (exit ${out.code})\n${text}\n` +
      new TextDecoder().decode(out.stderr).slice(-4000),
  );
  return JSON.parse(line.slice(6));
}

Deno.test("checkpoint restore: slices come back in STATE's shape, whole cells only", async () => {
  const dir = await tempDir("cp-shape-");
  const probe = join(dir, "probe.ts");
  await Deno.writeTextFile(probe, PROBE);
  const w = await run(probe, dir, "write");
  assertEquals((w.bag as { tags: string[] }).tags, ["x"], "control: wrote");

  const cp = await Deno.readTextFile(join(dir, "logs", "checkpoint.json"));
  assert(!cp.includes("CP-SECRET-7731"), `persist:"none" in checkpoint: ${cp}`);

  const r = await run(probe, dir, "read");
  // SHAPE: the onPersist shape never reaches live state.
  assertEquals(
    r.bag,
    { tags: ["x"] },
    "the checkpoint restored a stored SHAPE",
  );
  // SENTINEL: nothing but the declared cells (and framework `__` keys).
  const top = Object.keys(r).filter((k) => !k.startsWith("__")).sort();
  assertEquals(top, ["bag", "boom", "secret"], "a foreign top-level key");
  // A throwing onPersist cannot cost the checkpoint its slice either.
  assertEquals(r.boom, { v: 1 });
  assertEquals((r.secret as { token: string }).token, "");
});

Deno.test('checkpoint restore: a checkpoint an OLDER build wrote raw never hands back a persist:"none" slice', async () => {
  // The write side above keeps the secret out of every checkpoint THIS build
  // writes; this pins the read side (aio-boot.ts step 6), which a build that
  // wrote the checkpoint raw depends on.
  const dir = await tempDir("cp-raw-");
  const probe = join(dir, "probe.ts");
  await Deno.writeTextFile(probe, PROBE);
  await run(probe, dir, "read"); // creates the data layout
  const file = join(dir, "logs", "checkpoint.json");
  await Deno.writeTextFile(
    file,
    JSON.stringify({
      ts: Date.now(),
      state: {
        bag: { tags: ["raw"] },
        boom: { v: 3 },
        secret: { token: "CK-SECRET-99" },
      },
      recentActions: [],
      cells: {},
    }),
    { mode: 0o600 },
  );
  const r = await run(probe, dir, "read");
  assertEquals(r.bag, { tags: ["raw"] }, "control: the checkpoint restored");
  assertEquals(
    (r.secret as { token: string }).token,
    "",
    'a persist:"none" slice came back from an older build\'s checkpoint',
  );
});
