// An `onPersist`-shaped cell comes back the same way whatever stopped the app.
//
// Journal replay re-runs the actions after the last snapshot, and the replay
// kept only what a `persist` FILTER names out of the store. A shape names no
// fields, so what `onPersist` keeps off disk survived a SIGKILL and not a
// clean stop. Measured: `onPersist: (s) => ({ data: s.data })`, `setBoth(7)`
// came back `cache: 0` after a clean stop and `cache: 7` after a SIGKILL; and
// a shape paired with an `onRestore` that re-derives a live field got the
// live value back (`LIVEb`) instead of the derived one (`T(b)`). Pinned
// against a real SIGKILL, next to a real clean stop of the same run.
import { assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const child = (cellSrc: string, read: string, ops: string) => `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
${cellSrc}
const app = await aio.run({
  cells: [w],
  appId: "journal-on-persist-probe",
  client: "server-only",
  journal: true,
  // No snapshot inside the run: the writes live only in the journal.
  persistDebounceMs: 999999,
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
const phase = Deno.env.get("PHASE");
if (phase === "read") {
  Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify(${read}));
  await app.close();
  Deno.exit(0);
}
${ops}
if (phase === "kill") Deno.kill(Deno.pid, "SIGKILL");
await app.close();
Deno.exit(0);
`;

async function run(dir: string, phase: string): Promise<void> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (phase !== "kill" && !out.success) {
    throw new Error(
      `${phase} child failed:\n${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

async function restartAfter(
  src: string,
  stop: "kill" | "clean",
): Promise<unknown> {
  const dir = await tempDir(`aio-journal-on-persist-${stop}-`);
  try {
    await Deno.writeTextFile(`${dir}/app.ts`, src);
    await run(dir, stop);
    await run(dir, "read");
    return JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("journal replay: a field onPersist drops restarts at its default after SIGKILL, as after a clean stop", async () => {
  const src = child(
    `const w = cell("w", {
      state: { data: 0, cache: 0 },
      onPersist: (s) => ({ data: s.data }),
      methods: { setBoth(s, v) { s.data = v; s.cache = v; } },
    });`,
    `{ data: w.data, cache: w.cache }`,
    `await w.setBoth(7);`,
  );
  const clean = await restartAfter(src, "clean");
  assertEquals(clean, { data: 7, cache: 0 }, "the clean-stop baseline");
  assertEquals(
    await restartAfter(src, "kill"),
    clean,
    "a SIGKILL restart must match a clean one — replay must not resurrect " +
      "what onPersist keeps off disk",
  );
});

Deno.test("journal replay: an onPersist/onRestore pair re-derives the live field after SIGKILL, as after a clean stop", async () => {
  const src = child(
    `const w = cell("w", {
      state: { key: "", thumb: "", n: 0, notes: [] },
      persist: { exclude: ["n"] },
      onPersist: (s) => ({ key: "K:" + s.key, notes: s.notes }),
      onRestore: (s) => {
        s.key = s.key.replace(/^K:/, "");
        s.thumb = "T(" + s.key + ")";
      },
      methods: {
        set(s, k) { s.key = k; s.thumb = "LIVE" + k; s.n++; s.notes.push(k); },
      },
    });`,
    `{ key: w.key, thumb: w.thumb, n: w.n, notes: w.notes }`,
    `await w.set("a"); await w.set("b");`,
  );
  const clean = await restartAfter(src, "clean");
  assertEquals(
    clean,
    { key: "b", thumb: "T(b)", n: 0, notes: ["a", "b"] },
    "the clean-stop baseline",
  );
  assertEquals(await restartAfter(src, "kill"), clean);
});

// A shape that changes a declared field's TYPE — an id-keyed record stored as
// a list, the canonical "store it compact" reshape. The restore merge keeps
// the declared `{}` over a stored array (schema wins on a type mismatch), so
// the partner `onRestore` was handed `items: {}` and the list was gone: after
// a clean stop AND — through the round trip replay now takes — after a
// SIGKILL, where replay alone had the right value in hand.
Deno.test("journal replay: an onPersist that changes a field's type restores through onRestore after SIGKILL, as after a clean stop", async () => {
  const src = child(
    `const w = cell("w", {
      state: { items: {} },
      onPersist: (s) => ({ items: Object.values(s.items) }),
      onRestore: (s) => {
        if (Array.isArray(s.items)) {
          s.items = Object.fromEntries(s.items.map((i) => [i.id, i]));
        }
      },
      methods: { add(s, id) { s.items[id] = { id, n: 1 }; } },
    });`,
    `w.items`,
    `await w.add("a"); await w.add("b");`,
  );
  const want = { a: { id: "a", n: 1 }, b: { id: "b", n: 1 } };
  assertEquals(await restartAfter(src, "clean"), want, "clean stop");
  assertEquals(await restartAfter(src, "kill"), want, "SIGKILL");
});
