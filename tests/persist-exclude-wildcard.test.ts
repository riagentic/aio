// `persist.exclude` takes a `*` path segment — any key in that place — so a
// cell with six `xStatus.busy` flags writes ONE entry (`"*.busy"`), and a
// by-id map `"feeds.*.busy"`. Every reader of the persist filter honours it:
// the store's getter, journal replay (`unpersistedFromBase`), the dev
// checkpoint (`persistedFields`/`fieldsAsRestart`), and a worker cell, whose
// slice the main isolate persists. `visible.exclude` keeps `*` literal.
import { assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { applyCellFieldFilter } from "../src/state/state-filter.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { unpersistedFromBase } from "../src/state/cell-persist-filter.ts";
import { fieldsAsRestart, persistedFields } from "../src/server/boot-scrub.ts";
import { cell } from "../src/state/cell-create.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const FILTER = { exclude: ["*.busy", "feeds.*.busy"] };
const busy = () => ({
  data: 7,
  aStatus: { busy: true, n: 1 },
  bStatus: { busy: true, n: 2 },
  feeds: { x: { busy: true, url: "u" } },
});
const stored = {
  data: 7,
  aStatus: { n: 1 },
  bStatus: { n: 2 },
  feeds: { x: { url: "u" } },
};

Deno.test("persist wildcard: the store's projection drops every match; a visible reading takes * literally", () => {
  assertEquals(
    applyCellFieldFilter(FILTER, busy(), { wildcard: true }),
    stored,
  );
  // visible reading: `*` is a literal key, so nothing here matches.
  assertEquals(applyCellFieldFilter(FILTER, busy()), {
    data: 7,
    aStatus: { busy: true, n: 1 },
    bStatus: { busy: true, n: 2 },
    feeds: { x: { busy: true, url: "u" } },
  });
});

Deno.test("persist wildcard: journal replay and the checkpoint put back what a restart holds", () => {
  const base = {
    data: 0,
    aStatus: { busy: false, n: 0 },
    bStatus: { busy: false, n: 0 },
    feeds: {},
  };
  const restart = {
    data: 7,
    aStatus: { busy: false, n: 1 },
    bStatus: { busy: false, n: 2 },
    feeds: { x: { url: "u" } },
  };
  assertEquals(
    unpersistedFromBase(FILTER, base, busy()),
    { ...restart, data: 7 },
  );
  assertEquals(persistedFields({ c: busy() }, { c: FILTER }), { c: stored });
  assertEquals(
    fieldsAsRestart({ c: busy() }, { c: FILTER }, { c: base }),
    { c: restart },
  );
});

// Before wildcards, `"perms.*"` excluded the literal `"*"` key only — state
// that HAS one (`{ "*": "read", alice: "admin" }`) must keep storing `alice`,
// or an upgrade silently drops it. Where no literal `"*"` exists, `*` is the
// wildcard.
Deno.test('persist wildcard: an object with a literal "*" key reads the segment literally', () => {
  const st = {
    perms: { "*": "read", alice: "admin" },
    s: { a: { b: 1, c: 2 } },
  };
  assertEquals(
    applyCellFieldFilter({ exclude: ["perms.*", "s.*.b"] }, st, {
      wildcard: true,
    }),
    { perms: { alice: "admin" }, s: { a: { c: 2 } } },
  );
  assertEquals(
    unpersistedFromBase(
      { exclude: ["perms.*"] },
      { perms: { "*": "read", alice: "admin" } },
      { perms: { "*": "write", alice: "root" } },
    ),
    { perms: { "*": "read", alice: "root" } },
  );
});

// A literal "*" key in the DATA is always read literally (1.0.23 stored
// `alice` beside it — reading the wildcard there drops her). A declared "*"
// key only ADDS the literal reading, for writes whose data lacks the key.
Deno.test('persist wildcard: a declared "*" adds the literal reading; a literal "*" in data is never a wildcard', () => {
  const f = { exclude: ["perms.*"] };
  const at = (declared: unknown, perms: Record<string, string>) =>
    applyCellFieldFilter(f, { perms }, { wildcard: true, declared });
  const lit = { perms: { "*": "read", alice: "x" } };
  // declared literal "*": the "*" key only, with or without it in the data
  assertEquals(at(lit, { "*": "r", alice: "a" }), { perms: { alice: "a" } });
  assertEquals(at(lit, { alice: "a", bob: "b" }), {
    perms: { alice: "a", bob: "b" },
  });
  // declared fields, no "*": a "*" key in the data is still read literally
  assertEquals(
    at({ perms: { admin: "x" } }, { admin: "r", "*": "r", alice: "a" }),
    { perms: { admin: "r", alice: "a" } },
  );
  // …and with no "*" key in the data, the wildcard
  assertEquals(at({ perms: { admin: "x" } }, { admin: "r", alice: "a" }), {
    perms: {},
  });
  assertEquals(
    unpersistedFromBase(
      f,
      { perms: { alice: "boot" } },
      { perms: { alice: "now" } },
      lit,
    ),
    { perms: { alice: "now" } },
    "restore reads the declaration too",
  );
});

Deno.test("persist wildcard: where the declaration cannot tell (a record), the data decides — said, rate-limited", () => {
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _c: string, msg: string) => {
        if (lvl === "warn") seen.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  // Past any earlier test's line: this one's first write must say it.
  const realNow = Date.now;
  Date.now = () => realNow() + 3_600_000;
  try {
    const declared = { perms: {} };
    for (let i = 0; i < 3; i++) {
      assertEquals(
        applyCellFieldFilter(
          { exclude: ["perms.*"] },
          { perms: { "*": "r", alice: "a" } },
          { wildcard: true, declared },
        ),
        { perms: { alice: "a" } },
      );
    }
    assertEquals(seen.length, 1, "said, once a minute at most");
    assertEquals(seen[0]!.includes("declared state"), true);
  } finally {
    Date.now = realNow;
    setLogger(prev);
  }
});

Deno.test("persist wildcard: a path nothing declared can match fails loud; visible refuses a * head", () => {
  const state = { aStatus: { busy: false }, bStatus: { busy: false } };
  // The right spelling boots.
  cell("wcOk", { state, persist: { exclude: ["*.busy" as never] } });
  assertThrows(
    () => cell("wcTypo", { state, persist: { exclude: ["*.bussy" as never] } }),
    Error,
    'persist exclude names "*.bussy"',
  );
  assertThrows(
    () =>
      cell("wcVis", {
        state,
        visible: { exclude: ["*.busy" as "aStatus"] },
      }),
    Error,
    '"*" is not a state field',
  );
});

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

// A main-isolate cell and a worker cell, one filter. Inside the worker
// `aio.run()` never resolves, so the phase code runs on the main isolate only.
const CHILD = `
import { aio, cell } from "${spec(MOD)}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const def = (worker) => ({
  ...(worker ? { worker: true } : {}),
  state: {
    data: 0,
    aStatus: { busy: false, n: 0 },
    bStatus: { busy: false, n: 0 },
    feeds: {},
  },
  persist: { exclude: ["*.busy", "feeds.*.busy"] },
  methods: {
    work(s, v) {
      s.data = v;
      s.aStatus.busy = true; s.aStatus.n = v;
      s.bStatus.busy = true; s.bStatus.n = v;
      s.feeds.x = { busy: true, url: "u" + v };
    },
  },
});
export const mc = cell("mc", def(false));
export const wc = cell("wc", def(true));
const app = await aio.run({
  cells: [mc, wc],
  appId: "persist-wildcard-probe",
  client: "server-only",
  journal: true,
  persistDebounceMs: PHASE === "kill" ? 999999 : 0,
  port: PORT,
  appDir: DIR,
});
if (PHASE === "read") {
  const s = app.getState();
  Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify([s.mc, s.wc]));
  Deno.exit(0);
}
for (const type of ["mc:work", "wc:work"]) {
  const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify({ type, payload: { args: [5] } }),
  });
  if (res.status !== 200) throw new Error(res.status + " " + await res.text());
}
for (let t = 0; t < 200 && app.getState().wc.data !== 5; t++) {
  await new Promise((r) => setTimeout(r, 10));
}
if (PHASE === "kill") Deno.kill(Deno.pid, "SIGKILL");
await app.close();
Deno.exit(0);
`;

async function run(dir: string, phase: string): Promise<void> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
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

async function restartAfter(stop: "kill" | "clean"): Promise<unknown> {
  const dir = await tempDir(`aio-persist-wild-${stop}-`);
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    await run(dir, stop);
    await run(dir, "read");
    return JSON.parse(await Deno.readTextFile(join(dir, "out.json")));
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("persist wildcard: main and worker cells restart without the matched fields — clean stop and SIGKILL alike", async () => {
  const want = {
    data: 5,
    aStatus: { busy: false, n: 5 },
    bStatus: { busy: false, n: 5 },
    feeds: { x: { url: "u5" } },
  };
  assertEquals(await restartAfter("clean"), [want, want]);
  assertEquals(await restartAfter("kill"), [want, want]);
});
