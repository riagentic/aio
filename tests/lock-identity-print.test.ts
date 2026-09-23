// Owner identity every reader agrees on, and lock text safe to print.
//
// macOS's start token was `ps -o lstart=` TEXT, which follows the reader's TZ
// and locale: an owner written in Auckland/de_DE ("Mi 23 Sep 19:55:37 2026")
// read from UTC/C ("Wed Sep 23 07:55:37 2026") looked recycled, so a live app
// was judged dead and a second instance took its state.db. It is now UTC
// epoch seconds (`startEpoch`, `ps` run under LC_ALL=C TZ=UTC) — measured on
// the macOS 14 VM: writer Pacific/Auckland+de_DE, readers UTC+C,
// America/New_York+fr_FR and Asia/Kolkata+ja_JP all read 1790150137 and
// refused a second instance.
import { assert, assertEquals } from "@std/assert";
import {
  deadOwnerWarning,
  isHold,
  lockPath,
  ownerMatches,
  parseLstartUtc,
  printable,
  readLock,
} from "../src/server/single-instance-lock.ts";
import { maintenanceOp } from "../src/am/am-utils.ts";

Deno.test("parseLstartUtc: C-locale UTC lstart → epoch seconds; anything else null", () => {
  // The exact line the macOS VM printed for the writer, read under TZ=UTC.
  assertEquals(parseLstartUtc("Wed Sep 23 07:55:37 2026\n"), 1790150137);
  assertEquals(parseLstartUtc("Tue Sep  1 00:00:00 2026"), 1788220800);
  // Locale text — what v1.0.9 stored — is never mistaken for a time.
  assertEquals(parseLstartUtc("Mi 23 Sep 19:55:37 2026"), null);
  assertEquals(parseLstartUtc("水  9/23 13:25:37 2026"), null);
  assertEquals(parseLstartUtc(""), null);
  assertEquals(parseLstartUtc("Wed Foo 23 07:55:37 2026"), null);
});

Deno.test("ownerMatches: only a known-and-different identity says recycled", () => {
  const none = { token: null, epoch: null };
  // A v1.0.9 macOS lock: locale text in startToken, which no reader derives
  // any more — unknown, so pid liveness decides (never "dead").
  assert(ownerMatches({ startToken: "Mi 23 Sep 19:55:37 2026" }, none));
  assert(ownerMatches({}, { token: "5", epoch: 9 }));
  assert(ownerMatches({ startEpoch: 9 }, { token: null, epoch: 9 }));
  assert(!ownerMatches({ startEpoch: 9 }, { token: null, epoch: 10 }));
  assert(ownerMatches({ startEpoch: 9 }, none), "unreadable now → unknown");
  assert(ownerMatches({ startToken: "123" }, { token: "123", epoch: null }));
  assert(!ownerMatches({ startToken: "123" }, { token: "124", epoch: null }));
});

Deno.test("isHold: any present maintenance value is a hold", () => {
  for (const m of [undefined, null, false]) {
    assertEquals(isHold({ maintenance: m }), false, String(m));
  }
  assertEquals(isHold(null), false);
  for (const m of [{ op: "backup" }, "yes", 1, true, {}]) {
    assertEquals(isHold({ maintenance: m }), true, JSON.stringify(m));
  }
});

Deno.test("readLock: the record is byte-true — nothing is cleaned on read", () => {
  const key = `print-${crypto.randomUUID().slice(0, 8)}`;
  Deno.writeTextFileSync(
    lockPath(key),
    JSON.stringify({
      appId: "a\x1b[2J",
      pid: 5,
      port: 0,
      status: "started",
      home: "/h\t",
      maintenance: { op: "backup\x1b]0;x\x07", partial: "/p\x00" },
    }),
  );
  const lock = readLock(key)!;
  Deno.removeSync(lockPath(key));
  assertEquals(lock.appId, "a\x1b[2J");
  assertEquals(lock.home, "/h\t", "identity: the key is derived from it");
  assertEquals(lock.maintenance, {
    op: "backup\x1b]0;x\x07",
    partial: "/p\x00",
  });
});

Deno.test("printable: a field loses every control char; a message keeps lines + colour", () => {
  assertEquals(printable("ok\u0085\t\n"), "ok???");
  assertEquals(
    printable("a\x1b]0;x\x07b\x1b[1mB\x1b[0m\r\x9b2J\n\tc", true),
    "a?]0;x?b\x1b[1mB\x1b[0m??2J\n\tc",
  );
  // What DISPLAYS differently from what it is: bidi overrides/isolates and
  // zero-width characters, in a field and in a message alike.
  const unseen = "\u202a\u202e\u2066\u2069\u200b\u200f\ufeff";
  assertEquals(printable(`/h${unseen}x`), "/h???????x");
  assertEquals(printable(`/h${unseen}x`, true), "/h???????x");
  // Only the SGR codes aio's styling emits pass; conceal (8), blink (5),
  // compound and 256-colour forms do not.
  for (
    const ok of [
      "\x1b[0m",
      "\x1b[m",
      "\x1b[1m",
      "\x1b[2m",
      "\x1b[4m",
      "\x1b[31m",
      "\x1b[36m",
      "\x1b[39m",
      "\x1b[92m",
    ]
  ) {
    assertEquals(printable(`a${ok}b`, true), `a${ok}b`, JSON.stringify(ok));
  }
  for (
    const bad of [
      "\x1b[8m",
      "\x1b[5m",
      "\x1b[1;8m",
      "\x1b[38;5;0m",
      "\x1b[30;40m",
    ]
  ) {
    assert(!printable(`a${bad}b`, true).includes("\x1b"), JSON.stringify(bad));
  }
});

