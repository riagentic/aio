// A bug report must honour a NESTED `visible.exclude` — the spelling a secret
// actually uses.
//
// An audit of a wallet found the report builder screening state through
// `_cellFields`, a per-TOP-LEVEL-KEY map: `exclude: ["seeds.encSeed"]` judged
// the key `seeds` "included", so the whole array — every row's ciphertext, and
// the passphrase verifier beside it — was kept whole. The wire, the patch
// path, the client read seam and the persistence read-back all read the same
// dot paths correctly (`deepExcludePaths`); this door was the one that
// flattened them, and it opens the day an app sets `feedback:`.
//
// So the report screens state and timeline through the app's real filter, via
// the same walker every other seam calls.
import { assert, assertEquals } from "@std/assert";
import { buildReport } from "../src/server/report.ts";
import type { TimelineEntry } from "../src/server/timeline.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const CIPHER = "TOPSECRET-encSeed-ciphertext";
const VERIFIER = "TOPSECRET-vaultCheck-verifier";

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const seeds = cell("seeds", {
  state: { seeds: [], vaultCheck: "" },
  // The wallet's own spelling: the rows ship, the ciphertext in them does not.
  visible: { exclude: ["seeds.encSeed", "vaultCheck"] },
  methods: {
    add(s, id, enc) { s.seeds.push({ id, label: "acct " + id, encSeed: enc }); },
    setCheck(s, v) { s.vaultCheck = v; },
  },
});
await aio.run({
  cells: [seeds],
  appId: "report-nested-exclude-probe",
  client: "server-only",
  feedback: true,
  persist: false,
  port: PORT,
  appDir: DIR,
});
await seeds.add(1, "${CIPHER}");
await seeds.setCheck("${VERIFIER}");
const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-AIO": "1" },
  body: JSON.stringify({ type: "feedback:report", payload: { args: ["title", "body"] } }),
});
await res.text();
const dir = DIR + "/data/reports";
for (let i = 0; i < 200; i++) {
  try {
    if ([...Deno.readDirSync(dir)].some((e) => e.name.endsWith(".json"))) break;
  } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 25));
}
Deno.exit(0);
`;

Deno.test("feedback capture: a nested visible.exclude keeps the ciphertext out of the report", async () => {
  const dir = await tempDir("aio-report-nested-");
  await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: { DIR: dir, PORT: String(freePort()), AIO_APPS_DIR: dir },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const files = [...Deno.readDirSync(`${dir}/data/reports`)]
    .filter((e) => e.name.endsWith(".json"));
  assertEquals(files.length, 1, "one user report");
  const text = await Deno.readTextFile(`${dir}/data/reports/${files[0]!.name}`);
  assert(
    !text.includes(CIPHER),
    "a nested-excluded field must not leave in the report",
  );
  assert(
    !text.includes(VERIFIER),
    "the top-level exclude beside it must hold too",
  );
  // …and the report is still worth having: the row the app DOES show is there.
  const report = JSON.parse(text) as {
    state?: Record<string, Record<string, unknown>>;
  };
  const rows = report.state?.seeds?.seeds as { id: number; label: string }[];
  assert(Array.isArray(rows) && rows.length === 1, JSON.stringify(rows));
  assertEquals(rows[0]!.label, "acct 1");
  assert(!("encSeed" in rows[0]!), JSON.stringify(rows[0]));
});

/** The state a wallet holds, and the filter it declares over it. */
const slice = () => ({
  seeds: [
    { id: 1, label: "one", encSeed: CIPHER },
    { id: 2, label: "two", encSeed: CIPHER + "-2" },
  ],
  vaultCheck: VERIFIER,
  unlocked: false,
});

const FILTERS = { w: { exclude: ["seeds.encSeed", "vaultCheck"] } };

function sources(over: Record<string, unknown> = {}) {
  return {
    appId: "wallet",
    appVersion: "1",
    aioVersion: "1",
    dataDir: "/nonexistent",
    logsDir: "/nonexistent",
    exposed: false,
    persist: false,
    cells: ["w"],
    ...over,
  };
}

Deno.test("report state: dot-path excludes are removed, the rest survives", async () => {
  const r = await buildReport(
    { kind: "user", title: "t" },
    sources({
      getState: () => ({ w: slice() }),
      visibleFilters: FILTERS,
    }),
  );
  const text = JSON.stringify(r);
  assert(!text.includes(CIPHER), text.slice(0, 600));
  assert(!text.includes(VERIFIER), text.slice(0, 600));
  const w = r.state?.w as Record<string, unknown>;
  assertEquals(
    w.seeds,
    [{ id: 1, label: "one" }, { id: 2, label: "two" }],
    "the rows stay, the ciphertext in them goes",
  );
  assertEquals(w.unlocked, false, "an unlisted field is untouched");
  assert(!("vaultCheck" in w));
});

Deno.test("report timeline: a diff leaf under a dot-path exclude loses its values", async () => {
  const entries: TimelineEntry[] = [
    // The write itself — the leaf IS the excluded field.
    {
      seq: 1,
      ts: 1,
      type: "w:seal",
      payload: { args: [CIPHER] },
      diff: [{ path: "w.seeds.0.encSeed", before: "", after: CIPHER }],
    },
    // A leaf that CONTAINS one — the whole row replaced at once.
    {
      seq: 2,
      ts: 2,
      type: "w:addRow",
      payload: { args: [] },
      diff: [{
        path: "w.seeds.1",
        before: undefined,
        after: { id: 2, label: "two", encSeed: CIPHER },
      }],
    },
    // A leaf that has nothing to do with any of it.
    {
      seq: 3,
      ts: 3,
      type: "w:unlock",
      payload: { args: [] },
      diff: [{ path: "w.unlocked", before: false, after: true }],
    },
  ];
  const r = await buildReport(
    { kind: "user", title: "t" },
    sources({
      getTimeline: () => entries,
      visibleFilters: FILTERS,
    }),
  );
  const text = JSON.stringify(r.timeline);
  assert(!text.includes(CIPHER), text.slice(0, 600));
  const sealed = r.timeline?.find((e) => e.type === "w:seal");
  assert(sealed, "the action stays — that it happened is diagnostic");
  assertEquals(
    sealed.diff[0]!.path,
    "w.seeds.0.encSeed",
    "…and so does its path",
  );
  const row = r.timeline?.find((e) => e.type === "w:addRow");
  assertEquals(
    (row?.diff[0] as { after?: unknown })?.after,
    { id: 2, label: "two" },
    "a leaf that contains the field keeps the rest of itself",
  );
  const open = r.timeline?.find((e) => e.type === "w:unlock");
  assertEquals((open?.diff[0] as { after?: unknown })?.after, true);
});

Deno.test("report timeline: a whole-cell leaf that is not an object is carried as it is", async () => {
  // The cell slice itself appearing/vanishing (`before: undefined`). Screening
  // must not invent an object where the state had none — a report showing a
  // cell arrive where one went away is a wrong answer, not a cautious one.
  const r = await buildReport(
    { kind: "user", title: "t" },
    sources({
      getTimeline: () =>
        [{
          seq: 1,
          ts: 1,
          type: "w:__init",
          payload: { args: [] },
          diff: [{ path: "w", before: undefined, after: { unlocked: false } }],
        }] as TimelineEntry[],
      visibleFilters: FILTERS,
    }),
  );
  const d = r.timeline?.[0]?.diff[0] as { before?: unknown; after?: unknown };
  assertEquals(d.before, undefined);
  assertEquals(d.after, { unlocked: false });
});

Deno.test("report: the per-key flags form still screens (the published shape)", async () => {
  // `ReportSources.visible` is public surface and keeps working: a flags map
  // screens exactly the top-level keys it marks, as it always did.
  const r = await buildReport(
    { kind: "user", title: "t" },
    sources({
      getState: () => ({ w: { open: 1, pin: "1234" } }),
      visible: {
        w: {
          open: { persisted: true, ui: true },
          pin: { persisted: true, ui: false },
        },
      },
    }),
  );
  assertEquals(r.state?.w, { open: 1 });
  assert(!JSON.stringify(r).includes("1234"));
});
