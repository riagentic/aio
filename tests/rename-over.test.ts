// A rename over a file another process holds open is retried on Windows, for
// a bounded time, and a boot's own lock update survives it.
//
// Windows answers "access denied" to a rename over a file that any process
// has open without FILE_SHARE_DELETE — a second launch reading it, a syncing
// tool — and a replace did ONE `renameSync`, so a refusal had nothing on
// screen. (The lock file itself no longer goes through a rename at all: see
// `tests/lock-rewrite-in-place.test.ts`.) The OS steps are injected
// (`_renameDeps`), so the Windows rule runs on any OS.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  _renameDeps,
  HELD_COOLDOWN_MS,
  HeldOpenError,
  isHeldOpenError,
  moveFile,
  moveFileSync,
  removeOverSync,
  RENAME_BACKOFF_MS,
  renameOver,
  renameOverSync,
} from "../src/diagnostics/rename-over.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const DENIED = () =>
  new Deno.errors.PermissionDenied("Access is denied. (os error 5): rename");

/** Run `fn` as if on `windows`, with a rename that fails `fails` times (with
 *  `err()`) before the real one runs. Returns what the steps saw. */
function withRename<T>(
  o: { windows: boolean; fails: number; err?: () => Error },
  fn: () => T,
): { out: T; pauses: number[]; debug: string[]; calls: number } {
  const real = { ..._renameDeps };
  const seen = { pauses: [] as number[], debug: [] as string[], calls: 0 };
  _renameDeps.reset();
  _renameDeps.windows = () => o.windows;
  _renameDeps.pause = (ms) => void seen.pauses.push(ms);
  _renameDeps.debug = (m) => void seen.debug.push(m);
  _renameDeps.rename = (from, to) => {
    if (seen.calls++ < o.fails) throw (o.err ?? DENIED)();
    real.rename(from, to);
  };
  try {
    return { out: fn(), ...seen };
  } finally {
    Object.assign(_renameDeps, real);
  }
}

const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test("rename-over: the backoff is bounded between one and two seconds", () => {
  const total = RENAME_BACKOFF_MS.reduce((a, b) => a + b, 0);
  assert(total >= 1000 && total <= 2000, `total wait ${total} ms`);
});

Deno.test("rename-over: which errors mean 'held open'", () => {
  assert(isHeldOpenError(DENIED()));
  assert(isHeldOpenError(new Deno.errors.Busy("busy")));
  assert(isHeldOpenError(new Error("in use (os error 32): rename")));
  assert(isHeldOpenError(new Error("locked (os error 33): rename")));
  assert(!isHeldOpenError(new Deno.errors.NotFound("gone (os error 2)")));
  assert(!isHeldOpenError(new Error("disk full (os error 112)")));
  assert(!isHeldOpenError("PermissionDenied"));
});