Deno.test("am out/outError: what reaches the terminal is printable", async () => {
  const { out, outError } = await import("../src/am/am-output.ts");
  const said: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (s: string) => said.push(s);
  console.error = (s: string) => said.push(s);
  try {
    out({}, "pretty", "home /h\x1b]0;pwn\x07");
    out("state \x1b[2J", "pretty");
    out({ home: "/h\x1b[2J" }, "pretty");
    outError("refused: /h\x1b]8;;evil\x07", "pretty");
  } finally {
    console.log = log;
    console.error = err;
  }
  assertEquals(said.length, 4, "every call printed");
  for (const line of said) {
    assert(!/\x1b(?!\[[0-9;]*m)|\x07/.test(line), JSON.stringify(line));
  }
});

Deno.test("maintenanceOp: a record handed in directly is printable too", () => {
  // Not every caller reads through parseLock (a record built in memory).
  assertEquals(
    maintenanceOp({ maintenance: { op: "rest\x1b[2Jore" } }),
    "rest?[2Jore",
  );
  assertEquals(maintenanceOp({ maintenance: "yes" }), "am");
  assertEquals(maintenanceOp({}), null);
});

// A lock's `home`/`cwd`/`socketPath` are IDENTITY — the lock key is derived
// from `home`. Sanitizing them on READ (a tab → "?") made `am status`'s
// self-repair file the record under a SECOND key: two lock files for one app,
// "running from 2 data homes", and the next boot beside it. Printing is where
// text is made safe; the record stays byte-true.
Deno.test({
  name:
    "am status: a control char in home keeps ONE lock (repair under its own key)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const { tempDir, dropTempDir } = await import("../src/testing/temp-dir.ts");
    const { join, toFileUrl } = await import("@std/path");
    const dir = await tempDir("lock-tabhome-");
    try {
      await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
      const REPO = join(import.meta.dirname!, "..");
      const CFG = join(REPO, "deno.json");
      const code = `
        const m = await import(${
        JSON.stringify(
          toFileUrl(join(REPO, "src/server/single-instance-lock.ts")).href,
        )
      });
        const home = Deno.env.get("AIO_APPS_DIR") + "/h\\tx";
        const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} },
          () => new Response("ok"));
        m.writeLock({ appId: "tabapp", pid: Deno.pid, port: srv.addr.port,
          startedAt: Date.now(), status: "starting", cwd: "/", home,
          ...m.ownerIdentity(Deno.pid) });
        const o = await new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", "--config", ${JSON.stringify(CFG)},
            ${JSON.stringify(join(REPO, "src/am.ts"))}, "status",
            "--app=tabapp", "--home=" + home],
          stdout: "piped", stderr: "piped" }).output();
        const locks = [...Deno.readDirSync(m.lockDir())]
          .filter((e) => e.name.endsWith(".lock")).map((e) => e.name);
        const now = m.readLock(m.lockKey("tabapp", home));
        await srv.shutdown();
        console.log(JSON.stringify({ locks, status: now?.status, home: now?.home,
          said: new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr) }));`;
      const o = await new Deno.Command(Deno.execPath(), {
        args: ["eval", "--config", CFG, code],
        env: {
          XDG_RUNTIME_DIR: join(dir, "run"),
          AIO_APPS_DIR: join(dir, "apps"),
          HOME: join(dir, "home"),
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(o.stdout);
      assert(o.success, out + new TextDecoder().decode(o.stderr));
      const r = JSON.parse(out.trim().split("\n").at(-1)!);
      assertEquals(r.locks.length, 1, JSON.stringify(r));
      assertEquals(r.status, "started", r.said);
      assertEquals(
        r.home,
        join(dir, "apps") + "/h\tx",
        "the record is byte-true",
      );
      assert(!r.said.includes("\t"), "…and what is PRINTED is safe");
    } finally {
      await dropTempDir(dir);
    }
  },
});

// `processStartEpoch` runs synchronously inside every liveness check; a `ps`
// that hangs used to hang `am` and the boot with it. Bounded now — the whole
// process group, since a descendant holding the pipe kept the read open
// (measured on the macOS VM) — and a timeout is "unknown", never "dead".
Deno.test({
  name: "processStartEpoch: a hanging ps is cut off → null; a real one answers",
  ignore: Deno.build.os === "windows",
  async fn() {
    const { PS_TIMEOUT, processStartEpoch } = await import(
      "../src/server/single-instance-lock.ts"
    );
    const { tempDir, dropTempDir } = await import("../src/testing/temp-dir.ts");
    const dir = await tempDir("ps-hang-");
    const was = { ...PS_TIMEOUT };
    try {
      const fake = `${dir}/ps`;
      Deno.writeTextFileSync(fake, "#!/bin/sh\nsleep 30\n");
      Deno.chmodSync(fake, 0o755);
      PS_TIMEOUT.ps = fake;
      PS_TIMEOUT.seconds = 1;
      const t = Date.now();
      assertEquals(processStartEpoch(Deno.pid, "darwin"), null);
      assert(Date.now() - t < 10_000, `took ${Date.now() - t}ms`);
      PS_TIMEOUT.ps = "ps";
      const e = processStartEpoch(Deno.pid, "darwin");
      assert(
        typeof e === "number" && Math.abs(e * 1000 - Date.now()) < 86_400_000,
        String(e),
      );
    } finally {
      Object.assign(PS_TIMEOUT, was);
      await dropTempDir(dir);
    }
  },
});

Deno.test("deadOwnerWarning: the appId it names is printable too", () => {
  for (const m of [{ op: "backup" }, undefined]) {
    const w = deadOwnerWarning("a\x1b]0;pwn\x07", { pid: 1, maintenance: m });
    assert(!/[\x07\x1b]/.test(w), w);
  }
});
