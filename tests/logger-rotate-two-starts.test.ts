// Two starts at the same moment rotate the previous run's logs ONCE.
//
// The logger starts before the single-instance lock is taken, so both of two
// simultaneous launches rotated. Measured on a real machine after a double
// double-click: `debug.log.2` and no `debug.log.1` — one rotator saw the live
// file, then the other's fresh `.1`, shifted it to `.2`, and found the live
// file gone. One after the other was no better: the second archived the
// first's seconds-old files as "the previous run".
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  type ClaimFile,
  oncePerStart,
  rotateFile,
  START_CLAIM,
  START_ONCE_MS,
} from "../src/diagnostics/logger-rotate.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");

const names = (dir: string) =>
  [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n !== START_CLAIM)
    .sort();

Deno.test("on-start pass: two starts interleaved — the second waits for the first, then does not repeat it", async () => {
  const dir = await tempDir("rot-two-");
  try {
    const base = join(dir, "debug.log");
    await Deno.writeTextFile(base, "run 2\n");
    await Deno.writeTextFile(`${base}.1`, "run 1\n");
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => open = r);
    // The first rotator is INSIDE its pass (it has seen the live file) when
    // the second arrives — the interleaving that left `.2` without `.1`.
    let entered!: () => void;
    const inside = new Promise<void>((r) => entered = r);
    const first = oncePerStart(
      dir,
      async () => {
        order.push("first: in");
        entered();
        await gate;
        const did = await rotateFile(base, 7);
        order.push("first: out");
        return did;
      },
      false,
      { pid: 101 },
    );
    await inside;
    const second = oncePerStart(
      dir,
      async () => {
        order.push("second: in");
        return await rotateFile(base, 7);
      },
      false,
      { pid: 202 },
    );
    // The first holds the OS lock, so the second can only wait for it —
    // wherever it has got to when the gate opens.
    open();
    assertEquals(await first, true);
    assertEquals(await second, false, "the second start must not rotate");
    assertEquals(order, ["first: in", "first: out"]);
    assertEquals(names(dir), ["debug.log.1", "debug.log.2"]);
    assertEquals(await Deno.readTextFile(`${base}.1`), "run 2\n");
    assertEquals(await Deno.readTextFile(`${base}.2`), "run 1\n");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("on-start pass: who repeats it and who does not", async () => {
  const dir = await tempDir("rot-once-");
  try {
    // The claim's time is set by hand after every pass, so "how long ago" is
    // exact — no real clock in the comparison.
    const T0 = 1_700_000_000_000;
    const pass = async (pid: number, sinceLastMs: number) => {
      let ran = false;
      await oncePerStart(
        dir,
        () => {
          ran = true;
          return Promise.resolve();
        },
        undefined,
        { pid, now: () => T0 + sinceLastMs },
      );
      if (ran) Deno.utimeSync(join(dir, START_CLAIM), T0 / 1000, T0 / 1000);
      return ran;
    };
    assertEquals(await pass(101, 0), true, "the first start");
    assertEquals(await pass(202, 5), false, "another process, a moment later");
    assertEquals(await pass(101, 5), true, "the same process starting again");
    assertEquals(await pass(202, START_ONCE_MS - 1), false, "in the window");
    assertEquals(await pass(202, START_ONCE_MS), true, "past it: a new run");
    // …and that pass is now the recent one.
    assertEquals(await pass(303, 5), false);
    // A claim a moment AHEAD is the one just made: the file system's clock
    // and `Date.now()` are two clocks (Windows: up to 2 ms apart, measured).
    assertEquals(await pass(404, -1), false, "a moment ahead is recent");
    // One stamped beyond the window in the future (the clock stepped back)
    // is not recent.
    assertEquals(await pass(404, -START_ONCE_MS), true);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("on-start pass: a pass that failed leaves no claim — the next start runs it", async () => {
  const dir = await tempDir("rot-fail-");
  try {
    let failed = false;
    await oncePerStart(dir, () => Promise.reject(new Error("planted")), 0, {
      pid: 101,
    }).catch(() => failed = true);
    assert(failed, "the pass's error reaches the caller");
    let ran = false;
    await oncePerStart(
      dir,
      () => {
        ran = true;
        return Promise.resolve(0);
      },
      0,
      { pid: 202 },
    );
    assert(ran);
  } finally {
    await dropTempDir(dir);
  }
});

// ── the logger itself, two real processes on one log directory ──

const START = `import { AioLogger } from ${
  JSON.stringify(toFileUrl(join(REPO, "src/diagnostics/logger-core.ts")).href)
};
const l = new AioLogger({ dir: Deno.args[0], heartbeat: 0, console: false,
  level: "debug" });
await l.init();
l.pub("info", "run", Deno.args[1]);
l.pub("debug", "run", Deno.args[1]);
await l.flush();
`;

Deno.test("logger: a second process starting right behind the first does not rotate its files", async () => {
  const dir = await tempDir("rot-procs-");
  try {
    const logs = join(dir, "logs");
    await Deno.mkdir(logs);
    for (const k of ["app", "debug"]) {
      await Deno.writeTextFile(join(logs, `${k}.log`), "the previous run\n");
    }
    const script = join(dir, "start.ts");
    await Deno.writeTextFile(script, START);
    for (const tag of ["first-start", "second-start"]) {
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          join(REPO, "deno.json"),
          script,
          logs,
          tag,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(r.success, new TextDecoder().decode(r.stderr));
    }
    for (const k of ["app", "debug"]) {
      const live = await Deno.readTextFile(join(logs, `${k}.log`));
      assert(live.includes("first-start"), `${k}.log: ${live}`);
      assert(live.includes("second-start"), `${k}.log: ${live}`);
      assertEquals(
        await Deno.readTextFile(join(logs, `${k}.log.1`)),
        "the previous run\n",
        `${k}.log.1 must be the previous run`,
      );
    }
    assertEquals(
      names(logs).filter((n) => /\.\d+$/.test(n)),
      ["app.log.1", "debug.log.1"],
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("on-start pass: a directory that cannot hold the claim still gets its pass", async () => {
  const dir = await tempDir("rot-noclaim-");
  try {
    // The claim's name is taken by a directory: it cannot be opened as a file.
    await Deno.mkdir(join(dir, START_CLAIM));
    let ran = 0;
    for (const pid of [101, 202]) {
      await oncePerStart(
        dir,
        () => {
          ran++;
          return Promise.resolve();
        },
        undefined,
        { pid },
      );
    }
    assertEquals(
      ran,
      2,
      "unserialised, as before — never skipped, never thrown",
    );
  } finally {
    await dropTempDir(dir);
  }
});

// A claim file that opens but then fails must never be why the logger does
// not come up: each failing step degrades to "the pass runs", as before.
Deno.test("on-start pass: a claim file that fails mid-way never throws — unreadable counts as no claim", async () => {
  const dir = await tempDir("rot-badclaim-");
  try {
    const boom = () => Promise.reject(new Error("planted"));
    for (const broken of ["lock", "read", "stat", "truncate", "write"]) {
      // A recent claim by ANOTHER process is on disk: only a working read
      // could skip the pass.
      const path = join(dir, START_CLAIM);
      await Deno.writeTextFile(path, "101");
      let closed = 0;
      const open = async (p: string): Promise<ClaimFile> => {
        const f = await Deno.open(p, { read: true, write: true });
        return {
          lock: (x) => broken === "lock" ? boom() : f.lock(x),
          read: (b) => broken === "read" ? boom() : f.read(b),
          stat: () => broken === "stat" ? boom() : f.stat(),
          truncate: (n) => broken === "truncate" ? boom() : f.truncate(n),
          seek: (o, w) => f.seek(o, w),
          write: (b) => broken === "write" ? boom() : f.write(b),
          close: () => {
            closed++;
            f.close();
          },
        };
      };
      let ran = 0;
      const out = await oncePerStart(
        dir,
        () => {
          ran++;
          return Promise.resolve("ran");
        },
        "skipped",
        { pid: 202, open },
      );
      // Unreadable (read/stat) → no claim → the pass runs. Unlockable or
      // unwritable → the claim on disk is still read: skipped / ran as usual.
      const expected = broken === "read" || broken === "stat"
        ? "ran"
        : "skipped";
      assertEquals(out, expected, broken);
      assertEquals(closed, 1, `${broken}: the claim file is closed`);
      assertEquals(ran, expected === "ran" ? 1 : 0, broken);
    }
    // Unwritable, with the pass running (the claim is this process's own):
    // the result is returned, nothing is thrown.
    await Deno.writeTextFile(join(dir, START_CLAIM), "202");
    for (const broken of ["truncate", "write"]) {
      const open = async (p: string): Promise<ClaimFile> => {
        const f = await Deno.open(p, { read: true, write: true });
        return {
          lock: (x) => f.lock(x),
          read: (b) => f.read(b),
          stat: () => f.stat(),
          truncate: (n) => broken === "truncate" ? boom() : f.truncate(n),
          seek: (o, w) => f.seek(o, w),
          write: (b) => broken === "write" ? boom() : f.write(b),
          close: () => f.close(),
        };
      };
      assertEquals(
        await oncePerStart(dir, () => Promise.resolve("ran"), "skipped", {
          pid: 202,
          open,
        }),
        "ran",
        broken,
      );
    }
  } finally {
    await dropTempDir(dir);
  }
});
