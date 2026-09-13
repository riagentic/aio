// Two aio apps in ONE process — library mode, `testApps` — share every
// module-level singleton, and each of these was one: a value set per boot
// (last app wins) or cleared per shutdown (first app to close wins). Every
// case here boots a second app beside a first and asks whether the FIRST one
// still behaves as it did alone.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio, cell, log } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import {
  _resetFrozenWriteHint,
  setLogger,
} from "../src/diagnostics/logger-api.ts";
import {
  initDiagnosticBus,
  isDiagDev,
} from "../src/diagnostics/diagnostic-bus.ts";
import {
  _resetBigStateWarnings,
  warnBigFullState,
} from "../src/server/server-broadcast.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

type App = Awaited<ReturnType<typeof aio.run>> & { port: number };

/** A fresh `c` per app — a cell def binds to exactly one app. */
const makeCell = (id: string) =>
  cell("c", {
    state: { n: 0 },
    methods: {
      say(s: { n: number }, m: string) {
        log.warn(`USERLOG-${id}-${m}`);
        s.n++;
      },
      boom(_s: { n: number }, m: string) {
        throw new Error(`BOOM-${id}-${m}`);
      },
    },
  });

async function boot(
  id: string,
  dir: string,
  // deno-lint-ignore no-explicit-any
  extra: Record<string, any> = {},
  c = makeCell(id),
): Promise<App> {
  return await aio.run({
    cells: [c],
    appId: `${id}-${crypto.randomUUID().slice(0, 8)}`,
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port: freePort(),
    ...extra,
    // deno-lint-ignore no-explicit-any
  } as any) as App;
}

async function withDirs(
  fn: (a: string, b: string) => Promise<void>,
): Promise<void> {
  const a = await Deno.makeTempDir({ prefix: "aio-two-a-" });
  const b = await Deno.makeTempDir({ prefix: "aio-two-b-" });
  try {
    await fn(a, b);
  } finally {
    await Deno.remove(a, { recursive: true }).catch(() => {});
    await Deno.remove(b, { recursive: true }).catch(() => {});
  }
}

const read = (p: string) => Deno.readTextFile(p).catch(() => "");

// ── 1. closing B deleted A's control credential ───────────────────────────
Deno.test("two apps: closing one leaves the other's control credential armed", async () => {
  await withDirs(async (da, db) => {
    const users = { "alice-secret-123": { id: "alice", role: "admin" } };
    const A = await boot("ctla", da, { users });
    const B = await boot("ctlb", db, { users });
    let closedA = false;
    try {
      const keyPath = join(da, "data", "control.key");
      const key = (await Deno.readTextFile(keyPath)).trim();
      const probe = () =>
        fetch(`http://127.0.0.1:${A.port}/__aio/trojan/state`, {
          headers: { "x-aio-control": key },
        }).then(async (r) => (await r.body?.cancel(), r.status));
      assertEquals(await probe(), 200, "A's own key opens A");
      await B.close();
      assertEquals(
        await probe(),
        200,
        "B's shutdown must not disarm A — A's operator is locked out of A",
      );
      assert(
        await Deno.stat(keyPath).then(() => true, () => false),
        "A's control.key must still be on disk after B closed",
      );
      await A.close();
      closedA = true;
      assert(
        !(await Deno.stat(keyPath).then(() => true, () => false)),
        "…and A's own shutdown still removes it",
      );
    } finally {
      if (!closedA) await A.close();
    }
  });
});

// ── 4. one app's trojan traffic spent the other's rate limit ──────────────
Deno.test("two apps: the trojan rate limit is counted per app", async () => {
  await withDirs(async (da, db) => {
    const A = await boot("rla", da);
    const B = await boot("rlb", db);
    try {
      const get = (app: App) =>
        fetch(`http://127.0.0.1:${app.port}/__aio/trojan/state`)
          .then(async (r) => (await r.body?.cancel(), r.status));
      let last = 0;
      for (let i = 0; i < 101; i++) last = await get(A);
      assertEquals(last, 429, "A is past its own 100/s");
      assertEquals(await get(B), 200, "B's FIRST request is not A's 429");
    } finally {
      await B.close();
      await A.close();
    }
  });
});

// ── 2. one process-wide logger ────────────────────────────────────────────
Deno.test("two apps: each app's logs land in its own files, before and after the other closes", async () => {
  await withDirs(async (da, db) => {
    const a = makeCell("loga");
    const b = makeCell("logb");
    const A = await boot("loga", da, {}, a);
    const B = await boot("logb", db, {}, b);
    let closedB = false;
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
      origErr(...a);
    };
    try {
      await a.say("both-up");
      await b.say("both-up");
      await a.boom("both-up").catch(() => {});
      // A network-origin dispatch: the drain runs in A's server handler, not
      // inside a bound method call.
      const r = await fetch(
        `http://127.0.0.1:${A.port}/__aio/trojan/dispatch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-AIO": "1" },
          body: JSON.stringify({
            type: "c:boom",
            payload: { args: ["wire"] },
          }),
        },
      );
      await r.body?.cancel();
      await B.close();
      closedB = true;
      await a.say("after-b");
      await a.boom("after-b").catch(() => {});
    } finally {
      console.error = origErr;
      if (!closedB) await B.close();
      await A.close();
    }
    const aLog = await read(join(da, "logs", "app.log"));
    const bLog = await read(join(db, "logs", "app.log"));
    for (
      const m of [
        "USERLOG-loga-both-up",
        "BOOM-loga-both-up",
        "BOOM-loga-wire",
        "USERLOG-loga-after-b",
        "BOOM-loga-after-b",
      ]
    ) {
      assertStringIncludes(aLog, m, `A's app.log must hold ${m}`);
      assert(!bLog.includes(m), `B's app.log must not hold A's ${m}`);
    }
    assertStringIncludes(bLog, "USERLOG-logb-both-up");
    assert(
      !errs.some((l) => l.includes("reportError failed")),
      `A's errors after B closed must reach a logger: ${errs.join("\n")}`,
    );
  });
});

