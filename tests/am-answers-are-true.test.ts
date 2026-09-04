// `am` is the agent-facing surface: an answer it gives is acted on without a
// human reading it. Every finding here was an answer that was wrong while
// looking right — `{"ok":true}` for something that did nothing, `healthy:true`
// for a stranger's web server, a flag the table lists and the command refuses.
import { assert, assertEquals } from "@std/assert";
import {
  AppLock,
  lockKey,
  lockPath,
} from "../src/server/single-instance-lock.ts";
import { parseGlobalFlags } from "../src/am/am-utils.ts";
import { PASSTHROUGH, VERB_FLAGS } from "../src/am/am-flags.ts";
import { envelopePayload } from "../src/am/am-cmd-state.ts";

// ── A crash mid-write must not brick the app ──────────────────────────
//
// `writeLock` is a plain non-atomic write, so a crash or power cut leaves a
// 0-byte lock file. `readLock` then said "no lock" while `acquire` synthesised
// `pid: 0` and refused with "already running (pid 0, port 0)" — a pid no
// process has. `am status` said stopped, `am kill` killed nothing,
// `am kill --stale` found nothing, and the only way out was deleting a file in
// a runtime directory nobody has reason to know about. Two readers of one
// file, two answers — the failure `readLock`'s own docstring names.
Deno.test("an unreadable lock is reclaimed, not treated as an owner", async () => {
  const home = await Deno.makeTempDir({ prefix: "unreadable-lock-" });
  const key = lockKey("unreadablelockapp", home);
  try {
    await Deno.mkdir(lockPath(key).replace(/\/[^/]+$/, ""), {
      recursive: true,
    }).catch(() => {});
    await Deno.writeTextFile(lockPath(key), ""); // the crash's leftover
    const lock = new AppLock("unreadablelockapp", home);
    const r = await lock.acquire(0, false, {});
    assert(
      r.ok,
      `an empty lock file blocked the boot: ${JSON.stringify(r)}`,
    );
    lock.release();
  } finally {
    await Deno.remove(lockPath(key)).catch(() => {});
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

// ── A numeric flag has a RANGE, not just a type ───────────────────────
//
// `parseNumArg` takes `{min,max,integer}` and every call site omitted them, so
// only NaN was refused: `--wait=-5` reached `setTimeout(-5000)` (a 1 ms poll,
// forever), `--lines=0` printed EVERY line because `slice(-0)` is the whole
// array while the JSON said `"shown":0`, and `--port=0`/`-1` leaked a raw Deno
// internal — the leak `cmdStart`'s own comment says was fixed.
Deno.test("numeric am flags are bounded, not merely parsed", () => {
  const bad: [string, string][] = [
    ["--wait=-5", "--wait"],
    ["--lines=0", "--lines"],
    ["--lines=-5", "--lines"],
    ["--lines=1.5", "--lines"],
    ["--port=-1", "--port"],
    ["--port=99999", "--port"],
    ["--timeout=0", "--timeout"],
    ["--client-index=-1", "--client-index"],
  ];
  for (const [arg, label] of bad) {
    const { flags: f } = parseGlobalFlags([arg]);
    assert(
      f.error?.includes(label),
      `${arg} was accepted (error: ${f.error ?? "none"})`,
    );
  }
  // …and every honest value still parses, `--port=0` included: it is the
  // documented "pick a free one".
  for (const arg of ["--port=0", "--port=65535", "--lines=1", "--wait=0"]) {
    assertEquals(
      parseGlobalFlags([arg]).flags.error,
      undefined,
      `${arg} refused`,
    );
  }
});

// ── The dot form is a cell method everywhere, or nowhere ──────────────
//
// The trojan route normalises `[:.]` (its comment names the dot form) and
// `am dispatch`'s payload shaper tested only `:` — so `am dispatch
// counter.setTitle a=b` sent the named pairs as a BARE payload: the method's
// parameter was `undefined`, the key was deleted from state, and `am` reported
// `{"ok":true}`.
Deno.test("envelopePayload: `cell.method` is shaped like `cell:method`", () => {
  const named = { a: "b" };
  assertEquals(envelopePayload("counter:setTitle", named), { args: [named] });
  assertEquals(envelopePayload("counter.setTitle", named), { args: [named] });
  // A bare action type is NOT a cell method — its payload stays a payload.
  assertEquals(envelopePayload("Increment", named), named);
});

// ── The flag table and the command must agree ─────────────────────────
Deno.test("VERB_FLAGS lists nothing a verb refuses, and nothing twice", () => {
  const verbs = Object.entries(VERB_FLAGS);
  assert(verbs.length > 10, `VERB_FLAGS emptied: ${verbs.length} verbs`);
  for (const [verb, flags] of verbs) {
    assert(
      !(verb in PASSTHROUGH),
      `${verb} is in BOTH tables — one of them is not consulted`,
    );
    assertEquals(
      new Set(flags).size,
      flags.length,
      `${verb} lists a flag twice`,
    );
  }
  // `logs` carried `--level` while `logFlagError` refused every stray `-…`:
  // the central gate permitted a flag the verb does not take. A level is a
  // filter word (`am logs error`), not a flag.
  assert(
    !(VERB_FLAGS.logs ?? []).includes("--level"),
    "logs lists --level, which the command refuses",
  );
});
