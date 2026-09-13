// A problem report's TIMELINE honours the same two promises as its state:
// hidden fields stay hidden, and the size cap holds.
//
// Both were broken through the timeline, and both measured through a real
// `feedback: true` capture:
//
//  • `visible: { exclude: ["secret"] }` kept `w.secret` out of `state` — the
//    notes even said "fields hidden from clients were omitted: w.secret" — and
//    the timeline entry for `setSecret` carried `path: "w.secret"` with the
//    secret as `after`, and the call's arguments as its payload;
//  • a 391 KB state was "omitted (391KB > 256KB)" from a report that was
//    406 KB on disk, because the action that wrote those bytes carried them in
//    its diff.
import { assert, assertEquals } from "@std/assert";
import { buildReport, REPORT_LIMITS } from "../src/server/report.ts";
import type { TimelineEntry } from "../src/server/timeline.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const SECRET = "TOPSECRET-visible-excluded";

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const w = cell("w", {
  state: { data: {}, token: "" },
  visible: { exclude: ["token"] },
  methods: {
    setToken(s, v) { s.token = v; },
    big(s, n) { s.data.big = "x".repeat(n); },
  },
});
await aio.run({
  cells: [w],
  appId: "report-screen-probe",
  client: "server-only",
  feedback: true,
  persist: false,
  port: PORT,
  appDir: DIR,
});
await w.setToken("${SECRET}");
await w.big(400000);
const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-AIO": "1" },
  body: JSON.stringify({ type: "feedback:report", payload: { args: ["user title", "body"] } }),
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

Deno.test("feedback capture: the timeline withholds hidden fields and stays inside the size cap", async () => {
  const dir = await tempDir("aio-report-screen-");
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
  const text = await Deno.readTextFile(
    `${dir}/data/reports/${files[0]!.name}`,
  );
  const report = JSON.parse(text) as {
    truncated?: string[];
    timeline?: TimelineEntry[];
  };

  assert(
    !text.includes(SECRET),
    `a field the app hides from clients must not leave in the report — ` +
      `found it in: ${
        JSON.stringify(
          report.timeline?.filter((e) => JSON.stringify(e).includes(SECRET)),
        )
      }`,
  );
  const set = report.timeline?.find((e) => e.type === "w:setToken");
  assert(set, "the action itself is still in the timeline");
  assert(
    set.diff.some((d) => d.path === "w.token"),
    "its path stays — the action DID touch the field",
  );

  const size = new TextEncoder().encode(text).length;
  assert(
    size < REPORT_LIMITS.stateBytes + REPORT_LIMITS.timelineBytes,
    `report is ${Math.round(size / 1024)}KB — the timeline carried the ` +
      `bytes the state cap refused`,
  );
  assert(
    new TextEncoder().encode(JSON.stringify(report.timeline ?? [])).length <=
      REPORT_LIMITS.timelineBytes,
  );
  assert(
    report.truncated?.some((t) => t.includes("had their values elided")),
    `the elision is stated: ${JSON.stringify(report.truncated)}`,
  );
});

Deno.test("report timeline: a leaf that IS a whole cell loses its hidden keys, and the total cap drops the oldest", async () => {
  const visible = {
    v: {
      open: { persisted: true, ui: true },
      pin: { persisted: true, ui: false },
    },
  };
  const cellLeaf: TimelineEntry = {
    seq: 1,
    ts: 1,
    type: "v:reset",
    payload: { args: [] },
    diff: [{
      path: "v",
      before: { open: 1, pin: "1234" },
      after: { open: 2, pin: "9999" },
    }],
  };
  // Each entry just under the per-entry cap, enough of them to pass the total.
  const n = Math.ceil(
    REPORT_LIMITS.timelineBytes / (REPORT_LIMITS.timelineEntryBytes - 1024),
  ) + 2;
  const filler: TimelineEntry[] = Array.from({ length: n }, (_, i) => ({
    seq: i + 2,
    ts: i + 2,
    type: "v:note",
    payload: { args: [] },
    diff: [{
      path: "v.open",
      before: 0,
      after: "y".repeat(REPORT_LIMITS.timelineEntryBytes - 2048),
    }],
  }));
  const r = await buildReport({ kind: "user", title: "t" }, {
    appId: "a",
    appVersion: "1",
    aioVersion: "1",
    dataDir: "/nonexistent",
    logsDir: "/nonexistent",
    exposed: false,
    persist: false,
    cells: ["v"],
    visible,
    getTimeline: () => [cellLeaf, ...filler],
  });
  const text = JSON.stringify(r);
  assert(!text.includes("1234") && !text.includes("9999"), text.slice(0, 400));
  assert(
    JSON.stringify(r.timeline).length <= REPORT_LIMITS.timelineBytes,
    "the timeline section fits its cap",
  );
  assertEquals(r.timeline?.at(-1)?.seq, n + 1, "newest kept");
  assert(
    r.truncated?.some((t) => t.includes("oldest")),
    JSON.stringify(r.truncated),
  );
});