// ── 5. "read-only" is not a frozen write ──────────────────────────────────
Deno.test("frozen-write hint: an EROFS or a config table is not frozen state", () => {
  const seen: string[] = [];
  const sink = {
    logDir: "",
    pub: (_l: string, _c: string, msg: string) => seen.push(msg),
    perf: () => {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink;
  setLogger(sink);
  try {
    for (
      const line of [
        "save failed: Read-only file system (os error 30): open /mnt/usb/b.json",
        "unknown config key bogusKey — assets  READ-ONLY directories this app SERVES",
        "attempt to write a readonly database",
      ]
    ) {
      _resetFrozenWriteHint();
      seen.length = 0;
      log.error(line);
      assert(
        !seen.some((m) => m.includes("which is frozen")),
        `no frozen-state paragraph for: ${line}`,
      );
    }
    // The engine's own sentences still get it.
    for (
      const raw of [
        "Cannot assign to read only property 'n' of object '#<Object>'",
        "Cannot add property 1, object is not extensible",
        "Cannot delete property 'n' of #<Object>",
        "Cannot define property z, object is not extensible",
        '"n" is read-only',
        "Attempted to assign to readonly property.",
      ]
    ) {
      _resetFrozenWriteHint();
      seen.length = 0;
      log.error(`x: ${raw}`);
      assert(
        seen.some((m) => m.includes("which is frozen")),
        `the hint must still explain: ${raw}`,
      );
    }
  } finally {
    _resetFrozenWriteHint();
    setLogger(null);
  }
});

// ── 6a. a prod app joining switched a dev app's diagnostic bus off ────────
Deno.test("diagnostic bus: a prod app joining does not switch a dev app's bus off", () => {
  initDiagnosticBus(false); // full reset
  initDiagnosticBus(true, { keepListeners: true }); // dev app boots
  initDiagnosticBus(false, { keepListeners: true }); // prod app boots beside it
  assertEquals(isDiagDev(), true, "the dev app's bus must stay on");
  initDiagnosticBus(false); // a full reset still sets the mode outright
  assertEquals(isDiagDev(), false);
  initDiagnosticBus(false, { keepListeners: true }); // a lone prod app
  assertEquals(isDiagDev(), false, "a prod app alone keeps the bus off");
  initDiagnosticBus(false);
});

// ── 6b. the big-state warning latch was per process ───────────────────────
Deno.test("big-state warning: latched per app, not per process", () => {
  _resetBigStateWarnings();
  const seen: string[] = [];
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _c: string, msg: string) => {
        if (lvl === "warn") seen.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
    } as unknown as LogSink,
  );
  try {
    const big = (n: number) => ({ items: "x".repeat(n) });
    const ownerA = () => null;
    const ownerB = () => null;
    const a = big(5 * 1024 * 1024);
    warnBigFullState(JSON.stringify(a), () => a, ownerA);
    const b = big(2 * 1024 * 1024);
    warnBigFullState(JSON.stringify(b), () => b, ownerB);
    assertEquals(
      seen.filter((m) => m.includes('"items"')).length,
      2,
      `app B's own "items" must be named even though app A's was: ${seen}`,
    );
    // …and still once per app.
    warnBigFullState(JSON.stringify(b), () => b, ownerB);
    assertEquals(seen.filter((m) => m.includes('"items"')).length, 2);
  } finally {
    setLogger(null);
    _resetBigStateWarnings();
  }
});

// ── 6c. a rejected top-level await hung with the guard on ─────────────────
Deno.test("guardDispatches: a script whose top level rejects exits 1; a stray rejection does not", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-tla-" });
  try {
    const script = join(dir, "main.ts");
    const mod = new URL("../mod.ts", import.meta.url).href;
    await Deno.writeTextFile(
      script,
      `import { aio, cell } from ${JSON.stringify(mod)};
const c = cell("c", { state: { n: 0 }, methods: {} });
const app = await aio.run({ cells: [c], appId: "tla-" + Deno.pid,
  appDir: ${JSON.stringify(join(dir, "app"))}, client: "server-only",
  libraryMode: true, singleton: false, persist: false, port: 0 } as never);
if (Deno.env.get("MODE") === "stray") {
  Promise.reject(new Error("STRAY-REJECTION"));
  await new Promise((r) => setTimeout(r, 300));
  await app.close();
  console.log("SURVIVED-STRAY");
} else {
  await Promise.reject(new Error("TOP-LEVEL-REJECTION"));
}
`,
    );
    const run = async (mode: string) => {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--no-check",
          "--config",
          new URL("../deno.json", import.meta.url).pathname,
          script,
        ],
        env: { MODE: mode, AIO_APPS_DIR: join(dir, "apps") },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      const out = await child.output();
      clearTimeout(timer);
      const dec = new TextDecoder();
      return {
        code: out.code,
        text: dec.decode(out.stdout) + dec.decode(out.stderr),
      };
    };
    const tla = await run("tla");
    assertEquals(tla.code, 1, `top-level rejection must exit 1:\n${tla.text}`);
    assertStringIncludes(tla.text, "TOP-LEVEL-REJECTION");
    assertStringIncludes(tla.text, "top level threw");
    const stray = await run("stray");
    assertEquals(stray.code, 0, `a stray must be survived:\n${stray.text}`);
    assertStringIncludes(stray.text, "SURVIVED-STRAY");
    assertStringIncludes(stray.text, "STRAY-REJECTION"); // …and logged
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
