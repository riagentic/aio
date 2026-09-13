// A problem report withholds the ARGUMENTS of an async method that writes a
// hidden field — including one still running when the report is taken.
//
// The timeline screen judged each entry by its own diff. That is a sync
// method's whole write set; an async method commits its writes later, as
// `w:__setSetToken` entries that name the call (`call: <_callId>`), so the call
// entry has `diff: []` and kept its payload. Measured through a real
// `feedback: true` capture of `async setToken(s, v) { await …; s.token = v }`
// on a cell with `visible: { exclude: ["token"] }`:
//
//   {"type":"w:setToken","payload":{"args":["TOPSECRET-XYZ"],…},"diff":[]}
//
// — beside the notes saying `w.token` was withheld.
import { assert, assertEquals } from "@std/assert";
import { buildReport } from "../src/server/report.ts";
import type { TimelineEntry } from "../src/server/timeline.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const REDACTED = "[redacted]";

const visible = {
  w: {
    token: { persisted: true, ui: false },
    pub: { persisted: true, ui: true },
  },
  o: { n: { persisted: true, ui: true } },
};

const sources = (timeline: TimelineEntry[]) => ({
  appId: "a",
  appVersion: "1",
  aioVersion: "1",
  dataDir: "/nonexistent",
  logsDir: "/nonexistent",
  exposed: false,
  persist: false,
  cells: ["w", "o"],
  visible,
  getTimeline: () => timeline,
});

const payloadOf = (r: { timeline?: TimelineEntry[] }, seq: number) =>
  r.timeline?.find((e) => e.seq === seq)?.payload;

Deno.test("report timeline: an async call's payload is screened by its write set, and withheld while its writes cannot be seen whole", async () => {
  const timeline: TimelineEntry[] = [
    // 1–2: async call on the hidden-field cell, write landed later.
    {
      seq: 1,
      ts: 1,
      type: "w:setToken",
      payload: { args: ["SECRET-DONE"], _callId: "c1" },
      diff: [],
    },
    {
      seq: 2,
      ts: 2,
      type: "w:__setSetToken",
      origin: "w:setToken",
      cause: "effect",
      call: "c1",
      payload: { mutations: [{ path: ["token"], value: "SECRET-DONE" }] },
      diff: [{ path: "w.token", before: "", after: "SECRET-DONE" }],
    },
    // 3–4: async call still running — wrote a public field, the secret next.
    {
      seq: 3,
      ts: 3,
      type: "w:pubThenToken",
      payload: { args: ["SECRET-INFLIGHT"], _callId: "c2" },
      diff: [],
    },
    {
      seq: 4,
      ts: 4,
      type: "w:__setPubThenToken",
      origin: "w:pubThenToken",
      cause: "effect",
      call: "c2",
      payload: { mutations: [{ path: ["pub"], value: "p" }] },
      diff: [{ path: "w.pub", before: "", after: "p" }],
    },
    // 5–6: async call on a cell with NO hidden field whose run wrote one.
    {
      seq: 5,
      ts: 5,
      type: "o:relay",
      payload: { args: ["SECRET-RELAYED"], _callId: "c3" },
      diff: [],
    },
    {
      seq: 6,
      ts: 6,
      type: "w:__setSetToken",
      origin: "w:setToken",
      cause: "effect",
      call: "c3",
      payload: { mutations: [{ path: ["token"], value: "SECRET-RELAYED" }] },
      diff: [{ path: "w.token", before: "", after: "SECRET-RELAYED" }],
    },
    // 7: a sync call writing only a public field — its diff is its whole
    // write set, so its arguments stay.
    {
      seq: 7,
      ts: 7,
      type: "w:setPub",
      payload: { args: ["public-arg"] },
      diff: [{ path: "w.pub", before: "p", after: "public-arg" }],
    },
    // 8: an async call on a cell with no hidden field, nothing hidden written.
    {
      seq: 8,
      ts: 8,
      type: "o:bump",
      payload: { args: ["o-arg"], _callId: "c4" },
      diff: [],
    },
    {
      seq: 9,
      ts: 9,
      type: "o:__setBump",
      origin: "o:bump",
      cause: "effect",
      call: "c4",
      payload: { mutations: [{ path: ["n"], value: 1 }] },
      diff: [{ path: "o.n", before: 0, after: 1 }],
    },
  ];
  const r = await buildReport({ kind: "user", title: "t" }, sources(timeline));
  const text = JSON.stringify(r);
  for (const s of ["SECRET-DONE", "SECRET-INFLIGHT", "SECRET-RELAYED"]) {
    assert(!text.includes(s), `${s} left in the report: ${text}`);
  }
  assertEquals(payloadOf(r, 1), REDACTED, "linked by _callId");
  assertEquals(payloadOf(r, 3), REDACTED, "in flight: fail closed");
  assertEquals(payloadOf(r, 5), REDACTED, "cross-cell write, linked");
  assertEquals(payloadOf(r, 7), { args: ["public-arg"] }, "sync, public");
  assertEquals(payloadOf(r, 8), { args: ["o-arg"], _callId: "c4" });
  assertEquals(payloadOf(r, 4), {
    mutations: [{ path: ["pub"], value: "p" }],
  });
  // What happened stays: the type, the call link, the paths.
  assertEquals(r.timeline?.find((e) => e.seq === 2)?.call, "c1");
  assert(r.timeline?.find((e) => e.seq === 2)?.diff[0]?.path === "w.token");
  assert(
    r.truncated?.some((t) => t.includes("5 action payloads")),
    JSON.stringify(r.truncated),
  );
});

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
let release;
const gate = new Promise((r) => { release = r; });
const w = cell("w", {
  state: { token: "", pub: "" },
  visible: { exclude: ["token"] },
  methods: {
    async setToken(s, v) { await new Promise((r) => setTimeout(r, 5)); s.token = v; },
    async pubThenToken(s, v) { s.pub = "p"; await gate; s.token = v; },
  },
});
await aio.run({
  cells: [w], appId: "report-async-args", client: "server-only",
  feedback: true, persist: false, port: PORT, appDir: DIR,
});
await w.setToken("TOPSECRET-ASYNC");
const inflight = w.pubThenToken("TOPSECRET-INFLIGHT");
await new Promise((r) => setTimeout(r, 30));
const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-AIO": "1" },
  body: JSON.stringify({ type: "feedback:report", payload: { args: ["t", "b"] } }),
});
await res.text();
const dir = DIR + "/data/reports";
for (let i = 0; i < 200; i++) {
  try {
    if ([...Deno.readDirSync(dir)].some((e) => e.name.endsWith(".json"))) break;
  } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 25));
}
release();
await inflight;
Deno.exit(0);
`;

Deno.test("feedback capture: an async method's secret argument does not leave in the report", async () => {
  const dir = await tempDir("aio-report-async-args-");
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
  const report = JSON.parse(text) as { timeline?: TimelineEntry[] };
  // Not vacuous: both calls are in the captured timeline.
  const types = (report.timeline ?? []).map((e) => e.type);
  assert(types.includes("w:setToken"), types.join(", "));
  assert(types.includes("w:pubThenToken"), types.join(", "));
  for (const s of ["TOPSECRET-ASYNC", "TOPSECRET-INFLIGHT"]) {
    assert(
      !text.includes(s),
      `${s} left in the report: ${
        JSON.stringify(
          report.timeline?.filter((e) => JSON.stringify(e).includes(s)),
        )
      }`,
    );
  }
});