Deno.test("rename-over: Windows, held open 3 times → replaced, one debug line", async () => {
  const dir = await tempDir("rename-over-");
  try {
    const tmp = join(dir, "a.tmp"), to = join(dir, "a");
    Deno.writeTextFileSync(to, "old");
    Deno.writeTextFileSync(tmp, "new");
    const r = withRename(
      { windows: true, fails: 3 },
      () => renameOverSync(tmp, to),
    );
    assertEquals(Deno.readTextFileSync(to), "new");
    assertEquals(r.pauses, RENAME_BACKOFF_MS.slice(0, 3));
    assertEquals(r.debug.length, 1);
    assert(
      r.debug[0]!.includes(to) && r.debug[0]!.includes("try 4"),
      r.debug[0],
    );
    assert(!exists(tmp));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("rename-over: a first-try success says nothing and waits for nothing", async () => {
  const dir = await tempDir("rename-over-");
  try {
    const tmp = join(dir, "a.tmp"), to = join(dir, "a");
    Deno.writeTextFileSync(tmp, "new");
    const r = withRename(
      { windows: true, fails: 0 },
      () => renameOverSync(tmp, to),
    );
    assertEquals(Deno.readTextFileSync(to), "new");
    assertEquals(r.pauses, []);
    assertEquals(r.debug, []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("rename-over: Windows, always held → an error naming the file and the OS error, the tmp gone", async () => {
  const dir = await tempDir("rename-over-");
  try {
    const tmp = join(dir, "a.tmp"), to = join(dir, "a");
    Deno.writeTextFileSync(to, "old");
    Deno.writeTextFileSync(tmp, "new");
    const r = withRename({ windows: true, fails: Infinity }, () =>
      assertThrows(
        () => renameOverSync(tmp, to),
        Error,
        `could not replace ${to}`,
      ));
    assert(r.out.message.includes("os error 5"), r.out.message);
    assert(r.out.cause instanceof Deno.errors.PermissionDenied);
    assertEquals(r.pauses, [...RENAME_BACKOFF_MS]);
    assertEquals(r.calls, RENAME_BACKOFF_MS.length + 1);
    assertEquals(r.debug, []);
    assertEquals(Deno.readTextFileSync(to), "old");
    assert(!exists(tmp), "the tmp must not be left behind");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("rename-over: an error that is not 'held open' is not retried, and the tmp is gone", async () => {
  const dir = await tempDir("rename-over-");
  try {
    const tmp = join(dir, "a.tmp"), to = join(dir, "a");
    Deno.writeTextFileSync(tmp, "new");
    const err = new Deno.errors.NotFound("no such dir (os error 3)");
    const r = withRename(
      { windows: true, fails: Infinity, err: () => err },
      () => assertThrows(() => renameOverSync(tmp, to)),
    );
    assertEquals(r.out, err);
    assertEquals(r.pauses, []);
    assertEquals(r.calls, 1);
    assert(!exists(tmp));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("rename-over: POSIX never retries — a denied rename there is a real permission", async () => {
  const dir = await tempDir("rename-over-");
  try {
    const tmp = join(dir, "a.tmp"), to = join(dir, "a");
    Deno.writeTextFileSync(tmp, "new");
    const r = withRename(
      { windows: false, fails: 1 },
      () => assertThrows(() => renameOverSync(tmp, to)),
    );
    assert(r.out instanceof Deno.errors.PermissionDenied);
    assertEquals(r.pauses, []);
    assertEquals(r.calls, 1);
    assert(!exists(tmp));
  } finally {
    await dropTempDir(dir);
  }
});

// ── the async twin, the keep-the-source moves, the removal ──

/** As `withRename`, for the async step and the remove step. */
async function withSteps<T>(
  o: {
    windows: boolean;
    fails: number;
    err?: () => Error;
    keepMemory?: boolean;
  },
  fn: () => T | Promise<T>,
): Promise<{ out: T; waits: number[]; debug: string[]; calls: number }> {
  const real = { ..._renameDeps };
  const seen = { waits: [] as number[], debug: [] as string[], calls: 0 };
  const failing = () => {
    if (seen.calls++ < o.fails) throw (o.err ?? DENIED)();
  };
  if (!o.keepMemory) _renameDeps.reset();
  _renameDeps.windows = () => o.windows;
  _renameDeps.pause = (ms) => void seen.waits.push(ms);
  _renameDeps.sleep = (ms) => {
    seen.waits.push(ms);
    return Promise.resolve();
  };
  _renameDeps.debug = (m) => void seen.debug.push(m);
  _renameDeps.rename = (from, to) => {
    failing();
    real.rename(from, to);
  };
  _renameDeps.renameAsync = async (from, to) => {
    failing();
    await real.renameAsync(from, to);
  };
  _renameDeps.remove = (path) => {
    failing();
    real.remove(path);
  };
  try {
    return { out: await fn(), ...seen };
  } finally {
    Object.assign(_renameDeps, real);
  }
}

const thrown = async (fn: () => unknown): Promise<Error> => {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
};

Deno.test("renameOver (async): same rule, same bounds, same messages as the sync one", async () => {
  const dir = await tempDir("rename-over-");
  try {
    const tmp = join(dir, "a.tmp"), to = join(dir, "a");
    Deno.writeTextFileSync(to, "old");
    Deno.writeTextFileSync(tmp, "new");
    const r = await withSteps(
      { windows: true, fails: 3 },
      () => renameOver(tmp, to),
    );
    assertEquals(Deno.readTextFileSync(to), "new");
    assertEquals(r.waits, RENAME_BACKOFF_MS.slice(0, 3));
    assertEquals(r.debug.length, 1);
    assert(r.debug[0]!.includes("replaced on try 4"), r.debug[0]);

    // Held to the end: the same error text as the sync twin, the tmp gone.
    const both: string[] = [];
    for (const run of [renameOver, renameOverSync]) {
      Deno.writeTextFileSync(tmp, "newer");
      const f = await withSteps(
        { windows: true, fails: Infinity },
        () => thrown(() => run(tmp, to)),
      );
      assertEquals(f.waits, [...RENAME_BACKOFF_MS]);
      assertEquals(f.calls, RENAME_BACKOFF_MS.length + 1);
      assert(f.out.cause instanceof Deno.errors.PermissionDenied);
      assert(!exists(tmp), "the tmp must not be left behind");
      both.push(f.out.message);
    }
    assertEquals(both[0], both[1]);
    assertEquals(
      both[0],
      `could not replace ${to} after 11 tries over 1315 ms: Access is ` +
        `denied. (os error 5): rename — it is open in another program, or ` +
        `this user may not write it.`,
    );
    assertEquals(Deno.readTextFileSync(to), "new");

    // POSIX, and an error that is not "held open": one call, no wait.
    Deno.writeTextFileSync(tmp, "x");
    const p = await withSteps(
      { windows: false, fails: 1 },
      () => thrown(() => renameOver(tmp, to)),
    );
    assert(p.out instanceof Deno.errors.PermissionDenied);
    assertEquals([p.calls, p.waits.length], [1, 0]);
    assert(!exists(tmp));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("renameOver / renameOverSync: a first-try success is ONE rename call and nothing else", async () => {
  const dir = await tempDir("rename-over-");
  try {
    for (const run of [renameOver, renameOverSync, moveFile, moveFileSync]) {
      const tmp = join(dir, "a.tmp"), to = join(dir, "a");
      Deno.writeTextFileSync(tmp, "new");
      const r = await withSteps(
        { windows: true, fails: 0 },
        () => run(tmp, to),
      );
      assertEquals([r.calls, r.waits.length, r.debug.length], [1, 0, 0]);
      assertEquals(Deno.readTextFileSync(to), "new");
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("moveFile / moveFileSync: the same retry, and a source that is DATA stays where it was", async () => {
  const dir = await tempDir("rename-over-");
  try {
    const from = join(dir, "state.db"), to = join(dir, "state.db.aside");
    for (const run of [moveFile, moveFileSync]) {
      Deno.writeTextFileSync(from, "the data");
      const held = await withSteps(
        { windows: true, fails: Infinity },
        () => thrown(() => run(from, to)),
      );
      assertEquals(held.waits, [...RENAME_BACKOFF_MS]);
      assert(held.out.message.startsWith(`could not replace ${to} after 11 `));
      assertEquals(Deno.readTextFileSync(from), "the data");

      const other = await withSteps({
        windows: true,
        fails: 1,
        err: () => new Deno.errors.NotFound("gone (os error 2)"),
      }, () => thrown(() => run(from, to)));
      assert(other.out instanceof Deno.errors.NotFound);
      assertEquals(Deno.readTextFileSync(from), "the data");

      const ok = await withSteps(
        { windows: true, fails: 2 },
        () => run(from, to),
      );
      assertEquals(ok.debug.length, 1);
      assertEquals(Deno.readTextFileSync(to), "the data");
      assert(!exists(from));
      Deno.removeSync(to);
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("removeOverSync: a held file is waited for; gone is the goal; the bound is loud", async () => {
  const dir = await tempDir("rename-over-");
  try {
    const f = join(dir, "app.lock");
    Deno.writeTextFileSync(f, "{}");
    const ok = await withSteps(
      { windows: true, fails: 2 },
      () => removeOverSync(f),
    );
    assertEquals(ok.out, true);
    assertEquals(ok.waits, RENAME_BACKOFF_MS.slice(0, 2));
    assertEquals(ok.debug.length, 1);
    assert(ok.debug[0]!.includes("removed on try 3"), ok.debug[0]);
    assert(!exists(f));

    // Already gone: false, no wait, no line.
    const gone = await withSteps(
      { windows: true, fails: 0 },
      () => removeOverSync(f),
    );
    assertEquals([gone.out, gone.waits.length, gone.debug.length], [
      false,
      0,
      0,
    ]);

    Deno.writeTextFileSync(f, "{}");
    const held = await withSteps(
      { windows: true, fails: Infinity },
      () => thrown(() => removeOverSync(f)),
    );
    assertEquals(held.waits, [...RENAME_BACKOFF_MS]);
    assert(held.out.message.startsWith(`could not remove ${f} after 11 tries`));
    assert(!held.out.message.includes("kept it open"), held.out.message);
    assert(held.out.message.includes("os error 5"), held.out.message);
    assert(exists(f));

    // POSIX: one call, the OS error as it is.
    const posix = await withSteps(
      { windows: false, fails: 1 },
      () => thrown(() => removeOverSync(f)),
    );
    assert(posix.out instanceof Deno.errors.PermissionDenied);
    assertEquals([posix.calls, posix.waits.length], [1, 0]);
  } finally {
    await dropTempDir(dir);
  }
});

// ── a target held LONGER than the bound: remembered, then fails fast ──

Deno.test("a target that stays held: one full wait, then fast failures; said once per cool-down; recovery said once", async () => {
  const dir = await tempDir("rename-over-");
  const real = { ..._renameDeps };
  try {
    const to = join(dir, "journal");
    Deno.writeTextFileSync(to, "old");
    let clock = 1_000, blocked = 0, calls = 0, fail = true;
    const lines: string[] = [];
    _renameDeps.reset();
    _renameDeps.windows = () => true;
    _renameDeps.now = () => clock;
    _renameDeps.pause = (ms) => void (blocked += ms);
    _renameDeps.sleep = (ms) => {
      blocked += ms;
      return Promise.resolve();
    };
    _renameDeps.warn = (m) => void lines.push(`warn ${m}`);
    _renameDeps.info = (m) => void lines.push(`info ${m}`);
    _renameDeps.debug = (m) => void lines.push(`debug ${m}`);
    const step = () => {
      calls++;
      if (fail) throw DENIED();
    };
    _renameDeps.rename = (from, t) => {
      step();
      real.rename(from, t);
    };
    _renameDeps.renameAsync = async (from, t) => {
      step();
      await real.renameAsync(from, t);
    };
    const BOUND = RENAME_BACKOFF_MS.reduce((a, b) => a + b, 0);
    // Every attempt has its OWN temp name, as the real writers do; the sync
    // and the async verb take turns — one memory for both.
    let n = 0;
    const attempt = async (): Promise<HeldOpenError | null> => {
      const tmp = join(dir, `journal.${++n}.tmp`);
      Deno.writeTextFileSync(tmp, `v${n}`);
      try {
        if (n % 2) renameOverSync(tmp, to);
        else await renameOver(tmp, to);
        return null;
      } catch (e) {
        assert(e instanceof HeldOpenError, String(e));
        assert(!exists(tmp), "the tmp must not be left behind");
        return e;
      }
    };

    // 20 failing replaces: ONE bound of waiting in all, 11 + 19 rename calls.
    const errs: (HeldOpenError | null)[] = [];
    for (let i = 0; i < 20; i++) {
      errs.push(await attempt());
      clock += 100;
    }
    assertEquals(blocked, BOUND);
    assertEquals(calls, RENAME_BACKOFF_MS.length + 1 + 19);
    assertEquals(errs.map((e) => e!.repeat), [false, ...Array(19).fill(true)]);
    assert(
      errs[5]!.message.includes("after 1 try over 0 ms"),
      errs[5]!.message,
    );
    assertEquals(lines, [], "the first failure is the caller's to report");

    // Past the cool-down: the full wait is spent again, and that — once —
    // is said by the helper, with the count.
    clock += HELD_COOLDOWN_MS;
    const again = await attempt();
    assertEquals(blocked, 2 * BOUND);
    assertEquals(again!.repeat, true);
    assertEquals(lines.length, 1, lines.join("\n"));
    assert(lines[0]!.startsWith(`warn ${to} still cannot be replaced — 21 `));
    assert((await attempt())!.repeat);
    assertEquals(blocked, 2 * BOUND, "inside the new cool-down: no wait");

    // The holder lets go: the next write lands at once, and says so, once.
    fail = false;
    assertEquals(await attempt(), null);
    assertEquals(blocked, 2 * BOUND);
    assertEquals(lines.length, 2, lines.join("\n"));
    assertEquals(
      lines[1],
      `info ${to}: replaced again after 22 failed attempts`,
    );
    assertEquals(await attempt(), null);
    assertEquals(lines.length, 2, "recovery is said once");
    assertEquals(Deno.readTextFileSync(to), `v${n}`);

    // Forgotten: a later failure is a first failure again.
    fail = true;
    const fresh = await attempt();
    assertEquals(fresh!.repeat, false);
    assertEquals(blocked, 3 * BOUND);
  } finally {
    Object.assign(_renameDeps, real);
    _renameDeps.reset();
    await dropTempDir(dir);
  }
});

Deno.test("held targets: the memory is bounded — the oldest is forgotten, never the newest", async () => {
  const dir = await tempDir("rename-over-");
  try {
    const fill = async (i: number) => {
      const tmp = join(dir, `t${i}.tmp`);
      Deno.writeTextFileSync(tmp, "x");
      return await withSteps(
        { windows: true, fails: Infinity, keepMemory: true },
        () => thrown(() => renameOverSync(tmp, join(dir, `t${i}`))),
      );
    };
    _renameDeps.reset();
    for (let i = 0; i <= 64; i++) {
      assertEquals((await fill(i)).waits.length, RENAME_BACKOFF_MS.length);
    }
    // 65 targets met the bound; 64 are remembered.
    assertEquals((await fill(64)).waits, [], "the newest fails fast");
    assertEquals((await fill(1)).waits, [], "so does the second oldest");
    assertEquals(
      (await fill(0)).waits.length,
      RENAME_BACKOFF_MS.length,
      "the oldest was dropped: a full wait again",
    );
  } finally {
    _renameDeps.reset();
    await dropTempDir(dir);
  }
});
