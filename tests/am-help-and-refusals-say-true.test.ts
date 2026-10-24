// Sentences am said that were not true.
//
// - `am help <typo>` printed "unknown command" and exited 0 (its `--json`
//   twin already exited 1), so `am help x && …` read as success.
// - `am help trigger` called the optional client index required (`<idx>`) and
//   named ten of the sixteen actions the verb accepts.
// - `am start --wiat=5` forwarded the typo; the app suggested its --width.
// - `am stop --instance=x` (nothing running there) told the reader about
//   `AIO_APPS_DIR=…/.aio-instances/x` — a variable they never set, which
//   `--instance` sets internally — instead of naming the flag they typed.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { HELP_TEXT, TRIGGER_ACTIONS } from "../src/am/am-help-text.ts";
import { helpBlock } from "../src/am/am-cmd-meta.ts";
import { amFlagTypoNotes, noLockMessage } from "../src/am/am-cmd-start.ts";
import { instanceAppsDir } from "../src/server/app-dirs.ts";

const AM = join(import.meta.dirname!, "..", "src", "am.ts");

Deno.test("am help <unknown>: exit 1 in pretty mode too", async () => {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", AM, "help", "no-such-verb"],
    env: { NO_COLOR: "1", AIO_AM_NO_DELEGATE: "1" },
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(r.code, 1);
  assertStringIncludes(new TextDecoder().decode(r.stderr), "unknown command");
  const ok = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", AM, "help", "trigger"],
    env: { NO_COLOR: "1", AIO_AM_NO_DELEGATE: "1" },
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(ok.code, 0, "a known verb's help is still a success");
});

Deno.test("am help trigger: the index is optional and every action is named", () => {
  const block = helpBlock(HELP_TEXT, "trigger") ?? "";
  assertStringIncludes(block, "trigger [idx] <path>");
  assert(TRIGGER_ACTIONS.length >= 16, "the action list is not empty");
  for (const a of TRIGGER_ACTIONS) {
    assert(new RegExp(`[(/]${a}[/)]`).test(block), `help omits ${a}`);
  }
});

Deno.test("no-lock refusal under --instance names the flag, not AIO_APPS_DIR", () => {
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", instanceAppsDir("ag-r1-probe"));
  try {
    const m = noLockMessage("no-such-app-r1");
    assertStringIncludes(m, "--instance=ag-r1-probe");
    assert(!m.includes("AIO_APPS_DIR="), m);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
  }
});

Deno.test("am help state: --wait=N is said to re-print forever", () => {
  // `am state x --wait=5` reads like "wait up to 5 s"; it is a poll loop that
  // never exits — an agent hung on it. The help must say so.
  const block = helpBlock(HELP_TEXT, "state") ?? "";
  assertStringIncludes(block, "never exits");
});

Deno.test("am start: a typo of am's own flag is named as am's", () => {
  // `am start --wiat=5` reached the app, which suggested ITS `--width`.
  const [note] = amFlagTypoNotes(["--wiat=5"]);
  assertStringIncludes(note ?? "", "did you mean am's --wait?");
  // Runtime, deno and am flags are known — no note for any of them.
  assertEquals(
    amFlagTypoNotes(["--wait=5", "--expose", "--env-file=.env", "--width=9"]),
    [],
  );
  // An app's own flags are not am typos (each was suggested once).
  assertEquals(
    amFlagTypoNotes(["--name=x", "--date=1", "--tls", "--root=/", "--seed=1"]),
    [],
  );
  assertStringIncludes(amFlagTypoNotes(["--prot=1"])[0] ?? "", "--port?");
});
