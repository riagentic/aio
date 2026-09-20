// A lock refusal must not take a SIBLING app down.
//
// `acquireSingletonLock` answered "Already running" with `Deno.exit(1)`. Alone
// in the process that is the right exit. With another app already booted in
// the same process (D2 — an app plus its admin panel) it ended THAT app too,
// through `unload`, with no Phase 1–7 and no final persist. Now: throw when a
// sibling runtime is registered; exit only when alone.
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import {
  _alreadyRunningMessage,
  acquireSingletonLock,
} from "../src/server/aio-run-helpers.ts";
import { registerRuntime } from "../src/server/shutdown.ts";
import {
  lockDir,
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { appHome } from "../src/server/app-dirs.ts";

Deno.test({
  name:
    "singleton refusal: throws (does not exit) when another runtime shares the process",
  async fn() {
    const appId = `d2-refusal-${Deno.pid}`;
    // An owner that is alive (pid 1 — EPERM counts as alive) and whose port
    // answers, so the lock is neither stale nor a zombie: a genuine refusal.
    const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
    const port = (l.addr as Deno.NetAddr).port;
    writeLock({
      appId,
      pid: 1,
      port,
      startedAt: Date.now() - 60_000,
      status: "started",
      cwd: Deno.cwd(),
    });
    const unregister = registerRuntime(() => Promise.resolve());
    const realExit = Deno.exit;
    let exited = false;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = () => {
      exited = true;
      throw new Error("Deno.exit called");
    };
    try {
      await assertRejects(
        () => acquireSingletonLock(appId, undefined, port, true, false),
        Error,
        "Already running",
      );
      if (exited) {
        throw new Error(
          "refusal exited the process with a sibling app running",
        );
      }
    } finally {
      Deno.exit = realExit;
      unregister();
      removeLock(appId);
      l.close();
    }
  },
});

// ── the refusal has to name the way OUT ─────────────────────────────
//
// "Already running: todo at http://localhost:9010 (pid 123)" is true and a
// dead end. The reporter who hit it did so on the FIRST run of a fresh
// scaffold: a second, unrelated project also called `todo`. That is the case
// worth naming, because the appId also picks the data home — the two projects
// were about to share one database.

Deno.test("singleton refusal: names how to stop it, and the appId/data-home collision", () => {
  const msg = _alreadyRunningMessage({
    appId: "todo",
    port: 9010,
    pid: 4242,
    home: "/home/u/.todo",
    takeover: false,
  });
  assertStringIncludes(msg, "Already running: todo");
  // `am stop todo` was asserted here for a long time, and it does not stop it:
  // the positional argument of `am stop` is a COMPONENT label (deno.json →
  // build.targets), so a single-app project answers "this project declares no
  // components, so \"todo\" names nothing" and the app keeps running. MEASURED
  // against a live example app: exit 1, process still up; `--app=` works from
  // any directory. The test name always said "names how to stop it" — the
  // assertion just checked a different string than the claim.
  assertStringIncludes(msg, "am stop --app=todo");
  assert(
    !/am stop todo/.test(msg),
    "the positional form names a component, not an app",
  );
  assertStringIncludes(msg, "kill 4242");
  assertStringIncludes(msg, "--takeover");
  // The trap: `--port` looks like the fix and is not.
  assertStringIncludes(msg, "--port=N` does NOT help");
  // The data home is the reason a name clash is not cosmetic.
  assertStringIncludes(msg, "/home/u/.todo");
  assertStringIncludes(msg, 'aio.run({ appId: "…" })');
});

Deno.test("singleton refusal: --takeover that failed gets the fact, not the advice it already followed", () => {
  const msg = _alreadyRunningMessage({
    appId: "todo",
    port: 0,
    pid: 0,
    home: "/home/u/.todo",
    takeover: true,
  });
  assertStringIncludes(msg, "Failed to take over");
  assert(
    !msg.includes("--takeover"),
    `it just ran with --takeover. Got: ${msg}`,
  );
  assert(!msg.includes("(pid"), `no pid known — say nothing. Got: ${msg}`);
});

// A refusal across two homes was believed impossible ("a second boot from a
// DIFFERENT home is a different instance by construction"), so the message
// printed the caller's OWN home as the running instance's and went on to
// explain that both processes share one database. MEASURED, by running a
// compiled artifact under a temp $HOME beside the ordinary instance:
//
//   [AIO] Already running: r5a-counter at http://localhost:62290 (pid 1552822)
//         (home /tmp/…/r5a-prodhome/.r5a-counter)
//     If that is a DIFFERENT project … both would read and write one database.
//
// Every location in it is wrong: pid 1552822's home is ~/.r5a-counter, the
// directory named is this boot's own, the two databases are different files,
// and renaming the app would not have helped. $HOME alone does not scope the
// lock — `lockDir()` scopes on AIO_APPS_DIR, deliberately and for a reason
// (an e2e under a temp HOME once reached the production instance) — so this
// refusal is reachable, and the fix it owes the reader is that env var.
Deno.test("singleton refusal: a refusal across two homes names the RUNNING one", () => {
  const msg = _alreadyRunningMessage({
    appId: "todo",
    port: 9010,
    pid: 4242,
    home: "/tmp/sandbox/.todo",
    otherHome: "/home/u/.todo",
    takeover: false,
  });
  assertStringIncludes(
    msg,
    "home /home/u/.todo",
    "the head must name where the RUNNING instance keeps its data",
  );
  assertStringIncludes(msg, "/tmp/sandbox/.todo");
  assertStringIncludes(msg, "AIO_APPS_DIR");
  assert(
    !msg.includes("one database"),
    `two homes are two databases — say what is true. Got: ${msg}`,
  );
});

// …and what it says about WHERE the lock is has to be true on this machine.
//
// The two-home branch explained the collision with "(it lives in
// $XDG_RUNTIME_DIR)". `lockDir()` reads `$XDG_RUNTIME_DIR ?? "/tmp"` on posix
// and `%TEMP%` on Windows — so on macOS, on Windows, in a container and over
// plain ssh (every host with no systemd user session) that sentence names an
// env var that does not exist, about a file that is somewhere else. A refusal
// whose whole job is to send the reader to the right place cannot guess at it:
// it knows the directory, so it says the directory.
Deno.test("singleton refusal: the two-home branch names the real lock directory", () => {
  const msg = _alreadyRunningMessage({
    appId: "todo",
    port: 9010,
    pid: 4242,
    home: "/tmp/sandbox/.todo",
    otherHome: "/home/u/.todo",
    takeover: false,
  });
  assertStringIncludes(
    msg,
    lockDir(),
    "the reader is being sent to the lock — name where it actually is",
  );
  assert(
    !msg.includes("$XDG_RUNTIME_DIR"),
    `that variable is unset on macOS, on Windows and in any container — the ` +
      `lock is then in /tmp or %TEMP%. Got: ${msg}`,
  );
});

// …and the refusal has to CARRY the running instance's home to that message.
// Reproduced the way it happens: $HOME moves, so each process derives its own
// `~/.<appId>` and both land on the same lock key (lockDir scopes on
// AIO_APPS_DIR, not on $HOME — deliberately).
Deno.test({
  name: "singleton refusal: the running instance's home reaches the message",
  async fn() {
    const appId = `d2-home-${Deno.pid}`;
    const realHome = Deno.env.get("HOME");
    // AIO_APPS_DIR is the env var that DOES isolate (lockDir scopes on it), so
    // the collision only exists without one — and a sibling test file in this
    // process may have set it. Removed for the duration, restored after.
    const realApps = Deno.env.get("AIO_APPS_DIR");
    if (realApps !== undefined) Deno.env.delete("AIO_APPS_DIR");
    const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
    const port = (l.addr as Deno.NetAddr).port;
    // The holder's $HOME. Its home IS its `appHome`, so its lock key is the
    // bare appId — which is exactly why the second boot collides with it.
    Deno.env.set("HOME", "/tmp/r5a-other-home");
    const other = appHome(appId);
    writeLock({
      appId,
      pid: 1,
      port,
      startedAt: Date.now() - 60_000,
      status: "started",
      cwd: Deno.cwd(),
      home: other,
    });
    const unregister = registerRuntime(() => Promise.resolve());
    try {
      Deno.env.set("HOME", "/tmp/r5a-this-home"); // the second boot
      const err = await assertRejects(
        () => acquireSingletonLock(appId, undefined, port, true, false),
        Error,
        "Already running",
      );
      assertStringIncludes(
        err.message,
        `home ${other}`,
        "the head must name the home of the process that HOLDS the lock",
      );
      assertStringIncludes(err.message, "/tmp/r5a-this-home");
    } finally {
      unregister();
      // Both spellings: the key depends on $HOME at the moment it is computed,
      // and this case exists BECAUSE those two moments disagree.
      removeLock(lockKey(appId, other));
      removeLock(appId);
      l.close();
      if (realHome !== undefined) Deno.env.set("HOME", realHome);
      if (realApps !== undefined) Deno.env.set("AIO_APPS_DIR", realApps);
    }
  },
});
