// A problem report honours the app's `persist` declaration, not only `visible`.
//
// `persist: { exclude: ["token"] }` is documented as "not written to disk"
// (docs/auth/secrets-and-observability.md), and `persist: "none"` keeps a
// whole cell off disk (a session token, a draft). The dev checkpoint already
// reads that rule (`CheckpointView`). The report builder read `visible` only,
// so a field the app shows its own client but keeps off disk was written to
// `data/reports/*.json` — automatically, on a crash — and POSTed to the
// feedback URL: the one artifact that is written without anybody asking was
// the one that ignored "not written to disk".
//
// So the report screens state AND timeline through each cell's persist filter
// too, through the same walker (`applyCellFieldFilter` / `visibleValueAt`).
import { assert, assertEquals } from "@std/assert";
import { buildReport } from "../src/server/report.ts";
import type { TimelineEntry } from "../src/server/timeline.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const TOKEN = "TOPSECRET-session-token";
const DRAFT = "TOPSECRET-unsaved-draft";

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const auth = cell("auth", {
  state: { user: "", token: "" },
  // The client shows the token (it sends it on), the disk never holds it.
  persist: { exclude: ["token"] },
  methods: { login(s, u, t) { s.user = u; s.token = t; } },
});
const scratch = cell("scratch", {
  state: { draft: "" },
  persist: "none",
  methods: { type(s, v) { s.draft = v; } },
});
await aio.run({
  cells: [auth, scratch],
  appId: "report-persist-exclude-probe",
  client: "server-only",
  feedback: true,
  port: PORT,
  appDir: DIR,
});
await auth.login("ann", "${TOKEN}");
await scratch.type("${DRAFT}");
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

Deno.test("feedback capture: persist-excluded fields and persist:none cells stay out of the report on disk", async () => {
  const dir = await tempDir("aio-report-persist-");
  try {
    await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
      env: {
        DIR: dir,
        PORT: String(freePort()),
        AIO_APPS_DIR: dir,
        HOME: dir,
        AIO_HOME: `${dir}/aio-home`,
        AIO_FEEDBACK_DIR: `${dir}/feedback`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    const files = [...Deno.readDirSync(`${dir}/data/reports`)]
      .filter((e) => e.name.endsWith(".json"));
    assertEquals(files.length, 1, "one user report");
    const text = await Deno.readTextFile(
      `${dir}/data/reports/${files[0]!.name}`,
    );
    assert(!text.includes(TOKEN), "a persist-excluded field reached disk");
    assert(!text.includes(DRAFT), "a persist:none cell reached disk");
    const report = JSON.parse(text) as {
      state?: Record<string, Record<string, unknown>>;
      truncated?: string[];
    };
    assertEquals(report.state?.auth?.user, "ann", "the persisted rest stays");
    assert(
      report.truncated?.some((t) => t.includes("auth.token")),
      "the omission is named: " + JSON.stringify(report.truncated),
    );
  } finally {
    await dropTempDir(dir);
  }
});

const sources = (timeline: TimelineEntry[], state?: object) => ({
  appId: "a",
  appVersion: "1",
  aioVersion: "1",
  dataDir: "/nonexistent",
  logsDir: "/nonexistent",
  exposed: false,
  persist: true,
  cells: ["auth", "o"],
  visibleFilters: { auth: "all" as const, o: "all" as const },
  _persistFilters: {
    auth: { exclude: ["token"] },
    o: "all" as const,
  },
  getState: state ? () => state as Record<string, unknown> : undefined,
  getTimeline: () => timeline,
});

Deno.test("report timeline: diff values and args of writes to a persist-excluded field are withheld", async () => {
  const timeline: TimelineEntry[] = [
    {
      seq: 1,
      ts: 1,
      type: "auth:login",
      payload: { args: ["ann", TOKEN] },
      diff: [
        { path: "auth.user", before: "", after: "ann" },
        { path: "auth.token", before: "", after: TOKEN },
      ],
    },
    {
      seq: 2,
      ts: 2,
      type: "o:bump",
      payload: { args: [1] },
      diff: [{ path: "o.n", before: 0, after: 1 }],
    },
  ];
  const r = await buildReport(
    { kind: "user", title: "t" },
    sources(timeline, { auth: { user: "ann", token: TOKEN }, o: { n: 1 } }),
  );
  const text = JSON.stringify(r);
  assert(!text.includes(TOKEN), text.slice(0, 800));
  assertEquals(r.timeline?.length, 2);
  assertEquals(r.timeline![1]!.payload, { args: [1] }, "untouched stays");
  assertEquals(r.timeline![0]!.diff[0]!.after, "ann", "a kept leaf stays");
  assertEquals(r.state?.o, { n: 1 });
});
